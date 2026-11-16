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
import { LINK_ENDED, createRecovery } from '../src/recovery.js';
import { memoryBackend } from '../src/store.js';
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

// A forgotten password, end to end against the stand-in: the app's request, the emailed link as a browser opens it, the code
// exchange and the new password.

const EMAIL = 'reader@example.test';
const OLD = 'the old password';
const NEW = 'a brand new password';
const SERVER = 'https://app.little-archive.example';

function resetFor(base) {
  const supabase = createSupabase({ url: base, publishableKey: CONFIG.supabasePublishableKey, http });
  const backend = memoryBackend();
  return { supabase, backend, recovery: createRecovery({ supabase, backend }) };
}

/** The links the stand-in would have emailed to an address, newest first (its development-only page). */
async function mailFor(base, to) {
  const page = await (await fetch(`${base}/stand-in-mail?to=${encodeURIComponent(to)}`)).text();
  return [...page.matchAll(/href='([^']+)'/g)].map(match => match[1].replaceAll('&amp;', '&'));
}

/** What the phone's browser does with an emailed link: one request, and the app's own address it is sent on to. */
async function openInBrowser(link) {
  const answer = await fetch(link, { redirect: 'manual' });
  assert.equal(answer.status, 302);
  return answer.headers.get('location');
}

test('a reset against the stand-in: the request is accepted with the app\'s redirect, the link comes back with a code, and the new password signs in', { skip }, async t => {
  const base = await startStub(t);
  const { supabase, backend, recovery } = resetFor(base);
  await supabase.signUp(EMAIL, OLD);
  await recovery.request({ email: EMAIL, server: SERVER });
  const [link] = await mailFor(base, EMAIL);
  assert.equal(new URL(link).searchParams.get('redirect_to'), 'littlearchive://auth-callback', 'the stand-in allows only that address, as the project does');
  assert.ok(new URL(link).searchParams.get('token').startsWith('pkce_'));
  const address = await openInBrowser(link);
  assert.match(address, /^littlearchive:\/\/auth-callback\?code=[0-9a-f]+$/, 'a code and nothing else: no session in the address');
  const session = await recovery.finish(address);
  assert.equal(session.email, EMAIL);
  assert.equal(await backend.get('recovery'), null);
  // The rules of the new password, as the service applies them.
  await assert.rejects(supabase.setPassword({ accessToken: session.accessToken, password: 'short' }), error => error instanceof AppError && error.field === 'password' && /too easy to guess/.test(error.message));
  await assert.rejects(supabase.setPassword({ accessToken: session.accessToken, password: OLD }), error => error instanceof AppError && error.field === 'password' && /already has/.test(error.message));
  await supabase.setPassword({ accessToken: session.accessToken, password: NEW });
  await assert.rejects(supabase.signIn(EMAIL, OLD), error => error instanceof AppError && /did not match/.test(error.message));
  assert.equal((await supabase.signIn(EMAIL, NEW)).userId, session.userId);
  // The session the link gave is an ordinary one: it refreshes.
  assert.ok((await supabase.refresh(session.refreshToken)).accessToken);
});

test('a reset against the stand-in: an address with no account gets the same silence and no mail', { skip }, async t => {
  const base = await startStub(t);
  const { supabase, recovery } = resetFor(base);
  await supabase.signUp(EMAIL, OLD);
  assert.equal(await recovery.request({ email: 'nobody@example.test', server: SERVER }), undefined);
  assert.equal(await recovery.request({ email: EMAIL, server: SERVER }), undefined);
  // Asked again within the minute: the stand-in answers 429 to the known address only, and the app still says nothing.
  assert.equal(await recovery.request({ email: EMAIL, server: SERVER }), undefined);
  assert.deepEqual(await mailFor(base, 'nobody@example.test'), []);
  assert.equal((await mailFor(base, EMAIL)).length, 1);
});

test('a reset against the stand-in: a link opened twice, and a code traded too late, are both the plain "ran out" sentence', { skip }, async t => {
  const base = await startStub(t, { STUB_MAIL_GAP: '0' });
  const first = resetFor(base);
  await first.supabase.signUp(EMAIL, OLD);
  await first.recovery.request({ email: EMAIL, server: SERVER });
  const [link] = await mailFor(base, EMAIL);
  await openInBrowser(link);
  const second = await openInBrowser(link);
  assert.match(second, /error_code=otp_expired/);
  await assert.rejects(first.recovery.finish(second), error => error instanceof AppError && error.message === LINK_ENDED);
  // A code is good for the project's five minutes from when the link was asked for; here that time is zero.
  const late = await startStub(t, { STUB_CODE_TTL: '0' });
  const slow = resetFor(late);
  await slow.supabase.signUp(EMAIL, OLD);
  await slow.recovery.request({ email: EMAIL, server: SERVER });
  const address = await openInBrowser((await mailFor(late, EMAIL))[0]);
  await new Promise(resolve => setTimeout(resolve, 20));
  await assert.rejects(slow.recovery.finish(address), error => error instanceof AppError && error.message === LINK_ENDED);
  // A code from this phone's link is of no use to a phone that did not ask for it.
  const third = resetFor(base);
  await first.recovery.request({ email: EMAIL, server: SERVER });
  await third.recovery.request({ email: 'someone.else@example.test', server: SERVER });
  const stolen = await openInBrowser((await mailFor(base, EMAIL))[0]);
  await assert.rejects(third.recovery.finish(stolen), error => error instanceof AppError && error.message === LINK_ENDED);
});

test('a reset against the stand-in: an account that only uses Google gets the same answer, and its link works too', { skip }, async t => {
  const base = await startStub(t, { STUB_GOOGLE_MODE: 'approve' });
  const google = await appFor(base, { browser }).google();
  const { supabase, recovery } = resetFor(base);
  assert.equal(await recovery.request({ email: 'google.reader@example.test', server: SERVER }), undefined);
  const session = await recovery.finish(await openInBrowser((await mailFor(base, 'google.reader@example.test'))[0]));
  assert.equal(session.userId, google.userId);
  await supabase.setPassword({ accessToken: session.accessToken, password: NEW });
  assert.equal((await supabase.signIn('google.reader@example.test', NEW)).userId, google.userId);
});
