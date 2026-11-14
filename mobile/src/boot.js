// The app's entry point, loaded in place of web/app.js by the bundle's index.html.
//
// It does what must happen before the library interface can run: find out which server this phone belongs to, sign in,
// and build the transport. Then it exposes the result as globalThis.__littleArchiveNative and loads the shared interface
// (/app.js, unchanged) exactly as the browser would. Everything here that is not Capacitor glue is in the small modules
// beside this file, which have their own tests.
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { KeychainAccess, SecureStorage } from '@aparajita/capacitor-secure-storage';
import rawConfig from '../app.config.json';
import { createTransport } from '../../web/transport.js';
import { validateConfig } from './config.js';
import { createCredentials } from './credentials.js';
import { discover } from './discovery.js';
import { createFileSaver } from './files.js';
import { createNativeHttp } from './native-http.js';
import { hostName } from './server-url.js';
import { checkServer, deviceName, hostedAddress, hostedClient, serverRecord, signInSelfHosted } from './setup.js';
import { createShareInbox } from './share.js';
import { createStore, secureBackend } from './store.js';
import { BACK, createUi } from './ui.js';

const ShareInbox = registerPlugin('ShareInbox');
const ui = createUi(document.getElementById('app'));

const NOTICE = 'la-notice';
const INSTALLED = 'la-installed';
function takeNotice() {
  try { const text = sessionStorage.getItem(NOTICE) || ''; sessionStorage.removeItem(NOTICE); return text; } catch { return ''; }
}
function reloadWith(message) {
  try { if (message) sessionStorage.setItem(NOTICE, message); } catch { /* The notice is a courtesy. */ }
  location.reload();
}

async function main() {
  if (!Capacitor.isNativePlatform()) {
    // The secure-storage plugin falls back to localStorage in a browser. The app must never do that with a credential.
    return ui.stop('This part runs in the app', 'Open Little Archive from the iOS or Android app. In a browser, use your server’s own address.');
  }
  let config;
  try { config = validateConfig(rawConfig); } catch (error) { return ui.stop('This build is not set up', error.message); }
  const platform = Capacitor.getPlatform();
  const http = createNativeHttp(CapacitorHttp);
  const backend = secureBackend(SecureStorage, KeychainAccess);
  const store = createStore(backend);
  try {
    await backend.init();
    // iOS keeps Keychain items when an app is deleted. This flag lives in the web view's storage, which is deleted with the
    // app, so a fresh install always starts signed out.
    if (!localStorage.getItem(INSTALLED)) { await backend.clear(); localStorage.setItem(INSTALLED, '1'); }
  } catch (error) {
    return ui.stop('Secure storage is not available', 'Little Archive keeps your sign-in in the phone’s secure storage and will not keep it anywhere else.');
  }
  const files = createFileSaver({ Filesystem, Directory, Share });
  files.cleanup();
  const inbox = createShareInbox({ plugin: ShareInbox, App });
  const initialShare = await inbox.initial(); // shared from another app before this one was open

  // First launch, or signed out: choose a server and sign in. Returns the record that is now stored.
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

  async function hostedSignIn(found, notice) {
    const supabase = hostedClient({ http, config });
    const result = await ui.account({
      host: hostName(found.url), notice,
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

  async function ownServer() {
    let typed = '';
    for (;;) {
      const found = await ui.server({ value: typed, submit: async text => { typed = text; return checkServer({ http, config, input: text }); } });
      if (found === BACK) return null;
      const record = await (found.mode === 'hosted' ? hostedSignIn(found, '') : selfHostedSignIn(found, ''));
      if (record) return record;
    }
  }

  async function firstLaunch(notice) {
    for (;;) {
      const choice = await ui.choose({ notice });
      notice = '';
      const record = choice === 'hosted' ? await connectToHostedService(hostedAddress(config), '') : await ownServer();
      if (record) return record;
    }
  }

  // A server is chosen but there is no credential (signed out, or the sign-in ended).
  async function signInAgain(record, notice) {
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
  }

  async function whoAmI(transport) {
    const response = await transport.fetch('/api/auth/me', { headers: { Accept: 'application/json' } });
    if (response.status === 401) return { authenticated: false };
    if (!response.ok) throw new Error(`The server answered ${response.status}.`);
    return response.json();
  }

  // Loops until there is a signed-in record that the server accepts.
  let record = await store.load();
  let notice = takeNotice();
  let session;
  while (!session) {
    if (!record) { record = await firstLaunch(notice); notice = ''; continue; }
    if (!record.credential) {
      record = await signInAgain(record, notice); notice = '';
      continue;
    }
    const hosted = record.server.kind === 'hosted';
    const supabase = hosted ? hostedClient({ http, config }) : null;
    const credentials = createCredentials({ record, store, supabase });
    const transport = createTransport({ baseUrl: record.server.url, http, credential: credentials });
    ui.working();
    let me;
    try { me = await whoAmI(transport); }
    catch {
      const choice = await ui.problem({ title: 'Could not reach your library', message: `Could not reach ${hostName(record.server.url)}. Your sign-in is kept; check your connection or try again.`, actions: [{ label: 'Try again', value: 'retry', primary: true }, { label: 'Use a different server', value: 'switch' }] });
      if (choice === 'switch') { transport.dispose(); await store.forget(); record = null; }
      continue;
    }
    if (!me.authenticated) {
      transport.dispose();
      await store.signOut();
      record = { ...record, credential: null };
      notice = 'Your sign-in ended. Sign in again to open your library.';
      continue;
    }
    session = { record, credentials, transport, supabase };
  }

  // Ending a session. Best effort on the server (revoke the device token, or end the Supabase session), certain on the phone.
  async function endSession({ forget, message }) {
    const { credentials, transport, supabase } = session;
    try {
      if (credentials.deviceToken) await transport.fetch('/api/auth/logout', { method: 'POST' });
      else if (credentials.accessToken) await supabase.signOut(credentials.accessToken);
    } catch { /* An unreachable server must not keep the person signed in on this phone. */ }
    credentials.clear();
    transport.dispose();
    await (forget ? store.forget() : store.signOut());
    reloadWith(message);
  }

  const { transport, credentials } = session;
  const native = Object.freeze({
    platform, mode: session.record.server.kind, serverUrl: session.record.server.url, initialShare,
    fetch: transport.fetch, localAsset: transport.localAsset, attachImage: transport.attachImage,
    onShare: inbox.subscribe, saveFile: files.save,
    // The interface asks for this when the server refuses the credential for good.
    async signedOut(message) {
      credentials.clear();
      transport.dispose();
      await store.signOut();
      reloadWith(message || 'Your sign-in ended. Sign in again to continue.');
    },
    account: Object.freeze({
      email: credentials.email,
      signOut: ({ deleted = false } = {}) => endSession({ forget: false, message: deleted ? 'Your account’s library was deleted.' : '' }),
      switchServer: () => endSession({ forget: true, message: '' }),
    }),
  });
  Object.defineProperty(globalThis, '__littleArchiveNative', { value: native, writable: false, configurable: false });
  await import('/app.js');
}

main().catch(error => {
  console.error(error);
  ui.stop('Something went wrong', 'Little Archive could not start. Close it and open it again.');
});
