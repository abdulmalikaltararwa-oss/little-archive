// The library's rules, run against a small in-memory server that counts what it is asked. These are the
// behaviours the buildless interface's browser tests assert: page sizes, keeping the loaded window, the newest
// request winning, focus-free navigation state, and leaving a save with unsaved edits.
import { describe, expect, it, vi } from 'vitest';
import { createArchive, memoryHistory, PAGE, type Archive } from './archive';
import type { Backend } from './backend';
import type { Item } from './types';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function makeItem(index: number): Item {
  return {
    id: `item-${index}`, platform: index % 3 === 0 ? 'tiktok' : 'instagram', url: `https://example.com/${index}`, title: `Save ${String(index).padStart(3, '0')}`,
    creator: '', caption: '', summary: '', notes: '', content_type: 'post', preview_url: null, thumbnail_url: null, tags: [], collections: [],
    favorite: index % 2 === 0, status: 'inbox', needs_review: false, saved_at: null, created_at: '', updated_at: '', last_seen_at: '',
  };
}

interface Server {
  backend: Backend;
  items: Item[];
  requests: string[];
  /** Holds every answer to GET /api/items until released, to test which request wins. */
  hold(): () => void;
  authenticated: boolean;
  unauthorized: string;
  signedOut: ReturnType<typeof vi.fn>;
}

function server(count: number, { kind = 'browser' as Backend['kind'], takesOver = false } = {}): Server {
  const items = Array.from({ length: count }, (_, index) => makeItem(index));
  const requests: string[] = [];
  let gate: Promise<void> | null = null;
  const state = { authenticated: true, unauthorized: '' };
  const signedOut = vi.fn(() => takesOver);
  const backend = {
    kind, mode: 'self-hosted', serverUrl: 'http://archive.test', passwordLogin: true, csrf: true, account: null, initialShare: null, remembers: true, real: true, purchases: null,
    signedOut, onShare: () => () => {}, thumbnail: () => null, saveFile: async () => 'downloaded' as const,
    async fetch(path: string, init: RequestInit = {}) {
      const url = new URL(path, 'http://archive.test');
      const method = init.method || 'GET';
      requests.push(`${method} ${url.pathname}${url.search}`);
      if (state.unauthorized && url.pathname !== '/api/auth/me') return json({ detail: state.unauthorized }, 401);
      if (url.pathname === '/api/auth/me') return json({ authenticated: state.authenticated, csrf_token: 'csrf' });
      if (url.pathname === '/api/auth/login') { state.authenticated = true; return json({ authenticated: true, csrf_token: 'csrf' }); }
      if (url.pathname === '/api/auth/logout') { state.authenticated = false; return json({ ok: true }); }
      if (url.pathname === '/api/stats') return json({ total: items.length, favorites: items.filter(item => item.favorite).length, to_revisit: 0, needs_review: 0, archived: 0, collections: 0, platforms: {} });
      if (url.pathname === '/api/collections') return json({ collections: [{ id: 'src-1', name: 'Saved', kind: 'source', platform: 'tiktok' }] });
      if (url.pathname === '/api/tags') return json({ tags: [] });
      if (url.pathname === '/api/settings') return json({ remote_previews: false, ai_enabled: false, ai_model: '' });
      if (url.pathname === '/api/features') return json({ detail: 'Not found' }, 404);
      if (url.pathname === '/api/items' && method === 'GET') {
        if (gate) await gate;
        const p = url.searchParams;
        let matching = items.filter(item => (!p.has('favorite') || item.favorite) && (!p.get('platform') || item.platform === p.get('platform')) && (!p.get('q') || item.title.includes(p.get('q')!)));
        if (p.get('sort') === 'title') matching = [...matching].sort((a, b) => a.title.localeCompare(b.title));
        const limit = Number(p.get('limit'));
        const offset = Number(p.get('offset'));
        return json({ items: matching.slice(offset, offset + limit), total: matching.length, limit, offset });
      }
      return json({ detail: 'Not found' }, 404);
    },
  } as unknown as Backend;
  return {
    backend, items, requests, signedOut,
    hold() { let release!: () => void; gate = new Promise<void>(resolve => { release = resolve; }); return () => { gate = null; release(); }; },
    get authenticated() { return state.authenticated; }, set authenticated(value) { state.authenticated = value; },
    get unauthorized() { return state.unauthorized; }, set unauthorized(value) { state.unauthorized = value; },
  };
}

async function ready(count: number, hash = '', options: Parameters<typeof server>[1] = {}) {
  const world = server(count, options);
  const history = memoryHistory(hash);
  const notify = vi.fn();
  const archive = createArchive({ backend: world.backend, history, notify });
  await archive.boot();
  return { ...world, world, archive, history, notify, state: () => archive.store.getState() };
}

const listRequests = (requests: string[]) => requests.filter(line => line.startsWith('GET /api/items?'));
const limitOf = (line: string) => Number(new URL(line.slice(4), 'http://x').searchParams.get('limit'));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('opening the library', () => {
  it('signs in state, loads the metadata and the first page', async () => {
    const { state, requests } = await ready(150);
    expect(state()).toMatchObject({ phase: 'ready', list: 'ready', total: 150 });
    expect(state().items).toHaveLength(PAGE);
    expect(state().features).toBeNull();
    expect(state().featuresKnown).toBe(true);
    expect(listRequests(requests)).toHaveLength(1);
  });

  it('shows the sign-in screen when there is no session, and opens after a password', async () => {
    const world = server(5);
    world.authenticated = false;
    const archive = createArchive({ backend: world.backend, history: memoryHistory() });
    await archive.boot();
    expect(archive.store.getState().phase).toBe('signed-out');
    await archive.login('correct horse');
    expect(archive.store.getState()).toMatchObject({ phase: 'ready', total: 5 });
    await archive.logout();
    expect(archive.store.getState()).toMatchObject({ phase: 'signed-out', items: [] });
  });

  it('opens the view the address names', async () => {
    const { state } = await ready(40, '#/favorites?sort=title');
    expect(state().filters).toMatchObject({ favorite: true, sort: 'title' });
    expect(state().items.every(item => item.favorite)).toBe(true);
  });

  it('gives a source collection its platform once the collections are known', async () => {
    const { state } = await ready(30, '#/collection/src-1');
    expect(state().filters).toMatchObject({ collection_id: 'src-1', platform: 'tiktok' });
  });
});

describe('loading saves', () => {
  it('appends a page at a time and stops at the end', async () => {
    const { archive, state } = await ready(150);
    await archive.loadItems(true);
    expect(state().items).toHaveLength(120);
    await archive.loadItems(true);
    await archive.loadItems(true);
    expect(state().items).toHaveLength(150);
    expect(new Set(state().items.map(item => item.id)).size).toBe(150);
  });

  it('refetches the whole loaded window without asking for more than 200 at once', async () => {
    const { archive, state, requests } = await ready(300);
    for (let page = 0; page < 3; page++) await archive.loadItems(true);
    expect(state().items).toHaveLength(240);
    requests.length = 0;
    await archive.loadItems(false, { preserveLoaded: true });
    expect(listRequests(requests).map(limitOf)).toEqual([200, 40]);
    expect(state().items).toHaveLength(240);
  });

  it('lets the newest request win and drops a late answer to a view that was left', async () => {
    const { archive, state, world } = await ready(120);
    const release = world.hold();
    const slow = archive.loadItems();
    archive.navigate({ q: 'Save 00' });
    release();
    await slow;
    await tick();
    expect(state().filters.q).toBe('Save 00');
    expect(state().items.every(item => item.title.includes('Save 00'))).toBe(true);
    expect(state().total).toBe(10);
  });

  it('keeps what is loaded and says so when a later page fails', async () => {
    const { archive, state, world, notify } = await ready(150);
    const original = world.backend.fetch;
    world.backend.fetch = async (path, init) => (path.startsWith('/api/items?') ? json({ detail: 'The database is busy.' }, 503) : original(path, init));
    await archive.loadItems(true);
    expect(state().items).toHaveLength(PAGE);
    expect(state().list).toBe('ready');
    expect(notify).toHaveBeenCalledWith('Your loaded saves are still here. The database is busy.', { error: true });
  });

  it('shows an error in place of the wall when a view cannot load at all', async () => {
    const { archive, state, world } = await ready(10);
    world.backend.fetch = async () => json({ detail: 'Down for a moment.' }, 503);
    await archive.loadItems();
    expect(state()).toMatchObject({ list: 'error', listError: 'Down for a moment.' });
  });
});

describe('an edited save', () => {
  it('is replaced in place when the edit cannot change what the view shows', async () => {
    const { archive, state, requests } = await ready(100);
    const before = state().items[3]!;
    requests.length = 0;
    await archive.refreshEditedItem({ ...before, notes: 'Try on Sunday' });
    expect(listRequests(requests)).toHaveLength(0);
    expect(state().items[3]).toMatchObject({ id: before.id, notes: 'Try on Sunday' });
    expect(state().items).toHaveLength(PAGE);
  });

  it('refetches the loaded window when the edit can move it in or out of the view', async () => {
    const { archive, state, requests, items } = await ready(100, '#/favorites');
    await archive.loadItems(true);
    const loaded = state().items.length;
    const victim = state().items[0]!;
    items.find(item => item.id === victim.id)!.favorite = false;
    requests.length = 0;
    await archive.refreshEditedItem({ ...victim, favorite: false });
    expect(listRequests(requests)).toHaveLength(1);
    expect(state().items.some(item => item.id === victim.id)).toBe(false);
    // The window is filled from the next matching save, so pages are not lost.
    expect(state().items.length).toBe(Math.min(loaded, state().total));
  });
});

describe('moving around', () => {
  it('writes each view to the address and clears the selection', async () => {
    const { archive, state, history } = await ready(50);
    archive.select('item-1', true);
    archive.goView('favorites');
    expect(history.hash()).toBe('#/favorites');
    expect(state().selected.size).toBe(0);
    archive.navigate({ q: 'tea' }, { replace: true });
    expect(history.entries).toEqual(['', '#/favorites?q=tea']);
    archive.goScreen('recipes', 'item-4/cook');
    expect(history.hash()).toBe('#/recipes/item-4/cook');
    expect(state().loc).toMatchObject({ screen: 'recipes', rest: 'item-4/cook' });
  });

  it('follows the Back button', async () => {
    const { archive, state, history } = await ready(50);
    archive.goView('favorites');
    history.back();
    await tick();
    expect(state().loc.view).toBe('all');
    expect(state().filters.favorite).toBe(false);
  });

  it('opens a save as one history step and leaves it with Back', async () => {
    const { archive, state, history } = await ready(50);
    await archive.openItem('item-3');
    expect(history.hash()).toBe('#/?item=item-3');
    await archive.openItem('item-4');
    expect(history.entries).toEqual(['', '#/?item=item-4']);
    await archive.closeItem();
    await tick();
    expect(state().loc.item).toBe('');
    expect(history.hash()).toBe('');
  });

  it('closes a save reached by a link without leaving the app', async () => {
    const { archive, state, history } = await ready(50, '#/favorites?item=item-2');
    expect(state().loc.item).toBe('item-2');
    await archive.closeItem();
    expect(history.entries).toEqual(['#/favorites']);
    expect(state().loc.item).toBe('');
  });

  it('asks before leaving a save with unsaved edits, including by Back', async () => {
    const { archive, state, history } = await ready(50);
    await archive.openItem('item-3');
    const guard = vi.fn(async () => false);
    archive.setLeaveGuard(guard);
    expect(await archive.closeItem()).toBe(false);
    expect(await archive.openItem('item-9')).toBe(false);
    expect(state().loc.item).toBe('item-3');
    history.back();
    await tick();
    expect(guard).toHaveBeenCalledTimes(3);
    expect(state().loc.item).toBe('item-3');
    expect(history.hash()).toBe('#/?item=item-3');
    guard.mockResolvedValue(true);
    expect(await archive.closeItem()).toBe(true);
    expect(state().loc.item).toBe('');
  });

  it('welcomes a save that was just added when its detail is closed', async () => {
    const { archive, state } = await ready(50);
    archive.markSaved('item-7');
    await archive.openItem('item-7');
    expect(state().justSaved).toBe('');
    await archive.closeItem();
    expect(state().justSaved).toBe('item-7');
  });
});

describe('selection', () => {
  it('stops at 200 and selects only what is loaded', async () => {
    const { archive, state } = await ready(300);
    for (let page = 0; page < 3; page++) await archive.loadItems(true);
    archive.selectLoaded();
    expect(state().selected.size).toBe(200);
    expect(archive.select('item-299', true)).toBe(false);
    expect(archive.select('item-0', false)).toBe(true);
    archive.clearSelection();
    expect(state()).toMatchObject({ selecting: false });
    expect(state().selected.size).toBe(0);
  });
});

describe('a sign-in that ended', () => {
  it('returns a browser to the sign-in screen with a calm sentence', async () => {
    const { archive, state, world } = await ready(20);
    world.unauthorized = 'Not authenticated.';
    await expect(archive.api.stats()).rejects.toThrow();
    expect(state()).toMatchObject({ phase: 'signed-out', loginNotice: 'Your session expired. Sign in to continue.', items: [] });
  });

  it('says so when a device’s sign-in ran out rather than calling it an error', async () => {
    const { archive, state, world } = await ready(20);
    world.unauthorized = 'This device token has expired.';
    await expect(archive.api.stats()).rejects.toThrow();
    expect(state().loginNotice).toMatch(/has run out/);
  });

  it('hands over to the app’s own sign-in inside the app', async () => {
    const { archive, state, world, signedOut } = await ready(20, '', { kind: 'native', takesOver: true });
    world.unauthorized = 'This device token has expired.';
    await expect(archive.api.stats()).rejects.toThrow();
    expect(signedOut).toHaveBeenCalledWith(expect.stringMatching(/has run out/));
    expect(state().phase).toBe('ready');
  });
});

describe('a shared link', () => {
  it('waits until it is taken, once', async () => {
    const world = server(3);
    (world.backend as { initialShare: unknown }).initialShare = { text: 'Look https://example.com/post?x=1 nice' };
    const archive: Archive = createArchive({ backend: world.backend, history: memoryHistory() });
    expect(archive.store.getState().pendingShare).toMatchObject({ shared: true, url: 'https://example.com/post?x=1' });
    expect(archive.takeShare()?.url).toBe('https://example.com/post?x=1');
    expect(archive.takeShare()).toBeNull();
  });
});
