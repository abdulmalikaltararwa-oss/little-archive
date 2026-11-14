import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '../scripts/build-web.mjs');
const ui = path.resolve(here, '../../ui');
const shipped = path.resolve(here, '../app.config.json');

// A small interface build with the shape Vite makes: an index.html that lists chunks as module scripts, a manifest, a chunk
// that is loaded later, a stylesheet that names an asset, and a demo page with a chunk of its own that the app must not take.
function interfaceBuild() {
  const dist = mkdtempSync(path.join(tmpdir(), 'la-ui-'));
  const put = (name, text) => { mkdirSync(path.dirname(path.join(dist, name)), { recursive: true }); writeFileSync(path.join(dist, name), text); };
  put('index.html', [
    '<!doctype html>', '<html lang="en">', '  <head>', '    <meta charset="utf-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '    <title>Little Archive</title>', '    <link rel="icon" href="./icon.svg" type="image/svg+xml">',
    '    <script src="./theme-init.js"></script>',
    '    <script type="module" crossorigin src="./assets/shared-CCCC.js"></script>',
    '    <script type="module" crossorigin src="./assets/main-AAAA.js"></script>',
    '    <link rel="stylesheet" crossorigin href="./assets/main-DDDD.css">',
    '  </head>', '  <body>', '    <div id="app"></div>', '  </body>', '</html>', ''].join('\n'));
  put('demo.html', '<!doctype html><script type="module" src="./assets/demo-FFFF.js"></script>');
  put('theme-init.js', '(function () { document.documentElement.dataset.theme = "light"; })();\n');
  put('icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  // The entry picks a backend when it starts, so it can reach the demo's chunk (with the demo's photos) as well as the ones it uses.
  put('assets/main-AAAA.js', 'import { shared } from "./shared-CCCC.js";\nexport const later = () => import("./screen-BBBB.js");\nexport const demo = () => import("./demo-FFFF.js");\nshared();\n');
  put('assets/shared-CCCC.js', 'export const shared = () => 1;\n');
  put('assets/screen-BBBB.js', 'export default 2;\n');
  put('assets/demo-FFFF.js', 'export const demo = "synthetic records";\n');
  put('assets/001-HHHH.webp', 'a photo of nothing');
  put('assets/main-DDDD.css', '@font-face { font-family: T; src: url(./icon-GGGG.svg); }\nbody { color: red; }\n');
  put('assets/icon-GGGG.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  // Vite 8 writes no key for the html pages. The entry is a shared chunk, named with a leading underscore, that holds its own css and assets.
  put('.vite/manifest.json', JSON.stringify({
    '_shared-CCCC.js': { file: 'assets/shared-CCCC.js', name: 'shared' },
    '_main-AAAA.js': { file: 'assets/main-AAAA.js', name: 'main', imports: ['_shared-CCCC.js'], dynamicImports: ['src/screen.tsx', 'src/data/backends/demo.ts'], css: ['assets/main-DDDD.css'], assets: ['assets/icon-GGGG.svg'] },
    'src/screen.tsx': { file: 'assets/screen-BBBB.js', name: 'screen', src: 'src/screen.tsx', isDynamicEntry: true, imports: ['_shared-CCCC.js'] },
    'src/data/backends/demo.ts': { file: 'assets/demo-FFFF.js', name: 'demo', src: 'src/data/backends/demo.ts', isDynamicEntry: true, assets: ['assets/001-HHHH.webp'] },
  }));
  return dist;
}

const fixture = interfaceBuild();
test.after(() => rmSync(fixture, { recursive: true, force: true }));

function build(env = {}, dist = fixture) {
  const out = mkdtempSync(path.join(tmpdir(), 'la-www-'));
  try { execFileSync(process.execPath, [script], { env: { ...process.env, LA_WWW_DIR: out, LA_UI_DIST: dist, ...env }, stdio: 'pipe' }); }
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

test('the bundle holds what index.html reaches of the interface, byte for byte, and the app shell, and nothing else', () => {
  const out = build();
  try {
    assert.deepEqual([...walk(out)].sort(), ['assets/icon-GGGG.svg', 'assets/main-AAAA.js', 'assets/main-DDDD.css', 'assets/screen-BBBB.js', 'assets/shared-CCCC.js', 'icon.svg', 'index.html', 'native/boot.js', 'native/native.css', 'theme-init.js']);
    for (const name of ['assets/main-AAAA.js', 'assets/shared-CCCC.js', 'assets/screen-BBBB.js', 'assets/main-DDDD.css', 'assets/icon-GGGG.svg', 'icon.svg', 'theme-init.js']) assert.equal(read(out, name), read(fixture, name), `${name} is copied, not changed`);
    // The demo page, the demo's chunk and its photos stay out of the app.
    for (const left of ['demo.html', 'assets/demo-FFFF.js', 'assets/001-HHHH.webp']) assert.ok(!existsSync(path.join(out, left)), left);
    // The shell is bundled with the transport and the store driver; the interface's entry is loaded by it, not bundled into it.
    const boot = read(out, 'native/boot.js');
    assert.match(boot, /createTransport/);
    assert.match(boot, /purchaseUpdated/);
    assert.match(boot, /import\("\/assets\/main-AAAA\.js"\)/);
    assert.doesNotMatch(boot, /synthetic records|shared = /);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('index.html starts the shell, not the interface, and its policy lets the web view reach nothing but itself', () => {
  const out = build();
  try {
    const html = read(out, 'index.html');
    assert.deepEqual(html.match(/<script\b[^>]*>/g), ['<script src="./theme-init.js">', '<script type="module" src="./native/boot.js">'], 'the shell is the only module the page starts; it loads the interface after sign-in');
    assert.match(html, /<link rel="stylesheet" crossorigin href="\.\/assets\/main-DDDD\.css">\n\s*<link rel="stylesheet" href="\.\/native\/native\.css">/, 'the interface\'s styles first, then the app\'s');
    assert.match(html, /viewport-fit=cover/);
    const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
    for (const directive of ["default-src 'self'", "script-src 'self'", "connect-src 'self'", "object-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'"]) assert.ok(csp.includes(directive), directive);
    assert.doesNotMatch(csp, /unsafe-eval|unsafe-inline'[^;]*script|\*/, 'no eval, no inline script, no wildcard');
    assert.match(csp, /img-src 'self' data: blob: https:/);
    // Everything else in the page is the interface's page.
    const stripped = html.replace(/\n    <meta name="text-scale"[^\n]*/, '').replace(/\n    <meta http-equiv="Content-Security-Policy"[^\n]*/, '').replace('    <link rel="stylesheet" href="./native/native.css">\n    <script type="module" src="./native/boot.js"></script>\n', '');
    assert.equal(stripped, read(fixture, 'index.html').replace(/    <script type="module"[^\n]*\n/g, ''));
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('a build that is not whole stops: no manifest, a file the manifest names that is missing, a reference to nothing, a script the app does not expect', () => {
  const broken = interfaceBuild();
  try {
    unlinkSync(path.join(broken, 'assets/icon-GGGG.svg'));
    assert.throws(() => build({}, broken), /icon-GGGG|ENOENT/);
  } finally { rmSync(broken, { recursive: true, force: true }); }
  const bare = interfaceBuild();
  try {
    rmSync(path.join(bare, '.vite'), { recursive: true });
    assert.throws(() => build({}, bare), /--manifest/);
  } finally { rmSync(bare, { recursive: true, force: true }); }
  const dangling = interfaceBuild();
  try {
    writeFileSync(path.join(dangling, 'assets/main-AAAA.js'), 'import "./gone-ZZZZ.js";\n');
    assert.throws(() => build({}, dangling), /gone-ZZZZ\.js, which is not in the bundle/);
  } finally { rmSync(dangling, { recursive: true, force: true }); }
  const foreign = interfaceBuild();
  try {
    writeFileSync(path.join(foreign, 'index.html'), read(foreign, 'index.html').replace('<script src="./theme-init.js"></script>', '<script src="./theme-init.js"></script>\n    <script src="https://cdn.example/x.js"></script>'));
    assert.throws(() => build({}, foreign), /script the app does not expect/);
  } finally { rmSync(foreign, { recursive: true, force: true }); }
});

// The real thing, when the interface's dependencies are installed (they are not in the mobile-only CI job).
test('the real interface builds into the bundle, started by the shell, with nothing of the demo', { skip: !existsSync(path.join(ui, 'node_modules/vite/bin/vite.js')) && 'run npm ci in ui/ to include this check', timeout: 300_000 }, () => {
  const out = mkdtempSync(path.join(tmpdir(), 'la-www-'));
  try {
    const env = { ...process.env, LA_WWW_DIR: out };
    delete env.LA_UI_DIST;
    execFileSync(process.execPath, [script], { env, stdio: 'pipe' });
    const html = read(out, 'index.html');
    assert.equal((html.match(/<script type="module"/g) || []).length, 1);
    const entry = read(out, 'native/boot.js').match(/import\("(\/assets\/main-[\w-]+\.js)"\)/)[1];
    assert.ok(existsSync(path.join(out, entry)), 'the entry the shell imports is in the bundle');
    const files = [...walk(out)];
    assert.ok(!files.some(file => /demo/.test(file)), 'no demo page, no demo chunk');
    assert.ok(files.includes('theme-init.js') && files.includes('icon.svg'));
    assert.ok(files.some(file => /^assets\/main-.*\.css$/.test(file)));
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

test('a release bundle holds no trace of the emulator address; only a build that asks for a development bundle accepts it', () => {
  const release = build();
  const debug = build({ LA_DEBUG_BUILD: '1' });
  try {
    assert.doesNotMatch(read(release, 'native/boot.js'), /10\.0\.2\.2|__LA_DEBUG_BUILD__/, 'the release bundle has the address check without the emulator host');
    assert.match(read(debug, 'native/boot.js'), /10\.0\.2\.2/);
    assert.doesNotMatch(read(debug, 'native/boot.js'), /__LA_DEBUG_BUILD__/, 'the flag is a build-time literal, not something the page can set');
  } finally { rmSync(release, { recursive: true, force: true }); rmSync(debug, { recursive: true, force: true }); }
});

test('the configuration is checked by the same rule as the bundle: an emulator address needs a development build', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'la-config-'));
  try {
    const dev = path.join(directory, 'emulator.json');
    writeFileSync(dev, JSON.stringify({ ...JSON.parse(readFileSync(shipped, 'utf8')), hostedServerUrl: 'http://10.0.2.2:8852' }));
    assert.throws(() => build({ LA_APP_CONFIG: dev }), /hostedServerUrl/, 'a release build refuses to be pointed at the emulator host');
    const out = build({ LA_APP_CONFIG: dev, LA_DEBUG_BUILD: '1' });
    try { assert.ok(read(out, 'native/boot.js').includes('http://10.0.2.2:8852')); } finally { rmSync(out, { recursive: true, force: true }); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
