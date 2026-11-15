import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AppError } from '../src/discovery.js';
import { createCredentials } from '../src/credentials.js';
import { createStore, memoryBackend } from '../src/store.js';
import { createSupabase, sessionFrom } from '../src/supabase.js';
import { CALLBACK_URL, INTERRUPTED, createSocialSignIn, interruptedSignIn, parseCallback } from '../src/social.js';
import { CONFIG, bytes, fakeHttp, fakeJwt, reply } from './helpers.mjs';

const BASE = CONFIG.supabaseUrl;
const NOW = 1_800_000_000_000;
const USER = '0d0f6c1e-62f1-4a35-a0b8-1d7a1a6d8b11';
const SETTINGS = `${BASE}/auth/v1/settings`;
const PKCE = `POST ${BASE}/auth/v1/token?grant_type=pkce`;
const ID_TOKEN = `POST ${BASE}/auth/v1/token?grant_type=id_token`;
const sha256 = text => createHash('sha256').update(text).digest();
const hex = bytes => Buffer.from(bytes).toString('hex');
const b64url = bytes => Buffer.from(bytes).toString('base64url');

const session = (claims = { email: 'reader@example.com' }, user = { id: USER, email: 'reader@example.com' }) => ({
  access_token: fakeJwt({ sub: USER, exp: NOW / 1000 + 3600, ...claims }), refresh_token: 'refresh-1', expires_in: 3600, token_type: 'bearer', user,
});
const appleToken = nonce => fakeJwt({ iss: 'https://appleid.apple.com', aud: 'app.littlearchive.mobile', sub: '001234.abcdef.5678', nonce });

async function refusal(promise) {
  try { await promise; } catch (error) { assert.ok(error instanceof AppError, String(error)); return error.message; }
  assert.fail('expected an AppError');
}

/** A native plugin that answers as scripted and remembers what it was asked. */
function fakePlugin({ browser, apple } = {}) {
  const asked = { browser: [], apple: [] };
  return {
    asked,
    browser: async options => { asked.browser.push(options); return typeof browser === 'function' ? browser(options) : browser; },
    apple: async options => { asked.apple.push(options); return typeof apple === 'function' ? apple(options) : apple; },
  };
}

function rig({ routes = {}, plugin = fakePlugin(), platform = 'ios', ...rest } = {}) {
  const fake = fakeHttp(routes);
  const supabase = createSupabase({ url: BASE, publishableKey: CONFIG.supabasePublishableKey, http: fake.http, now: () => NOW });
  return { ...fake, plugin, social: createSocialSignIn({ supabase, plugin, platform, ...rest }) };
}

// What a project with both providers switched on answers to GET /auth/v1/settings (internal/api/settings.go).
const switchedOn = reply(200, { external: { apple: true, google: true, email: true }, disable_signup: false });
const challengeOf = address => new URL(address).searchParams.get('code_challenge');

test('the callback is accepted only when it is exactly the app\'s own address, and an error beats a code', () => {
  assert.deepEqual(parseCallback('littlearchive://auth-callback?code=abc123'), { kind: 'code', code: 'abc123' });
  assert.deepEqual(parseCallback('littlearchive://auth-callback/?code=abc123'), { kind: 'code', code: 'abc123' });
  assert.deepEqual(parseCallback('LittleArchive://Auth-Callback?code=abc123'), { kind: 'code', code: 'abc123' });
  // Supabase puts an error in the query and repeats it in the fragment.
  assert.deepEqual(parseCallback('littlearchive://auth-callback?error=access_denied&error_code=signup_disabled&error_description=Signups+not+allowed'), { kind: 'error', errorCode: 'signup_disabled' });
  assert.deepEqual(parseCallback('littlearchive://auth-callback#error=access_denied&error_code=user_banned'), { kind: 'error', errorCode: 'user_banned' });
  assert.deepEqual(parseCallback('littlearchive://auth-callback?error=access_denied'), { kind: 'error', errorCode: '' });
  assert.equal(parseCallback('littlearchive://auth-callback?code=abc123&error=access_denied').kind, 'error', 'an error is never ignored because a code came with it');
  for (const wrong of [
    'littlearchive://auth-callback', 'littlearchive://auth-callback?', 'littlearchive://auth-callback?code=', 'littlearchive://auth-callback?other=1',
    'littlearchive://share?code=abc123', 'littlearchive://auth-callback.example.com?code=abc123', 'littlearchive://auth-callback/more?code=abc123',
    'littlearchive://user@auth-callback?code=abc123', 'littlearchive:auth-callback?code=abc123', 'https://auth-callback?code=abc123',
    'otherapp://auth-callback?code=abc123', `littlearchive://auth-callback?code=${'x'.repeat(513)}`, 'littlearchive://auth-callback?code=a b',
    '', null, undefined, 42, {},
  ]) assert.deepEqual(parseCallback(wrong), { kind: 'invalid' }, String(wrong));
});

test('Google: the browser is sent to the pinned project with the SHA-256 of a verifier that only the code exchange then carries', async () => {
  const exchanged = [];
  const plugin = fakePlugin({ browser: { status: 'returned', url: 'littlearchive://auth-callback?code=auth-code-1' } });
  const { social, calls } = rig({ plugin, routes: {
    [`GET ${SETTINGS}`]: switchedOn,
    [PKCE]: request => { exchanged.push(JSON.parse(request.body)); return reply(200, session()); },
  } });
  const result = await social.google();
  assert.equal(result.email, 'reader@example.com');
  assert.equal(result.refreshToken, 'refresh-1');
  assert.equal(plugin.asked.browser.length, 1);
  const opened = new URL(plugin.asked.browser[0].url);
  assert.deepEqual(Object.keys(plugin.asked.browser[0]), ['url'], 'the native side is given the address and nothing else');
  assert.equal(`${opened.origin}${opened.pathname}`, `${BASE}/auth/v1/authorize`);
  assert.equal(opened.searchParams.get('provider'), 'google');
  assert.equal(opened.searchParams.get('redirect_to'), CALLBACK_URL);
  assert.equal(opened.searchParams.get('code_challenge_method'), 's256', 'Supabase spells it in lower case');
  assert.equal(opened.searchParams.get('prompt'), 'select_account', 'Google shows its account chooser, so a second sign-in does not silently reuse the last account');
  assert.deepEqual([...opened.searchParams.keys()].sort(), ['code_challenge', 'code_challenge_method', 'prompt', 'provider', 'redirect_to']);
  assert.equal(exchanged.length, 1);
  assert.deepEqual(Object.keys(exchanged[0]).sort(), ['auth_code', 'code_verifier']);
  assert.equal(exchanged[0].auth_code, 'auth-code-1');
  const verifier = exchanged[0].code_verifier;
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/, 'RFC 7636: 43 to 128 unreserved characters');
  assert.equal(opened.searchParams.get('code_challenge'), b64url(sha256(verifier)), 'the challenge is the base64url SHA-256 of the verifier');
  // The requests the app itself makes: the check that the provider is on (the project's public settings, which starts no sign-in
  // and carries nothing of this attempt), then the exchange. Both to the pinned project, both with the publishable key.
  assert.deepEqual(calls.map(call => `${call.method} ${call.url}`), [`GET ${SETTINGS}`, `POST ${BASE}/auth/v1/token?grant_type=pkce`]);
  for (const call of calls) { assert.ok(call.url.startsWith(`${BASE}/`), call.url); assert.equal(call.headers.apikey, CONFIG.supabasePublishableKey); }
  assert.equal(calls[0].body, undefined);
  assert.ok(!JSON.stringify(calls[0]).includes(verifier) && !plugin.asked.browser[0].url.includes(verifier), 'the verifier is in no request but the exchange');
});

test('Google: every attempt makes a new verifier, and the app never reuses one', async () => {
  const seen = [];
  const plugin = fakePlugin({ browser: { status: 'returned', url: 'littlearchive://auth-callback?code=c' } });
  const { social } = rig({ plugin, routes: { [`GET ${SETTINGS}`]: switchedOn, [PKCE]: request => { seen.push(JSON.parse(request.body).code_verifier); return reply(200, session()); } } });
  await social.google();
  await social.google();
  assert.equal(new Set(seen).size, 2);
  assert.equal(new Set(plugin.asked.browser.map(item => challengeOf(item.url))).size, 2);
});

test('Google: closing the browser returns quietly, with no error and no exchange', async () => {
  const plugin = fakePlugin({ browser: { status: 'cancelled' } });
  const { social, calls } = rig({ plugin, routes: { [`GET ${SETTINGS}`]: switchedOn } });
  assert.equal(await social.google(), null);
  assert.deepEqual(calls.map(call => call.method), ['GET']);
  // And the screen can be used again straight away.
  assert.equal(await social.google(), null);
});

test('Google: a callback that is an error, or has no code, or is not the app\'s own address is refused, and nothing is exchanged', async () => {
  const run = async url => {
    const { social, calls } = rig({ plugin: fakePlugin({ browser: { status: 'returned', url } }), routes: { [`GET ${SETTINGS}`]: switchedOn } });
    const message = await refusal(social.google());
    assert.equal(calls.filter(call => call.method === 'POST').length, 0, `no exchange for ${url}`);
    return message;
  };
  assert.match(await run('littlearchive://auth-callback?error=access_denied&error_code=signup_disabled&error_description=anything'), /New accounts cannot be created/);
  assert.match(await run('littlearchive://auth-callback?error=access_denied&error_code=user_banned'), /suspended/);
  assert.match(await run('littlearchive://auth-callback?error=access_denied&error_description=The+user+denied'), /Google did not finish signing you in/);
  assert.match(await run('littlearchive://auth-callback?error=server_error&error_code=provider_disabled'), /Google sign-in is not switched on yet/);
  assert.ok(!(await run('littlearchive://auth-callback?error=access_denied&error_description=Click+evil.example')).includes('evil'), 'text carried by the address is never shown');
  for (const wrong of ['littlearchive://auth-callback', 'littlearchive://share?code=x', 'https://evil.example/?code=x', 'littlearchive://auth-callback/x?code=x', '']) assert.match(await run(wrong), /did not come back the way it should/, wrong);
  // The native side must say "returned" with an address: any other answer is the same as no answer.
  for (const answer of [undefined, null, {}, { status: 'returned' }, { status: 'weird', url: 'littlearchive://auth-callback?code=x' }, { url: 'littlearchive://auth-callback?code=x' }]) {
    const { social, calls } = rig({ plugin: fakePlugin({ browser: answer }), routes: { [`GET ${SETTINGS}`]: switchedOn } });
    assert.match(await refusal(social.google()), /did not come back the way it should/);
    assert.equal(calls.filter(call => call.method === 'POST').length, 0);
  }
});

test('Google: a project that has not switched Google on is explained, and the browser is never opened', async () => {
  const plugin = fakePlugin({ browser: { status: 'returned', url: 'littlearchive://auth-callback?code=x' } });
  const { social } = rig({ plugin, routes: { [`GET ${SETTINGS}`]: reply(200, { external: { apple: true, google: false } }) } });
  assert.match(await refusal(social.google()), /^Google sign-in is not switched on yet\. Use your email and password for now\.$/);
  // The same refusal as an error answer: the 400 the authorize address gives for a provider that is off, and the two error codes.
  for (const body of [{ code: 400, error_code: 'validation_failed', msg: 'Unsupported provider: provider is not enabled' }, { error_code: 'provider_disabled' }, { error_code: 'oauth_provider_not_supported' }]) {
    assert.match(await refusal(rig({ plugin, routes: { [`GET ${SETTINGS}`]: reply(400, body) } }).social.google()), /not switched on yet/, JSON.stringify(body));
  }
  // And when the service cannot be reached at all, there is no point opening a browser on it.
  assert.match(await refusal(rig({ plugin, routes: { [`GET ${SETTINGS}`]: new Error('offline') } }).social.google()), /Could not reach the sign-in service/);
  assert.equal(plugin.asked.browser.length, 0);
});

test('Google: only an answer that says the provider is off stops the sign-in; any other answer to the check opens the browser', async () => {
  const html = (status, body, headers = {}) => ({ status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers }, body: bytes(body) });
  const answers = {
    'a 302 with the HTML body a redirect carries': html(302, '<a href="https://accounts.google.com/o/oauth2/v2/auth?client_id=x">Found</a>.\n\n', { location: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x' }),
    'a 302 with no body': { status: 302, headers: { location: 'https://accounts.google.com/' }, body: new Uint8Array() },
    'a 200 that lists the provider as on': switchedOn,
    'a 200 in a shape this app does not know': reply(200, { providers: ['google'] }),
    'a 200 that does not mention the provider': reply(200, { external: { apple: true } }),
    'a 200 that is not JSON': html(200, '<!doctype html><title>Sign in</title>'),
    'a 200 with nothing in it': { status: 200, headers: {}, body: new Uint8Array() },
    'a 429 (too many requests)': reply(429, { code: 429, error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' }),
    'a 400 about something else': reply(400, { code: 400, error_code: 'validation_failed', msg: 'code challenge has to be between 43 and 128 characters' }),
    'a 401 (the key was not accepted here)': reply(401, { message: 'No API key found in request' }),
    'a 404 (the route moved)': reply(404, { msg: 'not found' }),
    'a 503': reply(503, {}),
  };
  for (const [name, answer] of Object.entries(answers)) {
    const plugin = fakePlugin({ browser: { status: 'cancelled' } });
    const { social } = rig({ plugin, routes: { [`GET ${SETTINGS}`]: answer } });
    assert.equal(await social.google(), null, name);
    assert.equal(plugin.asked.browser.length, 1, `${name}: the browser opened`);
    assert.ok(plugin.asked.browser[0].url.startsWith(`${BASE}/auth/v1/authorize?`), name);
  }
});

test('Google: the exchange can fail in the ways Supabase documents, each in plain words', async () => {
  const run = async answer => refusal(rig({ plugin: fakePlugin({ browser: { status: 'returned', url: 'littlearchive://auth-callback?code=x' } }), routes: { [`GET ${SETTINGS}`]: switchedOn, [PKCE]: answer } }).social.google());
  assert.match(await run(reply(400, { error_code: 'bad_code_verifier', msg: 'code challenge does not match previously saved code verifier' })), /did not finish/);
  assert.match(await run(reply(404, { error_code: 'flow_state_not_found' })), /did not finish/);
  assert.match(await run(reply(422, { error_code: 'flow_state_expired' })), /took too long/);
  assert.match(await run(reply(500, {})), /having trouble/);
  assert.match(await run(new Error('offline')), /Could not reach the sign-in service/);
  assert.match(await run(reply(200, { access_token: 5 })), /could not read/);
});

test('Apple: the nonce Apple signs is the lower case hex SHA-256 of the raw one, which only the project receives', async () => {
  let sent;
  const plugin = fakePlugin({ apple: options => ({ status: 'signed_in', identityToken: appleToken(options.nonce) }) });
  const { social, calls } = rig({ plugin, routes: { [ID_TOKEN]: request => { sent = JSON.parse(request.body); return reply(200, session()); } } });
  const result = await social.apple();
  assert.equal(result.accessToken, session().access_token);
  assert.equal(plugin.asked.apple.length, 1);
  assert.deepEqual(Object.keys(plugin.asked.apple[0]), ['nonce']);
  const hashed = plugin.asked.apple[0].nonce;
  assert.match(hashed, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(sent).sort(), ['id_token', 'nonce', 'provider']);
  assert.equal(sent.provider, 'apple');
  assert.equal(sent.id_token, appleToken(hashed));
  assert.equal(hex(sha256(sent.nonce)), hashed, 'the project hashes the raw nonce and compares it with the one in the token');
  assert.notEqual(sent.nonce, hashed);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith(`${BASE}/`));
  assert.ok(!JSON.stringify(plugin.asked).includes(sent.nonce), 'the raw nonce is not given to the native side');
  // A new attempt, a new nonce.
  await social.apple();
  assert.notEqual(plugin.asked.apple[1].nonce, hashed);
});

test('Apple: closing the sheet returns quietly; a sheet that gives back nothing usable is an error and sends nothing', async () => {
  const none = rig({ plugin: fakePlugin({ apple: { status: 'cancelled' } }) });
  assert.equal(await none.social.apple(), null);
  assert.equal(none.calls.length, 0);
  for (const answer of [undefined, {}, { status: 'signed_in' }, { status: 'signed_in', identityToken: 'not-a-jwt' }, { status: 'signed_in', identityToken: 5 }, { identityToken: appleToken('x') }]) {
    const bad = rig({ plugin: fakePlugin({ apple: answer }) });
    assert.match(await refusal(bad.social.apple()), /Apple did not send back a sign-in/);
    assert.equal(bad.calls.length, 0);
  }
  const broken = rig({ plugin: { apple: async () => { throw Object.assign(new Error('Sign in with Apple did not work. Make sure this device is signed in to an Apple Account, then try again.'), { code: 'APPLE_FAILED' }); } } });
  assert.match(await refusal(broken.social.apple()), /signed in to an Apple Account/);
  const odd = rig({ plugin: { apple: async () => { throw new Error('x'.repeat(500)); } } });
  assert.equal(await refusal(odd.social.apple()), 'Sign in with Apple did not work. Try again.', 'a long message from the native side is not shown');
});

test('Apple: a project that has not switched Apple on, or does not know this app, is explained', async () => {
  const run = async answer => refusal(rig({ plugin: fakePlugin({ apple: options => ({ status: 'signed_in', identityToken: appleToken(options.nonce) }) }), routes: { [ID_TOKEN]: answer } }).social.apple());
  assert.match(await run(reply(400, { code: 400, error_code: 'provider_disabled', msg: 'Provider (issuer "https://appleid.apple.com") is not enabled' })), /^Apple sign-in is not switched on yet\./);
  assert.match(await run(reply(400, { error: 'invalid request', error_description: 'Unacceptable audience in id_token: [app.example.other]' })), /Apple sign-in is not set up for this app yet/);
  assert.match(await run(reply(422, { error_code: 'signup_disabled' })), /New accounts cannot be created/);
  assert.match(await run(reply(429, {})), /Too many attempts/);
});

test('Apple is offered on iOS only; Google on both; neither anywhere else', async () => {
  const on = platform => rig({ platform }).social.available;
  assert.deepEqual({ ...on('ios') }, { apple: true, google: true });
  assert.deepEqual({ ...on('android') }, { apple: false, google: true });
  assert.deepEqual({ ...on('web') }, { apple: false, google: false });
  const android = rig({ platform: 'android', plugin: fakePlugin({ apple: { status: 'cancelled' } }) });
  assert.match(await refusal(android.social.apple()), /not available on this device/);
  assert.equal(android.plugin.asked.apple.length, 0);
});

test('only one sign-in can be open: a second tap is refused, and the screen is usable again when the first ends, however it ends', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const plugin = fakePlugin({ browser: async () => { await gate; return { status: 'cancelled' }; } });
  const { social } = rig({ plugin, routes: { [`GET ${SETTINGS}`]: switchedOn } });
  const first = social.google();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(await refusal(social.google()), /already open/);
  assert.match(await refusal(social.apple()), /already open/);
  release();
  assert.equal(await first, null);
  // After an error too.
  const failing = rig({ plugin: { browser: async () => { throw new Error('boom'); } }, routes: { [`GET ${SETTINGS}`]: switchedOn } });
  await refusal(failing.social.google());
  await refusal(failing.social.google());
});

test('this device must be able to hash: without WebCrypto the sign-in says so instead of sending something weaker', async () => {
  const plugin = fakePlugin({ browser: { status: 'cancelled' }, apple: { status: 'cancelled' } });
  const { social, calls } = rig({ plugin, subtle: null });
  assert.match(await refusal(social.google()), /cannot prepare a safe sign-in/);
  assert.match(await refusal(social.apple()), /cannot prepare a safe sign-in/);
  assert.equal(calls.length, 0);
  assert.equal(plugin.asked.browser.length + plugin.asked.apple.length, 0);
});

test('the verifier and the nonce are not kept: nothing is written to storage or to a log, whatever way the attempt ends', async () => {
  const writes = [];
  const logs = [];
  const storage = { setItem: (...args) => writes.push(args), getItem: () => null, removeItem: () => {}, clear: () => {} };
  const original = { localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage, console: {} };
  globalThis.localStorage = storage; globalThis.sessionStorage = storage;
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace']) { original.console[level] = console[level]; console[level] = (...args) => logs.push(args); }
  const secrets = [];
  try {
    const outcomes = [
      { browser: { status: 'returned', url: 'littlearchive://auth-callback?code=c1' }, ok: true },
      { browser: { status: 'cancelled' } },
      { browser: { status: 'returned', url: 'littlearchive://auth-callback?error=access_denied' } },
    ];
    for (const outcome of outcomes) {
      const plugin = fakePlugin({ browser: outcome.browser, apple: options => ({ status: 'signed_in', identityToken: appleToken(options.nonce) }) });
      const { social } = rig({ plugin, routes: { [`GET ${SETTINGS}`]: switchedOn, [PKCE]: request => { secrets.push(JSON.parse(request.body).code_verifier); return reply(200, session()); }, [ID_TOKEN]: request => { secrets.push(JSON.parse(request.body).nonce); return reply(200, session()); } } });
      await social.google().catch(() => {});
      await social.apple().catch(() => {});
    }
  } finally {
    globalThis.localStorage = original.localStorage; globalThis.sessionStorage = original.sessionStorage;
    for (const [level, fn] of Object.entries(original.console)) console[level] = fn;
  }
  assert.ok(secrets.length >= 2 && secrets.every(secret => secret.length >= 43));
  assert.deepEqual(writes, [], 'nothing went to storage');
  for (const secret of secrets) assert.ok(!JSON.stringify(logs).includes(secret), 'a secret was logged');
});

test('Apple may withhold the email: a session without one is complete, is kept, and shows as empty rather than "undefined"', async () => {
  for (const user of [{ id: USER }, { id: USER, email: '' }, { id: USER, email: null }]) {
    const body = session({}, user);
    const made = sessionFrom(body, () => NOW);
    assert.equal(made.email, '', JSON.stringify(user));
    assert.equal(made.userId, USER);
    const record = { v: 1, server: { kind: 'hosted', url: 'https://app.little-archive.example' }, credential: made };
    const store = createStore(memoryBackend());
    await store.save(record);
    assert.equal((await store.load()).credential.email, '');
    const credentials = createCredentials({ record, store, supabase: null, now: () => NOW });
    assert.equal(credentials.email, '');
    assert.equal(credentials.kind, 'supabase');
    assert.ok(credentials.accessToken);
  }
  // Even with no user object, the token's own claims decide, and without an email there either it is still a session.
  assert.equal(sessionFrom({ ...session({}), user: undefined }, () => NOW).email, '');
  assert.equal(sessionFrom({ ...session({ email: 'claim@example.com' }), user: undefined }, () => NOW).email, 'claim@example.com');
  // A private relay address is just an address.
  assert.equal(sessionFrom(session({}, { id: USER, email: 'abc123@privaterelay.appleid.com' }), () => NOW).email, 'abc123@privaterelay.appleid.com');
});

test('a session from either provider is refreshed and ended exactly like an email one', async () => {
  const store = createStore(memoryBackend());
  const plugin = fakePlugin({ browser: { status: 'returned', url: 'littlearchive://auth-callback?code=c' } });
  const { social, http } = rig({ plugin, routes: { [`GET ${SETTINGS}`]: switchedOn, [PKCE]: reply(200, session()), [`POST ${BASE}/auth/v1/token?grant_type=refresh_token`]: reply(200, { ...session(), refresh_token: 'refresh-2' }) } });
  const got = await social.google();
  assert.equal(got.type, 'supabase');
  const record = { v: 1, server: { kind: 'hosted', url: 'https://app.little-archive.example' }, credential: { ...got, expiresAt: NOW - 1 } };
  await store.save(record);
  const credentials = createCredentials({ record, store, supabase: createSupabase({ url: BASE, publishableKey: CONFIG.supabasePublishableKey, http, now: () => NOW }), now: () => NOW });
  assert.ok(await credentials.get(), 'an expired token is traded for a new one');
  assert.equal((await store.load()).credential.refreshToken, 'refresh-2');
});

test('the screen is told when the sheet or the browser is done and the session is being fetched, and only then', async () => {
  const order = [];
  const google = rig({
    plugin: { browser: async () => { order.push('browser'); return { status: 'returned', url: 'littlearchive://auth-callback?code=abc' }; } },
    routes: { [`GET ${SETTINGS}`]: switchedOn, [PKCE]: () => { order.push('exchange'); return reply(200, session()); } },
  });
  await google.social.google({ onStage: stage => order.push(stage) });
  assert.deepEqual(order, ['browser', 'signing-in', 'exchange']);

  order.length = 0;
  const apple = rig({
    plugin: { apple: async options => { order.push('sheet'); return { status: 'signed_in', identityToken: appleToken(options.nonce) }; } },
    routes: { [ID_TOKEN]: () => { order.push('grant'); return reply(200, session()); } },
  });
  await apple.social.apple({ onStage: stage => order.push(stage) });
  assert.deepEqual(order, ['sheet', 'signing-in', 'grant']);

  // Closed, or come back with an error: there is no session to fetch, so nothing says "signing in".
  const stages = [];
  const onStage = stage => stages.push(stage);
  assert.equal(await rig({ plugin: fakePlugin({ browser: { status: 'cancelled' } }), routes: { [`GET ${SETTINGS}`]: switchedOn } }).social.google({ onStage }), null);
  await refusal(rig({ plugin: fakePlugin({ browser: { status: 'returned', url: 'littlearchive://auth-callback?error=access_denied' } }), routes: { [`GET ${SETTINGS}`]: switchedOn } }).social.google({ onStage }));
  assert.equal(await rig({ plugin: fakePlugin({ apple: { status: 'cancelled' } }) }).social.apple({ onStage }), null);
  assert.deepEqual(stages, []);
});

test('Android, the app started by the callback address with no sign-in waiting: one plain notice, once per process, and the code is never used', async () => {
  const memory = () => { const map = new Map(); return { map, getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => { map.set(key, String(value)); } }; };
  const launchedWith = url => ({ asked: 0, async getLaunchUrl() { this.asked += 1; return url === undefined ? undefined : { url }; } });
  const storage = memory();
  const App = launchedWith('littlearchive://auth-callback?code=a-code-from-the-old-process');
  assert.equal(INTERRUPTED, 'Sign-in was interrupted. Try again.');
  assert.equal(await interruptedSignIn({ platform: 'android', App, storage }), INTERRUPTED);
  // The page reloads after a sign-out and the launch address is still the same: it is not said again.
  assert.equal(await interruptedSignIn({ platform: 'android', App, storage }), '');
  assert.equal(App.asked, 1);
  assert.deepEqual([...storage.map.values()], ['1'], 'nothing of the address is kept, only that it was looked at');
  // An error callback, or a bare one, is the same interruption.
  for (const url of ['littlearchive://auth-callback?error=access_denied', 'littlearchive://auth-callback', 'LittleArchive://Auth-Callback/#x']) assert.equal(await interruptedSignIn({ platform: 'android', App: launchedWith(url), storage: memory() }), INTERRUPTED, url);
  // An ordinary start, a share, another host, and anything unreadable say nothing.
  for (const url of [undefined, '', 'littlearchive://share', 'littlearchive://auth-callback.example.com?code=x', 'littlearchive://auth-callbackx', 'https://auth-callback/?code=x', 42]) assert.equal(await interruptedSignIn({ platform: 'android', App: launchedWith(url), storage: memory() }), '', String(url));
  // iOS never gets the callback as a launch address, so it is not even asked.
  const ios = launchedWith('littlearchive://auth-callback?code=x');
  assert.equal(await interruptedSignIn({ platform: 'ios', App: ios, storage: memory() }), '');
  assert.equal(ios.asked, 0);
  // A plugin or a storage that fails is not a reason to stop the app from starting.
  assert.equal(await interruptedSignIn({ platform: 'android', App: { getLaunchUrl: async () => { throw new Error('no plugin'); } }, storage: memory() }), '');
  assert.equal(await interruptedSignIn({ platform: 'android', App, storage: { getItem() { throw new Error('blocked'); }, setItem() {} } }), '');
});
