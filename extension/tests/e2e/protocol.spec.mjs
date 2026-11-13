import {test,expect} from './fixtures.mjs';
import {instagramPage} from './source-pages.mjs';

test('known original status uses visible legacy mode and real headerless imports',async ({rig})=>{
  rig.relay.setStatusMode('legacy');
  const source=await rig.source(`https://www.instagram.com/${rig.account}/saved/all-posts/`,instagramPage());
  const popup=await rig.pair(source);
  await expect.poll(()=>popup.text('protocol-status')).toContain('Legacy 0.1.0 server compatibility mode');
  await rig.start(popup);
  await rig.waitCompleted(popup);
  expect((await rig.items()).length).toBe(21);
  expect((await rig.state()).run.protocolVersion).toBe(1);
  expect(rig.relay.attempts).toHaveLength(1);
  expect(rig.relay.attempts[0]).toMatchObject({protocol:null,status:200,replayed:false});
  expect((await rig.imports())[0]).toMatchObject({status:'completed',created:21});
});

test('incompatible handshake blocks a durable pending batch until v1 returns',async ({rig})=>{
  const collection='Protocol recovery keeps this name 🌿';
  const source=await rig.source(`https://www.instagram.com/${rig.account}/saved/synthetic-protocol/6234567890123456/`,instagramPage({heading:collection}));
  const popup=await rig.pair(source);
  await expect.poll(()=>popup.text('protocol-status')).toContain('Import protocol 1 verified');
  rig.relay.setDropBatchResponses(true);
  await rig.start(popup);
  await expect.poll(()=>rig.relay.attempts.some(attempt=>attempt.responseDropped)).toBe(true);
  await expect.poll(async()=>(await rig.state()).outbox[0]?.attempts || 0).toBeGreaterThan(0);
  await expect.poll(async()=>(await rig.state()).run?.status).toBe('finishing');
  const pending=await rig.state();
  const body=pending.outbox[0].body;
  expect((await rig.items()).length).toBe(21); // Real commit, still unacknowledged.

  rig.relay.setStatusMode('unsupported');
  rig.relay.setDropBatchResponses(false);
  const attemptsBeforeBlock=rig.relay.attempts.length;
  await popup.click('retry');
  await expect.poll(async()=>(await rig.state()).outbox[0]?.blocked).toBe(true);
  await expect.poll(()=>popup.text('run-message')).toContain('Pending batches are unchanged');
  const blocked=await rig.state();
  expect(blocked.outbox).toHaveLength(1);
  expect(blocked.outbox[0].body).toEqual(body);
  expect(blocked.run.id).toBe(pending.run.id);
  expect(blocked.run.nextSequence).toBe(pending.run.nextSequence);
  expect(rig.relay.attempts).toHaveLength(attemptsBeforeBlock); // The incompatible check sent no batch.

  rig.relay.setStatusMode('real');
  await popup.click('retry');
  await rig.waitCompleted(popup);
  expect(rig.relay.attempts).toHaveLength(attemptsBeforeBlock+1);
  expect(new Set(rig.relay.attempts.map(attempt=>attempt.digest)).size).toBe(1);
  expect(rig.relay.attempts.at(-1).body).toEqual(body);
  expect(rig.relay.attempts.at(-1)).toMatchObject({protocol:'1',status:200,replayed:true,responseDropped:false});
  expect((await rig.state()).run).toMatchObject({id:pending.run.id,created:21,updated:0,appliedBatches:1,nextSequence:1,protocolVersion:1});
  const items=await rig.items();
  expect(items).toHaveLength(21);
  expect(items.every(item=>item.collections.some(entry=>entry.name===collection))).toBe(true);
});
