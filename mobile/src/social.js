// "Continue with Apple" and "Continue with Google" for a hosted account. The email and password sign-in is in supabase.js; this
// module drives the two other ways in, and everything it keeps is in memory for the length of one attempt.
//
// Apple (iOS only, the native sheet). The app makes a random raw nonce and gives Apple its SHA-256 as lower case hex. Apple signs
// that string into the identity token it hands back. The token and the *raw* nonce go to the project
// (POST /auth/v1/token?grant_type=id_token), which hashes the raw value the same way and compares. A token with no matching nonce
// is refused by the project, so a stolen token is of no use without the raw nonce, which never left this function.
//
// Google (iOS and Android, the system browser, PKCE). The app makes a random code verifier and keeps it. The system
// authentication session opens the project's authorize address with the verifier's SHA-256 (the "code challenge"); the project
// sends the person to Google, then back to littlearchive://auth-callback?code=…; the app trades the code and the verifier for a
// session (POST /auth/v1/token?grant_type=pkce). A code from anyone else's attempt is useless here, because the project checks
// it against the challenge of the attempt that made it.
//
// The native side (SocialSignIn: Swift with AuthenticationServices, Java with Custom Tabs) only shows the sheet or the browser
// and hands back what came out of it. It never sees the verifier or the raw nonce, and it answers a call only while that call is
// waiting: there is no listener here for an address that arrives from anywhere else. Neither secret is written to storage or to
// any log, and both are gone when the attempt ends, whatever way it ends.
import { AppError } from './discovery.js';
import { callbackProblem } from './supabase.js';

/** The address Supabase sends the browser back to. It must be on the project's redirect allow-list, exactly as written here. */
export const CALLBACK_URL = 'littlearchive://auth-callback';
const CALLBACK = /^littlearchive:\/\/auth-callback\/?(\?[^#]*)?(#.*)?$/i;

const LABEL = { apple: 'Apple', google: 'Google' };
const CANNOT_PREPARE = 'This device cannot prepare a safe sign-in. Update the system web view and try again.';

const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const base64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * What came back from the browser. Only an address that is exactly the app's own callback counts; anything else is `invalid`.
 * An error wins over a code. Supabase puts the error in the query (and repeats it in the fragment), so both are read.
 * @returns {{kind: 'code', code: string} | {kind: 'error', errorCode: string} | {kind: 'invalid'}}
 */
export function parseCallback(address) {
  const match = CALLBACK.exec(typeof address === 'string' ? address : '');
  if (!match) return { kind: 'invalid' };
  const query = new URLSearchParams(match[1] || '');
  const fragment = new URLSearchParams((match[2] || '').slice(1));
  const get = name => query.get(name) ?? fragment.get(name);
  if (get('error') || get('error_code') || get('error_description')) return { kind: 'error', errorCode: String(get('error_code') || '') };
  const code = query.get('code');
  return code && code.length <= 512 && !/\s/.test(code) ? { kind: 'code', code } : { kind: 'invalid' };
}

/** Plain words for a failure of the native side. Its own sentences are fit to show; anything else is not. */
function nativeProblem(error, fallback) {
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  return new AppError(message && message.length < 200 ? message : fallback, { cause: error });
}

/**
 * @param {object} options
 * @param {ReturnType<import('./supabase.js').createSupabase>} options.supabase  pinned to the project this app was built for
 * @param {{apple(o: {nonce: string}): Promise<object>, browser(o: {url: string}): Promise<object>}} options.plugin  SocialSignIn
 * @param {'ios'|'android'|string} options.platform
 */
export function createSocialSignIn({ supabase, plugin, platform, subtle = globalThis.crypto?.subtle, fill = bytes => globalThis.crypto.getRandomValues(bytes) }) {
  // Sign in with Apple is part of iOS; Google works in any system browser.
  const available = Object.freeze({ apple: platform === 'ios', google: platform === 'ios' || platform === 'android' });
  let busy = false;

  async function sha256(text) {
    if (!subtle) throw new AppError(CANNOT_PREPARE);
    return new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(text)));
  }
  const secret = size => base64url(fill(new Uint8Array(size)));

  // One attempt at a time. A second tap while one is open is refused, not queued.
  async function exclusive(provider, attempt) {
    if (!available[provider]) throw new AppError(`${LABEL[provider]} sign-in is not available on this device.`);
    if (busy) throw new AppError('A sign-in is already open. Finish it or close it first.');
    busy = true;
    try { return await attempt(); } finally { busy = false; }
  }

  return {
    available,

    /** @returns {Promise<object|null>} the session, or null when the person closed the sheet */
    apple: () => exclusive('apple', async () => {
      const nonce = secret(32); // raw: for the project only
      const hashed = hex(await sha256(nonce)); // lower case hex: what Apple signs into the token
      let answer;
      try { answer = await plugin.apple({ nonce: hashed }); }
      catch (error) { throw nativeProblem(error, 'Sign in with Apple did not work. Try again.'); }
      if (answer?.status === 'cancelled') return null;
      const token = answer?.identityToken;
      if (answer?.status !== 'signed_in' || typeof token !== 'string' || token.split('.').length !== 3) throw new AppError('Apple did not send back a sign-in. Try again.');
      return supabase.signInWithIdToken({ provider: 'apple', idToken: token, nonce, label: LABEL.apple });
    }),

    /** @returns {Promise<object|null>} the session, or null when the person closed the browser */
    google: () => exclusive('google', async () => {
      const verifier = secret(48); // 64 characters; Supabase accepts 43 to 128
      const challenge = base64url(await sha256(verifier));
      await supabase.providerReady({ provider: 'google', label: LABEL.google });
      let answer;
      try { answer = await plugin.browser({ url: supabase.authorizeUrl({ provider: 'google', redirectTo: CALLBACK_URL, codeChallenge: challenge }) }); }
      catch (error) { throw nativeProblem(error, 'Could not open the browser for Google. Try again.'); }
      if (answer?.status === 'cancelled') return null;
      const back = answer?.status === 'returned' ? parseCallback(answer.url) : { kind: 'invalid' };
      if (back.kind === 'error') throw callbackProblem(back.errorCode, LABEL.google);
      if (back.kind !== 'code') throw new AppError('Google sign-in did not come back the way it should. Try again.');
      return supabase.exchangeCode({ authCode: back.code, codeVerifier: verifier, label: LABEL.google });
    }),
  };
}
