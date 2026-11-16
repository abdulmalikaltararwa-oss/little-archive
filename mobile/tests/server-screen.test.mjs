// The own-server screen (src/ui.js) in a DOM: the guidance under the form, the link to the guide, where focus goes and how a
// refusal is shown. jsdom comes from the interface's install (ui/node_modules), as in account-screen.test.mjs; without it these skip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { AppError } from '../src/discovery.js';
import { BACK, SELF_HOSTING_GUIDE, createUi } from '../src/ui.js';

let JSDOM;
try { ({ JSDOM } = createRequire(new URL('../../ui/package.json', import.meta.url))('jsdom')); } catch { /* skipped below */ }
const skip = JSDOM ? false : 'jsdom is not installed (run `npm ci` in ui/)';
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

function open(t, options) {
  const { window } = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { pretendToBeVisual: true });
  window.Element.prototype.scrollIntoView = () => {};
  const before = { document: globalThis.document, Node: globalThis.Node };
  globalThis.document = window.document;
  globalThis.Node = window.Node;
  t.after(() => { globalThis.document = before.document; globalThis.Node = before.Node; window.close(); });
  const ui = createUi(window.document.getElementById('app'), { iconUrl: 'icon.svg' });
  const result = ui.server(options);
  const $ = selector => window.document.querySelector(selector);
  return { window, result, $, send() { $('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); } };
}

test('the own-server screen says what an address looks like, that the phone must reach it, and links the guide', { skip }, t => {
  const page = open(t, { submit: async () => assert.fail('nothing was sent') });
  assert.equal(page.window.document.activeElement, page.$('h1'), 'focus is on the heading, so the keyboard does not cover the guidance');
  assert.equal(page.$('h1').getAttribute('tabindex'), '-1');
  // The field: a real label, the example and the https rule tied to it.
  const field = page.$('input[name=server]');
  assert.equal(page.$(`label[for=${field.id}]`).textContent, 'Server address');
  const hint = page.window.document.getElementById(field.getAttribute('aria-describedby'));
  assert.match(hint.textContent, /for example https:\/\/archive\.example\.com/);
  assert.match(hint.textContent, /must start with https:\/\//);
  // The guidance is a labelled region with a short list.
  const guide = page.$('.native-guide');
  assert.equal(page.window.document.getElementById(guide.getAttribute('aria-labelledby')).textContent, 'before you connect');
  const items = [...guide.querySelectorAll('li')].map(item => item.textContent);
  assert.equal(items.length, 2);
  assert.match(items[0], /has to be able to reach the server/);
  assert.match(items[0], /same Wi-Fi/);
  assert.match(items[0], /public https:\/\/ address/);
  assert.match(items[1], /http:\/\/ is refused/);
  // The link leaves the app for the browser, says so, and goes to the guide in the project's public repository.
  const link = guide.querySelector('a');
  assert.equal(link.href, SELF_HOSTING_GUIDE);
  assert.ok(SELF_HOSTING_GUIDE.endsWith('/little-archive/blob/main/docs/self-hosting.md'));
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.match(link.textContent, /opens in your browser/);
  assert.ok(link.classList.contains('native-link'), 'the class that makes it finger sized (44px, native.css)');
});

test('a refusal is shown on the address field, which takes focus, and Back still works', { skip }, async t => {
  const page = open(t, { value: 'http://192.168.1.20', submit: async () => { throw new AppError('This address is not encrypted.', { field: 'server' }); } });
  const field = page.$('input[name=server]');
  assert.equal(field.value, 'http://192.168.1.20', 'what was typed before is kept');
  page.send();
  await tick();
  assert.equal(field.getAttribute('aria-invalid'), 'true');
  const described = field.getAttribute('aria-describedby').split(' ').map(id => page.window.document.getElementById(id).textContent).join(' ');
  assert.match(described, /not encrypted/);
  assert.equal(page.window.document.activeElement, field);
  [...page.window.document.querySelectorAll('button')].find(button => button.textContent === 'Back').click();
  assert.equal(await page.result, BACK);
});
