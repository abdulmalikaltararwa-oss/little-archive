// The account screen (src/ui.js) in a DOM: the lock that keeps two sign-ins from overlapping, where focus goes, how an error is
// shown and what a screen reader is told. The DOM is jsdom from the interface's own install (ui/node_modules, where the build
// already finds vite), so nothing is added to mobile/; without it these tests skip, as they do in a job that installs only mobile/.
// jsdom does no layout and no :focus-visible, so what is checked is state: disabled, document.activeElement, attributes, text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { AppError } from '../src/discovery.js';
import { BACK, createUi } from '../src/ui.js';

let JSDOM;
try { ({ JSDOM } = createRequire(new URL('../../ui/package.json', import.meta.url))('jsdom')); } catch { /* skipped below */ }
const skip = JSDOM ? false : 'jsdom is not installed (run `npm ci` in ui/)';

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

/** A page with the screen drawn on it. `social`, `signIn` and `signUp` are scripted per test; every call is written down. */
function open(t, { providers = { apple: true, google: true }, social, signIn, signUp, notice, mode } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { pretendToBeVisual: true });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = () => {}; // jsdom has no layout
  const before = { document: globalThis.document, Node: globalThis.Node };
  globalThis.document = window.document;
  globalThis.Node = window.Node;
  t.after(() => { globalThis.document = before.document; globalThis.Node = before.Node; window.close(); });
  const calls = { social: [], signIn: [], signUp: [] };
  const ui = createUi(window.document.getElementById('app'), { iconUrl: 'icon.svg' });
  const result = ui.account({
    host: 'app.little-archive.example', notice, mode, providers,
    social: social && ((name, onStage) => { calls.social.push(name); return social(name, onStage); }),
    signIn: (...args) => { calls.signIn.push(args); return signIn(...args); },
    signUp: (...args) => { calls.signUp.push(args); return signUp(...args); },
  });
  const $ = selector => window.document.querySelector(selector);
  const all = selector => [...window.document.querySelectorAll(selector)];
  const byText = text => all('.native-screen button').find(button => button.textContent.trim() === text);
  const page = {
    window, calls, result, $, all, byText,
    get active() { return window.document.activeElement; },
    get body() { return window.document.body; },
    get buttons() { return all('.native-screen button'); },
    get live() { return $('[aria-live]').textContent; },
    apple: () => $('.native-social-apple'), google: () => $('.native-social-google'),
    submitButton: () => $('form button[type=submit]'),
    providerError: () => $('.native-socials .native-error'),
    formError: () => $('form .native-error-general'),
    fill(email = 'reader@example.com', password = 'a long password') { $('input[name=email]').value = email; $('input[name=password]').value = password; },
    /** What Return in a field, or the form's button, does. */
    send() { $('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); },
    touch(node) { node.dispatchEvent(new window.Event('pointerdown', { bubbles: true })); node.click(); },
    key(node, key = 'Enter') { node.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true })); },
  };
  return page;
}

const names = buttons => buttons.map(button => button.textContent.trim());
const usable = page => page.buttons.filter(button => !button.disabled);

test('arriving: with the "Continue with" buttons showing the keyboard stays down, and focus is on the heading, not the page body', { skip }, t => {
  const page = open(t, { social: async () => null });
  assert.deepEqual(names(page.buttons), ['Continue with Apple', 'Continue with Google', 'Sign in', 'Create account', 'Show password', 'Sign in', 'Back']);
  assert.notEqual(page.active.tagName, 'INPUT', 'the email field is not focused, so the keyboard does not cover the buttons');
  assert.equal(page.active, page.$('h1'));
  assert.equal(page.active.textContent, 'Welcome back');
  assert.equal(page.$('h1').getAttribute('tabindex'), '-1', 'the heading takes focus but is not a tab stop');
  // The provider buttons are not in the form, so Return in a field cannot press one.
  assert.equal(page.apple().closest('form'), null);
  assert.equal(page.google().type, 'button');
});

test('arriving: with no "Continue with" button the email field takes focus; with a notice, the notice does', { skip }, t => {
  const plain = open(t, { providers: { apple: false, google: false }, social: async () => null });
  assert.equal(plain.all('.native-social').length, 0);
  assert.equal(plain.active, plain.$('input[name=email]'));
  const told = open(t, { notice: 'Your sign-in ended. Sign in again to open your library.', social: async () => null });
  assert.equal(told.active, told.$('.notice'));
  assert.equal(told.active.getAttribute('role'), 'status');
  assert.match(told.active.textContent, /Your sign-in ended/);
});

test('the lock, from a provider: while Google is open nothing else can start a sign-in, by button or by Return', { skip }, async t => {
  const pending = deferred();
  let stage;
  const page = open(t, { social: (name, onStage) => { stage = onStage; return pending.promise; }, signIn: async () => assert.fail('the email form was sent while Google was open') });
  page.fill();
  page.touch(page.google());
  await tick();
  assert.deepEqual(usable(page), [], 'the tabs, both provider buttons, the form\'s button, Back and the rest are all disabled');
  assert.equal(page.google().getAttribute('aria-busy'), 'true');
  assert.equal(page.google().textContent, 'Opening Google…');
  assert.equal(page.apple().textContent, 'Continue with Apple');
  // Each of these would have started something before.
  page.apple().click();
  page.byText('Create account').click();
  page.byText('Back').click();
  page.send();
  page.google().click();
  await tick();
  assert.deepEqual(page.calls.social, ['google']);
  assert.equal(page.calls.signIn.length, 0);
  assert.equal(page.$('h1').textContent, 'Welcome back', 'the tab did not switch');
  assert.equal(page.$('input[name=email]').disabled, false, 'fields are left alone: disabling one would drop focus and the keyboard');
  await tick(80);
  assert.equal(page.live, 'Opening Google…', 'the busy state is announced');

  // The browser is back with a code and the session is being fetched: the words change, the lock stays.
  stage('signing-in');
  assert.equal(page.google().textContent, 'Signing in…');
  assert.equal(page.google().getAttribute('aria-busy'), 'true');
  assert.deepEqual(usable(page), []);
  await tick(80);
  assert.equal(page.live, 'Signing in…');

  // The person closed it: everything works again, nothing is said, and focus is back on the button they pressed.
  pending.resolve(null);
  await tick();
  assert.equal(usable(page).length, page.buttons.length);
  assert.equal(page.google().textContent, 'Continue with Google');
  assert.equal(page.google().hasAttribute('aria-busy'), false);
  assert.equal(page.providerError().hidden, true);
  assert.equal(page.active, page.google());
  assert.notEqual(page.active, page.body);
});

test('the lock, from the email form: while it is being sent the provider buttons, the tabs and Back are inert, and it cannot be sent twice', { skip }, async t => {
  const pending = deferred();
  const page = open(t, { social: async () => assert.fail('a provider started while the email sign-in was on its way'), signIn: () => pending.promise });
  page.fill();
  page.$('input[name=password]').focus();
  page.send();
  await tick();
  assert.deepEqual(usable(page), []);
  assert.equal(page.submitButton().textContent, 'Signing in…');
  assert.equal(page.submitButton().getAttribute('aria-busy'), 'true');
  page.google().click();
  page.apple().click();
  page.byText('Create account').click();
  page.byText('Back').click();
  page.send();
  await tick();
  assert.deepEqual(page.calls.signIn, [['reader@example.com', 'a long password']], 'sent once');
  assert.equal(page.calls.social.length, 0);
  assert.equal(page.active, page.$('input[name=password]'), 'focus stays in the field that was being typed in');

  pending.reject(new AppError('That email and password did not match. Check them and try again.'));
  await tick();
  assert.equal(usable(page).length, page.buttons.length, 'usable again after a failure');
  assert.equal(page.formError().hidden, false);
  assert.equal(page.formError().getAttribute('role'), 'alert');
  assert.match(page.formError().textContent, /did not match/);
  assert.equal(page.submitButton().textContent, 'Sign in');
  assert.equal(page.$('input[name=password]').value, 'a long password', 'a failed attempt keeps what was typed');
  assert.notEqual(page.active, page.body);
});

test('the email form sent from its button: the button loses focus when it is disabled, and gets it back when the attempt fails', { skip }, async t => {
  const pending = deferred();
  const page = open(t, { social: async () => null, signIn: () => pending.promise });
  page.fill();
  page.submitButton().focus();
  page.send();
  await tick();
  pending.reject(new AppError('The sign-in service is having trouble. Try again in a moment.'));
  await tick();
  assert.equal(page.active, page.submitButton());
});

test('a sign-in that worked answers once: the screen stays locked until the app replaces it, so a second one cannot start behind it', { skip }, async t => {
  const session = { credential: { type: 'supabase' } };
  const viaGoogle = open(t, { social: async () => session, signIn: async () => assert.fail('a second sign-in started') });
  viaGoogle.fill();
  viaGoogle.touch(viaGoogle.google());
  assert.equal(await viaGoogle.result, session);
  assert.deepEqual(usable(viaGoogle), []);
  viaGoogle.send(); viaGoogle.apple().click(); viaGoogle.byText('Back').click();
  await tick();
  assert.deepEqual(viaGoogle.calls.social, ['google']);

  const viaEmail = open(t, { social: async () => assert.fail('a second sign-in started'), signIn: async () => session });
  viaEmail.fill();
  viaEmail.send();
  assert.equal(await viaEmail.result, session);
  await tick();
  assert.deepEqual(usable(viaEmail), []);
  viaEmail.google().click(); viaEmail.send();
  await tick();
  assert.equal(viaEmail.calls.signIn.length, 1);
  assert.equal(viaEmail.$('input[name=password]').value, '', 'the password does not linger in the page');

  const back = open(t, { social: async () => null });
  back.byText('Back').click();
  assert.equal(await back.result, BACK);
});

test('a provider that fails: the reason is shown under the buttons, tied to the button that was pressed, and focus returns to it', { skip }, async t => {
  let attempt = 0;
  const page = open(t, { social: async () => { attempt += 1; if (attempt === 1) throw new AppError('Google sign-in is not switched on yet. Use your email and password for now.'); return null; } });
  page.touch(page.google());
  await tick();
  const error = page.providerError();
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /Google sign-in is not switched on yet/);
  assert.ok(error.id);
  assert.equal(page.google().getAttribute('aria-describedby'), error.id, 'a screen reader reads the reason with the button');
  assert.equal(page.apple().hasAttribute('aria-describedby'), false, 'and not with the other one');
  assert.equal(page.active, page.google());
  assert.equal(usable(page).length, page.buttons.length);
  assert.equal(page.google().textContent, 'Continue with Google');
  // Trying again clears it (this time the browser is closed, which says nothing).
  page.touch(page.google());
  await tick();
  assert.equal(page.providerError().hidden, true);
  assert.equal(page.google().hasAttribute('aria-describedby'), false);
  // Something that is not a sentence still gets one.
  const odd = open(t, { social: async () => { throw Object.assign(new Error(''), {}); } });
  odd.touch(odd.apple());
  await tick();
  assert.match(odd.providerError().textContent, /Something went wrong\. Try again\./);
  assert.equal(odd.active, odd.apple());
});

test('focus returned to a button after a touch shows no focus ring; after a key it does', { skip }, async t => {
  const page = open(t, { social: async () => null });
  page.touch(page.google());
  await tick();
  assert.equal(page.active, page.google());
  assert.ok(page.google().classList.contains('native-quiet'), 'pressed with a finger: focused quietly');
  page.google().blur();
  assert.equal(page.google().classList.contains('native-quiet'), false, 'only until focus leaves it');
  // The same button, pressed from a keyboard.
  page.google().focus();
  page.key(page.google());
  page.google().click();
  await tick();
  assert.equal(page.active, page.google());
  assert.equal(page.google().classList.contains('native-quiet'), false, 'pressed with a key: the ring is wanted');
});

test('switching between Sign in and Create account puts focus on the new heading', { skip }, async t => {
  const page = open(t, { social: async () => null });
  page.touch(page.byText('Create account'));
  assert.equal(page.$('h1').textContent, 'Create your account');
  assert.equal(page.active, page.$('h1'));
  assert.deepEqual(page.all('.native-tabs button').map(tab => tab.getAttribute('aria-pressed')), ['false', 'true']);
  assert.equal(page.$('input[name=password]').getAttribute('autocomplete'), 'new-password');
  page.touch(page.all('.native-tabs button')[0]);
  assert.equal(page.$('h1').textContent, 'Welcome back');
  assert.equal(page.active, page.$('h1'));
  // Pressing the tab that is already chosen redraws nothing, so focus stays where it is.
  const tab = page.all('.native-tabs button')[0];
  tab.focus(); tab.click();
  assert.equal(page.active, tab);
});

test('after "we sent you a message" the screen is redrawn on Sign in and focus is on the notice', { skip }, async t => {
  const page = open(t, { mode: 'up', social: async () => null, signUp: async () => ({ confirmationSent: true }) });
  assert.equal(page.$('h1').textContent, 'Create your account');
  page.fill('  new.reader@example.com ', 'a long password');
  page.submitButton().focus();
  page.send();
  await tick();
  assert.deepEqual(page.calls.signUp, [['new.reader@example.com', 'a long password']]);
  assert.equal(page.$('h1').textContent, 'Welcome back');
  const notice = page.$('.notice');
  assert.match(notice.textContent, /We sent a message to new\.reader@example\.com/);
  assert.equal(page.active, notice);
  assert.equal(usable(page).length, page.buttons.length, 'and the new screen is not left locked');
  assert.equal(page.$('input[name=password]').value, '');
});
