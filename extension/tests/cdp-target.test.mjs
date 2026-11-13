import test from 'node:test';
import assert from 'node:assert/strict';
import {tabTargetForPage} from './e2e/target-selection.mjs';

test('the extension action receives the parent tab target rather than the page target',()=>{
  const page={targetId:'page-1',type:'page',parentId:'tab-1',url:'https://synthetic.test/saved',browserContextId:'isolated'};
  const tab={targetId:'tab-1',type:'tab',url:page.url,browserContextId:'isolated'};
  assert.equal(tabTargetForPage(page,[page,tab]).targetId,'tab-1');
});

test('the tab fallback requires one exact URL match within the same isolated context',()=>{
  const page={targetId:'page-1',type:'page',url:'https://synthetic.test/saved',browserContextId:'isolated'};
  const tab={targetId:'tab-1',type:'tab',url:page.url,browserContextId:'isolated'};
  const other={...tab,targetId:'tab-other',browserContextId:'another-context'};
  assert.equal(tabTargetForPage(page,[other,tab]).targetId,'tab-1');
  assert.throws(()=>tabTargetForPage(page,[tab,{...tab,targetId:'ambiguous-tab'}]),/unambiguously/);
  assert.throws(()=>tabTargetForPage(page,[page,other]),/unambiguously/);
});
