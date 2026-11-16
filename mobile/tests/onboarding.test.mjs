// The order the app really signs in by (src/onboarding.js, which boot.js runs): the server is asked what it is before any
// sign-in is offered, and a hosted sign-in is offered only when the server names the sign-in service in app.config.json. These
// tests drive the same functions boot.js calls, with scripted screens, a scripted HTTP client and a scripted plugin, and look
// at what was drawn and what was requested. The pin is not something a test passes in: it comes out of discovery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnboarding } from '../src/onboarding.js';
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
function screens({ choices = ['hosted'], account = async () => BACK, problem = 'back', server = async () => BACK } = {}) {
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
  };
}

function plugin() {
  const asked = [];
  return { asked, browser: async options => { asked.push(['browser', options]); return { status: 'cancelled' }; }, apple: async options => { asked.push(['apple', options]); return { status: 'cancelled' }; } };
}

function rig({ routes, ui = screens(), platform = 'ios' } = {}) {
  const fake = fakeHttp(routes);
  const native = plugin();
  const backend = memoryBackend();
  const store = createStore(backend);
  const onboarding = createOnboarding({ http: fake.http, config: CONFIG, ui, store, platform, plugin: native });
  const toSignInService = () => fake.calls.filter(call => /supabase|\/auth\/v1\//.test(call.url));
  return { ...fake, ui, native, store, onboarding, toSignInService };
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
