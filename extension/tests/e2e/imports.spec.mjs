import {test,expect} from './fixtures.mjs';
import {instagramPage,instagramVirtualizedPage,tiktokPage} from './source-pages.mjs';

test('Instagram image grid imports through the real popup and refreshes without duplicating saves',async ({rig}) => {
  const collection='Weekend ideas · أفكار 🌿';
  const url=`https://www.instagram.com/${rig.account}/saved/synthetic-collection/1234567890123456/`;
  const source=await rig.source(url,instagramPage({heading:collection,creator:'synthetic.creator'}));
  expect(await source.locator('main[role="main"] a img[alt]').count()).toBe(21);
  expect(await source.locator('figcaption').count()).toBe(0);
  let popup=await rig.pair(source);
  expect(await popup.value('collection')).toBe(collection);
  await rig.start(popup);
  await rig.waitCompleted(popup);

  const original=await rig.items();
  expect(original).toHaveLength(21);
  for (const item of original) {
    expect(item.platform).toBe('instagram');
    expect(item.creator).toBe('@synthetic.creator');
    expect(item.caption).toBe('');
    expect(item.evidence.some(entry => entry.kind==='thumbnail_alt' && entry.text.startsWith('Synthetic saved image '))).toBe(true);
    expect(item.collections.map(entry => ({name:entry.name,kind:entry.kind}))).toEqual([{name:collection,kind:'source'}]);
    expect(item.url).toMatch(/^https:\/\/www\.instagram\.com\/(p|reel)\/CI_SYNTHETIC_\d{5}\/$/);
  }
  expect((await rig.imports())[0]).toMatchObject({created:21,updated:0,coverage:'enumeration_exhausted'});
  const first=original[0];
  await rig.owner.patch(`/api/items/${first.id}`,{title:'My edited title',notes:'Keep this personal note',favorite:true});

  await rig.closePopup();
  await source.reload();
  popup=await rig.openPopup(source);
  expect(await popup.value('collection')).toBe(collection);
  await rig.start(popup);
  await expect.poll(async () => (await rig.imports()).length).toBe(2);
  await rig.waitCompleted(popup);
  const refreshed=await rig.items();
  expect(refreshed).toHaveLength(21);
  expect(refreshed.map(item => item.id).sort()).toEqual(original.map(item => item.id).sort());
  expect(refreshed.find(item => item.id===first.id)).toMatchObject({title:'My edited title',notes:'Keep this personal note',favorite:true});
  const runs=await rig.imports();
  expect(runs.reduce((sum,run) => sum+run.created,0)).toBe(21);
  expect(runs.reduce((sum,run) => sum+run.updated,0)).toBe(21);
  const sourceCollections=(await rig.owner.get('/api/collections')).collections.filter(entry => entry.source_account===rig.account);
  expect(sourceCollections).toHaveLength(1);
  expect(sourceCollections[0]).toMatchObject({name:collection,kind:'source',count:21});
});

test('incremental scrolling sends bounded ordered batches to the actual server',async ({rig}) => {
  const source=await rig.source(
    `https://www.instagram.com/${rig.account}/saved/all-posts/`,
    instagramPage({count:51,appendOnScroll:2}),
  );
  const popup=await rig.pair(source);
  await rig.start(popup);
  await rig.waitCompleted(popup);
  const state=await rig.state();
  expect(state.run.discovered).toBe(53);
  expect(state.run.scrolls).toBeGreaterThanOrEqual(1);
  expect(state.run.appliedBatches).toBe(3);
  expect((await rig.items()).length).toBe(53);
  expect(rig.relay.attempts.map(attempt => attempt.body.sequence)).toEqual([0,1,2]);
  expect(rig.relay.attempts.map(attempt => attempt.body.items.length)).toEqual([50,1,2]);
  expect(new Set(rig.relay.attempts.map(attempt => attempt.body.batch_id)).size).toBe(3);
  for (const attempt of rig.relay.attempts) {
    expect(attempt.bytes).toBeLessThanOrEqual(256*1024);
    expect(attempt.status).toBe(200);
    expect(attempt.replayed).toBe(false);
  }
  expect((await rig.imports())[0]).toMatchObject({status:'completed',created:53,coverage:'enumeration_exhausted'});
});

test('All posts followed by individual collections preserves overlapping preset categories',async ({rig}) => {
  const collectionA='Original ideas · إلهام';
  const collectionB='Things to make 🌷';
  let source=await rig.source(
    `https://www.instagram.com/${rig.account}/saved/all-posts/`,instagramPage({count:3}),
  );
  let popup=await rig.pair(source);
  await rig.start(popup);
  await rig.waitCompleted(popup);
  const initial=await rig.items();
  const runIds=[(await rig.state()).run.id];
  expect(initial).toHaveLength(3);
  expect(initial.every(item=>item.collections.length===0)).toBe(true);
  for (const [slug,id,name,startIndex] of [['preset-a','1234567890123456',collectionA,0],['preset-b','2234567890123456',collectionB,1]]) {
    await rig.closePopup();
    await source.close();
    source=await rig.source(
      `https://www.instagram.com/${rig.account}/saved/${slug}/${id}/`,instagramPage({count:2,startIndex,heading:name,creator:'synthetic.creator'}),
    );
    popup=await rig.openPopup(source);
    expect(await popup.value('collection')).toBe(name);
    await rig.start(popup);
    await rig.waitCompleted(popup);
    runIds.push((await rig.state()).run.id);
  }
  expect(new Set(runIds).size).toBe(3);
  const items=await rig.items();
  expect(items.map(item=>item.id).sort()).toEqual(initial.map(item=>item.id).sort());
  const names=index=>items.find(item=>item.url.includes(`CI_SYNTHETIC_${String(index).padStart(5,'0')}`)).collections.map(collection=>collection.name).sort();
  expect(names(0)).toEqual([collectionA]);
  expect(names(1)).toEqual([collectionA,collectionB].sort());
  expect(names(2)).toEqual([collectionB]);
  expect((await rig.imports()).reduce((sum,run)=>sum+run.created,0)).toBe(3);
  expect((await rig.imports()).reduce((sum,run)=>sum+run.updated,0)).toBe(4);
});

test('ambiguous collection headings keep the exact-name field editable and empty',async ({rig}) => {
  const source=await rig.source(
    `https://www.instagram.com/${rig.account}/saved/ambiguous-headings/5234567890123456/`,
    instagramPage({count:1,heading:'First visible heading',extraHeading:'Another visible heading'}),
  );
  const popup=await rig.pair(source);
  expect(await popup.value('collection')).toBe('');
  await rig.start(popup,'The manually verified exact name 🌿');
  await rig.waitCompleted(popup);
  expect((await rig.items())[0].collections[0].name).toBe('The manually verified exact name 🌿');
});

test('TikTok Favorites imports video and photo identities with caption provenance',async ({rig}) => {
  // The odd-length prefix would make a UTF-16 slice at 240 split an emoji.
  const emojiCaption='A synthetic emojis '+'😀'.repeat(200);
  const source=await rig.source(`https://www.tiktok.com/@${rig.account}`,tiktokPage({videoCaption:emojiCaption}));
  const popup=await rig.pair(source);
  await rig.start(popup);
  await rig.waitCompleted(popup);
  const items=await rig.items();
  expect(items).toHaveLength(2);
  expect(items.map(item => item.content_type).sort()).toEqual(['image','video']);
  expect(items.every(item => item.creator==='@synthetic_creator')).toBe(true);
  expect(items.every(item => item.caption.startsWith('A synthetic '))).toBe(true);
  expect(items.every(item => item.evidence.some(entry => entry.kind==='thumbnail_alt'))).toBe(true);
  expect(items.every(item => item.evidence.some(entry => entry.kind==='caption'))).toBe(true);
  expect(items.every(item => item.collections.length===0)).toBe(true);
  const video=items.find(item=>item.content_type==='video');
  expect(video.caption).toBe(emojiCaption);
  expect(video.title).toBe('A synthetic emojis '+'😀'.repeat(110));
  expect((await rig.state()).run.discovered).toBe(2);
});

test('the real scanner pauses at an Instagram login prompt without importing cards',async ({rig}) => {
  const source=await rig.source(
    `https://www.instagram.com/${rig.account}/saved/all-posts/`,
    instagramPage({login:true}),
  );
  const popup=await rig.pair(source);
  await rig.start(popup);
  await expect.poll(async () => (await rig.state()).run?.status).toBe('paused');
  expect((await rig.state()).run.message).toMatch(/login or verification prompt/i);
  expect(await rig.items()).toHaveLength(0);
  expect(rig.relay.attempts).toHaveLength(0);
});

test('the real scanner rejects TikTok Posts even after the popup checkbox is confirmed',async ({rig}) => {
  const source=await rig.source(`https://www.tiktok.com/@${rig.account}`,tiktokPage({selected:'Posts'}));
  const popup=await rig.pair(source);
  await rig.start(popup);
  await expect.poll(async () => (await rig.state()).run?.status).toBe('paused');
  expect((await rig.state()).run.message).toMatch(/does not scan the Posts or Liked tab/i);
  expect(await rig.items()).toHaveLength(0);
  expect(rig.relay.attempts).toHaveLength(0);
});

test('pause, scope protection and resumed traversal pass known cards while preserving partial coverage',async ({rig}) => {
  const url=`https://www.instagram.com/${rig.account}/saved/all-posts/`;
  let source=await rig.source(url,instagramPage({count:12,end:false}));
  let popup=await rig.pair(source);
  await rig.start(popup);
  await expect.poll(async () => (await rig.items()).length).toBe(12);
  await expect.poll(() => popup.text('run-state')).toBe('Running');
  await popup.click('pause');
  await expect.poll(() => popup.text('run-state')).toBe('Paused');
  const checkpoint=(await rig.state()).run;

  await rig.closePopup();
  await source.close();
  const other=await rig.source(
    `https://www.instagram.com/${rig.account}/saved/another-synthetic-collection/3234567890123456/`,
    instagramPage({count:3}),
  );
  popup=await rig.openPopup(other);
  await popup.click('resume');
  await expect.poll(() => popup.text('notice')).toMatch(/page scope changed/i);
  expect((await rig.state()).run.status).toBe('paused');
  expect((await rig.items()).length).toBe(12);

  await rig.closePopup();
  await other.close();
  source=await rig.source(url,instagramVirtualizedPage({knownCount:12}));
  popup=await rig.openPopup(source);
  await popup.click('resume');
  await expect.poll(() => popup.text('run-state')).toBe('Running');
  // Reopening at the top must pass twelve already-known virtualized cards.
  // Eight rounds without a *new upload* do not mean traversal has stagnated.
  await expect.poll(async () => (await rig.items()).length,{timeout:40_000}).toBe(13);
  await popup.click('finish');
  await rig.waitCompleted(popup);
  const resumed=(await rig.state()).run;
  expect(resumed.id).toBe(checkpoint.id);
  expect(resumed.discovered).toBe(13);
  expect(resumed.coverage).toBe('partial');
  expect(rig.relay.attempts).toHaveLength(2);
  expect(rig.relay.attempts.map(attempt=>attempt.body.items.length)).toEqual([12,1]);
  expect((await rig.imports())[0]).toMatchObject({created:13,coverage:'partial'});
});

test('a committed batch survives browser restart and replays exactly once after a lost response',async ({rig}) => {
  const url=`https://www.instagram.com/${rig.account}/saved/synthetic-retry/4234567890123456/`;
  const collection='Retry keeps the original name ✨';
  let source=await rig.source(url,instagramPage());
  let popup=await rig.pair(source);
  rig.relay.setDropBatchResponses(true);
  await rig.start(popup,collection);
  await expect.poll(() => rig.relay.attempts.some(attempt => attempt.responseDropped)).toBe(true);
  await expect.poll(async () => (await rig.state()).outbox[0]?.attempts || 0).toBeGreaterThan(0);
  await expect.poll(async () => (await rig.state()).run?.status).toBe('finishing');
  expect((await rig.items()).length).toBe(21); // The backend commit really happened.
  const pending=await rig.state();
  const batch=pending.outbox[0].body;
  expect(pending.outbox).toHaveLength(1);
  expect(pending.run.appliedBatches).toBe(0); // No response was acknowledged yet.

  await rig.restart(); // Same disposable profile, new Chromium process/worker.
  const restored=await rig.state();
  expect(restored.connected).toBe(true);
  expect(restored.run.id).toBe(pending.run.id);
  expect(restored.outbox[0].body).toEqual(batch);
  source=await rig.source(url,instagramPage());
  popup=await rig.openPopup(source);
  await expect.poll(() => popup.text('run-state')).toBe('Finishing');
  rig.relay.setDropBatchResponses(false);
  await popup.click('retry');
  await rig.waitCompleted(popup);

  const items=await rig.items();
  expect(items).toHaveLength(21);
  expect(items.every(item => item.collections.some(entry => entry.name===collection))).toBe(true);
  const state=await rig.state();
  expect(state.run).toMatchObject({created:21,updated:0,appliedBatches:1,nextSequence:1});
  expect(rig.relay.attempts.length).toBeGreaterThanOrEqual(2);
  expect(new Set(rig.relay.attempts.map(attempt => attempt.digest)).size).toBe(1);
  expect(rig.relay.attempts.every(attempt => attempt.body.batch_id===batch.batch_id && attempt.body.sequence===0)).toBe(true);
  expect(rig.relay.attempts.at(-1)).toMatchObject({status:200,replayed:true,responseDropped:false});
  expect((await rig.imports())[0]).toMatchObject({status:'completed',created:21,updated:0});
});
