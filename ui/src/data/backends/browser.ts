// A self-hosted server on the page's own origin. Same-origin fetch, the owner's cookie, nothing else.
import { safeURL } from '@web/utils.js';
import type { Backend } from '../backend';

export function createBrowserBackend(
  { fetchImpl = (input: string, init?: RequestInit) => fetch(input, init), origin = location.origin }: { fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>; origin?: string } = {},
): Backend {
  return {
    kind: 'browser',
    mode: 'self-hosted',
    serverUrl: origin,
    passwordLogin: true,
    csrf: true,
    account: null,
    initialShare: null,
    remembers: true,
    real: true,
    purchases: null,
    fetch(path, init = {}) {
      if (!path.startsWith('/api/')) return Promise.reject(new Error('Only the library API can be reached from here.'));
      return fetchImpl(path, { ...init, credentials: 'same-origin' });
    },
    thumbnail(value) {
      const src = safeURL(value, { local: true });
      return src ? { type: 'url', src } : null;
    },
    async saveFile(blob, filename) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      return 'downloaded';
    },
    signedOut: () => false,
    onShare: () => () => {},
  };
}
