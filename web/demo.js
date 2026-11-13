import { SYNTHETIC_RECORDS } from './demo-data.js';
import { createDemoAPI } from './demo-store.js';

// This adapter is installed only by demo.html. The authenticated application
// index.html never imports this module. No request falls through to a backend.
const demoAPI = createDemoAPI(SYNTHETIC_RECORDS);
window.fetch = async (input, init = {}) => {
  const requestURL = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  const url = new URL(requestURL, location.origin);
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) {
    throw new Error('Network requests are disabled in this isolated demo.');
  }
  if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  return demoAPI(url.pathname + url.search, init);
};

await import('./app.js');
