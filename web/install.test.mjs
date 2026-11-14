import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { SHARE_PATH } from './utils.js';

const read = name => readFileSync(new URL(name, import.meta.url));
const text = name => read(name).toString('utf8');
const manifest = JSON.parse(text('./manifest.webmanifest'));

// PNG: 8-byte signature, then the IHDR chunk with width and height as big-endian 32-bit integers.
function pngSize(name) {
  const bytes = read(name);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${name} is not a PNG`);
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR');
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

test('the manifest has what a browser needs to install the app', () => {
  assert.equal(manifest.name, 'Little Archive');
  assert.ok(manifest.short_name);
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.id, '/');
  assert.ok(manifest.start_url.startsWith(manifest.scope));
  for (const color of [manifest.background_color, manifest.theme_color]) assert.match(color, /^#[0-9a-f]{6}$/);
  // The app is not affiliated with the platforms it can save from.
  assert.doesNotMatch(JSON.stringify([manifest.name, manifest.short_name, manifest.description]), /instagram|tiktok/i);
});

test('manifest colours are the refreshed design tokens, not stale ones', () => {
  const css = text('./styles.css');
  const themeLayer = css.slice(css.indexOf('@layer theme {'));
  const light = themeLayer.match(/:root \{ --bg:(#[0-9a-f]{6})/i)[1].toLowerCase();
  const dark = themeLayer.match(/:root\[data-theme="dark"\] \{ --bg:(#[0-9a-f]{6})/i)[1].toLowerCase();
  assert.equal(manifest.background_color, light);
  assert.equal(manifest.theme_color, light);
  assert.match(text('./index.html'), new RegExp(`<meta name="theme-color" content="${light}">`, 'i'));
  // The script reads the token itself; its fallbacks must still be the same two colours.
  const app = text('./app.js');
  assert.ok(app.includes(`'${light}'`) && app.includes(`'${dark}'`));
  assert.match(app, /getPropertyValue\('--bg'\)/);
});

test('every declared icon exists with its declared size, and the required sizes are present', () => {
  const declared = new Set();
  for (const icon of manifest.icons) {
    assert.ok(icon.src.startsWith('/'), icon.src);
    if (icon.type === 'image/png') assert.equal(pngSize(`.${icon.src}`), icon.sizes, icon.src);
    else assert.equal(icon.src, '/icon.svg');
    declared.add(`${icon.sizes} ${icon.purpose}`);
  }
  for (const needed of ['192x192 any', '512x512 any', '512x512 maskable']) assert.ok(declared.has(needed), `missing ${needed}`);
  assert.equal(pngSize('./apple-touch-icon.png'), '180x180');
});

test('the share target is a plain GET to the path the app reads, inside the app scope', () => {
  const target = manifest.share_target;
  assert.equal(target.action, SHARE_PATH);
  assert.equal(target.method, 'GET');
  assert.deepEqual(target.params, { title: 'title', text: 'text', url: 'url' });
  assert.ok(target.action.startsWith(manifest.scope));
  assert.equal(target.enctype, 'application/x-www-form-urlencoded');
});

test('index.html links the manifest and touch icon, and needs no inline script', () => {
  const html = text('./index.html');
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png" sizes="180x180">/);
  assert.deepEqual(html.match(/<script\b[^>]*>/g), ['<script type="module" src="/app.js">']);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
});

test('the public demo does not advertise the share target or the install files', () => {
  const demo = text('./demo.html');
  assert.doesNotMatch(demo, /manifest|apple-touch|\/share/i);
  assert.match(text('./app.js'), /let pendingShare = IS_DEMO \? null : readShareTarget\(location\)/);
});

test('no service worker: the app shell is not cached, so there is no stale shell and nothing private to leak', () => {
  // Installability and the share target do not need one, and the app is only useful with its live,
  // signed-in API. Adding one means deciding what it may cache, how sign-out clears it, and how an
  // update reaches people who run unhashed, buildless files. Review SECURITY.md and docs/phone.md first.
  for (const name of readdirSync(new URL('.', import.meta.url))) {
    if (name.endsWith('.js') || name.endsWith('.html')) assert.doesNotMatch(text(`./${name}`), /serviceWorker|service-worker/, name);
  }
  assert.equal(readdirSync(new URL('.', import.meta.url)).some(name => /^(sw|service-worker)\.js$/.test(name)), false);
});
