import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const scanner=await readFile(new URL('../content.js',import.meta.url),'utf8');

async function runSyntheticTraversal({seen,advance=true}) {
  const messages=[];
  let scrolls=0;
  let listener;
  let done;
  const finished=new Promise(resolve => {done=resolve;});
  const node=()=>({
    setAttribute(){},addEventListener(){},append(){},remove(){},
    attachShadow(){return {append(){}};},
  });
  const adapter={
    inspect:()=>({}),
    collect:()=>({records:[{_key:`synthetic-${advance ? scrolls : 0}`,url:`https://www.instagram.com/p/SYNTHETIC_${advance ? scrolls : 0}/`}],lastLink:null}),
    endStatus:()=>advance && scrolls===12 ? 'end' : null,
    scrollContainer:()=>({clientHeight:800,scrollBy(){scrolls+=1;}}),
  };
  vm.runInNewContext(scanner,{
    window:{__littleArchiveAdapters:adapter},
    document:{createElement:node,documentElement:{append(){}}},
    chrome:{runtime:{
      id:'synthetic-extension',
      onMessage:{addListener(handler){listener=handler;}},
      async sendMessage(message){
        messages.push(message);
        if (message.type==='scan-finished' || message.type==='scan-paused') done(message);
        return {ok:true};
      },
    }},
    innerHeight:800,
    setTimeout:callback=>queueMicrotask(callback),
  });
  const reply=await new Promise(resolve => listener({type:'la-start',run:{id:'synthetic-run',seen}}, {id:'synthetic-extension'},resolve));
  assert.equal(reply.ok,true);
  const timer=setTimeout(()=>done({type:'timed-out'}),1000);
  try {
    const result=await finished;
    assert.notEqual(result.type,'timed-out','Scanner should terminate at the observed end or stagnation bound.');
    return {messages,result,scrolls};
  } finally {clearTimeout(timer);}
}

test('resume traverses more than eight already-known virtualized cards before reaching new saves',async()=>{
  const result=await runSyntheticTraversal({seen:Array.from({length:12},(_,i)=>`synthetic-${i}`)});
  assert.equal(result.scrolls,12);
  assert.equal(result.result.coverage,'enumeration_exhausted');
  const uploaded=result.messages.filter(message=>message.type==='capture').flatMap(message=>message.items);
  assert.equal(uploaded.length,1,'Known checkpoint identities must not upload again.');
  assert.equal(uploaded[0].url,'https://www.instagram.com/p/SYNTHETIC_12/');
});

test('unchanging known cards still stop at the stagnation bound with partial coverage',async()=>{
  const result=await runSyntheticTraversal({seen:['synthetic-0'],advance:false});
  assert.equal(result.scrolls,8);
  assert.equal(result.result.coverage,'partial');
  assert.equal(result.messages.filter(message=>message.type==='capture').flatMap(message=>message.items).length,0);
});
