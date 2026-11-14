// How the interface talks to a server when it runs inside the iOS or Android app.
//
// In a browser none of this is used: app.js calls the page's own fetch with the owner's cookie, exactly as
// before. The app's shell (mobile/src) builds one transport after the person has signed in and hands it to
// app.js, which then sends every /api request through it. It differs from fetch in three deliberate ways:
//
//  - The server is a configured address, not the page's own origin, and only /api paths are ever sent there.
//    A path that tries to leave /api (a protocol-relative address, another host, "..") is refused, so a
//    hostile value that arrives in server data can never carry the credential to another host.
//  - The credential is a bearer token that the transport owns. Callers cannot supply or read it, and it is
//    never put in a URL. There are no cookies.
//  - Requests go through `http`, the platform's native HTTP client, not the web view's fetch. That is why
//    the server needs no CORS allowance for the app, and why the password-login origin check is untouched.
//    Because an <img> cannot send a header, thumbnails are fetched the same way and shown from a blob URL.
//
// This module has no platform imports so that it can be tested in Node. The native client and the token
// source are passed in. app.js does not import it (the public demo ships a fixed list of files); the app's
// shell does, and exposes the result to app.js as globalThis.__littleArchiveNative.

const API = '/api/';
const PATH_CHARACTERS = /^\/api\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/;
const ASSET_PATH = /^\/api\/assets\/[0-9a-f]{64}$/;
const NULL_BODY = new Set([101, 204, 205, 304]);
// A header the caller may not set: the transport owns the credential, and the platform owns the rest.
const FORBIDDEN_REQUEST_HEADERS = new Set(['authorization', 'cookie', 'host', 'origin', 'referer', 'content-length', 'connection', 'proxy-authorization']);
// The platform client has already decoded the body, so these no longer describe it.
const STALE_RESPONSE_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'set-cookie']);

export class TransportError extends Error {
  constructor(message, options) { super(message, options); this.name = 'TransportError'; }
}

// The server address is the origin plus an optional path prefix (a reverse proxy may serve the app under one).
export function cleanBaseUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new TransportError('The server address is not a valid web address.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TransportError('The server address must be a plain http or https address.');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

// The only way a caller names a URL: an absolute path under /api. Anything else is refused.
export function apiUrl(baseUrl, path) {
  const refuse = () => new TransportError('Only the library API can be reached from here.');
  if (typeof path !== 'string' || !path.startsWith(API) || !PATH_CHARACTERS.test(path)) throw refuse();
  const [pathname] = path.split('?');
  if (pathname.split('/').some(part => ['.', '..'].includes(part.replace(/%2e/gi, '.')))) throw refuse();
  return baseUrl + path;
}

function abortError() {
  return typeof DOMException === 'function' ? new DOMException('The operation was aborted.', 'AbortError') : Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
}

async function bodyBytes(body) {
  if (body == null) return undefined;
  if (typeof body === 'string' || body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof Blob !== 'undefined' && body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  throw new TransportError('That kind of request body is not supported.');
}

function cleanHeaders(headers) {
  const out = {};
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers || {});
  for (const [name, value] of entries) if (!FORBIDDEN_REQUEST_HEADERS.has(String(name).toLowerCase())) out[name] = String(value);
  return out;
}

function toResponse(reply) {
  const status = Number(reply.status);
  if (!Number.isInteger(status) || status < 200 || status > 599) throw new TransportError('The server sent an unreadable answer.');
  const headers = new Headers();
  for (const [name, value] of Object.entries(reply.headers || {})) {
    if (STALE_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    try { headers.set(name, String(value)); } catch { /* A header that Headers will not hold is dropped. */ }
  }
  return new Response(NULL_BODY.has(status) || !reply.body?.length ? null : reply.body, { status, headers });
}

function redirectRefusal() {
  // The platform client is told not to follow redirects: a credential must never travel to a second address.
  return new Response(JSON.stringify({ detail: 'The server redirected this request. Check the server address in settings.' }), { status: 502, headers: { 'content-type': 'application/json' } });
}

/**
 * @param {object} options
 * @param {string} options.baseUrl  the server, for example https://archive.example.com
 * @param {(request: {url: string, method: string, headers: object, body?: string|Uint8Array}) => Promise<{status: number, headers: object, body: Uint8Array}>} options.http
 * @param {{get: () => Promise<string|null>, refresh?: () => Promise<string|null>}} options.credential
 *        `get` gives the token to send (refreshing it first if it is about to expire); `refresh(failedToken)` is tried once after a 401.
 */
export function createTransport({ baseUrl, http, credential, maxImages = 400, imageConcurrency = 5, observe = observeImage, createObjectURL = blob => URL.createObjectURL(blob), revokeObjectURL = url => URL.revokeObjectURL(url) }) {
  const base = cleanBaseUrl(baseUrl);
  const unreachable = error => new TypeError('The server could not be reached.', { cause: error });

  async function send(url, method, headers, body, token) {
    try { return await http({ url, method, headers: { ...headers, Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body }) }); }
    catch (error) { throw unreachable(error); }
  }

  async function attempt(url, method, headers, body) {
    let token;
    try { token = await credential.get(); } catch (error) { throw unreachable(error); }
    if (!token) return new Response(JSON.stringify({ detail: 'Sign in to your library.' }), { status: 401, headers: { 'content-type': 'application/json' } });
    let reply = await send(url, method, headers, body, token);
    if (reply.status === 401 && credential.refresh) {
      let fresh;
      try { fresh = await credential.refresh(token); } catch (error) { throw unreachable(error); }
      if (fresh && fresh !== token) reply = await send(url, method, headers, body, fresh);
    }
    return reply.status >= 300 && reply.status < 400 ? redirectRefusal() : toResponse(reply);
  }

  async function exchange(path, init = {}) {
    const url = apiUrl(base, path);
    const { signal } = init;
    if (signal?.aborted) throw abortError();
    const method = String(init.method || 'GET').toUpperCase();
    const headers = cleanHeaders(init.headers);
    const body = await bodyBytes(init.body);
    if (body !== undefined && ['GET', 'HEAD'].includes(method)) throw new TransportError('A GET request cannot carry a body.');
    if (!signal) return attempt(url, method, headers, body);
    if (signal.aborted) throw abortError();
    // The native client cannot be cancelled; its answer is simply dropped once the caller has given up.
    return new Promise((resolve, reject) => {
      const stop = () => reject(abortError());
      signal.addEventListener('abort', stop, { once: true });
      attempt(url, method, headers, body).then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
    });
  }

  // Thumbnails ---------------------------------------------------------------------------------------------
  // An <img> cannot send the bearer token, so each stored thumbnail is fetched natively and shown from a blob URL.
  // The address is content-addressed (the SHA-256 of the image), so a cached copy is never stale.
  const cache = new Map(); // path -> Promise<blob URL>; insertion order is recency
  const waiting = [];
  let active = 0;

  function slot() {
    if (active < imageConcurrency) { active += 1; return Promise.resolve(); }
    return new Promise(resolve => waiting.push(resolve));
  }
  function release() {
    const next = waiting.shift();
    if (next) next(); else active -= 1;
  }

  // The path of a stored thumbnail, or null for anything else (including every address that is not this server's own).
  function localAsset(value) {
    return typeof value === 'string' && ASSET_PATH.test(value) ? value : null;
  }

  function blobUrl(path) {
    if (!ASSET_PATH.test(path)) return Promise.reject(new TransportError('That is not a stored thumbnail.'));
    const known = cache.get(path);
    if (known) { cache.delete(path); cache.set(path, known); return known; }
    const pending = (async () => {
      await slot();
      try {
        const response = await exchange(path);
        if (!response.ok) throw new TransportError('The thumbnail is not available.');
        const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (type !== 'image/png') throw new TransportError('The thumbnail is not an image.');
        return createObjectURL(await response.blob());
      } finally { release(); }
    })();
    cache.set(path, pending);
    pending.catch(() => { if (cache.get(path) === pending) cache.delete(path); });
    while (cache.size > maxImages) {
      const [oldest, value] = cache.entries().next().value;
      cache.delete(oldest);
      value.then(revokeObjectURL, () => {});
    }
    return pending;
  }

  // Shows a thumbnail in an <img> once it is near the screen. A failure raises the image's own error event, which the
  // interface already answers with its text cover.
  function attachImage(image, path) {
    observe(image, () => blobUrl(path).then(url => { image.src = url; }, () => image.dispatchEvent(new Event('error'))));
  }

  function dispose() {
    for (const value of cache.values()) value.then(revokeObjectURL, () => {});
    cache.clear();
  }

  return { baseUrl: base, fetch: exchange, localAsset, attachImage, blobUrl, dispose };
}

let sharedObserver;
const pendingImages = new WeakMap();
function observeImage(image, show) {
  if (typeof IntersectionObserver === 'undefined') { show(); return; }
  sharedObserver ||= new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      sharedObserver.unobserve(entry.target);
      const run = pendingImages.get(entry.target);
      pendingImages.delete(entry.target);
      run?.();
    }
  }, { rootMargin: '600px 0px' });
  pendingImages.set(image, show);
  sharedObserver.observe(image);
}
