import test from 'node:test';
import assert from 'node:assert/strict';
import {STORAGE_KEY,initialState} from '../core.js';
import {protocolStatus} from './protocol-fixture.mjs';

const events={};
let stored={};
let status=protocolStatus();
let dropBatchResponse=false;
const requests=[];
const commits=new Map();
const event=name=>({addListener:handler=>{events[name]=handler;}});
const tab={id:12,url:'https://www.instagram.com/protocol_fixture/saved/all-posts/'};
globalThis.chrome={
  runtime:{id:'protocol-test-extension',getURL:path=>'chrome-extension://protocol-test-extension/'+path,
    onMessage:event('message'),onInstalled:event('installed'),onStartup:event('startup')},
  storage:{local:{get:async key=>({[key]:structuredClone(stored[key])}),set:async value=>{stored={...stored,...structuredClone(value)};},setAccessLevel:async()=>{}}},
  alarms:{create:async()=>{},onAlarm:event('alarm')},
  tabs:{query:async()=>[tab],get:async()=>tab,sendMessage:async()=>({ok:true}),onRemoved:event('removed')},
  scripting:{executeScript:async()=>[]},permissions:{contains:async()=>true,remove:async()=>true},
};
globalThis.fetch=async(url,options)=>{
  const path=new URL(url).pathname;
  requests.push({path,body:options.body,protocol:options.headers['X-Little-Archive-Protocol']});
  if (path.endsWith('/status')) return Response.json(status);
  if (path==='/api/extension/imports') return Response.json({run_id:'synthetic-protocol-run',instance_id:status.instance_id,protocol_version:1});
  if (path.endsWith('/batches')) {
    const body=JSON.parse(options.body);
    const previous=commits.get(body.batch_id);
    if (previous) assert.equal(options.body,previous);
    commits.set(body.batch_id,options.body);
    if (dropBatchResponse) throw new TypeError('Synthetic response lost after commit');
    return Response.json({status:'applied',created:1,updated:0,skipped:0,replayed:Boolean(previous)});
  }
  if (path.endsWith('/finish')) return Response.json({ok:true,created:1,updated:0,skipped:0,coverage:'partial'});
  throw new Error('Unexpected test endpoint');
};
await import('../background.js');
const popup={id:'protocol-test-extension',url:'chrome-extension://protocol-test-extension/popup.html'};
const source={id:popup.id,url:tab.url,tab:{id:tab.id},frameId:0};
const send=(payload,sender=popup)=>new Promise(resolve=>events.message(payload,sender,resolve));
const state=()=>stored[STORAGE_KEY];
const uploads=()=>requests.filter(entry=>entry.path.endsWith('/batches'));
async function until(predicate) {
  for (let i=0;i<200;i++) {
    if (predicate()) return;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.fail('Timed out waiting for protocol checkpoint');
}
const configure=()=>send({type:'configure',server:'https://protocol.example.test',token:'synthetic-protocol-import-token'});

test('an unsupported pairing status sends no write and leaves existing storage intact',async()=>{
  await send({type:'status'}); // Drain the initial read-only startup.
  stored[STORAGE_KEY]=initialState();
  const before=JSON.stringify(stored);
  status.extension_protocol.versions={'2':{}};
  const response=await configure();
  assert.equal(response.ok,false);
  assert.equal(response.code,'server_protocol_unsupported');
  assert.match(response.error,/Update/);
  assert.equal(JSON.stringify(stored),before);
  assert.equal(requests.filter(entry=>entry.body!==undefined).length,0);
});

test('protocol interruption preserves committed-but-unacknowledged v1 bytes and identities',async()=>{
  status=protocolStatus();
  assert.equal((await configure()).ok,true);
  assert.equal(state().config.protocol.mode,'negotiated');
  assert.equal((await send({type:'start',sourceAccount:'protocol_fixture',collectionName:'',confirmed:true})).ok,true);
  assert.equal(state().run.protocolVersion,1);
  dropBatchResponse=true;
  assert.equal((await send({type:'capture',runId:state().run.id,items:[{url:'https://www.instagram.com/p/PROTOCOL_FIXTURE/'}]},source)).ok,true);
  await until(()=>state().outbox[0]?.attempts===1);
  const body=JSON.stringify(state().outbox[0].body);
  const runId=state().run.id;
  const nextSequence=state().run.nextSequence;
  const uploadCount=uploads().length;
  status.extension_protocol.versions={'2':{}};
  assert.equal((await send({type:'retry'})).ok,true);
  await until(()=>state().outbox[0]?.blocked);
  assert.equal(state().run.status,'paused');
  assert.match(state().run.message,/Pending batches are unchanged/);
  assert.equal(JSON.stringify(state().outbox[0].body),body);
  assert.equal(state().run.id,runId);
  assert.equal(state().run.nextSequence,nextSequence);
  assert.equal(uploads().length,uploadCount);
  assert.equal((await send({type:'resume'})).code,'server_protocol_unsupported');

  status=protocolStatus();
  dropBatchResponse=false;
  assert.equal((await send({type:'resume'})).ok,true);
  await until(()=>state().outbox.length===0);
  assert.equal(uploads().length,uploadCount+1);
  assert.ok(uploads().every(entry=>entry.body===body && entry.protocol==='1'));
  assert.equal(commits.size,1);
  assert.equal(state().run.id,runId);
  assert.equal(state().run.nextSequence,nextSequence);
  assert.equal((await send({type:'finish'})).ok,true);
  await until(()=>state().run.status==='completed');
  assert.ok(requests.filter(entry=>entry.body!==undefined).every(entry=>entry.protocol==='1'));
  assert.ok(requests.filter(entry=>entry.body===undefined).every(entry=>entry.protocol===undefined));
});

test('an original checkpoint without a protocol field resumes unchanged against a new server',async()=>{
  const prior=structuredClone(state());
  prior.run.status='paused';
  prior.run.appliedBatches=0;
  prior.run.created=0;
  delete prior.run.protocolVersion;
  delete prior.config.protocol;
  const committedBody=uploads()[0].body;
  prior.outbox=[{body:JSON.parse(committedBody),attempts:1,nextRetryAt:0,blocked:false}];
  stored[STORAGE_KEY]=prior;
  const before=uploads().length;
  events.startup();
  await until(()=>state().outbox.length===0);
  assert.equal(uploads().length,before+1);
  assert.equal(uploads().at(-1).body,committedBody);
  assert.equal(uploads().at(-1).protocol,'1');
  assert.equal(state().run.id,prior.run.id);
  assert.equal(state().run.nextSequence,prior.run.nextSequence);
  assert.equal(state().run.appliedBatches,1);
  assert.equal(state().run.created,1);
  assert.equal(Object.hasOwn(state().run,'protocolVersion'),false);
});

test('unknown run protocol and storage formats cannot send or discard queued payloads',async()=>{
  const saved=structuredClone(state());
  saved.run.status='paused';
  saved.run.protocolVersion=2;
  saved.outbox=[{body:JSON.parse(uploads()[0].body),attempts:0,nextRetryAt:0,blocked:false}];
  stored[STORAGE_KEY]=saved;
  const body=JSON.stringify(saved.outbox[0].body);
  const count=uploads().length;
  assert.equal((await send({type:'resume'})).code,'checkpoint_protocol_unsupported');
  assert.equal((await send({type:'retry'})).ok,true);
  await until(()=>state().outbox[0]?.blocked);
  assert.equal(uploads().length,count);
  assert.equal(JSON.stringify(state().outbox[0].body),body);

  stored[STORAGE_KEY]={...saved,version:2};
  const snapshot=JSON.stringify(stored);
  events.startup();
  events.alarm({name:'little-archive-retry'});
  events.removed(tab.id);
  for (const type of ['status','retry','forget','disconnect']) {
    const response=await send({type});
    assert.equal(response.ok,false);
    assert.equal(response.code,'checkpoint_format_unsupported');
  }
  assert.equal(JSON.stringify(stored),snapshot);
  assert.equal(uploads().length,count);
});
