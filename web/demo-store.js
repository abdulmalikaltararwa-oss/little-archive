import { safeURL } from './utils.js';

const unsupported = 'This is an isolated synthetic demo. Install your own Little Archive instance to use real imports, connections, local AI, thumbnails, or backups.';
const clone = value => structuredClone(value);
const json = (payload, status = 200, extra = {}) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json', ...extra } });
const escapeHTML = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const normalize = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').replaceAll('ـ', '').toLowerCase().replace(/[أإآ]/g, 'ا');

export function createDemoAPI(fixtures, { clock = () => new Date().toISOString() } = {}) {
  const items = new Map();
  const collections = new Map();
  let serial = 100;
  const nextID = kind => `demo-${kind}-${++serial}`;

  function resolveCollection(name, color = '#94a98b') {
    name = String(name || '').trim();
    if (!name || name.length > 200) throw new Error('Give your collection a name of 1–200 characters.');
    const existing = [...collections.values()].find(c => normalize(c.name) === normalize(name));
    if (existing) return existing;
    const c = { id: nextID('collection'), name, color, kind: 'local', platform: 'web', source_account: 'local' };
    collections.set(c.id, c); return c;
  }

  function canonical(raw) {
    const value = safeURL(raw);
    if (!value) throw new Error('Use a complete HTTP or HTTPS link without embedded credentials.');
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (['instagram.com', 'www.instagram.com', 'm.instagram.com'].includes(host)) {
      const match = url.pathname.match(/^\/(?:p|reel|reels)\/([\w-]+)\/?$/);
      if (!match) throw new Error('Use an individual Instagram post or Reel link.');
      return { platform: 'instagram', key: match[1], url: `https://www.instagram.com/p/${match[1]}/`, content_type: url.pathname.includes('/reel') ? 'video' : 'post' };
    }
    if (['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'].includes(host)) {
      const match = url.pathname.match(/^\/(@[^/]+)\/(video|photo)\/(\d+)\/?$/);
      if (!match) throw new Error('Use an individual TikTok video or photo link.');
      return { platform: 'tiktok', key: match[3], url: `https://www.tiktok.com/${match[1]}/${match[2]}/${match[3]}`, content_type: match[2] === 'video' ? 'video' : 'image' };
    }
    if (['vm.tiktok.com', 'vt.tiktok.com'].includes(host)) throw new Error('Open the short link and copy the full TikTok post URL.');
    return { platform: 'web', key: value, url: value, content_type: 'link' };
  }

  function cleanTags(tags) {
    if (!Array.isArray(tags) || tags.length > 50) throw new Error('Use at most 50 topics per save.');
    const seen = new Set();
    return tags.map(t => {
      if (typeof t !== 'string' || !t.trim() || t.trim().length > 80) throw new Error('Each topic must be 1–80 characters.');
      return t.trim();
    }).filter(tag => { const key = normalize(tag); if (seen.has(key)) return false; seen.add(key); return true; });
  }

  function localMemberships(ids) {
    if (!Array.isArray(ids) || ids.length > 50) throw new Error('Choose at most 50 local collections.');
    return [...new Set(ids)].map(id => { const c = collections.get(id); if (!c) throw new Error('That collection no longer exists.'); return clone(c); });
  }

  function seed() {
    let created = 0;
    fixtures.forEach((fixture, i) => {
      const id = `demo-item-${i + 1}`;
      if (items.has(id)) return;
      const identity = canonical(fixture.url);
      const timestamp = new Date(Date.now() - i * 86400000).toISOString();
      items.set(id, {
        id, ...identity, source_key: identity.key, source_account: 'demo', title: fixture.title,
        creator: fixture.creator, caption: fixture.caption, summary: fixture.summary, notes: fixture.notes,
        content_type: fixture.content_type, preview_url: null, thumbnail_url: fixture.cover ? new URL(`./demo-media/${fixture.cover}`, import.meta.url).href : null,
        tags: [...fixture.tags], collections: fixture.collections.map(c => clone(resolveCollection(c.name))),
        favorite: fixture.favorite, status: fixture.status, needs_review: fixture.needs_review,
        saved_at: fixture.saved_at, created_at: timestamp, updated_at: timestamp, last_seen_at: timestamp,
        evidence: [{ kind: 'caption', text: fixture.caption }], ai: null,
      });
      created++;
    });
    return created;
  }
  seed();

  function mustItem(id) { const item = items.get(id); if (!item) throw new Error('This demo save no longer exists.'); return item; }
  function collectionList() {
    return [...collections.values()].map(c => ({ ...c, count: [...items.values()].filter(i => i.status !== 'archived' && i.collections.some(x => x.id === c.id)).length })).sort((a, b) => a.name.localeCompare(b.name));
  }
  function edit(item, patch) {
    const updated = clone(item);
    for (const [key, value] of Object.entries(patch)) {
      if (['title', 'summary', 'notes'].includes(key)) {
        const limit = { title: 500, summary: 4000, notes: 20000 }[key];
        if (typeof value !== 'string' || value.length > limit || (key === 'title' && !value.trim())) throw new Error(`Use a valid ${key} under ${limit} characters.`);
        updated[key] = value;
      } else if (key === 'tags') updated.tags = cleanTags(value);
      else if (['favorite', 'needs_review'].includes(key)) { if (typeof value !== 'boolean') throw new Error('Use a boolean value.'); updated[key] = value; }
      else if (key === 'status') { if (!['inbox', 'to_revisit', 'done', 'archived'].includes(value)) throw new Error('Choose a valid progress state.'); updated.status = value; }
      else if (key === 'collection_ids') updated.collections = [...updated.collections.filter(c => c.kind === 'source'), ...localMemberships(value)];
      else throw new Error('This field cannot be edited in the demo.');
    }
    updated.updated_at = clock(); return updated;
  }

  function matchingItems(parameters) {
    const words = normalize(parameters.get('q') || '').split(/\s+/).filter(Boolean);
    return [...items.values()].filter(item => {
      if (parameters.get('status') ? item.status !== parameters.get('status') : item.status === 'archived') return false;
      if (parameters.get('platform') && item.platform !== parameters.get('platform')) return false;
      if (parameters.get('collection_id') && !item.collections.some(c => c.id === parameters.get('collection_id'))) return false;
      if (parameters.get('tag') && !item.tags.includes(parameters.get('tag'))) return false;
      for (const key of ['favorite', 'needs_review']) if (parameters.has(key) && item[key] !== (parameters.get(key) === 'true')) return false;
      const text = normalize([item.title, item.caption, item.summary, item.notes, item.creator, ...item.tags].join(' '));
      return words.every(word => text.includes(word));
    });
  }

  return async (path, init = {}) => {
    const url = new URL(path, 'http://demo.invalid');
    const route = url.pathname;
    const method = String(init.method || 'GET').toUpperCase();
    let body = {};
    try {
      if (init.body && typeof init.body === 'string') body = JSON.parse(init.body);
      if (route === '/api/health') return json({ status: 'ok', version: '0.1.0', demo: true });
      if (route === '/api/auth/me') return json({ authenticated: true, csrf_token: '', version: '0.1.0', demo: true });
      if (route.startsWith('/api/auth/')) return json({ detail: 'This public demo has no account or credentials. Reload the page to reset its synthetic content.' }, 501);

      if (route === '/api/settings') {
        if (method !== 'GET') return json({ detail: 'Remote media connections are disabled in the public demo. No external content is fetched.' }, 501);
        return json({ remote_previews: false, ai_enabled: false, ai_model: '', ai_available: false, demo: true });
      }
      if (route === '/api/stats' && method === 'GET') {
        const all = [...items.values()]; const visible = all.filter(i => i.status !== 'archived');
        return json({ total: visible.length, favorites: visible.filter(i => i.favorite).length, to_revisit: visible.filter(i => i.status === 'to_revisit').length, needs_review: visible.filter(i => i.needs_review).length, archived: all.length - visible.length, collections: collections.size, platforms: Object.fromEntries(['instagram', 'tiktok', 'web'].map(p => [p, visible.filter(i => i.platform === p).length])) });
      }
      if (route === '/api/tags' && method === 'GET') {
        const counts = new Map(); for (const item of items.values()) if (item.status !== 'archived') for (const tag of item.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
        return json({ tags: [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)) });
      }
      if (route === '/api/collections') {
        if (method === 'GET') return json({ collections: collectionList() });
        if (method === 'POST') { const c = resolveCollection(body.name, body.color); return json({ ...c, count: 0 }); }
      }
      const collectionMatch = route.match(/^\/api\/collections\/([^/]+)$/);
      if (collectionMatch) {
        const c = collections.get(collectionMatch[1]); if (!c) return json({ detail: 'Collection not found.' }, 404);
        if (method === 'DELETE') { collections.delete(c.id); for (const item of items.values()) item.collections = item.collections.filter(x => x.id !== c.id); return json({ ok: true }); }
        if (method === 'PATCH') {
          if (body.name != null) {
            if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200) throw new Error('Use a collection name of 1–200 characters.');
            if ([...collections.values()].some(x => x.id !== c.id && normalize(x.name) === normalize(body.name))) return json({ detail: 'That collection name is already in use.' }, 409);
            c.name = body.name.trim();
          }
          if (body.color) c.color = body.color;
          for (const item of items.values()) item.collections = item.collections.map(x => x.id === c.id ? clone(c) : x);
          return json(collectionList().find(x => x.id === c.id));
        }
      }
      if (route === '/api/items' && method === 'GET') {
        const p = url.searchParams;
        const result = matchingItems(p);
        const sort = p.get('sort') || 'recent';
        if (sort === 'random') for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
        else result.sort(sort === 'title' ? (a, b) => a.title.localeCompare(b.title) : sort === 'oldest' ? (a, b) => a.created_at.localeCompare(b.created_at) : (a, b) => b.created_at.localeCompare(a.created_at));
        const limit = Math.max(1, Math.min(200, Number(p.get('limit')) || 60)); const offset = Math.max(0, Number(p.get('offset')) || 0);
        return json({ items: clone(result.slice(offset, offset + limit)), total: result.length, limit, offset });
      }
      if (route === '/api/items' && method === 'POST') {
        const identity = canonical(body.url); const existing = [...items.values()].find(i => i.source_account === 'default' && i.platform === identity.platform && i.source_key === identity.key);
        const id = existing?.id || nextID('item'); const stamp = clock();
        const item = existing || { id, ...identity, source_key: identity.key, source_account: 'default', title: body.title?.trim() || 'A new demo save', creator: '', caption: '', summary: '', notes: '', content_type: identity.content_type, preview_url: null, thumbnail_url: null, tags: [], collections: [], favorite: false, status: 'inbox', needs_review: true, saved_at: null, created_at: stamp, updated_at: stamp, last_seen_at: stamp, evidence: [], ai: null };
        const patch = Object.fromEntries(['title', 'summary', 'notes', 'tags', 'collection_ids'].filter(k => body[k] != null && !(k === 'title' && !body[k].trim())).map(k => [k, body[k]]));
        const updated = edit(item, patch); items.set(id, updated); return json(clone(updated));
      }
      if (route === '/api/items/bulk' && method === 'POST') {
        if ((body.ids == null) === (body.filters == null)) throw new Error('Choose selected IDs or a library filter.');
        if (body.ids != null && (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 200)) throw new Error('Select between 1 and 200 saves.');
        if (body.filters != null && (typeof body.filters !== 'object' || Array.isArray(body.filters))) throw new Error('Use a valid library filter.');
        const selected = body.ids != null ? [...new Set(body.ids)].map(mustItem) : matchingItems(new URLSearchParams(Object.entries(body.filters).filter(([, value]) => value != null).map(([key, value]) => [key, String(value)])));
        const updates = selected.map(item => {
          if (body.action === 'favorite' || body.action === 'unfavorite') return edit(item, { favorite: body.action === 'favorite' });
          if (body.action === 'archive' || body.action === 'restore') return edit(item, { status: body.action === 'archive' ? 'archived' : 'inbox' });
          if (body.action === 'tag') return edit(item, { tags: [...new Set([...item.tags, String(body.value || '').trim()])] });
          if (body.action === 'collection') return edit(item, { collection_ids: [...new Set([...item.collections.filter(c => c.kind === 'local').map(c => c.id), body.value])] });
          throw new Error('Choose a supported bulk action.');
        });
        updates.forEach(item => items.set(item.id, item)); return json({ updated: updates.length });
      }
      const itemMatch = route.match(/^\/api\/items\/([^/]+)$/);
      if (itemMatch) {
        const item = items.get(itemMatch[1]); if (!item) return json({ detail: 'This demo save was not found.' }, 404);
        if (method === 'GET') return json(clone(item));
        if (method === 'PATCH') { const updated = edit(item, body); items.set(item.id, updated); return json(clone(updated)); }
        if (method === 'DELETE') { items.delete(item.id); return json({ ok: true }); }
      }
      if (route === '/api/imports' && method === 'GET') return json({ imports: [] });
      if (route === '/api/ai/jobs' && method === 'GET') return json({ jobs: [], total: 0, counts: { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 }, limit: 25, offset: 0 });
      if (route === '/api/extension/tokens' && method === 'GET') return json({ tokens: [] });
      if (route === '/api/demo' && method === 'POST') return json({ created: seed() });
      if (route === '/api/export' && method === 'GET') {
        const format = url.searchParams.get('format') || 'json';
        const all = [...items.values()].map(clone); let data; let contentType;
        if (format === 'json') { data = JSON.stringify({ format: 'little-archive', version: 1, demo: true, exported_at: clock(), items: all, collections: collectionList() }, null, 2); contentType = 'application/json'; }
        else if (format === 'csv') {
          const fields = ['title', 'url', 'platform', 'notes', 'tags', 'favorite', 'status'];
          const quote = value => { let text = String(value ?? ''); if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text; return '"' + text.replaceAll('"', '""') + '"'; };
          data = [fields.map(quote).join(','), ...all.map(item => fields.map(key => quote(key === 'tags' ? item.tags.join('; ') : item[key])).join(','))].join('\r\n'); contentType = 'text/csv';
        } else if (format === 'html') { data = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<TITLE>Little Archive synthetic demo</TITLE>\n<DL><p>\n' + all.map(i => `<DT><A HREF="${escapeHTML(i.url)}">${escapeHTML(i.title)}</A>`).join('\n') + '\n</DL>'; contentType = 'text/html'; }
        else throw new Error('Choose JSON, CSV, or HTML.');
        return new Response(data, { headers: { 'Content-Type': contentType, 'Content-Disposition': `attachment; filename="little-archive-synthetic-demo.${format}"` } });
      }
      if (route.startsWith('/api/extension/') || route.startsWith('/api/ai/') || route.includes('/thumbnail') || route.includes('/ai/') || route === '/api/backup' || route === '/api/imports/file') return json({ detail: unsupported }, 501);
      return json({ detail: 'This action is unavailable in the synthetic demo.' }, 404);
    } catch (error) { return json({ detail: error instanceof Error ? error.message : 'The demo could not apply that change.' }, 400); }
  };
}
