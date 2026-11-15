// The app's sign-in code against the development stand-in for Supabase (dev/stub_supabase.py), over real HTTP on loopback. The
// stand-in applies the rules in Supabase's server source (the S256 check, the single-use code, the nonce hash, the answers for a
// provider that is off), so this shows that what the app sends is something that source accepts, which the scripted doubles in
// social.test.mjs cannot. It needs python3 and skips without it. Nothing leaves this computer.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AppError } from '../src/discovery.js';
import { createSupabase } from '../src/supabase.js';
import { createSocialSignIn } from '../src/social.js';
import { CONFIG, fakeJwt } from './helpers.mjs';
import { createHash } from 'node:crypto';

const stubPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dev/stub_supabase.py');
const python = spawnSync('python3', ['--version']).status === 0 ? 'python3' : null;

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  server.on('error', reject);
});

async function startStub(t, env = {}) {
  const port = await freePort();
  const child = spawn(python, [stubPath, '--port', String(port)], { env: { ...process.env, STUB_JWT_SECRET: 'j'.repeat(40), STUB_PUBLISHABLE_KEY: CONFIG.supabasePublishableKey, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`the stand-in exited early (${code})`)));
    child.stdout.on('data', chunk => { if (String(chunk).includes('Stub Supabase Auth')) resolve(); });
  });
  return `http://127.0.0.1:${port}`;
}

/** The native client's shape over fetch, with redirects left alone as the app's client leaves them. */
const http = async ({ url, method = 'GET', headers = {}, body }) => {
  const answer = await fetch(url, { method, headers, body, redirect: 'manual' });
  return { status: answer.status, headers: Object.fromEntries(answer.headers), body: new Uint8Array(await answer.arrayBuffer()) };
};

/** What the system browser does: follow redirects, press "Continue" on the stand-in Google's page, stop at the app's own address. */
async function browser({ url }) {
  let address = url;
  for (let step = 0; step < 8; step += 1) {
    if (address.startsWith('littlearchive://')) return { status: 'returned', url: address };
    const answer = await fetch(address, { redirect: 'manual' });
    if (answer.status >= 300 && answer.status < 400) { address = new URL(answer.headers.get('location'), address).href; continue; }
    const page = await answer.text();
    const next = /href='(\/stand-in-google\/(?:approve|deny)[^']*)'/.exec(page);
    assert.ok(next, `the browser reached something it cannot follow: ${answer.status} ${page.slice(0, 120)}`);
    address = new URL(next[1], address).href;
  }
  throw new Error('too many redirects');
}

const appleSheet = (email, sub = '001234.stand.in') => async ({ nonce }) => ({ status: 'signed_in', identityToken: fakeJwt({ iss: 'https://appleid.apple.com', aud: 'app.littlearchive.mobile', sub, nonce, ...(email ? { email } : {}) }) });

function appFor(base, plugin) {
  const supabase = createSupabase({ url: base, publishableKey: CONFIG.supabasePublishableKey, http });
  return createSocialSignIn({ supabase, plugin, platform: 'ios' });
}

const skip = python ? false : 'python3 is not installed';

test('Google against the stand-in: the app\'s challenge, redirect address and code exchange are accepted, and the same account comes back', { skip }, async t => {
  const base = await startStub(t);
  const social = appFor(base, { browser });
  const first = await social.google();
  assert.equal(first.email, 'google.reader@example.test');
  assert.ok(first.accessToken && first.refreshToken && first.userId);
  const second = await social.google();
  assert.equal(second.userId, first.userId);
  assert.notEqual(second.refreshToken, first.refreshToken);
});

test('Google against the stand-in: cancelling at Google comes back as an error in plain words, never as the text the address carried', { skip }, async t => {
  const base = await startStub(t, { STUB_GOOGLE_MODE: 'deny' });
  const social = appFor(base, { browser });
  await assert.rejects(social.google(), error => error instanceof AppError && /Google did not finish signing you in/.test(error.message) && !/denied/i.test(error.message));
});

test('Google against the stand-in: a project that has not switched Google on is explained, and no browser opens', { skip }, async t => {
  const base = await startStub(t, { STUB_PROVIDERS_OFF: 'google,apple' });
  let opened = 0;
  const social = appFor(base, { browser: async options => { opened += 1; return browser(options); }, apple: appleSheet('a@example.test') });
  await assert.rejects(social.google(), error => error instanceof AppError && /Google sign-in is not switched on yet/.test(error.message));
  assert.equal(opened, 0);
  await assert.rejects(social.apple(), error => error instanceof AppError && /Apple sign-in is not switched on yet/.test(error.message));
});

test('Apple against the stand-in: the hashed nonce Apple signs and the raw one the project is sent agree, with or without an email', { skip }, async t => {
  const base = await startStub(t);
  const withEmail = await appFor(base, { apple: appleSheet('reader@example.test') }).apple();
  assert.equal(withEmail.email, 'reader@example.test');
  const hidden = await appFor(base, { apple: appleSheet(null, '009999.hidden.email') }).apple();
  assert.equal(hidden.email, '', 'a person who withholds the email is signed in with an empty one');
  assert.ok(hidden.accessToken && hidden.userId);
  // And a token whose nonce is not the SHA-256 of what was sent is refused by the project.
  const forged = appFor(base, { apple: async () => ({ status: 'signed_in', identityToken: fakeJwt({ iss: 'https://appleid.apple.com', aud: 'app.littlearchive.mobile', sub: 'x', nonce: createHash('sha256').update('another').digest('hex') }) }) });
  await assert.rejects(forged.apple(), error => error instanceof AppError);
});
