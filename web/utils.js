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
