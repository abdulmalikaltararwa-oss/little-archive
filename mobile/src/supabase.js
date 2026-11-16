// Email and password sign-in against Supabase Auth, by its documented REST routes (no SDK).
//
//   POST /auth/v1/signup                        create an account
//   POST /auth/v1/token?grant_type=password     sign in
//   POST /auth/v1/token?grant_type=refresh_token  trade a refresh token for new tokens
//   POST /auth/v1/logout?scope=local            end this device's session
//   POST /auth/v1/token?grant_type=id_token     sign in with an Apple identity token (the native sheet), see social.js
//   GET  /auth/v1/settings                      which providers the project has switched on (asked before the browser opens)
//   GET  /auth/v1/authorize?provider=google&…   the address the system browser opens for Google (PKCE), see social.js
//   POST /auth/v1/token?grant_type=pkce         trade the code that came back for a session
//   POST /auth/v1/recover?redirect_to=…         ask for a password-reset link by email (PKCE), see recovery.js
//   PUT  /auth/v1/user                          set a new password, with the session the reset link gave
//
// Every request carries the project's publishable key in `apikey`. That key is public by design (it only identifies
// the project; what a person can do is set by their own access token), so it lives in app.config.json. No other
// Supabase key belongs in this app.
import { AppError, bodyJson } from './discovery.js';

const KNOWN = {
  invalid_credentials: 'That email and password did not match. Check them and try again.',
  email_not_confirmed: 'Confirm your email first: open the message we sent you, then sign in.',
  user_already_exists: 'An account with this email already exists. Sign in instead.',
  email_exists: 'An account with this email already exists. Sign in instead.',
  weak_password: 'That password is too easy to guess. Use a longer one.',
  signup_disabled: 'New accounts cannot be created right now.',
  over_request_rate_limit: 'Too many attempts. Wait a few minutes and try again.',
  over_email_send_rate_limit: 'Too many emails were sent. Wait a few minutes and try again.',
  validation_failed: 'Check the email address and try again.',
  user_banned: 'This account has been suspended.',
  // The code exchange of a browser sign-in (Supabase's PKCE flow): the code is single use and lasts a few minutes.
  bad_code_verifier: 'That sign-in did not finish. Try again.',
  flow_state_not_found: 'That sign-in did not finish. Try again.',
  flow_state_expired: 'That sign-in took too long. Try again.',
  bad_oauth_callback: 'That sign-in did not finish. Try again.',
  bad_oauth_state: 'That sign-in did not finish. Try again.',
  same_password: 'That is the password this account already has. Choose a different one.',
};

/**
 * Is this the answer of a project that has not switched the provider on? Supabase says so in two ways: the token grant answers
 * `provider_disabled` (and the error-codes page lists `oauth_provider_not_supported`), and the authorize address answers
 * `validation_failed` with "Unsupported provider: provider is not enabled" (or "missing OAuth secret"), which is what a
 * provider with no client secret yet looks like. Both are 400s.
 */
export function providerIsOff(body) {
  const code = body?.error_code || body?.code;
  if (code === 'provider_disabled' || code === 'oauth_provider_not_supported') return true;
  const message = String(body?.msg || body?.message || '');
  return code === 'validation_failed' && /^unsupported provider/i.test(message);
}

/** `label` names the provider ("Google", "Apple") for the sign-ins that have one; email and password has none. */
function problem(reply, label = '') {
  const body = bodyJson(reply) || {};
  if (label && providerIsOff(body)) return new AppError(`${label} sign-in is not switched on yet. Use your email and password for now.`);
  // Apple's identity token names the app it was made for; the project accepts only the bundle ids listed in its Apple settings.
  if (label && /unacceptable audience/i.test(String(body.error_description || body.msg || ''))) return new AppError(`${label} sign-in is not set up for this app yet. Use your email and password for now.`);
  const code = body.error_code || body.code;
  // The code travels with the sentence, for a caller that has its own words for it (a reset link's code exchange, recovery.js).
  if (typeof code === 'string' && KNOWN[code]) return new AppError(KNOWN[code], { code });
  if (reply.status === 429) return new AppError(KNOWN.over_request_rate_limit);
  if (reply.status >= 500) return new AppError('The sign-in service is having trouble. Try again in a moment.');
  const message = body.msg || body.message || body.error_description;
  return new AppError(typeof message === 'string' && message.length < 200 ? message : 'Sign-in did not work. Try again.');
}

// Reads the claims of an access token, for its expiry and email only. The server verifies the token; the app trusts nothing here.
export function readClaims(token) {
  try {
    const part = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(part.padEnd(Math.ceil(part.length / 4) * 4, '='));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0))));
  } catch { return {}; }
}

export function sessionFrom(body, now) {
  if (!body || typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') return null;
  const claims = readClaims(body.access_token);
  const lifetime = Number(body.expires_in);
  const expiresAt = Number.isFinite(Number(body.expires_at)) && Number(body.expires_at) > 0 ? Number(body.expires_at) * 1000
    : Number.isFinite(lifetime) && lifetime > 0 ? now() + lifetime * 1000 : (Number(claims.exp) || 0) * 1000;
  return { type: 'supabase', accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt, userId: String(body.user?.id || claims.sub || ''), email: String(body.user?.email || claims.email || '') };
}

/** What the app can say about a browser sign-in that came back with an error: the code, never the text the address carried. */
export function callbackProblem(errorCode, label) {
  if (errorCode && providerIsOff({ error_code: errorCode })) return new AppError(`${label} sign-in is not switched on yet. Use your email and password for now.`);
  if (typeof errorCode === 'string' && KNOWN[errorCode]) return new AppError(KNOWN[errorCode]);
  return new AppError(`${label} did not finish signing you in. Try again.`);
}

export function createSupabase({ url, publishableKey, http, now = Date.now }) {
  const base = String(url).replace(/\/+$/, '');
  async function call(path, { body, token, method = 'POST' } = {}) {
    const headers = { apikey: publishableKey, Accept: 'application/json', 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    try { return await http({ url: `${base}${path}`, method, headers, body: JSON.stringify(body ?? {}) }); }
    catch (error) { throw new AppError('Could not reach the sign-in service. Check your connection and try again.', { code: 'unreachable', cause: error }); }
  }
  /** A session from a token grant, or the reason in words. */
  async function granted(reply, label) {
    if (reply.status !== 200) throw problem(reply, label);
    const session = sessionFrom(bodyJson(reply), now);
    if (!session) throw new AppError('The sign-in service sent an answer the app could not read.');
    return session;
  }
  // Every address a browser sign-in uses starts from the pinned `base`, and nothing else: the provider's own pages are reached
  // by Supabase's redirect, never by an address the app was handed.
  function authorizeUrl({ provider, redirectTo, codeChallenge }) {
    if (provider !== 'google') throw new Error(`No browser sign-in for ${provider}.`);
    // prompt=select_account: Google shows its account chooser every time, so signing in again after signing out does not silently
    // reuse the Google account the browser remembers. The project passes query parameters it does not own on to the provider
    // (internal/api/external.go; `prompt` is not in its reserved list).
    const query = new URLSearchParams({ provider, redirect_to: redirectTo, prompt: 'select_account' });
    // Supabase's documented spelling is lower case: auth-js sends code_challenge_method=s256.
    if (codeChallenge) { query.set('code_challenge', codeChallenge); query.set('code_challenge_method', 's256'); }
    return `${base}/auth/v1/authorize?${query}`;
  }
  return {
    signIn: async (email, password) => granted(await call('/auth/v1/token?grant_type=password', { body: { email, password } })),
    authorizeUrl,
    /**
     * Is the provider switched on? Supabase answers a switched-off provider's authorize address with a 400 page that the system
     * browser would show as raw text and the app would never hear about. So the project's public settings are read first
     * (GET /auth/v1/settings lists `external.<provider>` as true or false, needs no sign-in and records nothing on the project).
     *
     * The sign-in is refused only when the answer says the provider is off, or when the service cannot be reached. Any other
     * answer (a rate limit, an error page, a shape this app does not know) lets the browser open: this check exists to turn one
     * known dead end into a sentence, not to stand between a person and a sign-in that may well work.
     */
    async providerReady({ provider, label }) {
      let reply;
      try { reply = await http({ url: `${base}/auth/v1/settings`, method: 'GET', headers: { apikey: publishableKey, Accept: 'application/json' } }); }
      catch (error) { throw new AppError('Could not reach the sign-in service. Check your connection and try again.', { cause: error }); }
      const body = bodyJson(reply);
      const off = reply.status === 200 ? body?.external?.[provider] === false : providerIsOff(body);
      if (off) throw new AppError(`${label} sign-in is not switched on yet. Use your email and password for now.`);
    },
    /** The code a browser sign-in came back with, for a session. `codeVerifier` is the secret half of the PKCE pair. */
    async exchangeCode({ authCode, codeVerifier, label }) {
      return granted(await call('/auth/v1/token?grant_type=pkce', { body: { auth_code: authCode, code_verifier: codeVerifier } }), label);
    },
    /** Sign in with an identity token from a provider's own sheet. `nonce` is the raw value whose SHA-256 (lower case hex) the token carries. */
    async signInWithIdToken({ provider, idToken, nonce, label }) {
      return granted(await call('/auth/v1/token?grant_type=id_token', { body: { provider, id_token: idToken, nonce } }), label);
    },
    /** @returns {Promise<{session: object} | {confirmationSent: true}>} */
    async signUp(email, password) {
      const reply = await call('/auth/v1/signup', { body: { email, password } });
      if (reply.status !== 200) throw problem(reply);
      const body = bodyJson(reply);
      const session = sessionFrom(body, now);
      // With email confirmation on, Supabase answers with the new user and no session.
      return session ? { session } : { confirmationSent: true };
    },
    /**
     * Ask the project to email a password-reset link. `codeChallenge` makes it a PKCE link: it comes back to `redirectTo` with a
     * code that is of use only with the verifier this phone kept (recovery.js). The address goes in the query, as auth-js sends it.
     *
     * Whatever the service answers, this returns without a word, because the answers differ by whether the address has an
     * account: an unknown address is a 200 with nothing sent, while a known one asked twice within a minute is a 429. Saying
     * either apart from the other would tell a stranger which addresses are registered. Only not reaching the service throws.
     */
    async recover({ email, redirectTo, codeChallenge }) {
      await call(`/auth/v1/recover?${new URLSearchParams({ redirect_to: redirectTo })}`, { body: { email, code_challenge: codeChallenge, code_challenge_method: 's256' } });
    },
    /** Set the password of the account `accessToken` belongs to. Used with the session a reset link gave. */
    async setPassword({ accessToken, password }) {
      const reply = await call('/auth/v1/user', { method: 'PUT', token: accessToken, body: { password } });
      if (reply.status === 200) return;
      // The session the link gave has ended (it lasts as long as any access token): only a new link helps.
      if (reply.status === 401 || reply.status === 403) throw new AppError('This reset has run out. Go back and ask for a new link.', { code: 'session-ended' });
      const refusal = problem(reply);
      throw refusal.code === 'weak_password' || refusal.code === 'same_password' ? new AppError(refusal.message, { field: 'password', code: refusal.code }) : refusal;
    },
    /** A rejected refresh token means the session is over (null); anything else that goes wrong throws. */
    async refresh(refreshToken) {
      const reply = await call('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: refreshToken } });
      if (reply.status === 400 || reply.status === 401 || reply.status === 403) return null;
      if (reply.status !== 200) throw problem(reply);
      const session = sessionFrom(bodyJson(reply), now);
      if (!session) throw new AppError('The sign-in service sent an answer the app could not read.');
      return session;
    },
    /** Best effort: the local session is cleared whatever this returns. */
    async signOut(accessToken) {
      try { await call('/auth/v1/logout?scope=local', { token: accessToken }); } catch { /* The device forgets the session regardless. */ }
    },
  };
}
