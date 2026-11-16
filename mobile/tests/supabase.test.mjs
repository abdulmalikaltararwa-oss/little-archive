import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/discovery.js';
import { createSupabase, readClaims, sessionFrom } from '../src/supabase.js';
import { CONFIG, fakeHttp, fakeJwt, reply, text } from './helpers.mjs';

const BASE = CONFIG.supabaseUrl;
const NOW = 1_800_000_000_000;
const token = (extra = {}) => fakeJwt({ sub: '0d0f6c1e-62f1-4a35-a0b8-1d7a1a6d8b11', email: 'reader@example.com', exp: NOW / 1000 + 3600, ...extra });
const session = (extra = {}) => ({ access_token: token(), refresh_token: 'refresh-1', expires_in: 3600, token_type: 'bearer', user: { id: '0d0f6c1e-62f1-4a35-a0b8-1d7a1a6d8b11', email: 'reader@example.com' }, ...extra });
const client = routes => { const fake = fakeHttp(routes); return { ...fake, supabase: createSupabase({ url: `${BASE}/`, publishableKey: CONFIG.supabasePublishableKey, http: fake.http, now: () => NOW }) }; };

async function refusal(promise) {
  try { await promise; } catch (error) { assert.ok(error instanceof AppError, String(error)); return error.message; }
  assert.fail('expected an AppError');
}

test('sign-in posts to the password grant with the publishable key, and returns a session the app can store', async () => {
  const { supabase, calls } = client({ [`POST ${BASE}/auth/v1/token?grant_type=password`]: reply(200, session()) });
  const result = await supabase.signIn('reader@example.com', 'correct horse battery');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.apikey, CONFIG.supabasePublishableKey);
  assert.equal(calls[0].headers.Authorization, undefined, 'the publishable key is an apikey, never a bearer token');
  assert.deepEqual(JSON.parse(calls[0].body), { email: 'reader@example.com', password: 'correct horse battery' });
  assert.deepEqual(result, { type: 'supabase', accessToken: session().access_token, refreshToken: 'refresh-1', expiresAt: NOW + 3_600_000, userId: '0d0f6c1e-62f1-4a35-a0b8-1d7a1a6d8b11', email: 'reader@example.com' });
});

test('sign-up returns a session when no confirmation is needed, and says a message was sent when it is', async () => {
  const route = `POST ${BASE}/auth/v1/signup`;
  const direct = client({ [route]: reply(200, session()) });
  assert.equal((await direct.supabase.signUp('new@example.com', 'a long enough password')).session.refreshToken, 'refresh-1');
  const confirm = client({ [route]: reply(200, { id: 'x', email: 'new@example.com', confirmation_sent_at: '2026-11-14T10:00:00Z' }) });
  assert.deepEqual(await confirm.supabase.signUp('new@example.com', 'a long enough password'), { confirmationSent: true });
});

test('refresh trades the refresh token; a refused one ends the session (null), anything else is an error, not a sign-out', async () => {
  const route = `POST ${BASE}/auth/v1/token?grant_type=refresh_token`;
  const good = client({ [route]: reply(200, session({ refresh_token: 'refresh-2' })) });
  assert.equal((await good.supabase.refresh('refresh-1')).refreshToken, 'refresh-2');
  assert.deepEqual(JSON.parse(good.calls[0].body), { refresh_token: 'refresh-1' });
  for (const status of [400, 401, 403]) assert.equal(await client({ [route]: reply(status, { error_code: 'refresh_token_not_found' }) }).supabase.refresh('x'), null, String(status));
  await refusal(client({ [route]: reply(503, {}) }).supabase.refresh('x'));
  await refusal(client({ [route]: new Error('offline') }).supabase.refresh('x'));
});

test('sign-out sends the access token to end this device only, and never throws', async () => {
  const route = `POST ${BASE}/auth/v1/logout?scope=local`;
  const { supabase, calls } = client({ [route]: reply(204, {}) });
  await supabase.signOut('access-token');
  assert.equal(calls[0].headers.Authorization, 'Bearer access-token');
  await client({ [route]: new Error('offline') }).supabase.signOut('access-token');
});

test('errors are in plain words, from the error code, whatever the service wrote', async () => {
  const route = `POST ${BASE}/auth/v1/token?grant_type=password`;
  const say = async (answer) => refusal(client({ [route]: answer }).supabase.signIn('a@example.com', 'x'));
  assert.match(await say(reply(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' })), /email and password did not match/);
  assert.match(await say(reply(400, { error_code: 'email_not_confirmed' })), /Confirm your email/);
  assert.match(await say(reply(429, {})), /Too many attempts/);
  assert.match(await say(reply(500, {})), /having trouble/);
  assert.match(await say(reply(400, { msg: 'Some specific message' })), /Some specific message/);
  assert.match(await say(reply(400, { msg: 'x'.repeat(500) })), /did not work/, 'a long message is not shown');
  assert.match(await say(text(502, '<html>bad gateway</html>')), /having trouble/);
  assert.match(await refusal(client({ [route]: new Error('offline') }).supabase.signIn('a@example.com', 'x')), /Could not reach the sign-in service/);
  assert.match(await refusal(client({ [route]: reply(200, { access_token: 5 }) }).supabase.signIn('a@example.com', 'x')), /could not read/);
  const signup = client({ [`POST ${BASE}/auth/v1/signup`]: reply(422, { error_code: 'user_already_exists' }) });
  assert.match(await refusal(signup.supabase.signUp('a@example.com', 'x')), /already exists/);
});

test('asking for a reset link: the redirect address in the query, the challenge in the body, and silence whatever the answer', async () => {
  const route = `POST ${BASE}/auth/v1/recover?redirect_to=littlearchive%3A%2F%2Fauth-callback`;
  const ask = supabase => supabase.recover({ email: 'reader@example.com', redirectTo: 'littlearchive://auth-callback', codeChallenge: 'c'.repeat(43) });
  const { supabase, calls } = client({ [route]: reply(200, {}) });
  assert.equal(await ask(supabase), undefined);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.apikey, CONFIG.supabasePublishableKey);
  assert.deepEqual(JSON.parse(calls[0].body), { email: 'reader@example.com', code_challenge: 'c'.repeat(43), code_challenge_method: 's256' });
  // An unknown address is a 200 and a known one asked twice in a minute is a 429: neither may be told apart from the other.
  for (const answer of [reply(429, { error_code: 'over_email_send_rate_limit' }), reply(429, { error_code: 'over_request_rate_limit' }), reply(400, { error_code: 'validation_failed' }), reply(500, {}), text(502, 'bad gateway')]) assert.equal(await ask(client({ [route]: answer }).supabase), undefined);
  assert.match(await refusal(ask(client({ [route]: new Error('offline') }).supabase)), /Could not reach the sign-in service/);
});

test('a new password is PUT to the user route with the session\'s own token, and each refusal is in plain words', async () => {
  const route = `PUT ${BASE}/auth/v1/user`;
  const set = supabase => supabase.setPassword({ accessToken: 'the-access-token', password: 'a brand new password' });
  const { supabase, calls } = client({ [route]: reply(200, { id: 'user-1', email: 'reader@example.com' }) });
  assert.equal(await set(supabase), undefined);
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].headers.Authorization, 'Bearer the-access-token');
  assert.equal(calls[0].headers.apikey, CONFIG.supabasePublishableKey);
  assert.deepEqual(JSON.parse(calls[0].body), { password: 'a brand new password' });
  const failed = async answer => { try { await set(client({ [route]: answer }).supabase); } catch (error) { assert.ok(error instanceof AppError, String(error)); return error; } assert.fail('expected an AppError'); };
  const weak = await failed(reply(422, { error_code: 'weak_password', msg: 'Password should be at least 8 characters.' }));
  assert.match(weak.message, /too easy to guess/);
  assert.equal(weak.field, 'password', 'shown on the password field');
  const same = await failed(reply(422, { error_code: 'same_password', msg: 'New password should be different from the old password.' }));
  assert.equal(same.message, 'That is the password this account already has. Choose a different one.');
  assert.equal(same.field, 'password');
  for (const status of [401, 403]) assert.equal((await failed(reply(status, { error_code: 'bad_jwt' }))).message, 'This reset has run out. Go back and ask for a new link.');
  assert.match((await failed(reply(500, {}))).message, /having trouble/);
  assert.match((await failed(reply(429, {}))).message, /Too many attempts/);
  assert.match((await failed(new Error('offline'))).message, /Could not reach the sign-in service/);
});

test('the claims of an access token are read for display only, and garbage gives nothing', () => {
  assert.equal(readClaims(token()).email, 'reader@example.com');
  assert.equal(readClaims(fakeJwt({ email: 'zoë@example.com' })).email, 'zoë@example.com');
  for (const bad of ['', 'abc', 'a.b.c', null, undefined, 'a.%%%.c']) assert.deepEqual(readClaims(bad), {});
  assert.equal(sessionFrom({ access_token: 'a' }, () => NOW), null);
  assert.equal(sessionFrom(null, () => NOW), null);
  // expires_at (seconds) wins; otherwise the lifetime; otherwise the token's own exp.
  assert.equal(sessionFrom({ ...session(), expires_at: 1_900_000_000 }, () => NOW).expiresAt, 1_900_000_000_000);
  assert.equal(sessionFrom({ ...session(), expires_in: undefined }, () => NOW).expiresAt, (NOW / 1000 + 3600) * 1000);
});
