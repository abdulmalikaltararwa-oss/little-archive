import test from 'node:test';
import assert from 'node:assert/strict';
import {STORAGE_KEY} from '../core.js';

const events={};
let stored={};
let capturedRequests=[];
let loseFirstBatchResponse=true;
let committed=new Map();
let finishExpectedBatches=1;
const event=name=>({addListener:handler=>{events[name]=handler;}});
const tab={id:9,url:'https://www.instagram.com/sample/saved/all-posts/'};
globalThis.chrome={
  runtime:{id:'test-extension',getURL:path=>'chrome-extension://test-extension/'+path,
    onMessage:event('message'),onInstalled:event('installed'),onStartup:event('startup')},
  storage:{local:{get:async key=>({[key]:structuredClone(stored[key])}),set:async value=>{stored={...stored,...structuredClone(value)};},setAccessLevel:async()=>{}}},
  alarms:{create:async()=>{},onAlarm:event('alarm')},
  tabs:{query:async()=>[tab],get:async()=>tab,sendMessage:async()=>({ok:true}),create:async()=>{},onRemoved:event('removed')},
  scripting:{executeScript:async()=>[]},permissions:{contains:async()=>true,remove:async()=>true},
};
globalThis.fetch=async(url,options)=>{
  assert.equal(options.credentials,'omit');
  assert.equal(options.redirect,'error');
  assert.ok(['Bearer synthetic-private-import-token','Bearer synthetic-replacement-import-token'].includes(options.headers.Authorization));
  assert.equal(options.headers['X-Little-Archive-Protocol'],undefined,'known legacy server keeps its original header contract');
  const path=new URL(url).pathname;
  if(path.endsWith('/status')) return Response.json({ok:true,version:'0.1.0',instance_id:'instance-one'});
  if(path==='/api/extension/imports') return Response.json({run_id:'run-one',instance_id:'instance-one'});
  if(path.endsWith('/batches')) {
    capturedRequests.push(options.body);
    const body=JSON.parse(options.body);
    const previous=committed.get(body.batch_id);
    if(previous) assert.equal(previous,options.body,'replay must retain identical payload and batch identity');
    committed.set(body.batch_id,options.body);
    if(loseFirstBatchResponse){loseFirstBatchResponse=false;throw new TypeError('Simulated lost response after commit');}
    return Response.json({status:'applied',created:1,updated:0,skipped:0,replayed:Boolean(previous)});
  }
  if(path.endsWith('/finish')) {
    const body=JSON.parse(options.body);
    assert.equal(body.expected_batches,finishExpectedBatches);
    return Response.json({ok:true,created:finishExpectedBatches,updated:0,skipped:0,coverage:'partial'});
  }
  throw new Error('Unexpected endpoint '+path);
};

await import('../background.js');
const popup={id:'test-extension',url:'chrome-extension://test-extension/popup.html'};
const source={id:'test-extension',url:tab.url,tab:{id:tab.id},frameId:0};
function send(payload,sender=popup){return new Promise(resolve=>events.message(payload,sender,resolve));}
const state=()=>stored[STORAGE_KEY];
async function until(predicate){for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('Timed out waiting for durable worker state');}

test('worker retains an ambiguous committed batch and retries its exact identity',async()=>{
  assert.equal((await send({type:'configure',server:'https://archive.example.test',token:'synthetic-private-import-token'})).ok,true);
  assert.equal(state().config.protocol.mode,'legacy');
  assert.equal((await send({type:'start',sourceAccount:'sample',collectionName:'',confirmed:true})).ok,true);
  const rejected=await send({type:'capture',runId:'run-one',items:[{url:'https://www.instagram.com/p/BadFrame/'}]}, {...source,frameId:1});
  assert.equal(rejected.ok,false);
  assert.equal(state().run.discovered,0);
  assert.equal((await send({type:'capture',runId:'run-one',items:[{url:'https://www.instagram.com/p/Synthetic/'}],scrolls:1},source)).ok,true);
  await until(()=>state().outbox[0]?.attempts===1);
  assert.equal(state().outbox.length,1);
  assert.equal(state().run.appliedBatches,0);
  assert.equal((await send({type:'retry'})).ok,true);
  await until(()=>state().outbox.length===0);
  assert.equal(capturedRequests.length,2);
  assert.equal(capturedRequests[0],capturedRequests[1]);
  assert.equal(committed.size,1);
  assert.equal(state().run.appliedBatches,1);
  assert.equal(state().run.created,1);
  const status=await send({type:'status'});
  assert.ok(!JSON.stringify(status).includes('synthetic-private-import-token'));
});

test('worker rejects scope/account changes and server switching during a live run',async()=>{
  const capture=await send({type:'capture',runId:'run-one',items:[]},{...source,url:'https://www.instagram.com/other/saved/all-posts/'});
  assert.equal(capture.ok,false);
  const config=await send({type:'configure',server:'https://other.example.test',token:'synthetic-private-import-token'});
  assert.equal(config.ok,false);
  assert.match(config.error,/switching servers/);
  assert.equal(state().config.server,'https://archive.example.test');
  const replacement=await send({type:'configure',server:'https://archive.example.test',token:'synthetic-replacement-import-token'});
  assert.equal(replacement.ok,false);
  assert.match(replacement.error,/before changing its import token/);
  assert.equal(state().config.token,'synthetic-private-import-token');
  assert.equal((await send({type:'configure',server:'https://archive.example.test',token:''})).ok,true);
});

test('finish waits for durable acknowledged batches and preserves partial coverage',async()=>{
  const result=await send({type:'finish'});
  assert.equal(result.ok,true);
  await until(()=>state().run.status==='completed');
  assert.equal(state().run.coverage,'partial');
  assert.equal(state().run.discovered,1);
  const late=await send({type:'capture',runId:'run-one',items:[{url:'https://www.instagram.com/p/Late/'}]},source);
  assert.equal(late.ok,false);
  assert.equal(state().run.discovered,1);
});

test('a page cannot invoke privileged popup commands',async()=>{
  const result=await send({type:'configure',server:'https://attacker.example.test',token:'synthetic-private-import-token'},source);
  assert.equal(result.ok,false);
  assert.equal(state().config.server,'https://archive.example.test');
});

test('the completion display honors a server downgrade of empty-scan coverage',async()=>{
  finishExpectedBatches=0;
  assert.equal((await send({type:'start',sourceAccount:'sample',collectionName:'',confirmed:true})).ok,true);
  assert.equal((await send({type:'scan-finished',runId:'run-one',coverage:'enumeration_exhausted',reason:'Synthetic explicit empty state.'},source)).ok,true);
  await until(()=>state().run.status==='completed');
  assert.equal(state().run.coverage,'partial');
  assert.match(state().run.message,/Partial scan saved/);
  assert.equal(state().run.discovered,0);
});
