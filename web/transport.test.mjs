import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { apiUrl, cleanBaseUrl, createTransport, TransportError } from './transport.js';

const BASE = 'https://archive.example.com';
const HASH = 'a'.repeat(64);
const bytes = text => new TextEncoder().encode(text);
const json = (status, value, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: bytes(JSON.stringify(value)) });

// A native client that records what it was asked to send and answers from a script.
function fakeHttp(...replies) {
  const calls = [];
  const http = async request => {
    calls.push(request);
    const next = replies.length > 1 ? replies.shift() : replies[0];
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(request) : next;
  };
  return { http, calls };
}

function make({ replies = [json(200, { ok: true })], token = 'lad_secret-token', refresh, ...extra } = {}) {
  const client = fakeHttp(...replies);
  const credential = { get: async () => token, ...(refresh ? { refresh } : {}) };
  const transport = createTransport({ baseUrl: BASE, http: client.http, credential, ...extra });
  return { ...client, transport };
}

test('the server address is an origin and an optional prefix, nothing more', () => {
  assert.equal(cleanBaseUrl('https://archive.example.com/'), 'https://archive.example.com');
  assert.equal(cleanBaseUrl('https://archive.example.com/little/'), 'https://archive.example.com/little');
  assert.equal(cleanBaseUrl('http://localhost:8791'), 'http://localhost:8791');
  for (const bad of ['', 'archive.example.com', 'ftp://archive.example.com', 'https://user:pass@archive.example.com', 'https://archive.example.com/?x=1', 'https://archive.example.com/#top', 'javascript:alert(1)']) {
    assert.throws(() => cleanBaseUrl(bad), TransportError, bad);
  }
});

test('only absolute /api paths can be named, so the token cannot be sent anywhere else', () => {
  assert.equal(apiUrl(BASE, '/api/items?limit=60&q=a%20b'), `${BASE}/api/items?limit=60&q=a%20b`);
  assert.equal(apiUrl(`${BASE}/little`, '/api/health'), `${BASE}/little/api/health`);
  for (const bad of ['//evil.example/api/items', 'https://evil.example/api/items', '/apiary', '/api', '/api/../secret', '/api/%2e%2e/secret', '/api/.%2E/secret', '/api/./x', '/api/items#frag', '/api/\\evil', '/api/a\nb', '/api/a b', 'api/items', '', null, undefined, 42, '/api/ünï']) {
    assert.throws(() => apiUrl(BASE, bad), TransportError, JSON.stringify(bad));
  }
});

test('a request carries the bearer token, and the caller cannot supply or override credentials', async () => {
  const { transport, calls } = make();
  await transport.fetch('/api/items?limit=1', { headers: { Accept: 'application/json', Authorization: 'Bearer forged', cookie: 'a=b', Origin: 'https://evil.example', 'X-Test': '1' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE}/api/items?limit=1`);
  assert.equal(calls[0].method, 'GET');
  assert.deepEqual(calls[0].headers, { Accept: 'application/json', 'X-Test': '1', Authorization: 'Bearer lad_secret-token' });
});

test('the token never appears in a URL, a body or a header other than Authorization', async () => {
  const { transport, calls } = make();
  await transport.fetch('/api/items', { method: 'POST', body: JSON.stringify({ url: 'https://example.com' }), headers: { 'Content-Type': 'application/json' } });
  await transport.fetch('/api/items/abc');
  for (const call of calls) {
    assert.ok(!call.url.includes('lad_secret-token'));
    assert.ok(!String(call.body ?? '').includes('lad_secret-token'));
    assert.deepEqual(Object.entries(call.headers).filter(([, value]) => value.includes('lad_secret-token')).map(([name]) => name), ['Authorization']);
  }
});

test('bodies: JSON text, raw bytes and files are passed on; a body on GET is refused', async () => {
  const { transport, calls } = make();
  await transport.fetch('/api/items', { method: 'post', body: '{"a":1}', headers: { 'Content-Type': 'application/json' } });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body, '{"a":1}');
  await transport.fetch('/api/items/x/thumbnail', { method: 'POST', body: new Blob([Uint8Array.of(1, 2, 3)], { type: 'image/png' }), headers: { 'Content-Type': 'image/png' } });
  assert.ok(calls[1].body instanceof Uint8Array);
  assert.deepEqual([...calls[1].body], [1, 2, 3]);
  await assert.rejects(transport.fetch('/api/items', { method: 'GET', body: 'x' }), TransportError);
  await assert.rejects(transport.fetch('/api/items', { method: 'POST', body: new FormData() }), TransportError);
  assert.equal(calls.length, 2);
});

test('the answer is a real Response with the status, headers and body the server sent', async () => {
  const { transport } = make({ replies: [json(200, { items: [1, 2] }, { 'content-length': '999', 'content-encoding': 'gzip', 'set-cookie': 'x=1', 'x-version': '7' })] });
  const response = await transport.fetch('/api/items');
  assert.ok(response instanceof Response);
  assert.equal(response.status, 200);
  assert.equal(response.ok, true);
  assert.equal(response.headers.get('x-version'), '7');
  assert.equal(response.headers.get('content-encoding'), null, 'headers describing the encoded form are dropped');
  assert.equal(response.headers.get('set-cookie'), null, 'a cookie is never kept');
  assert.deepEqual(await response.json(), { items: [1, 2] });
  const error = make({ replies: [json(409, { detail: 'That change conflicts.' })] });
  const conflict = await error.transport.fetch('/api/items');
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).detail, 'That change conflicts.');
  const empty = make({ replies: [{ status: 204, headers: {}, body: new Uint8Array() }] });
  assert.equal((await empty.transport.fetch('/api/items/x', { method: 'DELETE' })).status, 204);
});

test('a redirect is not followed and the token is not sent a second time', async () => {
  const { transport, calls } = make({ replies: [{ status: 302, headers: { location: 'https://evil.example/api/items' }, body: new Uint8Array() }] });
  const response = await transport.fetch('/api/items');
  assert.equal(response.status, 502);
  assert.match((await response.json()).detail, /redirected/);
  assert.equal(calls.length, 1);
});

test('a refused token is refreshed once and the request is retried with the new one', async () => {
  const seen = [];
  const { transport, calls } = make({ token: 'old', replies: [json(401, { detail: 'no' }), json(200, { ok: true })], refresh: async () => { seen.push('refresh'); return 'new'; } });
  const response = await transport.fetch('/api/items');
  assert.equal(response.status, 200);
  assert.deepEqual(seen, ['refresh']);
  assert.deepEqual(calls.map(call => call.headers.Authorization), ['Bearer old', 'Bearer new']);
});

test('a token that stays refused is answered with the 401, and the refresh does not loop', async () => {
  let refreshes = 0;
  const { transport, calls } = make({ token: 'old', replies: [json(401, { detail: 'no' })], refresh: async () => { refreshes += 1; return 'new'; } });
  const response = await transport.fetch('/api/items');
  assert.equal(response.status, 401);
  assert.equal(refreshes, 1);
  assert.equal(calls.length, 2);
  // The same token coming back from a refresh is not worth a second try.
  const same = make({ token: 'same', replies: [json(401, {})], refresh: async () => 'same' });
  await same.transport.fetch('/api/items');
  assert.equal(same.calls.length, 1);
  // Without a refresh (a self-hosted device token) a 401 is simply reported.
  const device = make({ replies: [json(401, {})] });
  assert.equal((await device.transport.fetch('/api/items')).status, 401);
  assert.equal(device.calls.length, 1);
});

test('with no token nothing is sent: the answer is a 401', async () => {
  const { transport, calls } = make({ token: null });
  const response = await transport.fetch('/api/items');
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test('a network failure, or a failure to refresh the token, is a TypeError like fetch gives; a caller that gave up gets AbortError', async () => {
  const down = make({ replies: [new Error('offline')] });
  await assert.rejects(down.transport.fetch('/api/items'), error => error instanceof TypeError && error.cause?.message === 'offline');
  const unrefreshable = createTransport({ baseUrl: BASE, http: fakeHttp(json(200, {})).http, credential: { get: async () => { throw new Error('refresh failed'); } } });
  await assert.rejects(unrefreshable.fetch('/api/items'), TypeError);
  const controller = new AbortController();
  controller.abort();
  const { transport, calls } = make();
  await assert.rejects(transport.fetch('/api/items', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.length, 0);
  const late = new AbortController();
  const slow = make({ replies: [() => new Promise(resolve => setTimeout(() => resolve(json(200, {})), 30))] });
  const pending = slow.transport.fetch('/api/items', { signal: late.signal });
  late.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('only a stored thumbnail path is treated as a local thumbnail', () => {
  const { transport } = make();
  assert.equal(transport.localAsset(`/api/assets/${HASH}`), `/api/assets/${HASH}`);
  for (const bad of [`https://evil.example/api/assets/${HASH}`, `//evil.example/api/assets/${HASH}`, `/api/assets/${HASH}?x=1`, '/api/assets/short', `/api/assets/${HASH.toUpperCase()}`, '/api/items/1', null, undefined, 7]) assert.equal(transport.localAsset(bad), null, String(bad));
});

test('thumbnails are fetched with the token, checked to be PNG, cached, and revoked when evicted', async () => {
  const made = [];
  const revoked = [];
  const png = { status: 200, headers: { 'content-type': 'image/png' }, body: Uint8Array.of(137, 80, 78, 71) };
  const { transport, calls } = make({ replies: [png], maxImages: 2, createObjectURL: blob => { assert.equal(blob.type, 'image/png'); made.push(blob); return `blob:test/${made.length}`; }, revokeObjectURL: url => revoked.push(url) });
  const path = n => `/api/assets/${String(n).repeat(64)}`;
  assert.equal(await transport.blobUrl(path(1)), 'blob:test/1');
  assert.equal(await transport.blobUrl(path(1)), 'blob:test/1');
  assert.equal(calls.length, 1, 'a second look is served from the cache');
  assert.equal(calls[0].headers.Authorization, 'Bearer lad_secret-token');
  await transport.blobUrl(path(2));
  await transport.blobUrl(path(3));
  assert.deepEqual(revoked, ['blob:test/1'], 'the least recently used one is released');
  await assert.rejects(transport.blobUrl('/api/items/1'), TransportError);
  await assert.rejects(transport.blobUrl(`https://evil.example/api/assets/${HASH}`), TransportError);
});

test('a thumbnail that is not a PNG, or is missing, raises the image error event so the text cover shows', async () => {
  for (const reply of [json(404, { detail: 'Thumbnail not found.' }), { status: 200, headers: { 'content-type': 'text/html' }, body: bytes('<script>') }]) {
    const { transport } = make({ replies: [reply], observe: (image, show) => show() });
    const image = new EventTarget();
    let failed = false;
    image.addEventListener('error', () => { failed = true; });
    transport.attachImage(image, `/api/assets/${HASH}`);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(failed, true);
    assert.equal(image.src, undefined);
  }
});

test('a thumbnail is fetched only when its image comes near the screen', async () => {
  const png = { status: 200, headers: { 'content-type': 'image/png' }, body: Uint8Array.of(137, 80, 78, 71) };
  const queue = [];
  const { transport, calls } = make({ replies: [png], observe: (image, show) => queue.push(show), createObjectURL: () => 'blob:test/ready' });
  const image = new EventTarget();
  transport.attachImage(image, `/api/assets/${HASH}`);
  assert.equal(calls.length, 0);
  queue[0]();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(image.src, 'blob:test/ready');
});

test('at most a few thumbnails are fetched at once', async () => {
  let running = 0;
  let peak = 0;
  const { transport } = make({ imageConcurrency: 2, replies: [async () => { running += 1; peak = Math.max(peak, running); await new Promise(resolve => setTimeout(resolve, 5)); running -= 1; return { status: 200, headers: { 'content-type': 'image/png' }, body: Uint8Array.of(1) }; }], createObjectURL: () => 'blob:x' });
  await Promise.all([1, 2, 3, 4, 5, 6].map(n => transport.blobUrl(`/api/assets/${String(n).repeat(64)}`)));
  assert.equal(peak, 2);
});

test('app.js reaches the transport only through the global the app shell sets, and imports nothing the public demo does not ship', () => {
  const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const demoFiles = readFileSync(new URL('../scripts/build_demo.py', import.meta.url), 'utf8').match(/files = \[(.*?)\]/s)[1].match(/"([^"]+)"/g).map(name => name.slice(1, -1));
  const imports = [...app.matchAll(/(?:^|\n)import\s[^;]*?from\s+'\.\/([^']+)'/g)].map(match => match[1]);
  assert.ok(imports.length > 0);
  for (const name of imports) assert.ok(demoFiles.includes(name), `${name} is not in the demo allowlist`);
  assert.doesNotMatch(app, /from '\.\/transport\.js'|import\(.\.\/transport/);
  // With no app shell the page's own fetch is used, as before.
  assert.match(app, /native \? native\.fetch\(`\/api\$\{path\}`, options\) : fetch\(`\/api\$\{path\}`, options\)/);
  assert.match(app, /globalThis\.__littleArchiveNative \|\| null/);
});
