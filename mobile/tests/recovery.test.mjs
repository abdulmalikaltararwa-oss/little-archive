// A forgotten password (src/recovery.js): the request for a link, the verifier that waits for it in secure storage, the link's
// code traded for a session, and how an address that opens the app is found. Scripted HTTP and a memory stand-in for the
// phone's secure storage; tests/stub-roundtrip.test.mjs runs the same code against the stand-in for Supabase.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AppError } from '../src/discovery.js';
import { LINK_ENDED, LINK_NOT_ASKED, LINK_UNREADABLE, MAX_AGE_MS, RESET_SENT, createLinkInbox, createRecovery, launchCallback } from '../src/recovery.js';
import { CALLBACK_URL } from '../src/social.js';
import { memoryBackend } from '../src/store.js';
import { createSupabase } from '../src/supabase.js';
import { CONFIG, fakeHttp, fakeJwt, reply } from './helpers.mjs';

const BASE = CONFIG.supabaseUrl;
const SERVER = 'https://app.little-archive.example';
const RECOVER = `POST ${BASE}/auth/v1/recover?redirect_to=${encodeURIComponent(CALLBACK_URL)}`;
const TOKEN = `POST ${BASE}/auth/v1/token?grant_type=pkce`;
const session = { access_token: fakeJwt({ sub: 'user-1', exp: 2_000_000_000, email: 'reader@example.com' }), refresh_token: 'refresh-1', expires_in: 3600, user: { id: 'user-1', email: 'reader@example.com' } };

function rig(routes = {}, { at = 1_800_000_000_000 } = {}) {
  const fake = fakeHttp(routes);
  const backend = memoryBackend();
  const clock = { now: at };
  const supabase = createSupabase({ url: BASE, publishableKey: CONFIG.supabasePublishableKey, http: fake.http, now: () => clock.now });
  const recovery = createRecovery({ supabase, backend, now: () => clock.now });
  return { ...fake, backend, clock, recovery };
}
async function refusal(promise) {
  try { await promise; } catch (error) { assert.ok(error instanceof AppError, String(error)); return error; }
  assert.fail('expected an AppError');
}

test('the words are the ones the screens show', () => {
  assert.equal(RESET_SENT, 'If that address has an account, a reset link is on its way. Open the link on this phone, soon: it stops working after a few minutes.');
  assert.equal(LINK_ENDED, 'That reset link has run out or was already used. Ask for a new one, and open it within a few minutes.');
  assert.equal(LINK_NOT_ASKED, 'That reset link was not asked for on this phone, or a newer one has been asked for since. Ask for a new one here, then open it on this phone.');
  assert.equal(LINK_UNREADABLE, 'That link did not come back the way it should. Ask for a new one.');
});

test('asking for a link: the app\'s own callback address, a PKCE challenge, and the verifier kept in secure storage with the server and the time', async () => {
  const r = rig({ [RECOVER]: reply(200, {}) });
  await r.recovery.request({ email: 'reader@example.com', server: SERVER });
  assert.equal(r.calls.length, 1);
  const [call] = r.calls;
  assert.equal(new URL(call.url).searchParams.get('redirect_to'), 'littlearchive://auth-callback');
  assert.equal(call.headers.apikey, CONFIG.supabasePublishableKey);
  assert.equal(call.headers.Authorization, undefined);
  const body = JSON.parse(call.body);
  assert.deepEqual(Object.keys(body).sort(), ['code_challenge', 'code_challenge_method', 'email']);
  assert.equal(body.email, 'reader@example.com');
  assert.equal(body.code_challenge_method, 's256');
  const kept = await r.backend.get('recovery');
  assert.deepEqual(Object.keys(kept).sort(), ['madeAt', 'server', 'v', 'verifier']);
  assert.equal(kept.server, SERVER);
  assert.equal(kept.madeAt, r.clock.now);
  assert.match(kept.verifier, /^[A-Za-z0-9_-]{64}$/);
  assert.equal(body.code_challenge, createHash('sha256').update(kept.verifier).digest('base64url'), 'the challenge is the SHA-256 of the verifier, which never leaves the phone');
  assert.ok(!call.url.includes(kept.verifier) && !call.body.includes(kept.verifier));
  assert.deepEqual(await r.recovery.pending(), kept);
});

test('whatever the service answers, asking says nothing: an unknown address, a known one, one asked too often and a refusal all look the same', async () => {
  const answers = [reply(200, {}), reply(429, { code: 429, error_code: 'over_email_send_rate_limit', msg: 'For security purposes, you can only request this after 42 seconds.' }), reply(400, { error_code: 'validation_failed' }), reply(422, { error_code: 'email_address_invalid' }), reply(500, {})];
  for (const answer of answers) {
    const r = rig({ [RECOVER]: answer });
    assert.equal(await r.recovery.request({ email: 'reader@example.com', server: SERVER }), undefined, String(answer.status));
    assert.ok(await r.recovery.pending(), 'a verifier waits either way: the app cannot know whether a link was sent');
  }
});

test('not reaching the service is said, and an earlier request that may still have a link on its way is put back', async () => {
  const r = rig({ [RECOVER]: reply(200, {}) });
  await r.recovery.request({ email: 'reader@example.com', server: SERVER });
  const first = await r.backend.get('recovery');
  const offline = createRecovery({ supabase: createSupabase({ url: BASE, publishableKey: CONFIG.supabasePublishableKey, http: fakeHttp({ [RECOVER]: new Error('offline') }).http }), backend: r.backend, now: () => r.clock.now });
  assert.match((await refusal(offline.request({ email: 'reader@example.com', server: SERVER }))).message, /Could not reach the sign-in service/);
  assert.deepEqual(await r.backend.get('recovery'), first);
  // With nothing asked before, nothing is left behind.
  const fresh = rig({ [RECOVER]: new Error('offline') });
  await refusal(fresh.recovery.request({ email: 'reader@example.com', server: SERVER }));
  assert.equal(await fresh.backend.get('recovery'), null);
});

test('the link: its code and the kept verifier are traded for a session, once', async () => {
  const r = rig({ [RECOVER]: reply(200, {}), [TOKEN]: reply(200, session) });
  await r.recovery.request({ email: 'reader@example.com', server: SERVER });
  const { verifier } = await r.backend.get('recovery');
  const signedIn = await r.recovery.finish('littlearchive://auth-callback?code=the-code');
  assert.deepEqual(JSON.parse(r.calls[1].body), { auth_code: 'the-code', code_verifier: verifier });
  assert.equal(signedIn.email, 'reader@example.com');
  assert.equal(signedIn.refreshToken, 'refresh-1');
  assert.equal(await r.backend.get('recovery'), null, 'the verifier is gone once it has been used');
  assert.equal(await r.backend.get('session'), null, 'the session is handed back, not stored here');
  // The same link again, or any link with nothing asked for: no request, a plain sentence.
  const again = await refusal(r.recovery.finish('littlearchive://auth-callback?code=the-code'));
  assert.equal(again.message, LINK_NOT_ASKED);
  assert.equal(r.calls.length, 2);
});

test('a link that ran out or was used is said plainly, and a failed exchange does not spoil a link that is still on its way', async () => {
  // The project's own page says so in the address: nothing is sent.
  const told = rig({ [RECOVER]: reply(200, {}) });
  await told.recovery.request({ email: 'reader@example.com', server: SERVER });
  const expired = 'error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired';
  assert.equal((await refusal(told.recovery.finish(`littlearchive://auth-callback?${expired}#${expired}`))).message, LINK_ENDED);
  assert.equal(told.calls.length, 1);
  assert.ok(!LINK_ENDED.includes('Email link is invalid'), 'the text the address carried is never shown');
  // The project refuses the code: used, too old (five minutes from asking), or made for another verifier.
  for (const answer of [reply(404, { error_code: 'flow_state_not_found' }), reply(422, { error_code: 'flow_state_expired' }), reply(400, { error_code: 'bad_code_verifier' })]) {
    const r = rig({ [RECOVER]: reply(200, {}), [TOKEN]: answer });
    await r.recovery.request({ email: 'reader@example.com', server: SERVER });
    const error = await refusal(r.recovery.finish('littlearchive://auth-callback?code=some-code'));
    assert.equal(error.message, LINK_ENDED);
    assert.ok(await r.recovery.pending(), 'another app can send a made-up code; the real link must still work after it');
  }
  // Not reaching the service is its own sentence, and the verifier stays.
  const away = rig({ [RECOVER]: reply(200, {}), [TOKEN]: new Error('offline') });
  await away.recovery.request({ email: 'reader@example.com', server: SERVER });
  assert.match((await refusal(away.recovery.finish('littlearchive://auth-callback?code=some-code'))).message, /Could not reach the sign-in service/);
  assert.ok(await away.recovery.pending());
});

test('a session is never taken from an address: tokens in the fragment, another host and garbage are refused with nothing sent', async () => {
  const r = rig({ [RECOVER]: reply(200, {}) });
  await r.recovery.request({ email: 'reader@example.com', server: SERVER });
  const planted = `littlearchive://auth-callback#access_token=${session.access_token}&refresh_token=someone-elses&expires_in=3600&token_type=bearer&type=recovery`;
  for (const address of [planted, 'littlearchive://auth-callback', 'littlearchive://share?code=x', 'https://auth-callback/?code=x', '', null, 42]) {
    assert.equal((await refusal(r.recovery.finish(address))).message, LINK_UNREADABLE, String(address));
  }
  assert.equal(r.calls.length, 1, 'only the request for the link was ever sent');
  assert.ok(await r.recovery.pending());
});

test('a request is forgotten after an hour, when a newer one replaces it, and when it cannot be read', async () => {
  const r = rig({ [RECOVER]: reply(200, {}) });
  await r.recovery.request({ email: 'reader@example.com', server: SERVER });
  const first = (await r.recovery.pending()).verifier;
  r.clock.now += 60_000;
  await r.recovery.request({ email: 'reader@example.com', server: SERVER });
  assert.notEqual((await r.recovery.pending()).verifier, first, 'a new request makes a new verifier');
  r.clock.now += MAX_AGE_MS - 1;
  assert.ok(await r.recovery.pending());
  r.clock.now += 1;
  assert.equal(await r.recovery.pending(), null);
  assert.equal(await r.backend.get('recovery'), null, 'and it is removed, not just ignored');
  for (const junk of ['text', { v: 2, verifier: 'x'.repeat(64), server: SERVER, madeAt: r.clock.now }, { v: 1, verifier: 'short', server: SERVER, madeAt: r.clock.now }, { v: 1, verifier: 'x'.repeat(64), server: SERVER, madeAt: r.clock.now + 60_000 }]) {
    await r.backend.set('recovery', junk);
    assert.equal(await r.recovery.pending(), null);
    assert.equal(await r.backend.get('recovery'), null);
  }
  await r.recovery.request({ email: 'reader@example.com', server: SERVER });
  await r.recovery.forget();
  assert.equal(await r.recovery.pending(), null);
});

test('nothing of a reset is written to the web view\'s storage or to a log', async () => {
  const writes = [];
  const storage = { setItem: (...args) => writes.push(args), getItem: () => null, removeItem: () => {}, clear: () => {} };
  const before = { local: globalThis.localStorage, session: globalThis.sessionStorage, log: console.log, error: console.error, warn: console.warn };
  const said = [];
  globalThis.localStorage = storage; globalThis.sessionStorage = storage;
  console.log = console.error = console.warn = (...args) => said.push(args);
  try {
    const r = rig({ [RECOVER]: reply(200, {}), [TOKEN]: reply(200, session) });
    await r.recovery.request({ email: 'reader@example.com', server: SERVER });
    await r.recovery.finish('littlearchive://auth-callback?code=the-code');
    const failing = rig({ [RECOVER]: reply(200, {}), [TOKEN]: reply(400, { error_code: 'bad_code_verifier' }) });
    await failing.recovery.request({ email: 'reader@example.com', server: SERVER });
    await refusal(failing.recovery.finish('littlearchive://auth-callback?code=the-code'));
  } finally {
    globalThis.localStorage = before.local; globalThis.sessionStorage = before.session;
    console.log = before.log; console.error = before.error; console.warn = before.warn;
  }
  assert.deepEqual(writes, []);
  assert.deepEqual(said, []);
});

const memory = () => { const map = new Map(); return { map, getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => { map.set(key, String(value)); } }; };
const launchedWith = url => ({ asked: 0, async getLaunchUrl() { this.asked += 1; return url === undefined ? undefined : { url }; } });

test('the address the app was started by is found once: from the launch address, or on Android from the plugin that set it aside', async () => {
  const link = 'littlearchive://auth-callback?code=a-code';
  // iOS: the launch address, once. A reload after a sign-out has the same launch address and must not see the link again.
  const ios = { platform: 'ios', plugin: { interrupted: async () => assert.fail('iOS has no such question') }, App: launchedWith(link), storage: memory() };
  assert.equal(await launchCallback(ios), link);
  assert.equal(await launchCallback(ios), '');
  assert.equal(ios.App.asked, 1);
  assert.deepEqual([...ios.storage.map.values()], ['1'], 'nothing of the address is kept, only that it was looked at');
  // Android: the plugin hands over the address it set aside, once.
  const answers = [{ interrupted: true, url: link }, { interrupted: false }];
  const android = { platform: 'android', plugin: { interrupted: async () => answers.shift() }, App: launchedWith(undefined), storage: memory() };
  assert.equal(await launchCallback(android), link);
  assert.equal(await launchCallback(android), '');
  // A native side from before reset links knows only that it dropped a callback: the launch address fills it in when it can,
  // and otherwise the bare callback address stands for "something came back that cannot be used".
  const old = flag => ({ interrupted: async () => ({ interrupted: flag }) });
  assert.equal(await launchCallback({ platform: 'android', plugin: old(true), App: launchedWith(link), storage: memory() }), link);
  assert.equal(await launchCallback({ platform: 'android', plugin: old(true), App: launchedWith(undefined), storage: memory() }), 'littlearchive://auth-callback');
  const none = { interrupted: async () => { throw new Error('not implemented'); } };
  assert.equal(await launchCallback({ platform: 'android', plugin: none, App: launchedWith(link), storage: memory() }), link);
  // An ordinary start, a share, another host, and anything unreadable say nothing.
  for (const url of [undefined, '', 'littlearchive://share', 'littlearchive://auth-callback.example.com?code=x', 'littlearchive://auth-callbackx', 'https://auth-callback/?code=x', 42]) {
    assert.equal(await launchCallback({ platform: 'android', plugin: old(false), App: launchedWith(url), storage: memory() }), '', String(url));
    assert.equal(await launchCallback({ platform: 'ios', plugin: none, App: launchedWith(url), storage: memory() }), '', String(url));
  }
  assert.equal(await launchCallback({ platform: 'android', plugin: { interrupted: async () => ({ interrupted: true, url: 'https://evil.example/?code=x' }) }, App: launchedWith(undefined), storage: memory() }), 'littlearchive://auth-callback', 'an address that is not the callback is not passed on');
  // A plugin or a storage that fails is not a reason to stop the app from starting.
  assert.equal(await launchCallback({ platform: 'android', plugin: none, App: { getLaunchUrl: async () => { throw new Error('no plugin'); } }, storage: memory() }), '');
  assert.equal(await launchCallback({ platform: 'ios', plugin: none, App: launchedWith(link), storage: { getItem() { throw new Error('blocked'); }, setItem() {} } }), '');
  assert.equal(await launchCallback({ platform: 'android', plugin: { interrupted: async () => ({ interrupted: true, url: link }) }, App: launchedWith(undefined), storage: { getItem() { throw new Error('blocked'); }, setItem() {} } }), link);
});

function emitter() {
  const handlers = {};
  return { handlers, addListener(name, handler) { handlers[name] = handler; }, emit(name, event) { handlers[name]?.(event); } };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('the inbox on iOS: an opened callback address waits to be taken, once; a share and a repeat are not links', async () => {
  const App = emitter();
  const plugin = emitter();
  const clock = { now: 1_800_000_000_000 };
  const links = createLinkInbox({ platform: 'ios', plugin, App, now: () => clock.now });
  assert.equal(plugin.handlers.callback, undefined);
  assert.equal(links.waiting, false);
  assert.equal(links.take(), '');
  let woke = false;
  links.arrival().then(() => { woke = true; });
  App.emit('appUrlOpen', { url: 'littlearchive://share' });
  App.emit('appUrlOpen', { url: 'https://example.com/?code=x' });
  App.emit('appUrlOpen', {});
  await tick();
  assert.equal(woke, false);
  App.emit('appUrlOpen', { url: 'littlearchive://auth-callback?code=one' });
  await tick();
  assert.equal(woke, true);
  assert.equal(links.waiting, true);
  assert.equal(links.take(), 'littlearchive://auth-callback?code=one');
  assert.equal(links.waiting, false);
  // The launch address and the event can carry the same link: within a moment it is one link.
  clock.now += 1500;
  links.push('littlearchive://auth-callback?code=one');
  assert.equal(links.waiting, false);
  links.push('littlearchive://auth-callback?code=two');
  assert.equal(links.take(), 'littlearchive://auth-callback?code=two');
  // A link that ran out always comes back as the same address. Tapping it again later is answered again, not ignored.
  const ended = 'littlearchive://auth-callback?error=access_denied&error_code=otp_expired';
  links.push(ended);
  assert.equal(links.take(), ended);
  clock.now += 30_000;
  links.push(ended);
  assert.equal(links.take(), ended);
  // Closed, once someone is signed in: nothing is kept.
  links.close();
  App.emit('appUrlOpen', { url: 'littlearchive://auth-callback?code=three' });
  assert.equal(links.waiting, false);
});

test('the inbox on Android: only the plugin\'s event, and while the app is running only when this phone is waiting on a link', async () => {
  const App = emitter();
  const plugin = emitter();
  const backend = memoryBackend();
  const links = createLinkInbox({ platform: 'android', plugin, App, backend });
  assert.equal(App.handlers.appUrlOpen, undefined, 'appUrlOpen could also carry the callback of a Google sign-in that is waiting');
  // Nothing asked for: a stray callback (another app, or a sign-in the system interrupted) changes nothing on screen.
  plugin.emit('callback', { url: 'littlearchive://auth-callback?code=stray' });
  await tick();
  assert.equal(links.waiting, false);
  // The project saying that an emailed link ran out is about a reset whatever this phone remembers.
  plugin.emit('callback', { url: 'littlearchive://auth-callback?error=access_denied&error_code=otp_expired' });
  await tick();
  assert.match(links.take(), /otp_expired/);
  // Waiting on a link: the callback is taken.
  await backend.set('recovery', { v: 1, verifier: 'v'.repeat(64), server: SERVER, madeAt: Date.now() });
  plugin.emit('callback', { url: 'littlearchive://auth-callback?code=the-link' });
  await tick();
  assert.equal(links.take(), 'littlearchive://auth-callback?code=the-link');
  // The address the app was started by is pushed by boot.js whatever the phone remembers; onboarding decides what it is.
  await backend.remove('recovery');
  links.push('littlearchive://auth-callback?code=cold-start');
  assert.equal(links.waiting, true);
});
