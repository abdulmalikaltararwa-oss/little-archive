import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoAPI } from './demo-store.js';
import { SYNTHETIC_RECORDS } from './demo-data.js';

const call = async (api, path, method = 'GET', body) => {
  const response = await api(path, { method, body: body == null ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
};

test('demo starts with 15 synthetic fixtures and no real connections', async () => {
  const api = createDemoAPI(SYNTHETIC_RECORDS);
  const { data } = await call(api, '/api/stats');
  assert.equal(data.total, 15);
  assert.equal(data.favorites, 4);
  assert.equal(data.to_revisit, 3);
  assert.equal(data.needs_review, 2);
  assert.deepEqual(data.platforms, { instagram: 6, tiktok: 5, web: 4 });
  const settings = (await call(api, '/api/settings')).data;
  assert.equal(settings.remote_previews, false);
  assert.equal(settings.ai_enabled, false);
  assert.equal((await call(api, '/api/auth/me')).data.csrf_token, '');
});

test('search and intersecting filters return appropriate demo records', async () => {
  const api = createDemoAPI(SYNTHETIC_RECORDS);
  const { data } = await call(api, '/api/items?q=lemon&platform=tiktok&status=to_revisit');
  assert.equal(data.total, 1);
  assert.equal(data.items[0].title, 'The lemon pasta worth remembering');
  assert.equal((await call(api, '/api/items?q=lemon&platform=instagram')).data.total, 0);
});

test('notes and favorite changes are in-memory and reset with a fresh demo', async () => {
  const api = createDemoAPI(SYNTHETIC_RECORDS);
  const id = 'demo-item-1';
  const edit = await call(api, `/api/items/${id}`, 'PATCH', { notes: 'My temporary note', favorite: false });
  assert.equal(edit.data.notes, 'My temporary note');
  assert.equal(edit.data.favorite, false);
  assert.equal((await call(api, '/api/stats')).data.favorites, 3);
  const reset = createDemoAPI(SYNTHETIC_RECORDS);
  assert.notEqual((await call(reset, `/api/items/${id}`)).data.notes, 'My temporary note');
});

test('collection CRUD and membership counts behave consistently', async () => {
  const api = createDemoAPI(SYNTHETIC_RECORDS);
  const c = (await call(api, '/api/collections', 'POST', { name: 'My demo ideas', color: '#94a98b' })).data;
  await call(api, '/api/items/demo-item-1', 'PATCH', { collection_ids: [c.id] });
  assert.equal((await call(api, `/api/items?collection_id=${c.id}`)).data.total, 1);
  await call(api, `/api/collections/${c.id}`, 'PATCH', { name: 'Renamed ideas' });
  assert.equal((await call(api, '/api/items/demo-item-1')).data.collections[0].name, 'Renamed ideas');
  await call(api, `/api/collections/${c.id}`, 'DELETE');
  assert.equal((await call(api, '/api/items/demo-item-1')).data.collections.length, 0);
  assert.equal((await call(api, '/api/stats')).data.total, 15);
});

test('archive, bulk operations, delete, and reseed work without source access', async () => {
  const api = createDemoAPI(SYNTHETIC_RECORDS);
  await call(api, '/api/items/bulk', 'POST', { ids: ['demo-item-1', 'demo-item-2'], action: 'archive' });
  assert.equal((await call(api, '/api/items?status=archived')).data.total, 2);
  assert.equal((await call(api, '/api/stats')).data.total, 13);
  await call(api, '/api/items/demo-item-3', 'DELETE');
  assert.equal((await call(api, '/api/demo', 'POST')).data.created, 1);
});

test('unsupported real features fail clearly rather than returning simulated success', async () => {
  const api = createDemoAPI(SYNTHETIC_RECORDS);
  for (const [path, method] of [['/api/backup', 'GET'], ['/api/imports/file', 'POST'], ['/api/extension/tokens', 'POST'], ['/api/ai/jobs', 'POST'], ['/api/items/demo-item-1/thumbnail', 'POST']]) {
    const response = await call(api, path, method, {});
    assert.equal(response.status, 501, path);
    assert.match(response.data.detail, /isolated synthetic demo/);
    assert.equal(response.data.token, undefined);
  }
});

test('demo exports preserve in-memory changes and identify their synthetic origin', async () => {
  const api = createDemoAPI(SYNTHETIC_RECORDS);
  await call(api, '/api/items/demo-item-1', 'PATCH', { notes: 'Export this temporary edit' });
  const { data } = await call(api, '/api/export?format=json');
  assert.equal(data.demo, true);
  assert.equal(data.items.length, 15);
  assert.equal(data.items[0].notes, 'Export this temporary edit');
  assert.equal(data.sessions, undefined);
  assert.equal(data.tokens, undefined);
});

test('unsafe links and invalid fields cannot create executable demo content', async () => {
  const api = createDemoAPI(SYNTHETIC_RECORDS);
  assert.equal((await call(api, '/api/items', 'POST', { url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await call(api, '/api/items/demo-item-1', 'PATCH', { preview_url: 'https://external.example/tracker' })).status, 400);
  const addition = await call(api, '/api/items', 'POST', { url: 'https://example.com/my-demo', title: '<script>literal text</script>', notes: 'Temporary only', tags: ['design'] });
  assert.equal(addition.status, 200);
  assert.equal(addition.data.title, '<script>literal text</script>');
  assert.equal(addition.data.preview_url, null);
});
