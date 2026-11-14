// What the app remembers between launches: which server, and the credential for it.
//
// It is one record in the platform's secure storage (the iOS Keychain, or an Android Keystore-backed store), never in
// localStorage or any file the web view can read. The password for a self-hosted server is never stored at all: it is
// exchanged once for a revocable device token, and only the token is kept.
//
//   { v: 1,
//     server: { kind: 'self-hosted' | 'hosted', url },
//     credential: null
//       | { type: 'device', token, id, name }
//       | { type: 'supabase', accessToken, refreshToken, expiresAt, userId, email } }
import { normalizeAddress } from './server-url.js';

const KEY = 'session';

function valid(record) {
  if (!record || record.v !== 1 || !['self-hosted', 'hosted'].includes(record.server?.kind)) return false;
  try { if (normalizeAddress(record.server.url) !== record.server.url) return false; } catch { return false; }
  const c = record.credential;
  if (c === null) return true;
  if (c?.type === 'device') return typeof c.token === 'string' && c.token.startsWith('lad_') && record.server.kind === 'self-hosted';
  if (c?.type === 'supabase') return typeof c.accessToken === 'string' && typeof c.refreshToken === 'string' && record.server.kind === 'hosted';
  return false;
}

/** @param backend {{get(key): Promise<any>, set(key, value): Promise<void>, remove(key): Promise<void>, clear(): Promise<void>}} */
export function createStore(backend) {
  let tail = Promise.resolve();
  // Writes happen one after another, so a token refresh and a sign-out can never interleave.
  const serial = work => { const run = tail.then(work, work); tail = run.catch(() => {}); return run; };
  return {
    async load() {
      try {
        const record = await backend.get(KEY);
        return valid(record) ? record : null; // anything unreadable is treated as signed out
      } catch { return null; }
    },
    save: record => serial(async () => { if (!valid(record)) throw new Error('Refusing to store an unreadable session.'); await backend.set(KEY, record); }),
    /** Keeps the server, drops the credential. */
    signOut: () => serial(async () => {
      const record = await backend.get(KEY).catch(() => null);
      if (valid(record)) await backend.set(KEY, { ...record, credential: null }); else await backend.remove(KEY);
    }),
    /** Forgets everything, including the server. */
    forget: () => serial(() => backend.clear()),
  };
}

export function memoryBackend() {
  const map = new Map();
  return {
    get: async key => (map.has(key) ? structuredClone(map.get(key)) : null),
    set: async (key, value) => { map.set(key, structuredClone(value)); },
    remove: async key => { map.delete(key); },
    clear: async () => { map.clear(); },
  };
}

/** The platform's secure storage, through @aparajita/capacitor-secure-storage. */
export function secureBackend(SecureStorage, KeychainAccess) {
  return {
    async init() {
      await SecureStorage.setKeyPrefix('littlearchive_');
      await SecureStorage.setSynchronize(false); // never into iCloud Keychain
      // Readable only while the phone is unlocked, and never copied to another device by a backup.
      await SecureStorage.setDefaultKeychainAccess(KeychainAccess.whenUnlockedThisDeviceOnly);
    },
    get: key => SecureStorage.get(key, false, false),
    set: (key, value) => SecureStorage.set(key, value, false, false, KeychainAccess.whenUnlockedThisDeviceOnly),
    remove: async key => { await SecureStorage.remove(key, false); },
    clear: () => SecureStorage.clear(false),
  };
}
