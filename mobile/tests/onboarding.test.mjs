// The order the app really signs in by (src/onboarding.js, which boot.js runs): the server is asked what it is before any
// sign-in is offered, and a hosted sign-in is offered only when the server names the sign-in service in app.config.json. These
// tests drive the same functions boot.js calls, with scripted screens, a scripted HTTP client and a scripted plugin, and look
// at what was drawn and what was requested. The pin is not something a test passes in: it comes out of discovery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnboarding } from '../src/onboarding.js';
import { LINK_ENDED, LINK_NOT_ASKED, RESET_SENT, createLinkInbox } from '../src/recovery.js';
import { INTERRUPTED } from '../src/social.js';
import { createStore, memoryBackend } from '../src/store.js';
import { BACK } from '../src/ui.js';
import { CONFIG, fakeHttp, fakeJwt, hostedInfo, reply } from './helpers.mjs';

const HOSTED = `${CONFIG.hostedServerUrl}/api/discovery`;
const PINNED = new URL(CONFIG.supabaseUrl).host;
const EVIL = 'https://evil-project.supabase.co';
const session = { access_token: fakeJwt({ sub: 'user-1', exp: 2_000_000_000, email: 'reader@example.com' }), refresh_token: 'refresh-1', expires_in: 3600, user: { id: 'user-1', email: 'reader@example.com' } };

class Stop extends Error {}

/**
 * Screens that answer as scripted and write down what they were asked to draw. `choose` answers from `choices` and then stops
 * the flow (the real one loops until someone signs in).
 */
function screens({ choices = ['hosted'], account = async () => BACK, problem = 'back', server = async () => BACK, forgot = async () => BACK, newPassword = async () => BACK } = {}) {
  const drawn = [];
  const left = [...choices];
  return {
    drawn,
    working: message => { drawn.push({ screen: 'working', message }); },
    choose: async options => { drawn.push({ screen: 'choose', ...options }); if (!left.length) throw new Stop(); return left.shift(); },
    problem: async options => { drawn.push({ screen: 'problem', ...options }); return problem; },
    account: async options => { drawn.push({ screen: 'account', ...options }); return account(options); },
    server: async options => { drawn.push({ screen: 'server', ...options }); return server(options); },
    password: async options => { drawn.push({ screen: 'password', ...options }); return BACK; },
    forgot: async options => { drawn.push({ screen: 'forgot', ...options }); return forgot(options); },
    newPassword: async options => { drawn.push({ screen: 'newPassword', ...options }); return newPassword(options); },
  };
}

function plugin() {
  const asked = [];
  return { asked, browser: async options => { asked.push(['browser', options]); return { status: 'cancelled' }; }, apple: async options => { asked.push(['apple', options]); return { status: 'cancelled' }; } };
}

/** `reset` gives the flow the phone's secure storage and an inbox for links, as boot.js does; without it there is no password reset. */
function rig({ routes, ui = screens(), platform = 'ios', reset = false } = {}) {
  const fake = fakeHttp(routes);
  const native = plugin();
  const backend = memoryBackend();
  const store = createStore(backend);
  const links = reset ? createLinkInbox({ platform, plugin: native, App: {}, backend }) : undefined;
  const onboarding = createOnboarding({ http: fake.http, config: CONFIG, ui, store, platform, plugin: native, ...(reset ? { backend, links } : {}) });
  const toSignInService = () => fake.calls.filter(call => /supabase|\/auth\/v1\//.test(call.url));
  return { ...fake, ui, native, store, backend, links, onboarding, toSignInService };
}

const shown = (ui, name) => ui.drawn.filter(entry => entry.screen === name);

test('before the server has answered, no sign-in is offered and nothing is sent to any sign-in service', async () => {
  for (const [name, answer] of Object.entries({ 'the server cannot be reached': new Error('offline'), 'the server answers with an error': reply(503, {}), 'the address is not a Little Archive server': reply(200, { name: 'something-else' }) })) {
    const { onboarding, ui, calls, native, toSignInService } = rig({ routes: { [HOSTED]: answer } });
    await assert.rejects(onboarding.firstLaunch(''), Stop);
    assert.equal(shown(ui, 'account').length, 0, `${name}: no account screen, so no email form and no "Continue with" button`);
    assert.equal(shown(ui, 'problem').length, 1, name);
    assert.deepEqual(calls.map(call => `${call.method} ${call.url}`), [`GET ${HOSTED}`], `${name}: the only request is the question to the server`);
    assert.deepEqual(Object.keys(calls[0].headers), ['Accept'], 'and it carries no key');
    assert.equal(toSignInService().length, 0, name);
    assert.equal(native.asked.length, 0, `${name}: no sheet and no browser`);
  }
});

test('a server that names a different sign-in service is refused: no account screen, no sheet, no request to either service', async () => {
  for (const advertised of [EVIL, `${CONFIG.supabaseUrl}.evil.example`, CONFIG.supabaseUrl.replace('https://', 'http://'), '', null]) {
    const { onboarding, ui, calls, native, toSignInService } = rig({ routes: { [HOSTED]: reply(200, hostedInfo(advertised)) } });
    await assert.rejects(onboarding.firstLaunch(''), Stop);
    assert.equal(shown(ui, 'account').length, 0, String(advertised));
    assert.match(shown(ui, 'problem')[0].message, /does not trust/, String(advertised));
    assert.equal(calls.length, 1, String(advertised));
    assert.equal(toSignInService().length, 0, String(advertised));
    assert.equal(native.asked.length, 0, String(advertised));
  }
});

test('the same refusal when a hosted server is typed under "My own server", and when a remembered server has changed its answer', async () => {
  // Typed: the form's own check fails, so the flow never gets as far as an account screen.
  let refusal;
  const typed = rig({
    routes: { 'https://other.example/api/discovery': reply(200, hostedInfo(EVIL)) },
    ui: screens({ choices: ['own'], server: async ({ submit }) => { try { await submit('https://other.example'); } catch (error) { refusal = error; } return BACK; } }),
  });
  await assert.rejects(typed.onboarding.firstLaunch(''), Stop);
  assert.match(refusal.message, /does not trust/);
  assert.equal(refusal.field, 'server');
  assert.equal(shown(typed.ui, 'account').length, 0);
  assert.equal(typed.toSignInService().length, 0);
  assert.equal(typed.native.asked.length, 0);

  // Remembered: this phone signed in to the hosted service before; today that server names another sign-in service.
  const again = rig({ routes: { [HOSTED]: reply(200, hostedInfo(EVIL)) }, ui: screens({ problem: 'switch' }) });
  assert.equal(await again.onboarding.signInAgain({ v: 1, server: { kind: 'hosted', url: CONFIG.hostedServerUrl }, credential: null }, ''), null);
  assert.equal(shown(again.ui, 'account').length, 0);
  assert.match(shown(again.ui, 'problem')[0].message, /does not trust/);
  assert.equal(again.toSignInService().length, 0);
  assert.equal(again.native.asked.length, 0);
});

test('a hosted service this app trusts, typed under "My own server", goes to the account screen and says why there is no owner password', async () => {
  const r = rig({
    routes: { [HOSTED]: reply(200, hostedInfo()) },
    ui: screens({ choices: ['own'], server: (() => { let asked = false; return async ({ submit }) => { if (asked) return BACK; asked = true; return submit(CONFIG.hostedServerUrl); }; })() }),
  });
  await assert.rejects(r.onboarding.firstLaunch(''), Stop);
  const [account] = shown(r.ui, 'account');
  assert.equal(account.notice, 'app.little-archive.example is a hosted Little Archive service, so you sign in with an account, not an owner password.');
  assert.equal(shown(r.ui, 'password').length, 0);
});

test('after a discovery that names the pinned service, the account screen appears and every way in goes to that service only', async () => {
  let atAccount;
  const stages = [];
  const routes = {
    [HOSTED]: reply(200, hostedInfo()),
    [`POST ${CONFIG.supabaseUrl}/auth/v1/token?grant_type=password`]: reply(200, session),
    [`GET ${CONFIG.supabaseUrl}/auth/v1/settings`]: reply(200, { external: { google: true, apple: true } }),
    [`POST ${CONFIG.supabaseUrl}/auth/v1/token?grant_type=pkce`]: reply(200, session),
  };
  const r = rig({ routes, ui: screens({ account: async options => {
    atAccount = r.calls.map(call => call.url);
    assert.deepEqual({ ...options.providers }, { apple: true, google: true });
    // Closing the browser: nothing is said, nothing is kept.
    assert.equal(await options.social('google', stage => stages.push(stage)), null);
    return options.signIn('reader@example.com', 'a long password');
  } }) });
  r.native.browser = async options => { r.native.asked.push(['browser', options]); return { status: 'cancelled' }; };
  const record = await r.onboarding.firstLaunch('');
  assert.deepEqual(atAccount, [HOSTED], 'when the account screen was drawn, the server had been asked and nothing else had been sent');
  assert.equal(record.server.kind, 'hosted');
  assert.equal(record.credential.email, 'reader@example.com');
  assert.deepEqual(await r.store.load(), record, 'the sign-in is kept');
  for (const call of r.calls.slice(1)) assert.equal(new URL(call.url).host, PINNED, call.url);
  assert.equal(new URL(r.native.asked[0][1].url).host, PINNED, 'the browser is sent to the pinned service too');
  assert.deepEqual(stages, [], 'a closed browser never reaches the exchange');
});

test('the stage of a Google sign-in reaches the screen: "signing in" is said after the browser comes back and before the exchange', async () => {
  const order = [];
  const routes = {
    [HOSTED]: reply(200, hostedInfo()),
    [`GET ${CONFIG.supabaseUrl}/auth/v1/settings`]: reply(200, { external: { google: true } }),
    [`POST ${CONFIG.supabaseUrl}/auth/v1/token?grant_type=pkce`]: () => { order.push('exchange'); return reply(200, session); },
  };
  const r = rig({ platform: 'android', routes, ui: screens({ account: async options => {
    assert.deepEqual({ ...options.providers }, { apple: false, google: true });
    return options.social('google', stage => order.push(stage));
  } }) });
  r.native.browser = async () => { order.push('browser'); return { status: 'returned', url: 'littlearchive://auth-callback?code=abc' }; };
  const record = await r.onboarding.firstLaunch('');
  assert.deepEqual(order, ['browser', 'signing-in', 'exchange']);
  assert.equal(record.credential.refreshToken, 'refresh-1');
});

// A forgotten password -------------------------------------------------------------------------------------------------------

const RECOVER = `POST ${CONFIG.supabaseUrl}/auth/v1/recover?redirect_to=littlearchive%3A%2F%2Fauth-callback`;
const TRADE = `POST ${CONFIG.supabaseUrl}/auth/v1/token?grant_type=pkce`;
const NEW_PASSWORD = `PUT ${CONFIG.supabaseUrl}/auth/v1/user`;
const SIGN_OUT = `POST ${CONFIG.supabaseUrl}/auth/v1/logout?scope=local`;
const LINK = 'littlearchive://auth-callback?code=the-code';
const EXPIRED = 'littlearchive://auth-callback?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired';
const waitingOn = backend => backend.set('recovery', { v: 1, verifier: 'v'.repeat(64), server: CONFIG.hostedServerUrl, madeAt: Date.now() });
const sent = calls => calls.map(call => `${call.method} ${call.url}`);

test('without the phone\'s secure storage there is no "Forgot your password?", and with it the account screen offers one', async () => {
  const plain = rig({ routes: { [HOSTED]: reply(200, hostedInfo()) } });
  await assert.rejects(plain.onboarding.firstLaunch(''), Stop);
  assert.equal(shown(plain.ui, 'account')[0].forgot, false);
  const full = rig({ reset: true, routes: { [HOSTED]: reply(200, hostedInfo()) } });
  await assert.rejects(full.onboarding.firstLaunch(''), Stop);
  assert.equal(shown(full.ui, 'account')[0].forgot, true);
});

test('forgot your password: the request goes to the pinned service after discovery, and the answer on screen is the same for every address', async () => {
  const notices = [];
  for (const answer of [reply(200, {}), reply(429, { error_code: 'over_email_send_rate_limit' }), reply(400, { error_code: 'validation_failed' })]) {
    let visits = 0;
    const r = rig({ reset: true, routes: { [HOSTED]: reply(200, hostedInfo()), [RECOVER]: answer }, ui: screens({
      account: async () => { visits += 1; return visits === 1 ? { forgot: 'reader@example.com' } : BACK; },
      forgot: async ({ submit, email }) => { await submit(email); return 'sent'; },
    }) });
    await assert.rejects(r.onboarding.firstLaunch(''), Stop);
    const [form] = shown(r.ui, 'forgot');
    assert.equal(form.host, 'app.little-archive.example');
    assert.equal(form.email, 'reader@example.com', 'the address typed on the sign-in form is carried over');
    assert.deepEqual(sent(r.calls), [`GET ${HOSTED}`, RECOVER], 'the server was asked what it is before anything went to the sign-in service');
    assert.equal(new URL(r.calls[1].url).host, PINNED);
    assert.equal(JSON.parse(r.calls[1].body).email, 'reader@example.com');
    assert.equal((await r.backend.get('recovery')).server, CONFIG.hostedServerUrl);
    notices.push(shown(r.ui, 'account')[1].notice);
  }
  assert.deepEqual(notices, [RESET_SENT, RESET_SENT, RESET_SENT]);
  // Going back from the reset screen says nothing and sends nothing.
  let visits = 0;
  const back = rig({ reset: true, routes: { [HOSTED]: reply(200, hostedInfo()) }, ui: screens({ account: async () => { visits += 1; return visits === 1 ? { forgot: '' } : BACK; } }) });
  await assert.rejects(back.onboarding.firstLaunch(''), Stop);
  assert.equal(shown(back.ui, 'account')[1].notice, '');
  assert.equal(back.toSignInService().length, 0);
});

test('the reset link opens the app: the server is asked first, then the code is traded, the new password set, and the sign-in kept', async () => {
  let atNewPassword;
  const r = rig({ reset: true, routes: { [HOSTED]: reply(200, hostedInfo()), [TRADE]: reply(200, session), [NEW_PASSWORD]: reply(200, { id: 'user-1' }) }, ui: screens({
    newPassword: async ({ submit }) => { atNewPassword = sent(r.calls); assert.equal(await r.store.load(), null, 'nothing is kept before the password is set'); await submit('a brand new password'); return 'saved'; },
  }) });
  await waitingOn(r.backend);
  r.links.push(LINK); // what boot.js does with the address the app was started by
  const record = await r.onboarding.firstLaunch('');
  assert.deepEqual(r.ui.drawn.map(entry => entry.screen), ['working', 'newPassword'], 'no first screen in between');
  assert.equal(shown(r.ui, 'working')[0].message, 'Opening your reset link…');
  assert.equal(shown(r.ui, 'newPassword')[0].email, 'reader@example.com');
  assert.deepEqual(atNewPassword, [`GET ${HOSTED}`, TRADE]);
  assert.deepEqual(sent(r.calls), [`GET ${HOSTED}`, TRADE, NEW_PASSWORD]);
  assert.deepEqual(Object.keys(r.calls[0].headers), ['Accept'], 'the question to the server carries no key');
  assert.deepEqual(JSON.parse(r.calls[1].body), { auth_code: 'the-code', code_verifier: 'v'.repeat(64) });
  assert.equal(r.calls[2].headers.Authorization, `Bearer ${session.access_token}`);
  assert.deepEqual(JSON.parse(r.calls[2].body), { password: 'a brand new password' });
  assert.equal(record.server.kind, 'hosted');
  assert.equal(record.credential.refreshToken, 'refresh-1');
  assert.deepEqual(await r.store.load(), record);
  assert.equal(await r.backend.get('recovery'), null);
});

test('a reset link is held to the same order as a sign-in: before the server has answered, or when it names another service, nothing goes to any sign-in service', async () => {
  for (const [name, answer] of Object.entries({ 'the server cannot be reached': new Error('offline'), 'the server names another sign-in service': reply(200, hostedInfo(EVIL)), 'the server answers as self-hosted': reply(200, { name: 'little-archive', version: '0.1.0', api: 1, mode: 'self-hosted', auth: { methods: ['device-token'], device_token_url: '/api/auth/devices' } }) })) {
    const r = rig({ reset: true, routes: { [HOSTED]: answer }, ui: screens({ choices: ['own'] }) });
    await waitingOn(r.backend);
    r.links.push(LINK);
    await assert.rejects(r.onboarding.firstLaunch(''), Stop);
    assert.equal(shown(r.ui, 'newPassword').length, 0, name);
    assert.equal(shown(r.ui, 'account').length, 0, name);
    assert.equal(r.toSignInService().length, 0, name);
    assert.ok(r.calls.every(call => call.url === HOSTED), name);
    assert.equal(await r.store.load(), null, name);
    assert.ok(await r.backend.get('recovery'), `${name}: the verifier is still there for when the link can be opened`);
  }
});

test('a link that ran out, was used, or was not asked for on this phone gets a plain sentence and a way to ask again', async () => {
  const cases = [
    { name: 'the project says the emailed link ran out', link: EXPIRED, waiting: true, routes: {}, message: LINK_ENDED },
    { name: 'the project refuses the code', link: LINK, waiting: true, routes: { [TRADE]: reply(422, { error_code: 'flow_state_expired' }) }, message: LINK_ENDED },
    { name: 'nothing was asked for on this phone', link: LINK, waiting: false, routes: {}, message: LINK_NOT_ASKED },
  ];
  for (const { name, link, waiting, routes, message } of cases) {
    let visits = 0;
    const r = rig({ reset: true, routes: { [HOSTED]: reply(200, hostedInfo()), [RECOVER]: reply(200, {}), ...routes }, ui: screens({
      problem: 'again', forgot: async ({ submit }) => { await submit('reader@example.com'); return 'sent'; },
      account: async () => { visits += 1; return BACK; },
    }) });
    if (waiting) await waitingOn(r.backend);
    r.links.push(link);
    await assert.rejects(r.onboarding.firstLaunch(''), Stop);
    const [problem] = shown(r.ui, 'problem');
    assert.equal(problem.title, 'That reset link did not work', name);
    assert.equal(problem.message, message, name);
    assert.deepEqual(problem.actions.map(action => action.label), ['Ask for a new link', 'Back'], name);
    assert.ok(!/Email link is invalid/.test(problem.message), 'the text the address carried is never shown');
    // "Ask for a new link" goes to the reset screen and then to the account screen with the usual sentence.
    assert.equal(shown(r.ui, 'forgot').length, 1, name);
    assert.equal(shown(r.ui, 'account')[0].notice, RESET_SENT, name);
    assert.equal(shown(r.ui, 'newPassword').length, 0, name);
    assert.equal(r.calls[0].url, HOSTED, `${name}: the server was asked first`);
  }
});

test('cancelling on the new-password screen ends the link\'s session and keeps nothing', async () => {
  const r = rig({ reset: true, routes: { [HOSTED]: reply(200, hostedInfo()), [TRADE]: reply(200, session), [SIGN_OUT]: reply(204, {}) }, ui: screens({ choices: ['own'] }) });
  await waitingOn(r.backend);
  r.links.push(LINK);
  await assert.rejects(r.onboarding.firstLaunch(''), Stop);
  assert.deepEqual(sent(r.calls), [`GET ${HOSTED}`, TRADE, SIGN_OUT]);
  assert.equal(r.calls[2].headers.Authorization, `Bearer ${session.access_token}`);
  assert.equal(await r.store.load(), null);
  assert.deepEqual(r.ui.drawn.map(entry => entry.screen), ['working', 'newPassword', 'choose', 'server', 'choose']);
  assert.equal(shown(r.ui, 'choose')[0].notice, '');
});

test('a link that arrives while a sign-in screen is up takes over from it', async () => {
  let r;
  const ui = screens({
    account: () => new Promise(() => { setTimeout(() => r.links.push(LINK), 0); }), // the person is in their mail app; the screen never answers
    newPassword: async ({ submit }) => { await submit('a brand new password'); return 'saved'; },
  });
  r = rig({ reset: true, ui, routes: { [HOSTED]: reply(200, hostedInfo()), [TRADE]: reply(200, session), [NEW_PASSWORD]: reply(200, {}) } });
  await waitingOn(r.backend);
  const record = await r.onboarding.signInAgain({ v: 1, server: { kind: 'hosted', url: CONFIG.hostedServerUrl }, credential: null }, 'Your sign-in ended.');
  assert.equal(record.credential.email, 'reader@example.com');
  assert.deepEqual(r.ui.drawn.map(entry => entry.screen), ['working', 'account', 'working', 'newPassword']);
});

test('Android, no reset asked for: a callback that reached a fresh process is the interrupted Google sign-in, said once, and its code is never used', async () => {
  const r = rig({ reset: true, platform: 'android', routes: {}, ui: screens({ choices: ['own'] }) });
  r.links.push(LINK);
  await assert.rejects(r.onboarding.firstLaunch(''), Stop);
  assert.equal(shown(r.ui, 'choose')[0].notice, INTERRUPTED);
  assert.equal(r.calls.length, 0, 'nothing is asked of any server');
  assert.equal(shown(r.ui, 'problem').length, 0);
  // With a reset waiting, the same address is the link.
  const waiting = rig({ reset: true, platform: 'android', routes: { [HOSTED]: reply(200, hostedInfo()), [TRADE]: reply(200, session), [NEW_PASSWORD]: reply(200, {}) }, ui: screens({ newPassword: async ({ submit }) => { await submit('a brand new password'); return 'saved'; } }) });
  await waitingOn(waiting.backend);
  waiting.links.push(LINK);
  assert.equal((await waiting.onboarding.firstLaunch('')).credential.email, 'reader@example.com');
});
