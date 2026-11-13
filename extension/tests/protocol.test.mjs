import test from 'node:test';
import assert from 'node:assert/strict';
import {negotiateProtocol,protocolHeaders,runProtocolVersion,ProtocolCompatibilityError} from '../protocol.js';
import {protocolStatus} from './protocol-fixture.mjs';

function rejects(status,code) {
  assert.throws(()=>negotiateProtocol(status),error=>
    error instanceof ProtocolCompatibilityError && error.status===409 && error.code===code);
}

test('explicit v1 is independent of app release and permits additive capabilities',()=>{
  const status=protocolStatus();
  status.version='9.7.3';
  status.extension_protocol.versions['1'].capabilities.push('future_optional_feature');
  status.extension_protocol.versions['2']={capabilities:[],limits:{}};
  const selection=negotiateProtocol(status);
  assert.deepEqual(selection,{version:1,mode:'negotiated',serverVersion:'9.7.3'});
  assert.deepEqual(protocolHeaders(selection),{'X-Little-Archive-Protocol':'1'});
});

test('only the known original 0.1.0 status without metadata enters legacy mode',()=>{
  const status={ok:true,version:'0.1.0',instance_id:'synthetic-old-instance'};
  const selection=negotiateProtocol(status);
  assert.deepEqual(selection,{version:1,mode:'legacy',serverVersion:'0.1.0'});
  assert.deepEqual(protocolHeaders(selection),{});
  for (const version of [undefined,'0.1.1','1.0.0','0.1.0-custom']) {
    rejects({...status,version},'server_protocol_missing');
  }
});

test('an invalid explicit declaration never falls back to legacy mode',()=>{
  for (const declaration of [null,[],{},'1',{name:'other',versions:{'1':{}}},
    {name:'little-archive.extension',versions:[]}]) {
    rejects({...protocolStatus(),extension_protocol:declaration},'invalid_protocol_declaration');
  }
  const status=protocolStatus();
  status.extension_protocol.versions={'2':status.extension_protocol.versions['1']};
  rejects(status,'server_protocol_unsupported');
});

test('missing capabilities or reduced limits block v1 instead of rewriting a queue',()=>{
  const required=protocolStatus().extension_protocol.versions['1'].capabilities;
  for (const omitted of required) {
    const status=protocolStatus();
    status.extension_protocol.versions['1'].capabilities=required.filter(value=>value!==omitted);
    rejects(status,'server_capabilities_missing');
  }
  for (const limits of [{max_batch_items:49,max_batch_bytes:262144},
    {max_batch_items:50,max_batch_bytes:262143},
    {max_batch_items:'50',max_batch_bytes:262144},
    {max_batch_items:50,max_batch_bytes:Infinity},{}]) {
    const status=protocolStatus();
    status.extension_protocol.versions['1'].limits=limits;
    rejects(status,'server_limits_incompatible');
  }
});

test('invalid status and unknown persisted protocol fail closed',()=>{
  for (const status of [null,[],{}, {...protocolStatus(),ok:false},
    {...protocolStatus(),instance_id:''}, {...protocolStatus(),instance_id:7}]) {
    rejects(status,'invalid_server_status');
  }
  const legacyRun={id:'synthetic-run',nextSequence:3};
  const snapshot=JSON.stringify(legacyRun);
  assert.equal(runProtocolVersion(legacyRun),1);
  assert.equal(JSON.stringify(legacyRun),snapshot);
  for (const version of [2,null,'1',0]) {
    assert.throws(()=>runProtocolVersion({protocolVersion:version}),{code:'checkpoint_protocol_unsupported'});
  }
  assert.throws(()=>protocolHeaders({version:1,mode:'unknown'}),{code:'protocol_not_negotiated'});
});
