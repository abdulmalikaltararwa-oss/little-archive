// Inside the iOS and Android app. The shell (mobile/src/boot.js) has already signed in and built the
// transport (web/transport.js); this adapter only maps its bridge onto the Backend interface. The bearer
// token never reaches this code: the transport owns it.
import type { Backend, NativeBridge } from '../backend';

export function createNativeBackend(bridge: NativeBridge): Backend {
  return {
    kind: 'native',
    mode: bridge.mode,
    serverUrl: bridge.serverUrl,
    passwordLogin: false,
    csrf: false,
    account: bridge.account,
    initialShare: bridge.initialShare ?? null,
    remembers: true,
    real: true,
    purchases: bridge.purchases ?? null,
    fetch: (path, init) => bridge.fetch(path, init),
    thumbnail(value) {
      // An <img> cannot send a header, so a stored thumbnail is fetched natively and shown from a blob URL.
      const path = bridge.localAsset(value);
      return path ? { type: 'attach', attach: image => bridge.attachImage(image, path) } : null;
    },
    async saveFile(blob, filename) {
      await bridge.saveFile(blob, filename);
      return 'shared';
    },
    signedOut(message) {
      void bridge.signedOut(message);
      return true;
    },
    onShare(listener) {
      const stop = bridge.onShare(listener);
      return typeof stop === 'function' ? stop : () => {};
    },
  };
}
