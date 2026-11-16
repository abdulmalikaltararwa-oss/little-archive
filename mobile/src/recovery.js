// A forgotten password, for a hosted account that signs in with email and password. Supabase Auth's own flow, by its REST routes:
//
//   1. The person gives their email. The app makes a PKCE pair (as "Continue with Google" does, social.js), keeps the verifier,
//      and asks the project to send a link: POST /auth/v1/recover?redirect_to=littlearchive://auth-callback with the challenge.
//   2. The email's link opens the project's own page in a browser (GET /auth/v1/verify?token=pkce_…&type=recovery), which sends
//      the browser on to littlearchive://auth-callback?code=…, and that opens this app.
//   3. The app trades the code and the verifier for a session (POST /auth/v1/token?grant_type=pkce), asks for a new password
//      and sets it (PUT /auth/v1/user), and carries on signed in.
//
// Why PKCE, when the email sign-up has none. Without a challenge the project puts the session itself in the address it sends
// the browser to (#access_token=…). Any app on the phone can open littlearchive://auth-callback…, so an address that carried a
// session could sign this phone in to an account someone else chose. The app therefore never takes a session from an address:
// only a code, or an error. parseCallback (social.js) already reads nothing else.
//
// What PKCE protects, and what it does not. It protects a reset that this phone asked for: the code in that link can be traded
// only with the verifier kept here, so another app that gets hold of the address gets nothing it can use. It does nothing for a
// reset that someone else asked for. Anyone who knows an email address can ask the project for a reset from their own machine,
// without a challenge, and that link redirects with the session in the address. This app refuses such an address, but if
// another app on the phone has claimed the littlearchive scheme and the person taps that link, that app receives the session.
// Nothing in this app can prevent that; it is listed in the guide's risks (docs/mobile-app.md).
//
// What that costs. The verifier has to outlive the app's process (the person leaves for their mail app, and the phone may end
// the app meanwhile), so unlike a Google sign-in's it is written down: one record in the phone's secure storage, beside the
// session's but under its own name, with the server it was asked for and the time. It goes when the link has been used, when
// another link is asked for, or when it is an hour old. It does not go when one exchange fails: on Android any app can send the
// callback address with a made-up code, and that must not spoil a link that is still on its way. And the link has to be opened
// on the phone that asked for it.
//
// How long a link lasts. The project's server checks the code exchange against the time the link was asked for, not the time it
// was opened (internal/models/flow_state.go, IsExpired: only a magic link is measured from its code), and the default is five
// minutes (External.FlowStateExpiryDuration). Read from the source, not run against a real project. So the screen says to open
// the link soon, and a link that has run out gets a plain sentence and a way to ask again.
import { AppError } from './discovery.js';
import { CALLBACK_URL, parseCallback, pkcePair } from './social.js';

const KEY = 'recovery';
/** A verifier older than this is forgotten. Longer than the project keeps a link alive, so the project is what decides. */
export const MAX_AGE_MS = 60 * 60 * 1000;

/** The same words whatever the address is, so the screen never says whether an address has an account. */
export const RESET_SENT = 'If that address has an account, a reset link is on its way. Open the link on this phone, soon: it stops working after a few minutes.';
export const LINK_ENDED = 'That reset link has run out or was already used. Ask for a new one, and open it within a few minutes.';
export const LINK_NOT_ASKED = 'That reset link was not asked for on this phone, or a newer one has been asked for since. Ask for a new one here, then open it on this phone.';
export const LINK_UNREADABLE = 'That link did not come back the way it should. Ask for a new one.';

const IS_CALLBACK = /^littlearchive:\/\/auth-callback(?:[/?#]|$)/i;
const LAUNCH_CHECKED = 'la-launch-checked';
// What the project answers when the code is not one it will trade with this verifier: used, too old, or made for another one.
const ENDED = new Set(['flow_state_not_found', 'flow_state_expired', 'bad_code_verifier']);

const valid = record => record?.v === 1 && typeof record.verifier === 'string' && record.verifier.length >= 43 && typeof record.server === 'string' && Number.isFinite(record.madeAt);

/** The request this phone is waiting on a link for, or null. One that is too old, or unreadable, is removed. */
export async function pendingReset(backend, now = Date.now) {
  let record;
  try { record = await backend.get(KEY); } catch { return null; }
  if (record == null) return null;
  if (valid(record) && now() - record.madeAt >= 0 && now() - record.madeAt < MAX_AGE_MS) return record;
  try { await backend.remove(KEY); } catch { /* it is ignored either way */ }
  return null;
}

/** Does the address say, in the project's own code, that an emailed link was too old or already used? */
export const saysLinkEnded = address => { const back = parseCallback(address); return back.kind === 'error' && back.errorCode === 'otp_expired'; };

/**
 * @param {object} options
 * @param {ReturnType<import('./supabase.js').createSupabase>} options.supabase  pinned to the project this app was built for
 * @param {{get(key: string): Promise<any>, set(key: string, value: any): Promise<void>, remove(key: string): Promise<void>}} options.backend  the phone's secure storage (store.js)
 */
export function createRecovery({ supabase, backend, now = Date.now, subtle, fill }) {
  const pending = () => pendingReset(backend, now);

  return {
    pending,

    /**
     * Ask for a link. `server` is the Little Archive server the account screen was for, so that the link can finish there.
     * The verifier is kept before the request is sent: a link must never be on its way with nothing here to trade its code.
     * Returns without saying anything about the address (supabase.recover); only not reaching the service throws.
     */
    async request({ email, server }) {
      const { verifier, challenge } = await pkcePair({ subtle, fill });
      const before = await pending();
      await backend.set(KEY, { v: 1, verifier, server, madeAt: now() });
      try { await supabase.recover({ email, redirectTo: CALLBACK_URL, codeChallenge: challenge }); }
      catch (error) {
        // The project never heard of this verifier. An earlier link may still be on its way: its verifier comes back.
        try { await (before ? backend.set(KEY, before) : backend.remove(KEY)); } catch { /* the request's own failure is what matters */ }
        throw error;
      }
    },

    /**
     * The address a reset link opened the app with, for a session. Throws an AppError fit to show when the link is of no use.
     * The session is returned, not stored: it is kept only once a new password has been set.
     */
    async finish(address) {
      const back = parseCallback(address);
      // The project says so itself when the emailed link is too old or was opened before (otp_expired); any other error is read the same.
      if (back.kind === 'error') throw new AppError(LINK_ENDED, { code: 'link-ended' });
      if (back.kind !== 'code') throw new AppError(LINK_UNREADABLE, { code: 'link-unreadable' });
      const waiting = await pending();
      if (!waiting) throw new AppError(LINK_NOT_ASKED, { code: 'link-not-asked' });
      let session;
      try { session = await supabase.exchangeCode({ authCode: back.code, codeVerifier: waiting.verifier }); }
      catch (error) { throw ENDED.has(error?.code) ? new AppError(LINK_ENDED, { code: 'link-ended', cause: error }) : error; }
      // The verifier has done its work. A second link needs a second request.
      try { await backend.remove(KEY); } catch { /* it ages out */ }
      return session;
    },

    /** Forget a request, for example once the person has signed in another way. */
    async forget() { try { await backend.remove(KEY); } catch { /* it ages out */ } },
  };
}

/**
 * The callback address this start of the app was caused by, or ''. Asked once per process.
 *
 * A reset link opens the app from the browser, often with the app not running. Where the address is then: on iOS, and on a
 * true cold start on Android, it is the address the app was launched with (`App.getLaunchUrl()`). On Android the sign-in plugin
 * also sees it (Capacitor hands it the intent the activity was created with) and, with no sign-in waiting, sets it aside for
 * this question (`plugin.interrupted()`, which answers once). A native side from before reset links says only that it dropped
 * one; then the bare callback address is returned, which reads as "something came back, and it cannot be used".
 *
 * The launch address stays the same when the page reloads after a sign-out, so `storage` (sessionStorage, which a new process
 * starts without) remembers that it was looked at. Nothing of the address is kept.
 *
 * @param {object} options
 * @param {string} options.platform
 * @param {{interrupted(): Promise<{interrupted?: boolean, url?: string}>}} options.plugin  SocialSignIn
 * @param {{getLaunchUrl(): Promise<{url?: string}|undefined>}} options.App  @capacitor/app
 * @param {{getItem(key: string): string|null, setItem(key: string, value: string): void}} options.storage
 */
export async function launchCallback({ platform, plugin, App, storage }) {
  // Each question is a courtesy: one that fails is never a reason not to start.
  let dropped = false;
  let address = '';
  if (platform === 'android') {
    try {
      const answer = await plugin.interrupted();
      dropped = answer?.interrupted === true;
      if (dropped && typeof answer.url === 'string' && IS_CALLBACK.test(answer.url)) address = answer.url;
    } catch { /* an older native side */ }
  }
  try {
    const first = !storage.getItem(LAUNCH_CHECKED);
    storage.setItem(LAUNCH_CHECKED, '1');
    if (first && !address) {
      const launched = (await App.getLaunchUrl())?.url;
      if (typeof launched === 'string' && IS_CALLBACK.test(launched)) address = launched;
    }
  } catch { /* nothing to say */ }
  return address || (dropped ? CALLBACK_URL : '');
}

/**
 * Callback addresses that open the app while no sign-in is waiting for one: in practice, a reset link. The first-launch
 * screens look here between screens (onboarding.js); once someone is signed in it is closed and such an address is ignored.
 *
 * Who delivers them. On iOS, @capacitor/app's `appUrlOpen` (a Google sign-in's callback never comes this way: the authentication
 * session keeps it). On Android, the sign-in plugin's `callback` event, which it sends only when no sign-in of its own is
 * waiting; `appUrlOpen` is not listened to there, because it could also carry the callback of a Google sign-in that is waiting.
 * Any app can cause either, so what arrives is only ever read as a code to trade with a kept verifier, or as an error.
 *
 * On both platforms an address that arrives while the app is running is taken only when this phone is waiting on a reset link.
 * Otherwise it is dropped: it is a stray or another app's doing, nobody here asked for it, and taking it would redraw the screen
 * someone is typing on and ask a server a question for nothing. `backend` is the secure storage the request is kept in; without
 * it nothing that arrives is taken. (`push`, which boot.js uses for the address the app was started by, does not ask: at a
 * start there is no screen to lose, and onboarding.js decides what that address is.)
 */
export function createLinkInbox({ platform, plugin, App, backend, now = Date.now }) {
  let open = true;
  let queued = '';
  let last = '';
  let lastAt = 0;
  let wake;
  let arrival = new Promise(resolve => { wake = resolve; });
  function push(address) {
    if (!open || typeof address !== 'string' || !IS_CALLBACK.test(address)) return;
    // The same address twice in a moment is one link heard twice (the launch address and the event can both carry it). Later
    // it is a second tap, and is answered again: every link that ran out comes back as the very same address.
    if (address === last && now() - lastAt < 2000) return;
    last = address;
    lastAt = now();
    queued = address;
    wake();
  }
  const heard = event => {
    const address = event?.url;
    if (typeof address !== 'string' || !IS_CALLBACK.test(address) || !backend) return;
    pendingReset(backend).then(waiting => { if (waiting) push(address); }, () => {});
  };
  try {
    if (platform === 'android') plugin?.addListener?.('callback', heard);
    else App?.addListener?.('appUrlOpen', heard);
  } catch { /* without a listener, a link is still found at the next start */ }
  return {
    push,
    get waiting() { return queued !== ''; },
    /** Resolves when an address is waiting. It is not taken by this. */
    arrival: () => arrival,
    take() {
      const address = queued;
      if (address) { queued = ''; arrival = new Promise(resolve => { wake = resolve; }); }
      return address;
    },
    close() { open = false; queued = ''; },
  };
}
