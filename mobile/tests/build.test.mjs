import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '../scripts/build-web.mjs');
const web = path.resolve(here, '../../web');
const shipped = path.resolve(here, '../app.config.json');

function build(env = {}) {
  const out = mkdtempSync(path.join(tmpdir(), 'la-www-'));
  try { execFileSync(process.execPath, [script], { env: { ...process.env, LA_WWW_DIR: out, ...env }, stdio: 'pipe' }); }
  catch (error) { rmSync(out, { recursive: true, force: true }); throw new Error(String(error.stderr || error.message)); }
  return out;
}
function* walk(directory, base = directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full, base); else yield path.relative(base, full);
  }
}
const read = (...parts) => readFileSync(path.join(...parts), 'utf8');

test('the bundle holds the shared interface byte for byte, the app shell, and nothing else', () => {
  const out = build();
  try {
    assert.deepEqual([...walk(out)].sort(), ['app.js', 'fonts/Fraunces-OFL.txt', 'fonts/fraunces-soft.woff2', 'icon.svg', 'index.html', 'native/boot.js', 'native/native.css', 'styles.css', 'utils.js']);
    for (const name of ['app.js', 'utils.js', 'styles.css', 'icon.svg']) assert.equal(read(out, name), read(web, name), `${name} is copied, not changed`);
    // The shell is bundled with the transport; the interface does not import it (the public demo's file list is fixed).
    assert.match(read(out, 'native/boot.js'), /createTransport/);
    assert.doesNotMatch(read(out, 'app.js'), /from '\.\/transport\.js'|import\(.\.\/transport/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('index.html differs from the browser one only by what the app needs, and its policy lets the web view reach nothing but itself', () => {
  const out = build();
  try {
    const html = read(out, 'index.html');
    assert.match(html, /<script type="module" src="\/native\/boot\.js"><\/script>/);
    assert.doesNotMatch(html, /src="\/app\.js"/, 'app.js is loaded by the shell after sign-in, not by the page');
    assert.doesNotMatch(html, /manifest|apple-touch-icon/);
    assert.match(html, /viewport-fit=cover/);
    assert.match(html, /<link rel="stylesheet" href="\/native\/native\.css">/);
    const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
    for (const directive of ["default-src 'self'", "script-src 'self'", "connect-src 'self'", "object-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'"]) assert.ok(csp.includes(directive), directive);
    assert.doesNotMatch(csp, /unsafe-eval|unsafe-inline'[^;]*script|\*/, 'no eval, no inline script, no wildcard');
    assert.match(csp, /img-src 'self' data: blob: https:/);
    // Everything else in the page is the browser page.
    const original = read(web, 'index.html');
    const stripped = html.replace(/\n    <meta name="text-scale"[^\n]*/, '').replace(/\n    <meta http-equiv="Content-Security-Policy"[^\n]*/, '').replace(', viewport-fit=cover', '').replace('\n    <link rel="stylesheet" href="/native/native.css">', '').replace('/native/boot.js', '/app.js');
    assert.equal(stripped, original.replace('    <link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">\n', '').replace('    <link rel="manifest" href="/manifest.webmanifest">\n', ''));
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('the only Supabase key in the bundle is the publishable one, and no secret-looking value is', () => {
  const out = build();
  try {
    const config = JSON.parse(readFileSync(shipped, 'utf8'));
    const keys = new Set();
    for (const file of walk(out)) {
      if (/\.woff2$/.test(file)) continue;
      const text = read(out, file);
      for (const key of text.match(/\bsb_[a-z]+_[A-Za-z0-9_-]+/g) || []) keys.add(key);
      assert.doesNotMatch(text, /sb_secret_[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/, file);
    }
    assert.deepEqual([...keys], [config.supabasePublishableKey]);
    assert.ok(read(out, 'native/boot.js').includes(config.supabasePublishableKey));
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('a development configuration can point the build at local servers; a config with a secret stops the build', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'la-config-'));
  try {
    const good = path.join(directory, 'dev.json');
    writeFileSync(good, JSON.stringify({ ...JSON.parse(readFileSync(shipped, 'utf8')), hostedServerUrl: 'http://localhost:8852', supabaseUrl: 'http://127.0.0.1:8853' }));
    const out = build({ LA_APP_CONFIG: good });
    try { assert.ok(read(out, 'native/boot.js').includes('http://127.0.0.1:8853')); } finally { rmSync(out, { recursive: true, force: true }); }
    const bad = path.join(directory, 'bad.json');
    writeFileSync(bad, JSON.stringify({ ...JSON.parse(readFileSync(shipped, 'utf8')), supabasePublishableKey: 'sb_secret_0123456789abcdefghij' }));
    assert.throws(() => build({ LA_APP_CONFIG: bad }), /secret|publishable/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
