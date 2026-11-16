// The screens of a forgotten password (src/ui.js) in a DOM: the "Forgot your password?" button on the account screen, the screen
// that asks for the email, and the one that takes the new password. What is checked is what a person and a screen reader get:
// labels, where focus goes, how an error is tied to its field, what is disabled. jsdom comes from the interface's install
// (ui/node_modules), as in account-screen.test.mjs; without it these skip. Sizes (44px) are native.css's and are checked by class.
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

function open(t, draw) {
  const { window } = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { pretendToBeVisual: true });
  window.Element.prototype.scrollIntoView = () => {};
  const before = { document: globalThis.document, Node: globalThis.Node };
  globalThis.document = window.document;
  globalThis.Node = window.Node;
  t.after(() => { globalThis.document = before.document; globalThis.Node = before.Node; window.close(); });
  const ui = createUi(window.document.getElementById('app'), { iconUrl: 'icon.svg' });
  const result = draw(ui);
  const $ = selector => window.document.querySelector(selector);
  const all = selector => [...window.document.querySelectorAll(selector)];
  return {
    window, result, $, all,
    byText: text => all('.native-screen button').find(button => (button.getAttribute('aria-label') || button.textContent.trim()) === text),
    get active() { return window.document.activeElement; },
    get live() { return $('[aria-live]').textContent; },
    labelOf: input => $(`label[for=${input.id}]`).textContent,
    described: input => (input.getAttribute('aria-describedby') || '').split(' ').filter(Boolean).map(id => window.document.getElementById(id).textContent).join(' '),
    send() { $('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); },
  };
}

const account = (t, options = {}) => open(t, ui => ui.account({ host: 'app.little-archive.example', providers: { apple: true, google: true }, social: async () => null, signIn: async () => assert.fail('not sent'), signUp: async () => assert.fail('not sent'), ...options }));

test('the account screen: "Forgot your password?" is on the Sign in view only, at the end of the password\'s label, and hands over the email typed so far', { skip }, async t => {
  const page = account(t, { forgot: true });
  const button = page.byText('Forgot your password?');
  assert.ok(button, 'the button is there');
  assert.equal(button.type, 'button', 'Return in a field still signs in');
  assert.ok(button.classList.contains('native-textlink'), 'a text link with a 44px area to press (native.css; account-screen.test.mjs reads the rule)');
  assert.equal(button.parentElement, page.$(`label[for=${page.$('input[name=password]').id}]`).parentElement, 'in the password label\'s row, so it adds no height');
  assert.deepEqual(page.all('form button').map(node => node.getAttribute('aria-label') || node.textContent.trim()), ['Forgot your password?', 'Show password', 'Sign in', 'Create an account', 'Back']);
  // Creating an account has no password to forget.
  page.byText('Create an account').click();
  assert.equal(button.hidden, true);
  page.byText('Sign in').click();
  assert.equal(button.hidden, false);
  page.$('input[name=email]').value = '  reader@example.com ';
  page.byText('Forgot your password?').click();
  assert.deepEqual(await page.result, { forgot: 'reader@example.com' });
  // Without the option (a build with no reset) there is no button.
  assert.equal(account(t).byText('Forgot your password?'), undefined);
});

test('the account screen: the forgot button is under the screen\'s lock, like every other way off the screen', { skip }, async t => {
  const pending = deferred();
  const page = account(t, { forgot: true, social: () => pending.promise });
  let settled = false;
  page.result.then(() => { settled = true; });
  page.$('.native-social-google').click();
  await tick();
  assert.equal(page.byText('Forgot your password?').disabled, true);
  page.byText('Forgot your password?').click();
  await tick();
  assert.equal(settled, false);
  pending.resolve(null);
  await tick();
  assert.equal(page.byText('Forgot your password?').disabled, false);
});

const forgot = (t, options = {}) => open(t, ui => ui.forgot({ host: 'app.little-archive.example', submit: async () => {}, ...options }));

test('the reset screen: focus on the heading, a labelled email field carried over, and the request sent once with the address trimmed', { skip }, async t => {
  const asked = [];
  const pending = deferred();
  const page = forgot(t, { email: 'reader@example.com', submit: email => { asked.push(email); return pending.promise; } });
  assert.equal(page.active, page.$('h1'));
  assert.equal(page.$('h1').textContent, 'Reset your password');
  assert.equal(page.$('h1').getAttribute('tabindex'), '-1');
  const field = page.$('input[name=email]');
  assert.equal(page.labelOf(field), 'Email');
  assert.equal(field.type, 'email');
  assert.equal(field.getAttribute('autocomplete'), 'username');
  assert.equal(field.value, 'reader@example.com');
  assert.match(page.$('.native-whisper').textContent, /^account on app\.little-archive\.example$/);
  assert.match(page.$('.native-lede').textContent, /^If this email has an account, we send it a link/, 'the same words for every address');
  field.value = ' reader@example.com  ';
  page.send();
  await tick();
  const button = page.$('form button[type=submit]');
  assert.equal(button.textContent, 'Sending…');
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(button.disabled, true);
  page.send();
  await tick();
  assert.deepEqual(asked, ['reader@example.com'], 'a second Return while it is on its way sends nothing');
  pending.resolve();
  assert.equal(await page.result, 'sent');
});

test('the reset screen: an empty or malformed address stays on the field, and not reaching the service is an alert', { skip }, async t => {
  const page = forgot(t, { submit: async () => assert.fail('nothing was sent') });
  const field = page.$('input[name=email]');
  for (const value of ['', 'not-an-address']) {
    field.value = value;
    page.send();
    await tick();
    assert.equal(field.getAttribute('aria-invalid'), 'true', value);
    assert.equal(page.active, field, value);
    assert.ok(page.described(field).length > 0, 'the reason is tied to the field');
  }
  const offline = forgot(t, { email: 'reader@example.com', submit: async () => { throw new AppError('Could not reach the sign-in service. Check your connection and try again.'); } });
  offline.send();
  await tick();
  const alert = offline.$('form [role=alert]');
  assert.equal(alert.hidden, false);
  assert.match(alert.textContent, /Could not reach the sign-in service/);
  assert.equal(offline.$('form button[type=submit]').disabled, false, 'the form can be sent again');
  offline.byText('Back to sign in').click();
  assert.equal(await offline.result, BACK);
});

const fresh = (t, options = {}) => open(t, ui => ui.newPassword({ email: 'reader@example.com', submit: async () => {}, ...options }));
const type = (page, password, again = password) => { page.$('input[name=password]').value = password; page.$('input[name=confirm]').value = again; };

test('the new-password screen: focus on the heading, two labelled fields with the sign-up rule and a show-password eye each', { skip }, t => {
  const page = fresh(t);
  assert.equal(page.active, page.$('h1'));
  assert.equal(page.$('h1').textContent, 'Choose a new password');
  assert.match(page.$('.native-lede').textContent, /^For reader@example\.com\./);
  const [password, confirm] = [page.$('input[name=password]'), page.$('input[name=confirm]')];
  assert.equal(page.labelOf(password), 'New password');
  assert.equal(page.labelOf(confirm), 'New password, again');
  for (const field of [password, confirm]) {
    assert.equal(field.type, 'password');
    assert.equal(field.getAttribute('autocomplete'), 'new-password');
    assert.equal(field.required, true);
  }
  assert.equal(password.getAttribute('minlength'), '8');
  assert.equal(page.described(password), 'At least 8 characters', 'the same rule the sign-up form states');
  assert.equal(page.described(confirm), '');
  // Show and hide, each field on its own, as on the sign-up form.
  const toggles = page.all('.native-eye');
  assert.equal(toggles.length, 2);
  toggles[0].click();
  assert.equal(password.type, 'text');
  assert.equal(confirm.type, 'password');
  assert.equal(toggles[0].getAttribute('aria-label'), 'Show password');
  assert.equal(toggles[1].getAttribute('aria-pressed'), 'false');
  assert.equal(toggles[0].getAttribute('aria-pressed'), 'true');
  toggles[0].click();
  assert.equal(password.type, 'password');
  // For a password manager: the account the new password belongs to, not shown and not a tab stop.
  const account = page.$('input[autocomplete=username]');
  assert.equal(account.value, 'reader@example.com');
  assert.equal(account.hidden, true);
  // With no email (an Apple account that withheld it), the sentence does not say "For ."
  assert.equal(fresh(t, { email: '' }).$('.native-lede').textContent, 'When it is saved you are signed in.');
});

test('the new-password screen: two entries that differ, or a short one, stop on the field that is wrong and send nothing', { skip }, async t => {
  const page = fresh(t, { submit: async () => assert.fail('nothing was sent') });
  const [password, confirm] = [page.$('input[name=password]'), page.$('input[name=confirm]')];
  type(page, 'a brand new password', 'a brand new passwrod');
  page.send();
  await tick();
  assert.equal(confirm.getAttribute('aria-invalid'), 'true');
  assert.equal(password.getAttribute('aria-invalid'), 'false');
  assert.ok(page.described(confirm).endsWith('The two passwords are not the same. Type the new password again.'));
  assert.equal(page.active, confirm, 'focus is on the field to fix, where the reason is read with it');
  assert.equal(confirm.value, 'a brand new passwrod', 'what was typed is still there to correct');
  type(page, 'short');
  page.send();
  await tick();
  assert.equal(password.getAttribute('aria-invalid'), 'true');
  assert.match(page.described(password), /Use at least 8 characters\./);
  assert.equal(page.active, password);
  assert.equal(confirm.getAttribute('aria-invalid'), 'false', 'the earlier error is gone');
  type(page, '');
  page.send();
  await tick();
  assert.equal(password.getAttribute('aria-invalid'), 'true');
  assert.equal(page.active, password);
});

test('the new-password screen: what the service refuses is shown where it belongs, and a saved password leaves nothing in the page', { skip }, async t => {
  const answers = [new AppError('That password is too easy to guess. Use a longer one.', { field: 'password' }), new AppError('This reset has run out. Go back and ask for a new link.'), null];
  const sent = [];
  const page = fresh(t, { submit: async password => { sent.push(password); const answer = answers.shift(); if (answer) throw answer; } });
  const password = page.$('input[name=password]');
  type(page, 'password1');
  page.send();
  await tick();
  assert.match(page.described(password), /too easy to guess/);
  assert.equal(page.active, password);
  page.send();
  await tick();
  const alert = page.$('form [role=alert]');
  assert.equal(alert.hidden, false);
  assert.equal(alert.textContent.includes('This reset has run out. Go back and ask for a new link.'), true);
  assert.equal(password.getAttribute('aria-invalid'), 'false');
  type(page, 'a brand new password');
  page.send();
  assert.equal(await page.result, 'saved');
  assert.deepEqual(sent, ['password1', 'password1', 'a brand new password']);
  await tick();
  assert.equal(password.value, '');
  assert.equal(page.$('input[name=confirm]').value, '');
});

test('the new-password screen: Cancel leaves, and while the password is being saved nothing can be pressed twice', { skip }, async t => {
  const pending = deferred();
  let calls = 0;
  const page = fresh(t, { submit: () => { calls += 1; return pending.promise; } });
  type(page, 'a brand new password');
  page.send();
  await tick();
  const button = page.$('form button[type=submit]');
  assert.equal(button.textContent, 'Saving…');
  assert.equal(button.disabled, true);
  page.send();
  await tick();
  assert.equal(calls, 1);
  pending.reject(new AppError('Could not reach the sign-in service. Check your connection and try again.'));
  await tick();
  assert.equal(button.textContent, 'Save password and sign in');
  page.byText('Cancel').click();
  assert.equal(await page.result, BACK);
});

test('a problem screen puts focus on its heading and says its message as an alert', { skip }, async t => {
  const page = open(t, ui => ui.problem({ title: 'That reset link did not work', message: 'That reset link has run out or was already used.', actions: [{ label: 'Ask for a new link', value: 'again', primary: true }, { label: 'Back', value: 'back' }] }));
  assert.equal(page.active, page.$('h1'));
  assert.equal(page.$('[role=alert]').textContent, 'That reset link has run out or was already used.');
  page.byText('Ask for a new link').click();
  assert.equal(await page.result, 'again');
});

test('a screen that was replaced while its sign-in was on its way cannot lock or unlock the screen that took its place', { skip }, async t => {
  // A reset link opens the app while the email sign-in is still being sent: the account screen is abandoned for the new-password
  // screen, and the sign-in's answer arrives afterwards.
  for (const outcome of ['signs in', 'fails']) {
    const pending = deferred();
    let ui;
    const page = open(t, made => { ui = made; return made.account({ host: 'app.little-archive.example', providers: { apple: true, google: true }, social: async () => null, signIn: () => pending.promise, signUp: async () => null, forgot: true }); });
    page.$('input[name=email]').value = 'reader@example.com';
    page.$('input[name=password]').value = 'a long password';
    page.send();
    await tick();
    assert.ok(page.all('.native-screen button').every(button => button.disabled), 'the account screen is locked while it signs in');
    ui.newPassword({ email: 'reader@example.com', submit: async () => {} });
    assert.equal(page.$('h1').textContent, 'Choose a new password');
    assert.ok(page.all('.native-screen button').every(button => !button.disabled));
    if (outcome === 'signs in') pending.resolve({ credential: {} }); else pending.reject(new AppError('That email and password did not match. Check them and try again.'));
    await tick();
    assert.equal(page.$('h1').textContent, 'Choose a new password', outcome);
    assert.ok(page.all('.native-screen button').every(button => !button.disabled), `${outcome}: Save, Cancel and the toggles still work`);
    assert.equal(page.active, page.$('h1'), `${outcome}: focus was not pulled away`);
  }
});
