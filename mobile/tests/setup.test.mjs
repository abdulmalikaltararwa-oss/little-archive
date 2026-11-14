import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/discovery.js';
import { createStore, memoryBackend } from '../src/store.js';
import { deviceName, hostedAddress, hostedClient, serverRecord, signInSelfHosted } from '../src/setup.js';
import { CONFIG, fakeHttp, reply, text } from './helpers.mjs';

const ADDRESS = 'https://archive.example.com';
const ROUTE = `POST ${ADDRESS}/api/auth/devices`;
const PASSWORD = 'correct horse battery staple';

async function failure(promise) {
  try { await promise; } catch (error) { assert.ok(error instanceof AppError, String(error)); return error; }
  assert.fail('expected an AppError');
}

test('the owner password is sent once, to this server, and only the device token comes back out', async () => {
  const { http, calls } = fakeHttp({ [ROUTE]: reply(200, { id: 'd1', name: 'Little Archive app (iPhone or iPad)', token: 'lad_secret-token', created_at: 'now' }) });
  const credential = await signInSelfHosted({ http, address: ADDRESS, password: PASSWORD, deviceName: deviceName('ios') });
  assert.deepEqual(credential, { type: 'device', token: 'lad_secret-token', id: 'd1', name: 'Little Archive app (iPhone or iPad)' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${ADDRESS}/api/auth/devices`);
  assert.deepEqual(JSON.parse(calls[0].body), { password: PASSWORD, name: 'Little Archive app (iPhone or iPad)' });
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.ok(!JSON.stringify(credential).includes(PASSWORD));
});

test('the password is not in what gets stored: only the device token and its labels', async () => {
  const backend = memoryBackend();
  const store = createStore(backend);
  const { http } = fakeHttp({ [ROUTE]: reply(200, { id: 'd1', name: 'phone', token: 'lad_secret-token' }) });
  const credential = await signInSelfHosted({ http, address: ADDRESS, password: PASSWORD, deviceName: 'phone' });
  await store.save(serverRecord({ mode: 'self-hosted', url: ADDRESS }, credential));
  assert.ok(!JSON.stringify(await backend.get('session')).includes(PASSWORD));
  assert.deepEqual(Object.keys((await store.load()).credential).sort(), ['id', 'name', 'token', 'type']);
});

test('each answer the server can give is explained, and a wrong password stays on the password field', async () => {
  const run = answer => failure(signInSelfHosted({ http: fakeHttp({ [ROUTE]: answer }).http, address: ADDRESS, password: PASSWORD, deviceName: 'phone' }));
  const wrong = await run(reply(401, { detail: 'That password did not match.' }));
  assert.equal(wrong.field, 'password');
  assert.match(wrong.message, /did not match/);
  assert.match((await run(reply(429, {}))).message, /Wait 15 minutes/);
  assert.match((await run(reply(404, {}))).message, /Little Archive account/);
  assert.match((await run(reply(400, { detail: 'Revoke an unused device before adding another (20-device limit).' }))).message, /20-device limit/);
  assert.match((await run(reply(200, { token: 'not-a-device-token' }))).message, /did not accept/);
  assert.match((await run(text(502, 'bad gateway'))).message, /did not accept/);
  assert.match((await run(new Error('offline'))).message, /Could not reach archive\.example\.com/);
  const empty = await failure(signInSelfHosted({ http: fakeHttp({}).http, address: ADDRESS, password: '', deviceName: 'phone' }));
  assert.equal(empty.field, 'password');
});

test('the device name is short, readable, and fits the server limit', () => {
  assert.equal(deviceName('ios'), 'Little Archive app (iPhone or iPad)');
  assert.equal(deviceName('android'), 'Little Archive app (Android)');
  assert.ok(deviceName('some-new-platform').length < 100);
});

test('the hosted service address and its sign-in client come from the config alone', () => {
  assert.equal(hostedAddress(CONFIG), 'https://app.little-archive.example');
  assert.throws(() => hostedAddress({ ...CONFIG, hostedServerUrl: 'http://app.little-archive.example' }), /not encrypted/);
  assert.ok(hostedClient({ http: fakeHttp({}).http, config: CONFIG }).signIn);
  assert.deepEqual(serverRecord({ mode: 'hosted', url: 'https://app.little-archive.example/' }, null), { v: 1, server: { kind: 'hosted', url: 'https://app.little-archive.example' }, credential: null });
});
