#!/usr/bin/env node
/**
 * Builds the web bundle that the iOS and Android apps load (mobile/www): the React interface in ../ui, plus the app shell.
 *
 *   npm run build:web         (or `npm run sync` to build and copy into both native projects)
 *
 * The interface is built by its own Vite project (`vite build --manifest` in ../ui, which must have had `npm ci`). Only what
 * index.html reaches is copied, found through Vite's manifest: the demo page that the same project also builds, and the
 * chunks only it uses, stay out of the app. The copy of index.html is changed in one way (see `shell` below): the page
 * starts the app shell, native/boot.js, instead of the interface's own entry. The shell signs in, defines
 * globalThis.__littleArchiveNative, and only then imports the interface's entry, which picks the native backend from it.
 *
 * Environment:
 *   LA_UI_DIST     a finished interface build to use instead of building one (the tests use a small fixture)
 *   LA_APP_CONFIG  a different config file, for a development build against a local server (it still has to pass validation)
 *   LA_WWW_DIR     a different output folder (the tests use a temporary one)
 *   LA_DEBUG_BUILD set to 1 for a development bundle: it additionally accepts http://10.0.2.2 (the Android emulator's name
 *                  for the computer), which a release bundle refuses. Never set it for a build that is shipped.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECRET_LOOKING, validateConfig } from '../src/config.js';

// A development bundle is chosen here, once, and applies to the address check while the configuration is validated below as
// well as to the bundle (esbuild's `define` replaces __LA_DEBUG_BUILD__ with a literal, so a release bundle holds no trace of it).
const debugBuild = ['1', 'true'].includes(String(process.env.LA_DEBUG_BUILD || '').toLowerCase());
globalThis.__LA_DEBUG_BUILD__ = debugBuild;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ui = path.resolve(root, '../ui');
const out = path.resolve(process.env.LA_WWW_DIR || path.join(root, 'www'));
const configPath = path.resolve(process.env.LA_APP_CONFIG || path.join(root, 'app.config.json'));

// The same policy the server sends to the browser, plus blob: for thumbnails (fetched with the bearer token and shown from
// a blob URL). The web view itself may connect nowhere: all network access goes through the native HTTP client.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";
const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">';
const MODULE_SCRIPT = /^[ \t]*<script type="module"[^>]*><\/script>\n/gm;

/** The interface, built by its own project. Its dependencies are installed there, not in mobile/. */
function buildInterface() {
  const vite = path.join(ui, 'node_modules/vite/bin/vite.js');
  try { execFileSync(process.execPath, [vite, '--version'], { stdio: 'pipe' }); }
  catch { throw new Error('The interface is not installed. Run `npm ci` in ui/, then build again.'); }
  execFileSync(process.execPath, [vite, 'build', '--manifest'], { cwd: ui, stdio: 'inherit' });
  return path.join(ui, 'dist');
}

// Backends the app never uses. The interface's entry can reach each of them (it picks one when it starts), but the app has the
// native one, so a copy of the public demo's records and photos, or of the browser's own backend, would only be weight.
const LEFT_OUT = new Set(['src/data/backends/demo.ts', 'src/data/backends/browser.ts']);

/**
 * The chunk that starts the interface: the one script on the page that no other script on the page imports. (Vite 8 does not
 * list html pages in the manifest, and the page names its entry's dependencies as scripts of their own.)
 */
function entryOf(manifest, html) {
  const byFile = new Map(Object.entries(manifest).map(([key, chunk]) => [chunk.file, key]));
  const keys = [...html.matchAll(/<script type="module"[^>]*\ssrc="\.\/([^"]+)"/g)].map(([, file]) => byFile.get(file));
  if (!keys.length || keys.includes(undefined)) throw new Error('index.html starts a script that the interface\'s manifest does not know.');
  const imported = new Set(keys.flatMap(key => manifest[key].imports || []));
  const entries = keys.filter(key => !imported.has(key));
  if (entries.length !== 1) throw new Error(`index.html does not have one entry script (found ${entries.length}).`);
  return entries[0];
}

/** Every file a chunk needs to run: itself, what it imports (now or later), its styles and its assets, minus the backends left out. */
function reachable(manifest, key) {
  const files = new Set();
  const seen = new Set();
  const visit = name => {
    if (seen.has(name)) return;
    seen.add(name);
    const chunk = manifest[name];
    if (!chunk) throw new Error(`The interface's manifest has no entry for ${name}.`);
    if (LEFT_OUT.has(chunk.src)) return;
    for (const file of [chunk.file, ...(chunk.css || []), ...(chunk.assets || [])]) files.add(file);
    for (const next of [...(chunk.imports || []), ...(chunk.dynamicImports || [])]) visit(next);
  };
  visit(key);
  return files;
}

function shell(html, { scripts }) {
  const swap = (from, to) => {
    if (!html.includes(from)) throw new Error(`ui/index.html no longer contains ${from}. Update mobile/scripts/build-web.mjs.`);
    html = html.replace(from, to);
  };
  swap(VIEWPORT, `${VIEWPORT}\n    <meta name="text-scale" content="scale">\n    <meta http-equiv="Content-Security-Policy" content="${CSP}">`);
  // The build lists the interface's chunks as module scripts. The shell loads the entry itself, once it has signed in.
  if (!html.match(MODULE_SCRIPT)) throw new Error('ui/index.html has no module script. Update mobile/scripts/build-web.mjs.');
  html = html.replace(MODULE_SCRIPT, '');
  swap('  </head>', `    <link rel="stylesheet" href="./native/native.css">\n    <script type="module" src="./native/boot.js"></script>\n  </head>`);
  // Nothing else in the page may start code or reach another origin.
  for (const tag of html.match(/<script\b[^>]*>/g) || []) if (!scripts.includes(tag.match(/src="([^"]+)"/)?.[1])) throw new Error(`The page has a script the app does not expect: ${tag}`);
  return html;
}

const uiDist = process.env.LA_UI_DIST ? path.resolve(process.env.LA_UI_DIST) : buildInterface();
const config = validateConfig(JSON.parse(await readFile(configPath, 'utf8')));
const manifest = JSON.parse(await readFile(path.join(uiDist, '.vite/manifest.json'), 'utf8').catch(() => { throw new Error(`${uiDist} is not a build made with --manifest.`); }));
const indexHtml = await readFile(path.join(uiDist, 'index.html'), 'utf8');
const entryKey = entryOf(manifest, indexHtml);
const entry = manifest[entryKey];
if (!/^assets\/[^/]+\.js$/.test(entry.file)) throw new Error(`The interface's entry is at an unexpected path: ${entry.file}.`);

// Files the page names itself (the icon, the theme script) besides the chunks the manifest knows.
const named = [...indexHtml.replace(MODULE_SCRIPT, '').matchAll(/(?:src|href)="\.\/([^"#?]+)"/g)].map(match => match[1]);
const files = new Set([...reachable(manifest, entryKey), ...named]);
const leftOut = new Set(Object.values(manifest).filter(chunk => LEFT_OUT.has(chunk.src)).map(chunk => path.basename(chunk.file)));

await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, 'native'), { recursive: true });
for (const file of files) {
  if (file.includes('..') || path.isAbsolute(file)) throw new Error(`Refusing to copy ${file}.`);
  await mkdir(path.dirname(path.join(out, file)), { recursive: true });
  await cp(path.join(uiDist, file), path.join(out, file));
}
await writeFile(path.join(out, 'index.html'), shell(indexHtml, { scripts: ['./theme-init.js', './native/boot.js'] }));
await cp(path.join(root, 'src/native.css'), path.join(out, 'native/native.css'));

const entryPath = `/${entry.file}`;
await build({
  entryPoints: [path.join(root, 'src/boot.js')],
  outfile: path.join(out, 'native/boot.js'),
  bundle: true,
  format: 'esm',
  target: ['safari15', 'chrome100'],
  legalComments: 'none',
  logLevel: 'warning',
  // The interface is loaded at run time, after sign-in, not bundled with the shell.
  external: [entryPath],
  define: { __LA_DEBUG_BUILD__: String(debugBuild), __LA_UI_ENTRY__: JSON.stringify(entryPath) },
  // Syntax-only minification, so the branch the flag turns off (and the host name in it) is removed from a release bundle.
  minifySyntax: true,
  plugins: [{
    name: 'app-config',
    setup(b) {
      // The shell imports ../app.config.json; a development build can point that at another file.
      b.onResolve({ filter: /app\.config\.json$/ }, () => ({ path: configPath }));
    },
  }],
});

// Every file the copied styles and scripts name must be in the bundle, or the app would fail on the phone and not here.
async function* walk(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, item.name);
    if (item.isDirectory()) yield* walk(full); else yield full;
  }
}
const exists = file => stat(file).then(() => true, () => false);
for await (const file of walk(out)) {
  if (/\.(woff2?|png|jpg)$/.test(file)) continue;
  const text = await readFile(file, 'utf8');
  // Nothing that looks like a secret may be in the bundle, and the only Supabase key in it is the publishable one.
  if (SECRET_LOOKING.test(text)) throw new Error(`${path.relative(out, file)} contains something that looks like a secret key.`);
  for (const key of new Set(text.match(/\bsb_[a-z]+_[A-Za-z0-9_-]+/g) || [])) if (key !== config.supabasePublishableKey) throw new Error(`${path.relative(out, file)} contains a Supabase key that is not the configured publishable key.`);
  if (!/\.(css|js)$/.test(file) || file.includes(`${path.sep}native${path.sep}`)) continue;
  const references = /\.css$/.test(file) ? [...text.matchAll(/url\(\s*["']?(\.{1,2}\/[^"')?#]+)/g)] : [...text.matchAll(/["'`](\.{1,2}\/[\w./-]+\.(?:js|css))["'`]/g)];
  for (const [, reference] of references) if (!leftOut.has(path.basename(reference)) && !await exists(path.resolve(path.dirname(file), reference))) throw new Error(`${path.relative(out, file)} refers to ${reference}, which is not in the bundle.`);
}

console.log(`Built ${path.relative(process.cwd(), out) || '.'} (${files.size} interface files, hosted service ${config.hostedServerUrl}${configPath === path.join(root, 'app.config.json') ? '' : `, development configuration ${configPath}`}${debugBuild ? ', DEVELOPMENT BUNDLE: do not ship' : ''}).`);
