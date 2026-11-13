import test from 'node:test';
import assert from 'node:assert/strict';
import { safeURL, parseTags, buildItemPatch, itemChangeAffectsView, formatDate, hostLabel, countLabel, createQuery, libraryScope, stableHue } from './utils.js';

test('untrusted links reject executable protocols and embedded credentials', () => {
  assert.equal(safeURL('javascript:alert(1)'), null);
  assert.equal(safeURL('data:text/html,hello'), null);
  assert.equal(safeURL('file:///private/data'), null);
  assert.equal(safeURL('https://user:password@example.com'), null);
  assert.equal(safeURL('https://example.com/path?q=1'), 'https://example.com/path?q=1');
  assert.equal(safeURL('not a URL'), null);
});

test('local asset links must resolve to the current origin', () => {
  assert.equal(safeURL('/assets/preview.png', { local: true }), 'http://localhost/assets/preview.png');
  assert.equal(safeURL('https://other.example/preview.png', { local: true }), null);
});

test('topic parsing preserves multilingual labels and removes duplicates', () => {
  assert.deepEqual(parseTags('design, طبخ, design, , Weekend ideas'), ['design', 'طبخ', 'Weekend ideas']);
  assert.throws(() => parseTags(Array.from({ length: 60 }, (_, n) => `topic-${n}`).join(',')), /50 topics/);
  assert.throws(() => parseTags('x'.repeat(81)), /80 characters/);
});

test('saving notes does not mark unchanged source title and summary as manual', () => {
  const item = { title: 'Imported title', summary: '', notes: '', tags: ['design'], status: 'inbox', needs_review: true, collections: [{ id: 'source', kind: 'source' }, { id: 'local', kind: 'local' }] };
  const edits = { title: item.title, summary: '', notes: 'Try this later', tags: ['design'], status: 'inbox', needs_review: true, collection_ids: ['local'] };
  assert.deepEqual(buildItemPatch(item, edits), { notes: 'Try this later' });
  assert.deepEqual(buildItemPatch(item, { title: 'My title', collection_ids: [] }), { title: 'My title', collection_ids: [] });
  assert.deepEqual(buildItemPatch(item, { title: item.title, notes: '', tags: ['design'] }), {});
});

test('filter query preserves combined constraints and omits empty fields', () => {
  const query = new URLSearchParams(createQuery({ q: 'طعام & design', platform: 'instagram', favorite: true, needs_review: false, collection_id: '', sort: 'recent' }, 60));
  assert.equal(query.get('q'), 'طعام & design');
  assert.equal(query.get('favorite'), 'true');
  assert.equal(query.get('offset'), '60');
  assert.equal(query.has('needs_review'), false);
  assert.equal(query.has('collection_id'), false);
});

test('ordinary annotation updates retain loaded pages and a Rediscover sample', () => {
  const before = { title: 'An idea', notes: '', tags: ['design'], status: 'inbox', favorite: false, needs_review: true };
  for (const sort of ['recent', 'oldest', 'random']) {
    assert.equal(itemChangeAffectsView(before, { ...before, title: 'A named idea', notes: 'Try this', favorite: true, status: 'done', needs_review: false }, { sort }), false, sort);
  }
  assert.equal(itemChangeAffectsView(before, { ...before, favorite: true }, { q: 'idea', sort: 'random' }), false);
  assert.equal(itemChangeAffectsView(before, { ...before, thumbnail_url: '/assets/new.png' }, { q: 'idea', sort: 'title' }), false);
});

test('edits affecting membership or title ordering require authoritative results', () => {
  const before = { title: 'An idea', notes: '', tags: ['design', 'weekend'], status: 'inbox', favorite: true, needs_review: true, collections: [{ id: 'saved', kind: 'local' }] };
  assert.equal(itemChangeAffectsView(before, { ...before, favorite: false }, { favorite: true }), true);
  assert.equal(itemChangeAffectsView(before, { ...before, needs_review: false }, { needs_review: true }), true);
  assert.equal(itemChangeAffectsView(before, { ...before, title: 'Zebra' }, { sort: 'title' }), true);
  assert.equal(itemChangeAffectsView(before, { ...before, status: 'archived' }, {}), true);
  assert.equal(itemChangeAffectsView(before, { ...before, status: 'done' }, { status: 'inbox' }), true);
  assert.equal(itemChangeAffectsView(before, { ...before, tags: ['weekend'] }, { tag: 'design' }), true);
  assert.equal(itemChangeAffectsView(before, { ...before, tags: ['design'] }, { tag: 'design' }), false);
  assert.equal(itemChangeAffectsView(before, { ...before, collections: [] }, { collection_id: 'saved' }), true);
  assert.equal(itemChangeAffectsView(before, { ...before, collections: [...before.collections, { id: 'other', kind: 'local' }] }, { collection_id: 'saved' }), false);
});

test('search changes defer to the server rather than approximating FTS in the UI', () => {
  const before = { title: 'أفكار', notes: 'A fresh start', tags: ['design'], summary: 'A saved idea' };
  for (const [field, value] of Object.entries({ title: 'Another title', notes: '', summary: '', tags: [] })) {
    assert.equal(itemChangeAffectsView(before, { ...before, [field]: value }, { q: 'أفكار start', sort: 'recent' }), true, field);
  }
});

test('unknown dates are not replaced by current dates', () => {
  assert.equal(formatDate(null), 'Unknown');
  assert.equal(formatDate('bad date'), 'Unknown');
  assert.notEqual(formatDate('2026-01-01T12:00:00Z'), 'Unknown');
});

test('whole-library operations preserve filter scope without pagination or sorting', () => {
  const view = { q: 'weekend', platform: 'instagram', collection_id: 'original', tag: 'design', status: '', favorite: true, needs_review: false, sort: 'random', limit: 60, offset: 120 };
  assert.deepEqual(libraryScope(view, 'all'), {});
  assert.deepEqual(libraryScope(view, 'review'), { needs_review: true });
  assert.deepEqual(libraryScope(view, 'view'), { q: 'weekend', platform: 'instagram', collection_id: 'original', tag: 'design', favorite: true });
  assert.deepEqual(libraryScope({ status: 'archived' }, 'view'), { status: 'archived' });
  assert.throws(() => libraryScope(view, 'invalid'), /scope/);
});

test('display helpers are deterministic and do not expose malformed URLs', () => {
  assert.equal(hostLabel('https://www.example.com/a'), 'example.com');
  assert.equal(hostLabel('javascript:alert(1)'), 'Saved link');
  assert.equal(countLabel(1, 'save'), '1 save');
  assert.equal(countLabel(2, 'save'), '2 saves');
  assert.equal(stableHue('a title'), stableHue('a title'));
  assert.ok(stableHue('another title') >= 0 && stableHue('another title') < 6);
});
