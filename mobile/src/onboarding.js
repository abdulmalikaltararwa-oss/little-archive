// First launch and signing in again: which server, then the sign-in that server calls for. boot.js runs these with the real
// HTTP client, screens, store and plugin; the tests run the same functions with stand-ins, so what is tested is the order the
// app really does things in.
//
// The order is the point. A hosted account's sign-in (email and password, Apple, Google) is offered only by hostedSignIn, and
// the only ways to it are the three flows below, each of which asks the server what it is first (discover, or checkServer which
// calls it). discover refuses a server that names any sign-in service but the one in app.config.json, so before discovery, and
// after a discovery that names another service, there is no account screen, no "Continue with" button and no request to any
// sign-in service at all. hostedSignIn checks what it was handed once more, so a future caller cannot skip the question.
import { AppError, discover } from './discovery.js';
import { hostName, normalizeAddress } from './server-url.js';
import { checkServer, deviceName, hostedAddress, hostedClient, serverRecord, signInSelfHosted } from './setup.js';
import { createSocialSignIn } from './social.js';
import { BACK } from './ui.js';

/**
 * @param {object} options
 * @param {Function} options.http  the native HTTP client
 * @param {{hostedServerUrl: string, supabaseUrl: string, supabasePublishableKey: string}} options.config  validated app.config.json
 * @param {object} options.ui  the first-launch screens (ui.js)
 * @param {{save(record: object): Promise<void>, forget(): Promise<void>}} options.store
 * @param {string} options.platform
 * @param {object} options.plugin  SocialSignIn
 */
export function createOnboarding({ http, config, ui, store, platform, plugin }) {
  async function hostedSignIn(found, notice) {
    if (found?.mode !== 'hosted' || !found.supabaseUrl || found.supabaseUrl !== normalizeAddress(config.supabaseUrl)) {
      throw new AppError('This server was not checked against the sign-in service this app trusts, so the app will not sign in to it.');
    }
    const supabase = hostedClient({ http, config });
    // Apple and Google use the same pinned client as the email sign-in: their addresses are built from config.supabaseUrl.
    const social = createSocialSignIn({ supabase, plugin, platform });
    const result = await ui.account({
      host: hostName(found.url), notice,
      providers: social.available,
      social: async (provider, onStage) => { const credential = await social[provider]({ onStage }); return credential ? { credential } : null; },
      signIn: async (email, password) => ({ credential: await supabase.signIn(email, password) }),
      signUp: async (email, password) => { const made = await supabase.signUp(email, password); return made.session ? { credential: made.session } : { confirmationSent: true }; },
    });
    if (result === BACK) return null;
    const record = serverRecord(found, result.credential);
    await store.save(record);
    return record;
  }

  async function selfHostedSignIn(found, notice) {
    const credential = await ui.password({ host: hostName(found.url), notice, submit: password => signInSelfHosted({ http, address: found.url, password, deviceName: deviceName(platform) }) });
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
        const choice = await ui.problem({ title: 'Could not connect', message: error.message, actions: [{ label: 'Try again', value: 'retry', primary: true }, { label: 'Back', value: 'back' }] });
        if (choice === 'back') return null;
        continue;
      }
      return hostedSignIn(found, notice);
    }
  }

  async function ownServer() {
    let typed = '';
    for (;;) {
      const found = await ui.server({ value: typed, submit: async text => { typed = text; return checkServer({ http, config, input: text }); } });
      if (found === BACK) return null;
      // A hosted service that this app trusts was typed here. It works, but with an account, which the person did not expect.
      const record = await (found.mode === 'hosted' ? hostedSignIn(found, `${hostName(found.url)} is a hosted Little Archive service, so you sign in with an account, not an owner password.`) : selfHostedSignIn(found, ''));
      if (record) return record;
    }
  }

  return {
    /** First launch, or no server chosen: choose one and sign in. Returns the record that is now stored. */
    async firstLaunch(notice) {
      for (;;) {
        const choice = await ui.choose({ notice });
        notice = '';
        const record = choice === 'hosted' ? await connectToHostedService(hostedAddress(config), '') : await ownServer();
        if (record) return record;
      }
    },

    /** A server is chosen but there is no credential (signed out, or the sign-in ended). Null means: not this server. */
    async signInAgain(record, notice) {
      for (;;) {
        ui.working('Connecting…');
        let found;
        try { found = await discover(http, record.server.url, config); }
        catch (error) {
          const choice = await ui.problem({ title: 'Could not connect', message: error.message, actions: [{ label: 'Try again', value: 'retry', primary: true }, { label: 'Use a different server', value: 'switch' }] });
          if (choice === 'switch') { await store.forget(); return null; }
          continue;
        }
        const signedIn = await (found.mode === 'hosted' ? hostedSignIn(found, notice) : selfHostedSignIn(found, notice));
        if (signedIn) return signedIn;
        await store.forget(); // "Back" from here means: not this server
        return null;
      }
    },
  };
}
