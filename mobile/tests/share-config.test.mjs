import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SECRET_LOOKING, validateConfig } from '../src/config.js';
import { cleanShare, createShareInbox } from '../src/share.js';
import { parseSharedContent } from '../../web/utils.js';
import { CONFIG } from './helpers.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

function inbox(queue) {
  const listeners = {};
  const plugin = { take: async () => ({ items: queue.splice(0) }), addListener: (name, handler) => { listeners[`plugin:${name}`] = handler; } };
  const App = { addListener: (name, handler) => { listeners[`app:${name}`] = handler; } };
  return { listeners, share: createShareInbox({ plugin, App }) };
}

test('what the share sheet leaves is cut to plain strings; an empty share is nothing', () => {
  assert.deepEqual(cleanShare({ title: 'T', text: 'x', url: 'https://example.com' }), { title: 'T', text: 'x', url: 'https://example.com' });
  assert.deepEqual(cleanShare({ text: 5, title: { a: 1 }, url: 'https://example.com' }), { title: '', text: '', url: 'https://example.com' });
  assert.equal(cleanShare({ text: 'a'.repeat(30_000) }).text.length, 20_000);
  for (const nothing of [null, undefined, 'text', 5, {}, { title: '', text: '', url: '' }]) assert.equal(cleanShare(nothing), null);
});

test('a share made before the interface was ready is handed over once', async () => {
  const { share } = inbox([{ title: '', text: 'Look https://example.com/a', url: '' }, { title: 'Newer', text: '', url: 'https://example.com/b' }]);
  assert.deepEqual(await share.initial(), { title: 'Newer', text: '', url: 'https://example.com/b' });
  assert.equal(await share.initial(), null);
});

test('a share is only taken when something is there to show it, and then reaches the handler on resume, on the app link and on the plugin event', async () => {
  const queue = [];
  const { share, listeners } = inbox(queue);
  queue.push({ title: '', text: 'waiting https://example.com/w', url: '' });
  const seen = [];
  const stop = share.subscribe(item => seen.push(item.text));
  await tick();
  assert.deepEqual(seen, ['waiting https://example.com/w'], 'what was waiting is delivered as soon as the interface subscribes');
  queue.push({ title: '', text: 'second', url: '' });
  await listeners['app:resume']();
  queue.push({ title: '', text: 'third', url: '' });
  await listeners['app:appUrlOpen']();
  queue.push({ title: '', text: 'fourth', url: '' });
  await listeners['plugin:shareReceived']();
  assert.deepEqual(seen, ['waiting https://example.com/w', 'second', 'third', 'fourth']);
  stop();
  queue.push({ title: '', text: 'unseen', url: '' });
  await listeners['app:resume']();
  assert.equal(queue.length, 1, 'with no handler left the share stays in the inbox instead of being dropped');
});

test('a native failure while taking a share is quiet', async () => {
  const share = createShareInbox({ plugin: { take: async () => { throw new Error('boom'); }, addListener() {} }, App: { addListener() {} } });
  assert.equal(await share.initial(), null);
});

test('whatever arrives is parsed by the same function as a browser share, so hostile text stays text', () => {
  const hostile = cleanShare({ title: '<img src=x onerror=alert(1)>', text: 'javascript:alert(1) https://example.com/ok', url: 'javascript:alert(1)' });
  const parsed = parseSharedContent(hostile);
  assert.equal(parsed.url, 'https://example.com/ok');
  assert.equal(parsed.title, '<img src=x onerror=alert(1)>', 'kept only as text for a form field');
  assert.equal(parseSharedContent(cleanShare({ url: 'intent://scan/#Intent;scheme=zxing;end' })).url, '');
});

test('the shipped config is valid and holds only public values', () => {
  const shipped = JSON.parse(readFileSync(new URL('../app.config.json', import.meta.url), 'utf8'));
  const config = validateConfig(shipped);
  assert.equal(config.hostedServerUrl, 'https://app.little-archive.example');
  assert.match(config.supabasePublishableKey, /^sb_publishable_/);
  assert.deepEqual(Object.keys(shipped).sort(), ['hostedServerUrl', 'supabasePublishableKey', 'supabaseUrl']);
});

test('a config that holds a secret, an unknown setting or an unusable address is refused', () => {
  assert.deepEqual(validateConfig(CONFIG), { ...CONFIG });
  const refuse = (change, pattern) => assert.throws(() => validateConfig({ ...CONFIG, ...change }), pattern, JSON.stringify(change));
  refuse({ supabasePublishableKey: 'sb_secret_abcdefghijklmnopqrstuvwxyz' }, /secret|publishable/);
  refuse({ supabasePublishableKey: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2ln' }, /secret|publishable/);
  refuse({ serviceRoleKey: 'x' }, /unknown setting/);
  refuse({ hostedServerUrl: 'http://app.little-archive.example' }, /not encrypted/);
  refuse({ hostedServerUrl: 'not a url' }, /hostedServerUrl/);
  refuse({ supabaseUrl: 'ftp://x.supabase.co' }, /supabaseUrl/);
  refuse({ supabasePublishableKey: 'anon-key' }, /publishable/);
  assert.throws(() => validateConfig(null), /object/);
  assert.throws(() => validateConfig([]), /object/);
  // A development build may point at servers on this computer.
  assert.equal(validateConfig({ ...CONFIG, hostedServerUrl: 'http://localhost:8852', supabaseUrl: 'http://127.0.0.1:8853' }).supabaseUrl, 'http://127.0.0.1:8853');
});

test('the secret patterns catch what they should and do not match their own source', () => {
  for (const secret of ['sb_secret_0123456789abcdef', 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJl', '-----BEGIN PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----', 'sk-abcdefghijklmnopqrstuvwx']) assert.match(secret, SECRET_LOOKING);
  assert.doesNotMatch(SECRET_LOOKING.source, SECRET_LOOKING);
  assert.doesNotMatch('sb_publishable_6lzHvoN7XFEsMuYQ7BnkIg_Xk4H4PWw', SECRET_LOOKING);
});
