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
  const HOME = CONFIG.hostedServerUrl;
  const good = fakeHttp({ [`${HOME}/api/discovery`]: reply(200, hostedInfo()) });
  assert.deepEqual(await discover(good.http, HOME, CONFIG), { mode: 'hosted', url: HOME, version: '0.1.0', supabaseUrl: CONFIG.supabaseUrl });
  // The same project written with a trailing slash is the same project.
  assert.equal((await discover(fakeHttp({ [`${HOME}/api/discovery`]: reply(200, hostedInfo(`${CONFIG.supabaseUrl}/`)) }).http, HOME, CONFIG)).mode, 'hosted');
  for (const other of ['https://evil.example', 'https://abcdefgh.supabase.co.evil.example', 'http://abcdefgh.supabase.co', 'https://other.supabase.co', '', null]) {
    const message = await failure(discover(fakeHttp({ [URL]: reply(200, hostedInfo(other)) }).http, ADDRESS, CONFIG));
    assert.match(message, /does not trust/, String(other));
  }
  const missing = { ...hostedInfo(), auth: {} };
  assert.match(await failure(discover(fakeHttp({ [URL]: reply(200, missing) }).http, ADDRESS, CONFIG)), /does not trust/);
});

test('a hosted server is accepted only at the address this build was made for, however rightly it names the sign-in service', async () => {
  // Anyone can run a server that names the real sign-in service. Signing in there would hand that server a token that is good
  // at the real one.
  const elsewhere = ['https://archive.example.com', 'https://evil.example', `${CONFIG.hostedServerUrl}.evil.example`, CONFIG.hostedServerUrl.replace('https://app.', 'https://www.'), `${CONFIG.hostedServerUrl}/other`, `${CONFIG.hostedServerUrl}:8443`];
  for (const address of elsewhere) {
    const { http, calls } = fakeHttp({ [`${address}/api/discovery`]: reply(200, hostedInfo()) });
    let refusal;
    try { await discover(http, address, CONFIG); } catch (error) { refusal = error; }
    assert.ok(refusal instanceof AppError, address);
    assert.equal(refusal.code, 'other-hosted', address);
    assert.equal(refusal.field, 'server');
    assert.match(refusal.message, /not the one this app was built for/, address);
    assert.equal(calls.length, 1);
  }
  // A build made for another service (staging, with LA_APP_CONFIG) accepts that one, and not production.
  const staging = { ...CONFIG, hostedServerUrl: 'https://staging.little-archive.example' };
  const at = address => discover(fakeHttp({ [`${address}/api/discovery`]: reply(200, hostedInfo()) }).http, address, staging);
  assert.equal((await at('https://staging.little-archive.example')).mode, 'hosted');
  assert.match(await failure(at(CONFIG.hostedServerUrl)), /not the one this app was built for/);
  // A config with no usable address accepts no hosted server at all.
  assert.match(await failure(discover(fakeHttp({ [URL]: reply(200, hostedInfo()) }).http, ADDRESS, { ...CONFIG, hostedServerUrl: undefined })), /not the one this app was built for/);
  // Self-hosted servers are untouched by this: they are anywhere.
  assert.equal((await discover(fakeHttp({ [URL]: reply(200, selfHostedInfo) }).http, ADDRESS, CONFIG)).mode, 'self-hosted');
});

test('every way this can go wrong is explained in words, naming the server', async () => {
  const cases = [
    [new Error('offline'), /Could not reach archive\.example\.com/],
    [reply(404, { detail: 'Not Found' }), /does not look like a Little Archive server/],
    [text(400, 'Invalid host header'), /LA_PUBLIC_URL/],
    [reply(401, {}), /blocking the app/],
    [reply(403, {}), /blocking the app/],
    [reply(500, {}), /answered with an error \(500\)/],
    [reply(301, {}, { location: 'https://archive.example.com/' }), /does not follow redirects/],
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

test('for a server someone typed, the common failures are said in setup words, each on the address field', async () => {
  const typed = async (input, answer) => {
    const address = /^https?:/.test(input) ? input : `http://${input}`;
    try { await checkServer({ http: fakeHttp({ [`${address}/api/discovery`]: answer }).http, config: CONFIG, input }); } catch (error) { assert.ok(error instanceof AppError, String(error)); assert.equal(error.field, 'server'); return error; }
    assert.fail('expected an AppError');
  };
  // Not https: nothing is sent, and the sentence points at the guide that the screen links.
  const plain = await typed('http://192.168.1.20:8787', new Error('never asked'));
  assert.match(plain.message, /not encrypted/);
  assert.match(plain.message, /self-hosting guide/);
  assert.equal(plain.code, 'not-encrypted');
  // Cannot reach it: the address, the server, the network, the certificate.
  const away = await typed(ADDRESS, new Error('offline'));
  assert.match(away.message, /^Could not reach archive\.example\.com\. /);
  assert.match(away.message, /server is running/);
  assert.match(away.message, /its own Wi-Fi/);
  assert.match(away.message, /certificate/);
  // localhost typed on a phone is the phone.
  assert.match((await typed('localhost:8787', new Error('refused'))).message, /that address is the phone itself/);
  // Something answered that is not Little Archive: a 404, another site's page, another product's JSON.
  for (const answer of [reply(404, { detail: 'Not Found' }), text(200, '<html>router</html>'), reply(200, { name: 'something-else' })]) {
    const other = await typed(ADDRESS, answer);
    assert.match(other.message, /answered, but not as a Little Archive server/);
    assert.match(other.message, /port/);
  }
  // A hosted-mode server that names a sign-in service the app was not built for.
  const hosted = await typed(ADDRESS, reply(200, hostedInfo('https://other.supabase.co')));
  assert.match(hosted.message, /runs in hosted mode/);
  assert.match(hosted.message, /does not trust/);
  assert.match(hosted.message, /self-hosted mode/);
  // A hosted-mode server that names the right sign-in service but is not the service this app was built for.
  const other = await typed(ADDRESS, reply(200, hostedInfo()));
  assert.equal(other.code, 'other-hosted');
  assert.equal(other.message, 'archive.example.com is a hosted Little Archive service, but not the one this app was built for, so the app will not sign you in there or send it anything of your account. For a Little Archive account, go back and choose "Little Archive account". A server of your own has to run in self-hosted mode to work with this app.');
  // Everything else keeps the sentence discovery wrote.
  assert.match((await typed(ADDRESS, text(400, 'Invalid host header'))).message, /LA_PUBLIC_URL/);
  assert.match((await typed(ADDRESS, reply(302, {}))).message, /does not follow redirects/);
});

test('the hosted service keeps its own plain sentences: no talk of Wi-Fi or certificates on that path', async () => {
  const message = await failure(discover(fakeHttp({ [URL]: new Error('offline') }).http, ADDRESS, CONFIG));
  assert.equal(message, 'Could not reach archive.example.com. Check the address and your connection.');
});
