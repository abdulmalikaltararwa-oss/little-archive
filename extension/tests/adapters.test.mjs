import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

function adapter({url='https://www.instagram.com/sample/saved/all-posts/',selected=[],login=false,anchors=[],headings=[]}={}) {
  const root={querySelectorAll:selector=>selector==='a[href]'?anchors:headings};
  const context={URL,location:new URL(url),window:{},document:{body:root,
    querySelector:selector=>selector.includes('input[type="password"]')?(login?{}:null):(selector==='main'?root:null),
    querySelectorAll:()=>selected.map(textContent=>({textContent})),
  }};
  vm.runInNewContext(readFileSync(new URL('../adapters.js',import.meta.url),'utf8'),context);
  return {api:context.window.__littleArchiveAdapters,root};
}
function anchor(href,{alt='',caption='',navigation=false}={}) {
  const image={getAttribute:()=>alt,currentSrc:'https://scontent.cdninstagram.com/preview.jpg'};
  return {href,
    closest:selector=>navigation && selector.includes('nav')?{}:null,
    querySelector:selector=>selector==='img'?image:(caption?{textContent:caption}:null),
  };
}

test('synthetic rendered cards preserve alt provenance and exclude navigation links',()=>{
  const {api,root}=adapter({anchors:[
    anchor('https://www.instagram.com/p/SyntheticA/',{alt:'Preview text'}),
    anchor('https://www.instagram.com/reel/SyntheticA/',{alt:'Duplicate permalink'}),
    anchor('https://www.instagram.com/p/NavOnly/',{navigation:true}),
    anchor('https://malicious.example/p/Ignore/'),
  ]});
  const {records}=api.collect(root,'instagram');
  assert.equal(records.length,1);
  assert.equal(records[0].thumbnail_alt,'Preview text');
  assert.equal(records[0].caption,undefined);
});

test('source login prompt stops collection',()=>{
  const url='https://www.instagram.com/sample/saved/all-posts/';
  const {api}=adapter({url,login:true});
  assert.throws(()=>api.inspect({sourceUrl:url,platform:'instagram',sourceAccount:'sample'}),/login or verification/);
});

test('TikTok Posted tab is rejected even when user previously confirmed Favorites',()=>{
  const url='https://www.tiktok.com/@sample';
  const {api}=adapter({url,selected:['Videos']});
  assert.throws(()=>api.inspect({sourceUrl:url,platform:'tiktok',sourceAccount:'sample',confirmed:true}),/Favorites tab/);
});

test('missing TikTok tab semantics require explicit current-view confirmation',()=>{
  const url='https://www.tiktok.com/@sample';
  const {api,root}=adapter({url});
  assert.throws(()=>api.inspect({sourceUrl:url,platform:'tiktok',sourceAccount:'sample',confirmed:false}),/cannot be verified/);
  assert.equal(api.inspect({sourceUrl:url,platform:'tiktok',sourceAccount:'sample',confirmed:true}),root);
});

test('end state uses explicit page-level markers and rejects caption text',()=>{
  const pageHeading={textContent:'No more posts',closest:()=>null};
  const captionHeading={textContent:'No more posts',closest:()=>({})};
  let fixture=adapter({headings:[captionHeading]});
  assert.equal(fixture.api.endStatus(fixture.root,2),null);
  fixture=adapter({headings:[pageHeading]});
  assert.equal(fixture.api.endStatus(fixture.root,2),'end');
  fixture=adapter({headings:[{textContent:'No saved posts yet',closest:()=>null}]});
  assert.equal(fixture.api.endStatus(fixture.root,0),'empty');
  assert.equal(fixture.api.endStatus(fixture.root,1),null);
});
