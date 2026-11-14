import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeHttp, fromBase64, toBase64 } from '../src/native-http.js';

// A stand-in for Capacitor's HTTP plugin that records the options it was given.
function plugin(answer) {
  const seen = [];
  return { seen, CapacitorHttp: { request: async options => { seen.push(options); return typeof answer === 'function' ? answer(options) : answer; } } };
}
const decode = bytes => new TextDecoder().decode(bytes);

test('every request is made without following redirects, with a timeout, and asks for binary-safe answers', async () => {
  const { seen, CapacitorHttp } = plugin({ status: 200, headers: {}, data: '' });
  await createNativeHttp(CapacitorHttp)({ url: 'https://a.example/api/x', method: 'GET', headers: { Accept: 'application/json' } });
  assert.equal(seen[0].disableRedirects, true);
  assert.equal(seen[0].connectTimeout, 30_000);
  assert.equal(seen[0].responseType, 'blob');
  assert.equal(seen[0].webFetchExtra, undefined);
  assert.equal(seen[0].data, undefined);
});

test('a text body goes as it is; the native clients need a content type to send one', async () => {
  const { seen, CapacitorHttp } = plugin({ status: 200, headers: {}, data: '' });
  const http = createNativeHttp(CapacitorHttp);
  await http({ url: 'https://a.example/api/items', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":"é"}' });
  assert.equal(seen[0].data, '{"a":"é"}');
  assert.equal(seen[0].dataType, undefined);
  await http({ url: 'https://a.example/api/items', method: 'POST', headers: {}, body: 'plain' });
  assert.equal(seen[1].headers['Content-Type'], 'text/plain; charset=utf-8');
});

test('a binary body goes as base64 marked as a file, and survives the round trip', async () => {
  const { seen, CapacitorHttp } = plugin({ status: 200, headers: {}, data: '' });
  const payload = Uint8Array.from({ length: 70_000 }, (_, i) => i % 256);
  await createNativeHttp(CapacitorHttp)({ url: 'https://a.example/api/imports/file', method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: payload });
  assert.equal(seen[0].dataType, 'file');
  assert.deepEqual(fromBase64(seen[0].data), payload);
  assert.equal(seen[0].headers['Content-Type'], undefined, 'the caller\'s own header is not duplicated');
  const empty = plugin({ status: 200, headers: {}, data: '' });
  await createNativeHttp(empty.CapacitorHttp)({ url: 'https://a.example/x', method: 'POST', headers: {}, body: Uint8Array.of(1) });
  assert.equal(empty.seen[0].headers['Content-Type'], 'application/octet-stream');
  assert.equal(toBase64(new Uint8Array()), '');
});

test('answers: JSON arrives parsed and is turned back into bytes; other types arrive as base64; header names are lower case', async () => {
  const json = await createNativeHttp(plugin({ status: 200, headers: { 'Content-Type': 'application/json', 'X-Version': '1' }, data: { items: [1, 2], name: 'é' } }).CapacitorHttp)({ url: 'https://a.example/api/items' });
  assert.deepEqual(JSON.parse(decode(json.body)), { items: [1, 2], name: 'é' });
  assert.deepEqual(json.headers, { 'content-type': 'application/json', 'x-version': '1' });
  const image = await createNativeHttp(plugin({ status: 200, headers: { 'content-type': 'image/png' }, data: toBase64(Uint8Array.of(137, 80, 78, 71)) }).CapacitorHttp)({ url: 'https://a.example/api/assets/x' });
  assert.deepEqual([...image.body], [137, 80, 78, 71]);
  // Android breaks long base64 into lines.
  const wrapped = await createNativeHttp(plugin({ status: 200, headers: { 'content-type': 'text/csv' }, data: 'YWJj\nZGVm\n' }).CapacitorHttp)({ url: 'https://a.example/api/export' });
  assert.equal(decode(wrapped.body), 'abcdef');
});

test('an error page that is not JSON is text, not base64 (Android and iOS differ here), and an empty answer is empty', async () => {
  const proxy = await createNativeHttp(plugin({ status: 502, headers: { 'content-type': 'text/html' }, data: '<h1>Bad gateway</h1>' }).CapacitorHttp)({ url: 'https://a.example/api/items' });
  assert.equal(proxy.status, 502);
  assert.equal(decode(proxy.body), '<h1>Bad gateway</h1>');
  const none = await createNativeHttp(plugin({ status: 204, headers: {}, data: '' }).CapacitorHttp)({ url: 'https://a.example/api/items/x', method: 'DELETE' });
  assert.equal(none.status, 204);
  assert.equal(none.body.length, 0);
  const scalar = await createNativeHttp(plugin({ status: 200, headers: { 'content-type': 'application/json' }, data: 5 }).CapacitorHttp)({ url: 'https://a.example/api/x' });
  assert.equal(decode(scalar.body), '5');
  const redirect = await createNativeHttp(plugin({ status: 302, headers: { Location: 'https://evil.example/' }, data: '' }).CapacitorHttp)({ url: 'https://a.example/api/x' });
  assert.equal(redirect.status, 302, 'returned to the transport, which refuses it');
});

test('a native failure is passed up for the caller to report', async () => {
  await assert.rejects(createNativeHttp({ request: async () => { throw new Error('The Internet connection appears to be offline.'); } })({ url: 'https://a.example/x' }), /offline/);
});
