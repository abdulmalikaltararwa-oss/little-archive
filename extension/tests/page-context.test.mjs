import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {visibleCollectionName} from '../page-context.js';

const source='https://www.instagram.com/sample/saved/synthetic-name/1234567890123456/';
function heading(text,{hidden=false,insidePost=false,opacity='1'}={}) {
  return {textContent:text,parentElement:null,opacity,
    closest:()=>insidePost ? {} : null,
    getClientRects:()=>hidden ? [] : [{}],
  };
}
function read(headings,{url=source,login=false}={}) {
  const root={querySelectorAll:()=>headings};
  return vm.runInNewContext(`(${visibleCollectionName.toString()})(${JSON.stringify(source)})`,{
    URL,location:new URL(url),
    document:{querySelector:selector=>selector.includes('input[type="password"]') ? (login ? {} : null) : selector==='main' ? root : null},
    getComputedStyle:node=>({display:'block',visibility:'visible',opacity:node.opacity ?? '1'}),
  });
}

test('a single visible collection heading prefills its exact Unicode text',()=>{
  assert.equal(read([heading('Weekend ideas · أفكار 🌿')]),'Weekend ideas · أفكار 🌿');
});

test('ambiguous or absent headings leave collection naming to the user',()=>{
  assert.equal(read([heading('Saved'),heading('Weekend ideas')]),null);
  assert.equal(read([]),null);
  assert.equal(read([heading('x'.repeat(201))]),null);
});

test('hidden headings and headings inside saved cards cannot supply a collection name',()=>{
  assert.equal(read([heading('Hidden',{hidden:true}),heading('Post title',{insidePost:true}),heading('Transparent',{opacity:'0'})]),null);
  assert.equal(read([heading('Hidden',{hidden:true}),heading('Actual collection')]),'Actual collection');
});

test('navigation, origin changes and login prompts prevent heading capture',()=>{
  for (const options of [
    {url:'https://www.instagram.com/sample/saved/another/2234567890123456/'},
    {url:'https://instagram.com/sample/saved/synthetic-name/1234567890123456/'},
    {login:true},
  ]) assert.equal(read([heading('Do not use this')],options),null);
});
