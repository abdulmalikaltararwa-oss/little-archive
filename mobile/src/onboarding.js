// First launch and signing in again: which server, then the sign-in that server calls for. boot.js runs these with the real
// HTTP client, screens, store and plugin; the tests run the same functions with stand-ins, so what is tested is the order the
// app really does things in.
//
// The order is the point. A hosted account's sign-in (email and password, Apple, Google) is offered only by hostedSignIn, and
// the only ways to it are the three flows below, each of which asks the server what it is first (discover, or checkServer which
// calls it). discover refuses a server that names any sign-in service but the one in app.config.json, so before discovery, and
// after a discovery that names another service, there is no account screen, no "Continue with" button and no request to any
// sign-in service at all. hostedSignIn checks what it was handed once more, so a future caller cannot skip the question.
//
// A forgotten password keeps the same order. The request for a reset link is made from the account screen, so after discovery.
// The link itself opens the app from outside (recovery.js), possibly with the app not running and nothing on screen yet: then
// the server the link was asked for is asked what it is first, and only when it names the pinned service is the link's code
// traded and a new password set (openLink below).
import { AppError, discover } from './discovery.js';
import { LINK_UNREADABLE, RESET_SENT, createRecovery, saysLinkEnded } from './recovery.js';
import { hostName, normalizeAddress } from './server-url.js';
import { checkServer, deviceName, hostedAddress, hostedClient, serverRecord, signInSelfHosted } from './setup.js';
import { INTERRUPTED, createSocialSignIn } from './social.js';
import { BACK } from './ui.js';

/** A callback address arrived while a screen was up, or before the first one: the flow that was running steps aside for it. */
class LinkOpened extends Error {}

/**
 * @param {object} options
 * @param {Function} options.http  the native HTTP client
 * @param {{hostedServerUrl: string, supabaseUrl: string, supabasePublishableKey: string}} options.config  validated app.config.json
 * @param {object} options.ui  the first-launch screens (ui.js)
 * @param {{save(record: object): Promise<void>, forget(): Promise<void>}} options.store
 * @param {string} options.platform
 * @param {object} options.plugin  SocialSignIn
 * @param {object} [options.backend]  the phone's secure storage (store.js), where a password reset keeps its verifier. Without
 *   it there is no "Forgot your password?".
 * @param {ReturnType<import('./recovery.js').createLinkInbox>} [options.links]  callback addresses that opened the app
 */
export function createOnboarding({ http, config, ui, store, platform, plugin, backend, links }) {
  const trusted = found => found?.mode === 'hosted' && Boolean(found.supabaseUrl) && found.supabaseUrl === normalizeAddress(config.supabaseUrl);
  // Every request this makes goes to config.supabaseUrl. It is built here and used only after a discovery that names that service.
  const recoveryFor = supabase => (backend ? createRecovery({ supabase, backend }) : null);

  /**
   * Draw a screen and wait for its answer, unless a link opens the app first: then LinkOpened is thrown, the flow that asked
   * unwinds to `guarded`, and the screen it left is replaced by the next one drawn. Links are looked at only here, when a
   * screen is about to be drawn or is up, so the flow's own requests between screens (asking a server what it is) always finish.
   * A sign-in that the abandoned screen had on its way is not waited for: its answer goes nowhere and nothing of it is kept.
   */
  function show(screen, options) {
    if (!links) return ui[screen](options);
    if (links.waiting) return Promise.reject(new LinkOpened());
    return Promise.race([ui[screen](options), links.arrival().then(() => { throw new LinkOpened(); })]);
  }

  /** The reset screen. Says the same thing afterwards whatever the address was, or nothing when the person went back. */
  async function forgotPassword(found, recovery, email) {
    const sent = await show('forgot', { host: hostName(found.url), email, submit: value => recovery.request({ email: value, server: found.url }) });
    return sent === BACK ? '' : RESET_SENT;
  }

  async function hostedSignIn(found, notice) {
    if (!trusted(found)) throw new AppError('This server was not checked against the sign-in service this app trusts, so the app will not sign in to it.');
    const supabase = hostedClient({ http, config });
    // Apple and Google use the same pinned client as the email sign-in: their addresses are built from config.supabaseUrl.
    // After an Apple sign-in the server that was just checked is given Apple's authorization code, with the new session as its
    // proof of who is asking, so that deleting the account later can revoke the Apple sign-in. social.js does not wait for this
    // and ignores how it ends; a server that is not set up for it answers that it kept nothing.
    const appleCode = ({ code, session }) => http({
      url: `${normalizeAddress(found.url)}/api/account/apple-authorization`, method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ authorization_code: code }),
    });
    const social = createSocialSignIn({ supabase, plugin, platform, appleCode });
    const recovery = recoveryFor(supabase);
    for (;;) {
      const result = await show('account', {
        host: hostName(found.url), notice,
        providers: social.available,
        social: async (provider, onStage) => { const credential = await social[provider]({ onStage }); return credential ? { credential } : null; },
        signIn: async (email, password) => ({ credential: await supabase.signIn(email, password) }),
        signUp: async (email, password) => { const made = await supabase.signUp(email, password); return made.session ? { credential: made.session } : { confirmationSent: true }; },
        forgot: Boolean(recovery),
      });
      if (result === BACK) return null;
      if (result.credential === undefined) { notice = await forgotPassword(found, recovery, result.forgot || ''); continue; }
      const record = serverRecord(found, result.credential);
      await store.save(record);
      await recovery?.forget(); // signed in: a reset link that is still on its way has nothing left to do
      return record;
    }
  }

  /**
   * A callback address opened the app with no sign-in waiting for it. Returns `{ record }` when it was a reset link that ended
   * in a new password and a kept sign-in, or `{ notice }` (which may be empty) for the flow that carries on.
   */
  async function openLink(address) {
    if (!address) return { notice: '' };
    const supabase = hostedClient({ http, config });
    const recovery = recoveryFor(supabase);
    const waiting = recovery ? await recovery.pending() : null;
    // On Android the same address is also what a Google sign-in's redirect looks like when it reaches a process that no longer
    // has the attempt (social.js, INTERRUPTED). A reset is known by the request this phone kept, or by the project saying that
    // an emailed link is too old; anything else there is the interrupted sign-in.
    if (!waiting && !saysLinkEnded(address) && platform === 'android') return { notice: INTERRUPTED };
    if (!recovery) return { notice: '' };
    // The link was asked for on the account screen of one server. That server is asked what it is before anything is traded.
    const server = waiting?.server || hostedAddress(config);
    let found;
    while (!found) {
      ui.working('Opening your reset link…');
      try { found = await discover(http, server, config); }
      catch (error) {
        const choice = await show('problem', { title: 'Could not connect', message: error.message, actions: [{ label: 'Try again', value: 'retry', primary: true }, { label: 'Back', value: 'back' }] });
        if (choice === 'back') return { notice: '' };
      }
    }
    if (!trusted(found)) return { notice: LINK_UNREADABLE }; // the server no longer has accounts: there is nothing to reset on it
    let session;
    try { session = await recovery.finish(address); }
    catch (error) {
      if (!(error instanceof AppError)) throw error;
      const choice = await show('problem', { title: 'That reset link did not work', message: error.message, actions: [{ label: 'Ask for a new link', value: 'again', primary: true }, { label: 'Back', value: 'back' }] });
      if (choice !== 'again') return { notice: '' };
      return { record: await hostedSignIn(found, await forgotPassword(found, recovery, '')), notice: '' };
    }
    // The session is held here and nowhere else until the new password is set; only then is it the phone's sign-in.
    const answer = await show('newPassword', { email: session.email, submit: password => supabase.setPassword({ accessToken: session.accessToken, password }) });
    if (answer === BACK) { await supabase.signOut(session.accessToken); return { notice: '' }; }
    const record = serverRecord(found, session);
    await store.save(record);
    return { record };
  }

  /**
   * Runs a sign-in flow, and lets a link that opens the app go first. `run(notice)` is the flow; it is started again after a
   * link that did not end in a sign-in, with what that link left to say (undefined the first time: the flow's own notice).
   */
  async function guarded(run) {
    let notice;
    for (;;) {
      try { return await run(notice); }
      catch (error) { if (!(error instanceof LinkOpened)) throw error; }
      for (let handled = false; !handled;) {
        try {
          const outcome = await openLink(links.take());
          if (outcome.record) return outcome.record;
          notice = outcome.notice || '';
          handled = true;
        } catch (error) { if (!(error instanceof LinkOpened)) throw error; } // another link arrived meanwhile: that one, then
      }
    }
  }

  async function selfHostedSignIn(found, notice) {
    const credential = await show('password', { host: hostName(found.url), notice, submit: password => signInSelfHosted({ http, address: found.url, password, deviceName: deviceName(platform) }) });
    if (credential === BACK) return null;
    const record = serverRecord(found, credential);
    await store.save(record);
    return record;
  }

  async function connectToHostedService(address, notice) {
    for (;;) {
      ui.working('Connecting…');
      let found;
      try { found = await discover(http, address, config); }
      catch (error) {
        const choice = await show('problem', { title: 'Could not connect', message: error.message, actions: [{ label: 'Try again', value: 'retry', primary: true }, { label: 'Back', value: 'back' }] });
        if (choice === 'back') return null;
        continue;
      }
      return hostedSignIn(found, notice);
    }
  }

  async function ownServer() {
    let typed = '';
    for (;;) {
      const found = await show('server', { value: typed, submit: async text => { typed = text; return checkServer({ http, config, input: text }); } });
      if (found === BACK) return null;
      // A hosted service that this app trusts was typed here. It works, but with an account, which the person did not expect.
      const record = await (found.mode === 'hosted' ? hostedSignIn(found, `${hostName(found.url)} is a hosted Little Archive service, so you sign in with an account, not an owner password.`) : selfHostedSignIn(found, ''));
      if (record) return record;
    }
  }

  return {
    /** First launch, or no server chosen: choose one and sign in. Returns the record that is now stored. */
    firstLaunch(notice) {
      return guarded(async carried => {
        let say = carried ?? notice;
        for (;;) {
          const choice = await show('choose', { notice: say });
          say = '';
          const record = choice === 'hosted' ? await connectToHostedService(hostedAddress(config), '') : await ownServer();
          if (record) return record;
        }
      });
    },

    /** A server is chosen but there is no credential (signed out, or the sign-in ended). Null means: not this server. */
    signInAgain(record, notice) {
      return guarded(async carried => {
        const say = carried ?? notice;
        for (;;) {
          ui.working('Connecting…');
          let found;
          try { found = await discover(http, record.server.url, config); }
          catch (error) {
            const choice = await show('problem', { title: 'Could not connect', message: error.message, actions: [{ label: 'Try again', value: 'retry', primary: true }, { label: 'Use a different server', value: 'switch' }] });
            if (choice === 'switch') { await store.forget(); return null; }
            continue;
          }
          const signedIn = await (found.mode === 'hosted' ? hostedSignIn(found, say) : selfHostedSignIn(found, say));
          if (signedIn) return signedIn;
          await store.forget(); // "Back" from here means: not this server
          return null;
        }
      });
    },
  };
}
