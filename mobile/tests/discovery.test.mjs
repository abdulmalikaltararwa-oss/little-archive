import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError, discover } from '../src/discovery.js';
import { checkServer } from '../src/setup.js';
import { CONFIG, bytes, fakeHttp, hostedInfo, reply, selfHostedInfo, text } from './helpers.mjs';

const ADDRESS = 'https://archive.example.com';
const URL = `${ADDRESS}/api/discovery`;

async function failure(promise) {
  try { await promise; } catch (error) { assert.ok(error instanceof AppError, String(error)); return error.message; }
  assert.fail('expected an AppError');
}

test('a self-hosted server is recognised, asked without credentials, and reported with its mode', async () => {
  const { http, calls } = fakeHttp({ [URL]: reply(200, selfHostedInfo) });
  assert.deepEqual(await discover(http, ADDRESS, CONFIG), { mode: 'self-hosted', url: ADDRESS, version: '0.1.0' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.deepEqual(Object.keys(calls[0].headers), ['Accept'], 'no credential goes to a server that has not said what it is');
});

test('a hosted server is accepted only when it names the one sign-in service this app trusts', async () => {
  const good = fakeHttp({ [URL]: reply(200, hostedInfo()) });
  assert.deepEqual(await discover(good.http, ADDRESS, CONFIG), { mode: 'hosted', url: ADDRESS, version: '0.1.0', supabaseUrl: CONFIG.supabaseUrl });
  // The same project written with a trailing slash is the same project.
  assert.equal((await discover(fakeHttp({ [URL]: reply(200, hostedInfo(`${CONFIG.supabaseUrl}/`)) }).http, ADDRESS, CONFIG)).mode, 'hosted');
  for (const other of ['https://evil.example', 'https://abcdefgh.supabase.co.evil.example', 'http://abcdefgh.supabase.co', 'https://other.supabase.co', '', null]) {
    const message = await failure(discover(fakeHttp({ [URL]: reply(200, hostedInfo(other)) }).http, ADDRESS, CONFIG));
    assert.match(message, /does not trust/, String(other));
  }
  const missing = { ...hostedInfo(), auth: {} };
  assert.match(await failure(discover(fakeHttp({ [URL]: reply(200, missing) }).http, ADDRESS, CONFIG)), /does not trust/);
});

test('every way this can go wrong is explained in words, naming the server', async () => {
  const cases = [
    [new Error('offline'), /Could not reach archive\.example\.com/],
    [reply(404, { detail: 'Not Found' }), /does not look like a Little Archive server/],
    [text(400, 'Invalid host header'), /LA_PUBLIC_URL/],
    [reply(401, {}), /blocking the app/],
    [reply(403, {}), /blocking the app/],
    [reply(500, {}), /answered with an error \(500\)/],
    [text(200, '<html>hello</html>'), /not a Little Archive server/],
    [reply(200, { name: 'something-else' }), /not a Little Archive server/],
    [reply(200, [1, 2]), /not a Little Archive server/],
    [reply(200, { ...selfHostedInfo, api: 2 }), /does not understand/],
    [reply(200, { ...selfHostedInfo, mode: 'cloud' }), /does not know/],
    [reply(200, { ...selfHostedInfo, auth: { methods: ['password-session'] } }), /does not offer sign-in for the app/],
    [reply(200, { ...selfHostedInfo, auth: { methods: ['device-token'], device_token_url: 'https://evil.example/token' } }), /does not offer sign-in for the app/],
  ];
  for (const [answer, pattern] of cases) assert.match(await failure(discover(fakeHttp({ [URL]: answer }).http, ADDRESS, CONFIG)), pattern);
});

test('checkServer validates the typed address before anything is sent', async () => {
  const { http, calls } = fakeHttp({});
  assert.match(await failure(checkServer({ http, config: CONFIG, input: 'http://archive.example.com' })), /not encrypted/);
  assert.match(await failure(checkServer({ http, config: CONFIG, input: 'ftp://x' })), /http:\/\/ or https:\/\//);
  assert.equal(calls.length, 0);
  const found = await checkServer({ http: fakeHttp({ 'http://localhost:8787/api/discovery': reply(200, selfHostedInfo) }).http, config: CONFIG, input: 'localhost:8787' });
  assert.deepEqual(found, { mode: 'self-hosted', url: 'http://localhost:8787', version: '0.1.0', insecure: true });
  assert.ok(bytes);
});
