// The public demo. The same in-memory store the buildless demo uses (web/demo-store.js, with its own tests)
// answers every /api request; nothing is sent anywhere. This module is only ever loaded by demo.html.
import { SYNTHETIC_RECORDS } from '@web/demo-data.js';
import { createDemoAPI } from '@web/demo-store.js';
import { safeURL } from '@web/utils.js';
import type { Backend } from '../backend';

export function createDemoBackend({ fixtures = SYNTHETIC_RECORDS }: { fixtures?: readonly unknown[] } = {}): Backend {
  const answer = createDemoAPI(fixtures);
  return {
    kind: 'demo',
    mode: 'self-hosted',
    serverUrl: globalThis.location?.origin ?? 'http://demo.invalid',
    passwordLogin: false,
    csrf: false,
    account: null,
    initialShare: null,
    remembers: false,
    real: false,
    purchases: null,
    async fetch(path, init = {}) {
      if (!path.startsWith('/api/')) throw new Error('Network requests are disabled in this isolated demo.');
      if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      return answer(path, init);
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
