// What the interface is given: globalThis.__littleArchiveNative. The interface (ui/src/data/backends/native.ts) maps this
// object, and nothing else, onto its Backend; NativeBridge in ui/src/data/backend.ts is the other half of the agreement, and
// tests/bridge.test.mjs reads that file to keep the two the same.
//
// The transport owns the credential: the interface can send requests through `fetch` and show thumbnails, and it cannot read
// the token. `purchases` is present only for a hosted account. A self-hosted server sells nothing and gates nothing.

/**
 * @param {object} parts
 * @param {string} parts.platform  'ios' | 'android'
 * @param {'self-hosted'|'hosted'} parts.mode
 * @param {string} parts.serverUrl
 * @param {{title: string, text: string, url: string}|null} parts.initialShare
 * @param {{fetch: Function, localAsset: Function, attachImage: Function}} parts.transport
 * @param {(handler: Function) => (() => void)} parts.onShare
 * @param {(blob: Blob, filename: string) => Promise<void>} parts.saveFile
 * @param {(message?: string) => Promise<void>} parts.signedOut  the server refused the credential for good
 * @param {string|undefined} parts.email
 * @param {(options?: {deleted?: boolean}) => Promise<void>} parts.signOut
 * @param {() => Promise<void>} parts.switchServer
 * @param {object} [parts.purchases]  a PurchaseBridge, for a hosted account
 */
export function createBridge({ platform, mode, serverUrl, initialShare, transport, onShare, saveFile, signedOut, email, signOut, switchServer, purchases }) {
  if (!['self-hosted', 'hosted'].includes(mode)) throw new Error(`Unknown server mode: ${mode}`);
  if (purchases && mode !== 'hosted') throw new Error('Only a hosted account has a store purchase.');
  const bridge = {
    platform, mode, serverUrl, initialShare: initialShare ?? null,
    fetch: transport.fetch, localAsset: transport.localAsset, attachImage: transport.attachImage,
    onShare, saveFile, signedOut,
    account: Object.freeze({ email, signOut, switchServer }),
  };
  if (purchases) bridge.purchases = purchases;
  return Object.freeze(bridge);
}
