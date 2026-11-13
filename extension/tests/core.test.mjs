import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeServerURL, permissionPattern, sourceContext, assertSource, canonicalPost,
  normalizeObservation, safePreview, makeBatches, queueObservations, byteLength,
  MAX_BATCH_BYTES, initialState, publicState,
} from '../core.js';

test('server destination is origin-only HTTPS or explicit HTTP loopback',()=>{
  assert.equal(normalizeServerURL(' http://localhost:8787/ '),'http://localhost:8787');
  assert.equal(normalizeServerURL('https://archive.example.test/'),'https://archive.example.test');
  for(const bad of ['http://example.test','javascript:alert(1)','https://user:pass@archive.test','https://archive.test/api','https://archive.test/?token=secret','https://archive.test/#token']) {
    assert.throws(()=>normalizeServerURL(bad));
  }
  assert.equal(permissionPattern('http://127.0.0.1:8787'),'http://127.0.0.1/*');
});

test('scope binding rejects feeds, audio, a different account, and a different collection',()=>{
  const page='https://www.instagram.com/sample_account/saved/12345/';
  const scope=sourceContext(page);
  assert.equal(scope.account,'sample_account');
  assert.equal(scope.isCollection,true);
  assertSource(page,'@sample_account',scope.scopeKey);
  assert.throws(()=>assertSource(page,'someone_else',scope.scopeKey));
  assert.throws(()=>assertSource('https://www.instagram.com/sample_account/saved/67890/','sample_account',scope.scopeKey));
  for(const bad of ['https://www.instagram.com/','https://www.instagram.com/p/abc/','https://www.instagram.com/sample_account/saved/audio/','https://evil.test/sample_account/saved/all-posts/']) {
    assert.throws(()=>sourceContext(bad));
  }
  assert.throws(()=>assertSource('https://www.instagram.com/sample_account/saved/','sample_account'));
});

test('TikTok context supports an account Favorites view and a collection, not video or likes paths',()=>{
  assert.equal(sourceContext('https://www.tiktok.com/@sample_account').scopeKey,'tiktok:sample_account:favorites');
  assert.equal(sourceContext('https://www.tiktok.com/@sample_account/collection/Ideas-123').isCollection,true);
  assert.throws(()=>sourceContext('https://www.tiktok.com/@sample_account/video/12345'));
  assert.throws(()=>sourceContext('https://www.tiktok.com/@sample_account/liked'));
});

test('Instagram slug-plus-numeric-ID collection URLs retain stable account-bound scope',()=>{
  const original='https://www.instagram.com/sample/saved/weekend-ideas/1234567890123456/';
  const renamed='https://www.instagram.com/sample/saved/new-display-name/1234567890123456/';
  const scope=sourceContext(original);
  assert.equal(scope.isCollection,true);
  assert.equal(scope.collectionId,'1234567890123456');
  assert.equal(scope.scopeKey,'instagram:sample:collection:1234567890123456');
  assert.equal(sourceContext(renamed).scopeKey,scope.scopeKey);
  assertSource(renamed,'sample',scope.scopeKey);
  assert.throws(()=>assertSource('https://www.instagram.com/sample/saved/weekend-ideas/2234567890123456/','sample',scope.scopeKey));
  assert.throws(()=>assertSource('https://www.instagram.com/another/saved/weekend-ideas/1234567890123456/','sample',scope.scopeKey));
  for (const path of ['saved/audio/12345/','saved/all-posts/12345/','saved/weekend-ideas/not-numeric/','saved/weekend-ideas/12345/extra/','feed/weekend-ideas/12345/']) {
    assert.throws(()=>sourceContext('https://www.instagram.com/sample/'+path));
  }
});

test('canonical IDs reject foreign and short URLs and preserve supported permalink identities',()=>{
  assert.equal(canonicalPost('https://www.instagram.com/reels/Ab_C-123/?igsh=tracking','instagram').url,'https://www.instagram.com/reel/Ab_C-123/');
  assert.equal(canonicalPost('https://www.instagram.com/p/Ab_C-123/','instagram').key,'Ab_C-123');
  assert.equal(canonicalPost('https://www.tiktok.com/@creator/photo/12345678','tiktok').content_type,'image');
  for(const bad of ['https://vm.tiktok.com/abc','https://tiktok.com.evil.test/@creator/video/12345678','https://user:secret@tiktok.com/@creator/video/12345678']) {
    assert.equal(canonicalPost(bad,'tiktok'),null);
  }
});

test('normalization binds collection membership and keeps alt separate from captions',()=>{
  const item=normalizeObservation({url:'https://www.instagram.com/p/Test123/',thumbnail_alt:'Text on cover',collections:[{source_key:'injected',name:'Other'}],caption:null,preview_url:'https://localhost/private'},'instagram',{source_key:'observed:abc',name:'Original نام'});
  assert.equal(item.thumbnail_alt,'Text on cover');
  assert.equal(item.caption,undefined);
  assert.deepEqual(item.collections,[{source_key:'observed:abc',name:'Original نام'}]);
  assert.equal(item.preview_url,undefined);
  assert.equal(safePreview('https://scontent.example.cdninstagram.com/photo.jpg?exp=123'),'https://scontent.example.cdninstagram.com/photo.jpg?exp=123');
  assert.equal(safePreview('https://cdninstagram.com.evil.test/photo.jpg'),null);
});

test('batches respect byte and record limits, including multibyte evidence',()=>{
  let n=0;
  const items=Array.from({length:122},(_,i)=>({url:`https://www.instagram.com/p/Test${i}/`,caption:'علم'.repeat(2000)}));
  const batches=makeBatches(items,0,()=>`batch-${n++}`);
  assert.equal(batches.flatMap(b=>b.items).length,items.length);
  batches.forEach((body,i)=>{
    assert.equal(body.sequence,i);
    assert.ok(body.items.length<=50);
    assert.ok(byteLength(body)<=MAX_BATCH_BYTES);
  });
});

test('queue checkpoint deduplicates the same post across permalink variants',()=>{
  const state={...initialState(),run:{platform:'instagram',collection:null,nextSequence:0,seen:[],discovered:0}};
  const first=queueObservations(state,[{url:'https://www.instagram.com/p/ABC/'},{url:'https://www.instagram.com/reel/ABC/'}],()=> 'batch-one');
  assert.equal(first.queued,1);
  const second=queueObservations(first.state,[{url:'https://www.instagram.com/p/ABC/'}],()=> 'unused');
  assert.equal(second.queued,0);
  assert.equal(second.state.outbox.length,1);
  assert.deepEqual(second.state.outbox[0].body,first.state.outbox[0].body);
  assert.deepEqual(state.run.seen,[],'input state was not mutated before persistence');
});

test('full outbox refuses more data without advancing the durable checkpoint',()=>{
  const state={...initialState(),outbox:[{body:{items:[{caption:'x'.repeat(4*1024*1024)}]}}],run:{platform:'instagram',collection:null,nextSequence:1,seen:[],discovered:0}};
  assert.throws(()=>queueObservations(state,[{url:'https://www.instagram.com/p/NewOne/'}],()=> 'batch-two'),/queue is full/);
  assert.equal(state.run.nextSequence,1);
  assert.deepEqual(state.run.seen,[]);
});

test('popup state never discloses the saved import token',()=>{
  const state={...initialState(),config:{server:'https://archive.example.test',token:'private-import-token-value',instance_id:'sample-instance'}};
  assert.equal(publicState(state).config.hasToken,true);
  assert.ok(!JSON.stringify(publicState(state)).includes('private-import-token-value'));
});
