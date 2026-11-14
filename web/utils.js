export const PLATFORM_NAMES = { instagram: 'Instagram', tiktok: 'TikTok', web: 'Web' };
export const STATUS_NAMES = { inbox: 'Inbox', to_revisit: 'To revisit', done: 'Done', archived: 'Archived' };

export function safeURL(value, { local = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, local ? globalThis.location?.origin || 'http://localhost' : undefined);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (local && url.origin !== (globalThis.location?.origin || 'http://localhost')) return null;
    return url.href;
  } catch { return null; }
}

export function parseTags(value) {
  const tags = [...new Set(String(value || '').split(',').map(x => x.trim()).filter(Boolean))];
  if (tags.length > 50) throw new Error('Use at most 50 topics per save.');
  if (tags.some(tag => tag.length > 80)) throw new Error('Keep each topic to 80 characters or fewer.');
  return tags;
}

export function buildItemPatch(original, edits) {
  const patch = {};
  for (const key of ['title', 'summary', 'notes', 'status', 'needs_review']) {
    if (Object.hasOwn(edits, key) && edits[key] !== original[key]) patch[key] = edits[key];
  }
  if (Object.hasOwn(edits, 'tags') && JSON.stringify(edits.tags) !== JSON.stringify(original.tags || [])) patch.tags = edits.tags;
  if (Object.hasOwn(edits, 'collection_ids')) {
    const before = (original.collections || []).filter(c => c.kind === 'local').map(c => c.id).sort();
    const after = [...edits.collection_ids].sort();
    if (JSON.stringify(before) !== JSON.stringify(after)) patch.collection_ids = edits.collection_ids;
  }
  return patch;
}

// An ordinary annotation edit must not reset pagination or reshuffle Rediscover.
// Search matching stays on the server: it has the authoritative text index.
export function itemChangeAffectsView(before, after, filters) {
  const changed = key => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null);
  if (filters.q && ['title', 'summary', 'notes', 'caption', 'creator', 'tags'].some(changed)) return true;
  if (filters.sort === 'title' && changed('title')) return true;
  if (filters.platform && changed('platform')) return true;
  if (filters.favorite && changed('favorite')) return true;
  if (filters.needs_review && changed('needs_review')) return true;
  if (filters.status ? changed('status') : (before.status === 'archived') !== (after.status === 'archived')) return true;
  if (filters.tag && (before.tags || []).includes(filters.tag) !== (after.tags || []).includes(filters.tag)) return true;
  if (filters.collection_id && (before.collections || []).some(c => c.id === filters.collection_id) !== (after.collections || []).some(c => c.id === filters.collection_id)) return true;
  return false;
}

export function formatDate(value, options = {}) {
  if (!value) return 'Unknown';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 'Unknown' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', ...options });
}

export function hostLabel(value) {
  const url = safeURL(value);
  return url ? new URL(url).hostname.replace(/^www\./, '') : 'Saved link';
}

export function countLabel(value, singular, plural = `${singular}s`) {
  const n = Number(value) || 0;
  return `${n.toLocaleString()} ${n === 1 ? singular : plural}`;
}

export function createQuery(filters, offset = 0, limit = 60) {
  const q = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  for (const [key, value] of Object.entries(filters)) {
    if (value !== '' && value !== false && value != null) q.set(key, String(value));
  }
  return q.toString();
}

export function libraryScope(filters, scope = 'all') {
  if (scope === 'all') return {};
  if (scope === 'review') return { needs_review: true };
  if (scope !== 'view') throw new Error('Choose a valid library scope.');
  const allowed = new Set(['q', 'platform', 'collection_id', 'tag', 'status', 'favorite', 'needs_review']);
  return Object.fromEntries(Object.entries(filters).filter(([key, value]) => allowed.has(key) && value !== '' && value !== false && value != null));
}

export function stableHue(text) {
  let hash = 0;
  for (const char of String(text || 'little')) hash = ((hash << 5) - hash + char.codePointAt(0)) | 0;
  return Math.abs(hash) % 6;
}

export function errorMessage(error) {
  if (typeof error === 'string') return error;
  return error?.message || 'Something went wrong. Please try again.';
}

// Sharing into the app. On Android the installed app is offered in the share
// sheet and opens /share?title=&text=&url= (see manifest.webmanifest). Whatever
// arrives there is untrusted: it is reduced to plain strings that only ever
// prefill form fields, never markup, and nothing is saved until the owner taps Save.
export const SHARE_PATH = '/share';
const SHARE_LIMITS = { raw: 20000, url: 4096, title: 500, notes: 4000 };
// A link in prose ends at whitespace, a quote or an angle bracket.
const LINK_IN_TEXT = /https?:\/\/[^\s<>"'`\u00AB\u00BB\u2018-\u201D]+/giu;
// Control, format (zero-width, bidi), surrogate and separator characters can hide or reorder what a link says.
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
const TRAILING_PUNCTUATION = /[.,;:!?\u060C\u061B\u061F\u3002\uFF0C\uFF01\uFF1F]/u;
const CLOSERS = { ')': '(', ']': '[', '}': '{' };

function occurrences(text, character) { return text.split(character).length - 1; }

// Prose punctuation after a link is not part of it; a closing bracket is only when it has no opener in the link.
function trimLink(link) {
  let value = link;
  for (let last = value.at(-1); last; last = value.at(-1)) {
    const opener = CLOSERS[last];
    if (!TRAILING_PUNCTUATION.test(last) && !(opener && occurrences(value, last) > occurrences(value, opener))) break;
    value = value.slice(0, -1);
  }
  return value;
}

function plausibleHost(href) {
  const { hostname } = new URL(href);
  return hostname.includes('.') || hostname === 'localhost' || hostname.startsWith('[');
}

function limitText(value, max) { return Array.from(value).slice(0, max).join(''); }

function candidateLinks(value) {
  const links = [];
  for (const match of value.matchAll(LINK_IN_TEXT)) {
    const candidate = trimLink(match[0]);
    if (candidate.length > SHARE_LIMITS.url || HIDDEN_CHARACTERS.test(candidate)) continue;
    const href = safeURL(candidate);
    if (href && href.length <= SHARE_LIMITS.url && plausibleHost(href)) links.push({ href, token: match[0] });
  }
  return links;
}

function singleLine(value, max) {
  return limitText(value.replace(BIDI_CONTROLS, '').replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ').trim(), max);
}

function multiLine(value, max) {
  const text = value.replace(BIDI_CONTROLS, '').replace(/\r\n?|\u2028|\u2029/g, '\n')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, character => (character === '\n' ? character : ' ')).replace(/[^\S\n]+/g, ' ');
  return limitText(text.split('\n').map(line => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim(), max);
}

// Pure parser for the three share fields. The first usable link wins, looked for in
// url, then text, then title: Android apps usually put the link inside the text.
export function parseSharedContent({ title = '', text = '', url = '' } = {}) {
  const raw = { title: String(title ?? ''), text: String(text ?? ''), url: String(url ?? '') };
  for (const key of Object.keys(raw)) raw[key] = raw[key].slice(0, SHARE_LIMITS.raw);
  const shared = Object.values(raw).some(value => value.trim());
  let link = null;
  for (const key of ['url', 'text', 'title']) { link = candidateLinks(raw[key])[0]; if (link) break; }
  const withoutLinks = (value, keep) => value.replace(LINK_IN_TEXT, token => (keep(token) ? token : ' '));
  const isChosen = token => Boolean(link) && safeURL(trimLink(token)) === link.href;
  const heading = singleLine(withoutLinks(raw.title, () => false), SHARE_LIMITS.title);
  // Other links in the text stay in the notes, so nothing the person shared is dropped.
  const notes = multiLine(withoutLinks(raw.text, token => !isChosen(token)), SHARE_LIMITS.notes);
  return { shared, url: link?.href || '', title: heading, notes: notes === heading ? '' : notes };
}

// Reads a share launch from a Location-like object. Anything that is not the share path is not a share.
export function readShareTarget(location) {
  if (!location || location.pathname !== SHARE_PATH) return null;
  const params = new URLSearchParams(location.search);
  return parseSharedContent({ title: params.get('title') ?? '', text: params.get('text') ?? '', url: params.get('url') ?? '' });
}

// TikTok's own share sheet often produces short links. The server never follows links, so it cannot save them.
export function isTikTokShortLink(value) {
  const url = safeURL(value);
  return Boolean(url) && ['vm.tiktok.com', 'vt.tiktok.com'].includes(new URL(url).hostname);
}
