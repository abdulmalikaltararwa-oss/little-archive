// Pure validation and queue helpers. No browser session or page internals are read.
export const MAX_BATCH_ITEMS = 50;
export const MAX_BATCH_BYTES = 256 * 1024;
export const MAX_OUTBOX_BYTES = 4 * 1024 * 1024;
export const MAX_STATE_BYTES = 8 * 1024 * 1024;
export const STORAGE_KEY = 'littleArchiveState';
const encoder = new TextEncoder();
export const byteLength = value => encoder.encode(JSON.stringify(value)).byteLength;

export function normalizeServerURL(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('Enter a complete server URL, such as http://localhost:8787.'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Use HTTPS for a remote server. HTTP is supported only on localhost or 127.0.0.1.');
  }
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('Use the server origin only, with no credentials, path, query, or fragment.');
  }
  return url.origin;
}

export function permissionPattern(server) {
  const url = new URL(normalizeServerURL(server));
  // Chrome host grants cover all ports; requests remain pinned to the configured origin.
  return `${url.protocol}//${url.hostname}/*`;
}

export function normalizeAccount(value) {
  const account = String(value || '').trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9._]{1,80}$/.test(account)) throw new Error('Enter the account handle shown in the source page URL.');
  return account;
}

export function sourceContext(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Open a supported Saved or Favorites page first.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Open the source platform over HTTPS.');
  if (['www.instagram.com', 'instagram.com'].includes(url.hostname)) {
    const match = url.pathname.match(/^\/([a-zA-Z0-9._]+)\/saved(?:\/([^/]+))?\/?$/);
    if (!match) throw new Error('Open your Instagram Saved view or a saved collection. Feed and individual-post pages are not supported.');
    const account = normalizeAccount(match[1]);
    const slug = match[2] || '';
    const isCollection = Boolean(slug && slug !== 'all-posts');
    if (slug === 'audio') throw new Error('Saved audio is outside this post importer. Open All posts or a post collection.');
    return {platform:'instagram', account, isCollection, scopeKey:`instagram:${account}:saved:${slug || 'index'}`, url:url.origin + url.pathname, isIndex:!slug};
  }
  if (['www.tiktok.com', 'tiktok.com'].includes(url.hostname)) {
    const match = url.pathname.match(/^\/@([a-zA-Z0-9._]+)(?:\/(favorites|favourites|collection)(?:\/([^/]+))?)?\/?$/);
    if (!match || (match[2] === 'collection' && !match[3])) throw new Error('Open your TikTok profile Favorites tab or a favorites collection.');
    const account = normalizeAccount(match[1]);
    const isCollection = match[2] === 'collection';
    return {platform:'tiktok', account, isCollection, scopeKey:`tiktok:${account}:${isCollection ? 'collection:' + match[3] : 'favorites'}`, url:url.origin + url.pathname, isIndex:false};
  }
  throw new Error('This tab is not an Instagram Saved or TikTok Favorites view.');
}

export function assertSource(value, account, expectedScope) {
  const result = sourceContext(value);
  if (result.account !== normalizeAccount(account)) throw new Error('The page account does not match this import.');
  if (expectedScope && result.scopeKey !== expectedScope) throw new Error('The page scope changed. Reopen the original collection before resuming.');
  if (result.isIndex) throw new Error('Open All posts or an individual collection before starting.');
  return result;
}

export function canonicalPost(value, platform) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (platform === 'instagram' && ['instagram.com','www.instagram.com'].includes(url.hostname)) {
    const match = url.pathname.match(/^\/(p|reel|reels)\/([a-zA-Z0-9_-]{1,100})\/?$/);
    if (!match) return null;
    return {url:`https://www.instagram.com/${match[1] === 'p' ? 'p' : 'reel'}/${match[2]}/`, key:match[2], content_type:match[1] === 'p' ? 'post' : 'video'};
  }
  if (platform === 'tiktok' && ['tiktok.com','www.tiktok.com'].includes(url.hostname)) {
    const match = url.pathname.match(/^\/@([a-zA-Z0-9._]{1,80})\/(video|photo)\/(\d{5,30})\/?$/);
    if (!match) return null;
    return {url:`https://www.tiktok.com/@${match[1]}/${match[2]}/${match[3]}`, key:match[3], content_type:match[2] === 'video' ? 'video' : 'image'};
  }
  return null;
}

function text(value, limit) { return typeof value === 'string' ? value.slice(0, limit).trim() : ''; }
export function safePreview(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const roots = ['cdninstagram.com','fbcdn.net','tiktokcdn.com','tiktokcdn-us.com','tiktokcdn-eu.com','ibytedtos.com','byteoversea.com','muscdn.com','tiktok.com','ttwstatic.com'];
    if (!roots.some(root => url.hostname === root || url.hostname.endsWith('.' + root))) return null;
    return url.href;
  } catch { return null; }
}

export function normalizeObservation(value, platform, collection = null) {
  if (!value || typeof value !== 'object') return null;
  const post = canonicalPost(value.url, platform);
  if (!post) return null;
  const item = {url:post.url, content_type:post.content_type};
  for (const [key, cap] of Object.entries({title:240, creator:160, caption:12000, thumbnail_alt:6000})) {
    const clean = text(value[key], cap);
    if (clean) item[key] = clean;
  }
  const preview = safePreview(value.preview_url);
  if (preview) item.preview_url = preview;
  // Collections are supplied from the bound run, never accepted from page-supplied records.
  if (collection) item.collections = [{source_key:collection.source_key, name:collection.name}];
  return item;
}

export function makeBatches(items, startSequence = 0, idFactory = () => crypto.randomUUID()) {
  const batches = [];
  let body = {batch_id:idFactory(), sequence:startSequence, items:[]};
  for (const item of items) {
    const candidate = {...body, items:[...body.items, item]};
    if (candidate.items.length > MAX_BATCH_ITEMS || byteLength(candidate) > MAX_BATCH_BYTES) {
      if (!body.items.length) throw new Error('A record exceeds the import message size limit.');
      batches.push(body);
      body = {batch_id:idFactory(), sequence:body.sequence + 1, items:[item]};
      if (byteLength(body) > MAX_BATCH_BYTES) throw new Error('A record exceeds the import message size limit.');
    } else body = candidate;
  }
  if (body.items.length) batches.push(body);
  return batches;
}

export function queueObservations(state, records, idFactory) {
  const run = state.run;
  if (!run) throw new Error('There is no active import.');
  const seen = new Set(run.seen || []);
  const fresh = [];
  for (const raw of records) {
    const item = normalizeObservation(raw, run.platform, run.collection);
    if (!item) continue;
    const identity = canonicalPost(item.url, run.platform).key;
    if (seen.has(identity)) continue;
    seen.add(identity); fresh.push(item);
  }
  const bodies = makeBatches(fresh, run.nextSequence, idFactory);
  const outbox = [...(state.outbox || []), ...bodies.map(body => ({body, attempts:0, nextRetryAt:0}))];
  const next = {...state, outbox, run:{...run, seen:[...seen], nextSequence:run.nextSequence + bodies.length, discovered:seen.size}};
  if (byteLength(outbox) > MAX_OUTBOX_BYTES || byteLength(next) > MAX_STATE_BYTES) {
    throw new Error('The local import queue is full. Pause, reconnect the server, and retry pending batches before resuming.');
  }
  return {state:next, queued:fresh.length};
}

export function initialState() { return {version:1, config:null, run:null, outbox:[]}; }

export function publicState(state) {
  const run = state.run;
  return {
    config:state.config ? {server:state.config.server, hasToken:Boolean(state.config.token), instance_id:state.config.instance_id} : null,
    run:run ? {
      id:run.id, platform:run.platform, sourceAccount:run.sourceAccount, scopeUrl:run.scopeUrl,
      collectionName:run.collection?.name || '', status:run.status, discovered:run.discovered,
      created:run.created, updated:run.updated, skipped:run.skipped, appliedBatches:run.appliedBatches,
      pendingBatches:state.outbox.length, pendingItems:state.outbox.reduce((n,b) => n + b.body.items.length, 0),
      scrolls:run.scrolls || 0, message:run.message || '', coverage:run.coverage || 'partial',
      startedAt:run.startedAt, lastHeartbeat:run.lastHeartbeat,
    } : null,
  };
}
