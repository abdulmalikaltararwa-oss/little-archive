// Email and password sign-in against Supabase Auth, by its documented REST routes (no SDK).
//
//   POST /auth/v1/signup                        create an account
//   POST /auth/v1/token?grant_type=password     sign in
//   POST /auth/v1/token?grant_type=refresh_token  trade a refresh token for new tokens
//   POST /auth/v1/logout?scope=local            end this device's session
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
};

function problem(reply) {
  const body = bodyJson(reply) || {};
  const code = body.error_code || body.code;
  if (typeof code === 'string' && KNOWN[code]) return new AppError(KNOWN[code]);
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

export function createSupabase({ url, publishableKey, http, now = Date.now }) {
  const base = String(url).replace(/\/+$/, '');
  async function call(path, { body, token } = {}) {
    const headers = { apikey: publishableKey, Accept: 'application/json', 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    try { return await http({ url: `${base}${path}`, method: 'POST', headers, body: JSON.stringify(body ?? {}) }); }
    catch (error) { throw new AppError('Could not reach the sign-in service. Check your connection and try again.', { cause: error }); }
  }
  return {
    async signIn(email, password) {
      const reply = await call('/auth/v1/token?grant_type=password', { body: { email, password } });
      if (reply.status !== 200) throw problem(reply);
      const session = sessionFrom(bodyJson(reply), now);
      if (!session) throw new AppError('The sign-in service sent an answer the app could not read.');
      return session;
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
