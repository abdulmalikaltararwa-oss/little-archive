#!/usr/bin/env node
/**
 * Builds the web bundle that the iOS and Android apps load (mobile/www), from the shared interface in ../web.
 *
 *   npm run build:web         (or `npm run sync` to build and copy into both native projects)
 *
 * The interface is not duplicated in git: app.js, utils.js, styles.css, the icon and the font are copied from ../web byte for
 * byte. The only changes are to the copy of index.html (see `shell` below) and the additions in www/native: the app shell,
 * bundled from mobile/src with its plugins and the shared transport (../web/transport.js), and native.css.
 *
 * Environment:
 *   LA_APP_CONFIG  a different config file, for a development build against a local server (it still has to pass validation)
 *   LA_WWW_DIR     a different output folder (the tests use a temporary one)
 */
import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECRET_LOOKING, validateConfig } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const web = path.resolve(root, '../web');
const out = path.resolve(process.env.LA_WWW_DIR || path.join(root, 'www'));
const configPath = path.resolve(process.env.LA_APP_CONFIG || path.join(root, 'app.config.json'));

// What the apps ship from the shared interface. Nothing else in ../web (tests, the demo, the manifest) goes in.
const SHARED = ['app.js', 'utils.js', 'styles.css', 'icon.svg', 'fonts/fraunces-soft.woff2', 'fonts/Fraunces-OFL.txt'];

// The same policy the server sends to the browser, plus blob: for thumbnails (fetched with the bearer token and shown from
// a blob URL). The web view itself may connect nowhere: all network access goes through the native HTTP client.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";

function shell(html) {
  const swap = (from, to) => {
    if (!html.includes(from)) throw new Error(`web/index.html no longer contains ${from}. Update mobile/scripts/build-web.mjs.`);
    html = html.replace(from, to);
  };
  swap('<meta name="viewport" content="width=device-width, initial-scale=1">', `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n    <meta name="text-scale" content="scale">\n    <meta http-equiv="Content-Security-Policy" content="${CSP}">`);
  swap('    <link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">\n', '');
  swap('    <link rel="manifest" href="/manifest.webmanifest">\n', '');
  swap('    <link rel="stylesheet" href="/styles.css">\n', '    <link rel="stylesheet" href="/styles.css">\n    <link rel="stylesheet" href="/native/native.css">\n');
  swap('<script type="module" src="/app.js"></script>', '<script type="module" src="/native/boot.js"></script>');
  return html;
}

const config = validateConfig(JSON.parse(await readFile(configPath, 'utf8')));
await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, 'native'), { recursive: true });

for (const file of SHARED) {
  await mkdir(path.dirname(path.join(out, file)), { recursive: true });
  await cp(path.join(web, file), path.join(out, file));
}
await writeFile(path.join(out, 'index.html'), shell(await readFile(path.join(web, 'index.html'), 'utf8')));
await cp(path.join(root, 'src/native.css'), path.join(out, 'native/native.css'));

await build({
  entryPoints: [path.join(root, 'src/boot.js')],
  outfile: path.join(out, 'native/boot.js'),
  bundle: true,
  format: 'esm',
  target: ['safari15', 'chrome100'],
  legalComments: 'none',
  logLevel: 'warning',
  // The interface is loaded at run time, after sign-in, not bundled with the shell.
  external: ['/app.js'],
  plugins: [{
    name: 'app-config',
    setup(b) {
      // The shell imports ../app.config.json; a development build can point that at another file.
      b.onResolve({ filter: /app\.config\.json$/ }, () => ({ path: configPath }));
    },
  }],
});

// Nothing that looks like a secret may be in the bundle, and the only Supabase key in it is the publishable one.
async function* files(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* files(full); else yield full;
  }
}
for await (const file of files(out)) {
  if (/\.(woff2?|png|jpg)$/.test(file)) continue;
  const text = await readFile(file, 'utf8');
  if (SECRET_LOOKING.test(text)) throw new Error(`${path.relative(out, file)} contains something that looks like a secret key.`);
  const keys = new Set(text.match(/\bsb_[a-z]+_[A-Za-z0-9_-]+/g) || []);
  for (const key of keys) if (key !== config.supabasePublishableKey) throw new Error(`${path.relative(out, file)} contains a Supabase key that is not the configured publishable key.`);
}

console.log(`Built ${path.relative(process.cwd(), out) || '.'} (hosted service ${config.hostedServerUrl}${configPath === path.join(root, 'app.config.json') ? '' : `, development configuration ${configPath}`}).`);
