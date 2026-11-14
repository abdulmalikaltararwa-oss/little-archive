import test from 'node:test';
import assert from 'node:assert/strict';
import { createCredentials } from '../src/credentials.js';
import { createStore, memoryBackend } from '../src/store.js';

const SERVER = { kind: 'self-hosted', url: 'https://archive.example.com' };
const HOSTED = { kind: 'hosted', url: 'https://app.little-archive.example' };
const device = { type: 'device', token: 'lad_abc', id: '1', name: 'phone' };
const account = (extra = {}) => ({ type: 'supabase', accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: 10_000_000, userId: 'u', email: 'a@example.com', ...extra });

test('only a well-formed record is ever read or written', async () => {
  const backend = memoryBackend();
  const store = createStore(backend);
  assert.equal(await store.load(), null);
  await store.save({ v: 1, server: SERVER, credential: device });
  assert.deepEqual(await store.load(), { v: 1, server: SERVER, credential: device });
  for (const bad of [
    { v: 2, server: SERVER, credential: null },
    { v: 1, server: { kind: 'cloud', url: SERVER.url }, credential: null },
    { v: 1, server: { kind: 'self-hosted', url: 'https://archive.example.com/' }, credential: null },
    { v: 1, server: { kind: 'self-hosted', url: 'not a url' }, credential: null },
    { v: 1, server: SERVER, credential: { type: 'device', token: 'not-a-device-token' } },
    { v: 1, server: HOSTED, credential: device },
    { v: 1, server: SERVER, credential: account() },
    { v: 1, server: SERVER, credential: { type: 'password', password: 'hunter2' } },
    { v: 1, server: SERVER },
    null, 'text', 5,
  ]) {
    await assert.rejects(store.save(bad), /unreadable/, JSON.stringify(bad));
    await backend.set('session', bad);
    assert.equal(await store.load(), null, 'a record that does not fit is treated as signed out');
  }
});

test('signing out keeps the server and drops the credential; forgetting drops everything', async () => {
  const store = createStore(memoryBackend());
  await store.save({ v: 1, server: SERVER, credential: device });
  await store.signOut();
  assert.deepEqual(await store.load(), { v: 1, server: SERVER, credential: null });
  await store.forget();
  assert.equal(await store.load(), null);
  await store.signOut(); // nothing stored: still fine
  assert.equal(await store.load(), null);
});

test('a storage failure on read is signed out, never a crash', async () => {
  const store = createStore({ get: async () => { throw new Error('keychain locked'); }, set: async () => {}, remove: async () => {}, clear: async () => {} });
  assert.equal(await store.load(), null);
});

test('a device token is used as it is, never refreshed', async () => {
  const credentials = createCredentials({ record: { v: 1, server: SERVER, credential: device }, store: createStore(memoryBackend()) });
  assert.equal(await credentials.get(), 'lad_abc');
  assert.equal(await credentials.refresh('lad_abc'), null);
  assert.equal(credentials.deviceToken, 'lad_abc');
  assert.equal(credentials.accessToken, null);
});

function hosted({ expiresAt = 10_000_000, refresh, now = 5_000_000 } = {}) {
  const store = createStore(memoryBackend());
  const record = { v: 1, server: HOSTED, credential: account({ expiresAt }) };
  const calls = [];
  const supabase = { refresh: async token => { calls.push(token); return refresh(token, calls.length); } };
  return { credentials: createCredentials({ record, store, supabase, now: () => now }), store, record, calls };
}

test('a hosted token that is still good is used without a refresh', async () => {
  const { credentials, calls } = hosted({ refresh: async () => { throw new Error('must not be called'); } });
  assert.equal(await credentials.get(), 'access-1');
  assert.equal(calls.length, 0);
  assert.equal(credentials.email, 'a@example.com');
});

test('one that is about to expire is refreshed first, once, and the new tokens are stored before they are used', async () => {
  const { credentials, store, record, calls } = hosted({ expiresAt: 5_030_000, refresh: async () => account({ accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: 20_000_000 }) });
  await store.save(record);
  const results = await Promise.all([credentials.get(), credentials.get(), credentials.get()]);
  assert.deepEqual(results, ['access-2', 'access-2', 'access-2']);
  assert.deepEqual(calls, ['refresh-1'], 'concurrent requests share one exchange');
  assert.equal((await store.load()).credential.refreshToken, 'refresh-2');
});

test('after a 401 it is refreshed once; if another request already did that, nothing more is asked of the service', async () => {
  const { credentials, calls } = hosted({ refresh: async () => account({ accessToken: 'access-2', refreshToken: 'refresh-2' }) });
  assert.equal(await credentials.refresh('access-1'), 'access-2');
  assert.equal(await credentials.refresh('access-1'), 'access-2', 'the token that failed is already replaced');
  assert.equal(calls.length, 1);
});

test('a refresh token that is refused ends the session: the credential is gone from memory and from storage', async () => {
  const { credentials, store, record } = hosted({ expiresAt: 1, refresh: async () => null });
  await store.save(record);
  assert.equal(await credentials.get(), null);
  assert.equal(credentials.kind, null);
  assert.deepEqual(await store.load(), { ...record, credential: null });
});

test('failing to reach the service is an error, and the session is kept', async () => {
  const { credentials, store, record } = hosted({ expiresAt: 1, refresh: async () => { throw new Error('offline'); } });
  await store.save(record);
  await assert.rejects(credentials.get(), /offline/);
  assert.equal((await store.load()).credential.refreshToken, 'refresh-1');
});
