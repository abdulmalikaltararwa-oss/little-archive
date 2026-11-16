// The garden on the first-launch, sign-in, reset and own-server screens (src/garden.js, drawn by src/ui.js) in a DOM: it is
// there, it is decoration that a screen reader and the keyboard never meet, and the screen under it is what it was (one <h1>,
// the same place for focus). jsdom comes from the interface's install (ui/node_modules), as in account-screen.test.mjs;
// without it these skip. jsdom does no layout and applies no stylesheet, so what the garden looks like, that it is still while
// there is an error and that it goes while the keyboard is up are native.css's: the rules are read as text at the end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createUi } from '../src/ui.js';

let JSDOM;
try { ({ JSDOM } = createRequire(new URL('../../ui/package.json', import.meta.url))('jsdom')); } catch { /* skipped below */ }
const skip = JSDOM ? false : 'jsdom is not installed (run `npm ci` in ui/)';
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

function open(t, draw) {
  const { window } = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { pretendToBeVisual: true });
  window.Element.prototype.scrollIntoView = () => {};
  const before = { document: globalThis.document, Node: globalThis.Node };
  globalThis.document = window.document;
  globalThis.Node = window.Node;
  t.after(() => { globalThis.document = before.document; globalThis.Node = before.Node; window.close(); });
  const ui = createUi(window.document.getElementById('app'), { iconUrl: 'icon.svg' });
  draw(ui);
  const all = selector => [...window.document.querySelectorAll(selector)];
  return { window, ui, all, $: selector => window.document.querySelector(selector), byText: text => all('.native-screen button').find(button => button.textContent.trim() === text) };
}

const host = 'app.little-archive.example';
const never = () => new Promise(() => {});
const SCREENS = {
  'first launch': ui => ui.choose(),
  'first launch with a notice': ui => ui.choose({ notice: 'Your sign-in ended.' }),
  'sign in': ui => ui.account({ host, providers: { apple: true, google: true }, social: never, signIn: never, signUp: never, forgot: true }),
  'create account': ui => ui.account({ host, mode: 'up', providers: {}, signIn: never, signUp: never }),
  'reset: the email': ui => ui.forgot({ host, submit: never }),
  'reset: the new password': ui => ui.newPassword({ email: 'reader@example.com', submit: never }),
  'own server': ui => ui.server({ submit: never }),
  'own server: the owner password': ui => ui.password({ host: 'archive.example.com', submit: never }),
};

/** Everything the garden has to be, wherever it is drawn. */
function checkGarden(page, name) {
  const gardens = page.all('.native-garden');
  assert.equal(gardens.length, 1, `${name}: one garden`);
  const [bed] = gardens;
  assert.equal(bed.getAttribute('aria-hidden'), 'true', `${name}: hidden from a screen reader`);
  assert.equal(bed.closest('.native-band')?.parentElement, page.$('main.native-screen'), `${name}: at the foot of the hero band, at the top of the screen`);
  assert.equal(bed.closest('form'), null, `${name}: not inside the form`);
  assert.equal(bed.nextElementSibling, null, `${name}: the last thing in the band, so it lies along its foot`);

  // Nothing in it can take focus, be named, be pointed at by a label or a description, or be announced.
  assert.equal(bed.querySelectorAll('a, button, input, select, textarea, summary, [tabindex], [contenteditable], [role], [id], [aria-label], [aria-live], [title], img, svg').length, 0, `${name}: nothing focusable, named or announced inside`);
  for (const node of [bed, ...bed.querySelectorAll('*')]) assert.equal(node.getAttribute('style'), null, `${name}: no inline styles (classes only)`);

  // Plants: each one a <pre dir="ltr"> so slashes and brackets never mirror, every row of a plant the same width (a monospace
  // grid), plain ASCII, and more than one species and size.
  const plants = [...bed.querySelectorAll('pre')];
  assert.ok(plants.length >= 5, `${name}: a bed, not one flower (${plants.length})`);
  const leaves = [...bed.querySelectorAll('*')].filter(node => !node.children.length);
  for (const leaf of leaves) assert.ok(leaf.closest('pre'), `${name}: every character is inside a <pre>`);
  for (const plant of plants) {
    assert.equal(plant.getAttribute('dir'), 'ltr', `${name}: a plant is never mirrored`);
    const rows = plant.textContent.split('\n');
    assert.equal(new Set(rows.map(row => row.length)).size, 1, `${name}: every row of a plant is one width: ${JSON.stringify(rows)}`);
    assert.match(plant.textContent, /^[\x20-\x7e\n]+$/, `${name}: plain ASCII`);
    assert.ok(plant.closest('[aria-hidden="true"]'), `${name}: every plant is under aria-hidden`);
  }
  assert.ok(new Set(plants.map(plant => plant.textContent)).size >= 4, `${name}: several species`);
  assert.ok(bed.querySelectorAll('.native-flower-head').length >= 2, `${name}: flowers with heads, which are what sways`);

  // The screen is still the screen: one title, and its words are not the garden's.
  assert.equal(page.all('h1').length, 1, `${name}: the screen's own title is its only <h1>`);
  assert.equal(page.$('h1').closest('.native-band'), null, `${name}: the title is under the band, not on it`);
  for (const control of page.all('.native-screen button, .native-screen input, .native-screen a')) assert.equal(control.closest('.native-band'), null, `${name}: no control is on the band`);
}

for (const [name, draw] of Object.entries(SCREENS)) {
  test(`the garden: ${name} has it, hidden from the accessibility tree and out of reach of focus`, { skip }, t => {
    const page = open(t, draw);
    checkGarden(page, name);
    // Tab order: nothing in the band can be reached, and where focus was put on arrival is not the garden.
    assert.ok(!page.window.document.activeElement.closest?.('.native-garden'), 'focus is not in the garden');
  });
}

test('the garden: first launch has the tall band with the line; the screens with a form have the compact one', { skip }, t => {
  const first = open(t, SCREENS['first launch']);
  assert.ok(first.$('main').classList.contains('native-band-tall'));
  assert.equal(first.$('.native-band .native-tagline').textContent, 'Good things, kept close.');
  assert.equal(first.$('.native-band .native-tagline').tagName, 'P', 'the line is not a heading: the question is the title');
  for (const name of ['sign in', 'reset: the email', 'reset: the new password', 'own server']) {
    const page = open(t, SCREENS[name]);
    assert.ok(page.$('main').classList.contains('native-band-compact'), name);
    assert.equal(page.$('.native-tagline'), null, `${name}: no line, the form needs the room`);
  }
});

test('the garden: it is still there, and still hidden, after the account screen is redrawn (the other tab, a notice, an error)', { skip }, async t => {
  const page = open(t, ui => ui.account({ host, providers: { apple: true, google: true }, social: never, signIn: async () => { throw new Error('That email and password do not match an account.'); }, signUp: async () => ({ confirmationSent: true }) }));
  page.byText('Create an account').click();
  checkGarden(page, 'after switching to Create account');
  assert.equal(page.window.document.activeElement, page.$('h1'), 'focus is on the new heading, as before');

  page.$('input[name=email]').value = 'reader@example.com';
  page.$('input[name=password]').value = 'a long password';
  page.$('form').dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(5);
  checkGarden(page, 'with the "We sent a message" notice');
  assert.equal(page.window.document.activeElement, page.$('.notice'), 'focus is on the notice, as before');

  page.$('input[name=email]').value = 'reader@example.com';
  page.$('input[name=password]').value = 'a wrong password';
  page.$('form').dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(5);
  assert.equal(page.$('form .native-error-general').hidden, false, 'the error is showing');
  checkGarden(page, 'with an error showing');
  assert.equal(page.$('.native-error-general').closest('.native-band'), null, 'the error is not on the band');
});

test('the garden: a problem, a stop and the wait have no band and no garden', { skip }, t => {
  const page = open(t, ui => ui.problem({ title: 'No connection', message: 'Try again.', actions: [{ label: 'Try again', value: 'retry', primary: true }] }));
  assert.equal(page.$('.native-garden'), null);
  assert.equal(page.$('.native-band'), null);
  assert.ok(page.$('.native-brand'), 'the logo is still there');
  page.ui.working();
  assert.equal(page.$('.native-garden'), null);
  page.ui.stop('This is the app', 'Open it on a phone.');
  assert.equal(page.$('.native-garden'), null);
});

// What only the stylesheet can do. Read as text: there is no layout or media query to ask here; the looks were checked by eye.
test('the garden: native.css keeps it out of the way (no taps or selection, gone with the keyboard, still unless motion is welcome and nothing needs reading)', async () => {
  const css = (await readFile(new URL('../src/native.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = selector => css.split('\n').find(line => line.trimStart().startsWith(`${selector} {`)) || '';
  assert.match(rule('.native-garden'), /pointer-events: none/);
  assert.match(rule('.native-garden'), /-webkit-user-select: none; user-select: none/);
  assert.match(css, /:root\[data-keyboard\] \.native-garden \{ display: none; \}/, 'hidden while the keyboard is up');
  assert.match(css, /@media \(max-width: 359px\) \{ \.native-plant-roomy \{ display: none; \} \}/, 'a narrow phone leaves plants out whole');

  // The sway: every `animation` on the garden is inside the block for people who have not asked for less motion, it moves the
  // flower heads only, and it does not run while an error or a notice is on the screen.
  const start = css.indexOf('@media (prefers-reduced-motion: no-preference) {');
  assert.ok(start > 0, 'there is a block for motion that is welcome');
  const outside = css.slice(0, start);
  assert.doesNotMatch(outside.split('\n').filter(line => /native-(garden|plant|flower)/.test(line)).join('\n'), /animation/, 'nothing in the garden moves outside that block');
  const inside = css.slice(start);
  assert.match(inside, /@supports selector\(:has\(\*\)\)/, 'and only where the page can tell that an error is showing');
  const sway = inside.split('\n').find(line => line.includes('animation: native-sway'));
  assert.ok(sway, 'the sway is in the block');
  assert.match(sway, /\.native-screen:not\(:has\(\.native-error:not\(\[hidden\]\), \.notice, \[role='alert'\]:not\(\[hidden\]\)\)\) \.native-flower-head \{/, 'heads only, and not beside an error or a notice');
  assert.match(sway, /native-sway [5-9]s ease-in-out infinite/, 'slow');
  assert.match(css, /@keyframes native-sway \{[^}]*transform: rotate\(/, 'a transform, so it never changes the layout');
  assert.doesNotMatch(await readFile(new URL('../src/garden.js', import.meta.url), 'utf8'), /setTimeout|setInterval|requestAnimationFrame|\.style\b/, 'no timers and no inline styles in the drawing');
});
