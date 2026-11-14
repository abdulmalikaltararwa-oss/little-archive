// The library's state and the rules for changing it. No React here: a plain store that the screens subscribe
// to, so the same rules can be tested against any backend (src/data/archive.test.ts).
//
// The loading rules are the ones the buildless interface settled on and the browser tests assert:
//  - a view loads 60 saves; "more" appends 60; the server's page limit of 200 is never exceeded
//  - an edit that cannot change which saves match replaces the one save in place: no refetch, no reshuffle
//  - an edit that can, refetches exactly the window already loaded, so pages and scroll are kept
//  - a newer request always wins: an answer to a view that has been left is dropped
import { errorMessage, itemChangeAffectsView, libraryScope, parseSharedContent, readShareTarget, SHARE_PATH } from '@web/utils.js';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { createApi, type Api, type Scope } from './api';
import type { Backend } from './backend';
import { createClient } from './client';
import { filtersFor, formatHash, HOME, listChanged, parseHash, sameLoc, type Loc, type SeamScreen } from './location';
import { EMPTY_SETTINGS, EMPTY_STATS, type Collection, type Features, type Filters, type Item, type Settings, type SharedLink, type Stats, type Tag } from './types';

export const PAGE = 60;
export const SERVER_PAGE_LIMIT = 200;
export const MAX_SELECTED = 200;

export type Phase = 'booting' | 'boot-error' | 'signed-out' | 'ready';
export type ListState = 'loading' | 'ready' | 'error';

export interface ArchiveState {
  phase: Phase;
  bootError: string;
  loginNotice: string;
  stats: Stats;
  collections: Collection[];
  tags: Tag[];
  settings: Settings;
  /** What this server offers beyond the library (GET /api/features). Null until known, and on a server or demo without it. */
  features: Features | null;
  featuresKnown: boolean;
  loc: Loc;
  filters: Filters;
  items: Item[];
  total: number;
  list: ListState;
  listError: string;
  /** True while any list request is in flight (the grid's aria-busy). */
  busy: boolean;
  loadingMore: boolean;
  /** Bumped whenever the loaded saves change, so the grid can keep its reading position. */
  revision: number;
  selected: ReadonlySet<string>;
  selecting: boolean;
  pendingShare: SharedLink | null;
  /** The scope "Keep reviewing" walks through for the open save. */
  reviewScope: Scope | null;
  /** The save that was just added, for the one-off welcome on its card. */
  justSaved: string;
}

/** The slice of window.history the store needs; replaced by a memory version in tests. */
export interface HistoryPort {
  hash(): string;
  write(hash: string, mode: 'push' | 'replace', mark?: string): void;
  /** The mark given to the current entry when it was written. */
  mark(): string | null;
  back(): void;
  listen(listener: () => void): () => void;
  /** Reads a share-sheet launch (/share?title=&text=&url=), if this page is one. */
  shareTarget(): SharedLink | null;
  /** Puts the address back to the app's own once a shared link has been dealt with. */
  forgetShare(): void;
}

export function browserHistory(): HistoryPort {
  return {
    hash: () => location.hash,
    write(hash, mode, mark) {
      const url = `${location.pathname}${location.search}${hash}`;
      const state = mark ? { la: mark } : null;
      if (mode === 'push') history.pushState(state, '', url);
      else history.replaceState(state, '', url);
    },
    mark: () => (history.state as { la?: string } | null)?.la ?? null,
    back: () => history.back(),
    listen(listener) {
      addEventListener('popstate', listener);
      addEventListener('hashchange', listener);
      return () => { removeEventListener('popstate', listener); removeEventListener('hashchange', listener); };
    },
    shareTarget: () => readShareTarget(location),
    forgetShare() {
      if (location.pathname === SHARE_PATH) history.replaceState(null, '', `/${location.hash}`);
    },
  };
}

export function memoryHistory(initial = ''): HistoryPort & { entries: string[] } {
  const entries: { hash: string; mark: string | null }[] = [{ hash: initial, mark: null }];
  let index = 0;
  const listeners = new Set<() => void>();
  return {
    get entries() { return entries.map(entry => entry.hash); },
    hash: () => entries[index]!.hash,
    write(hash, mode, mark) {
      if (mode === 'push') { entries.splice(index + 1); entries.push({ hash, mark: mark ?? null }); index += 1; }
      else entries[index] = { hash, mark: mark ?? null };
    },
    mark: () => entries[index]!.mark,
    back() { if (index > 0) { index -= 1; for (const listener of listeners) listener(); } },
    listen(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    shareTarget: () => null,
    forgetShare() {},
  };
}

export interface ArchiveDeps {
  backend: Backend;
  history?: HistoryPort;
  /** Short feedback for things that happen away from a form (the island shows it). */
  notify?: (message: string, options?: { error?: boolean }) => void;
  /** Wraps the moment a save opens or closes, so the interface can animate it. `id` is the save involved. */
  transition?: (apply: () => void, id: string) => void;
}

export interface Archive {
  readonly backend: Backend;
  readonly api: Api;
  readonly store: StoreApi<ArchiveState>;
  boot(): Promise<void>;
  login(password: string): Promise<void>;
  logout(): Promise<void>;
  refreshMetadata(): Promise<void>;
  loadItems(append?: boolean, options?: { preserveLoaded?: boolean }): Promise<void>;
  refreshLibrary(): Promise<void>;
  refreshEditedItem(updated: Item): Promise<void>;
  navigate(patch: Partial<Loc>, options?: { replace?: boolean }): void;
  goView(view: string): void;
  /** Opens a feature screen. `rest` is the part of its address the screen reads for itself. */
  goScreen(screen: SeamScreen, rest?: string, options?: { replace?: boolean }): void;
  openItem(id: string, options?: { reviewScope?: Scope }): Promise<boolean>;
  closeItem(options?: { force?: boolean }): Promise<boolean>;
  /** The open save registers a check that runs before it is left (unsaved edits). */
  setLeaveGuard(guard: (() => Promise<boolean>) | null): void;
  select(id: string, on: boolean): boolean;
  selectLoaded(): void;
  clearSelection(): void;
  setSelecting(on: boolean): void;
  takeShare(): SharedLink | null;
  forgetShare(): void;
  setSettings(settings: Settings): void;
  markSaved(id: string): void;
  dispose(): void;
}

export function createArchive({ backend, history = browserHistory(), notify = () => {}, transition }: ArchiveDeps): Archive {
  let authenticated = false;
  let requestSeq = 0;
  let leaveGuard: (() => Promise<boolean>) | null = null;
  let pendingSaved = '';

  // Where the interface is, updated the instant a move is decided. The store's copy can trail it by a frame
  // while a view transition is being set up, so navigation decisions are made against this one.
  let here = parseHash(history.hash());
  const startLoc = here;
  const share = backend.kind === 'demo' ? null : backend.initialShare ? parseSharedContent(backend.initialShare) : history.shareTarget();

  const store = createStore<ArchiveState>(() => ({
    phase: 'booting', bootError: '', loginNotice: '',
    stats: EMPTY_STATS, collections: [], tags: [], settings: EMPTY_SETTINGS, features: null, featuresKnown: false,
    loc: startLoc, filters: filtersFor(startLoc),
    items: [], total: 0, list: 'loading', listError: '', busy: false, loadingMore: false, revision: 0,
    selected: new Set<string>(), selecting: false,
    pendingShare: share, reviewScope: null, justSaved: '',
  }));
  const get = store.getState;
  const set = store.setState;

  const client = createClient(backend, { isAuthenticated: () => authenticated, onUnauthorized: sessionExpired });
  const api = createApi(client);

  function sessionExpired(detail = '') {
    authenticated = false;
    client.setCsrf('');
    requestSeq += 1;
    // A device token that went unused (or reached its lifetime) is not an error, just a sign-in that ran out.
    const message = /expir/i.test(detail) ? 'This device’s sign-in has run out. Sign in again to pick up where you left off.' : 'Your session expired. Sign in to continue.';
    if (backend.signedOut(message)) return; // the app has its own sign-in
    set({ phase: 'signed-out', loginNotice: message, items: [], total: 0 });
  }

  async function boot() {
    set({ phase: 'booting', bootError: '' });
    try {
      const me = await api.me();
      authenticated = Boolean(me.authenticated);
      client.setCsrf(me.csrf_token || '');
      if (authenticated) await initializeLibrary();
      else if (!backend.signedOut('')) set({ phase: 'signed-out', loginNotice: '' });
    } catch (error) {
      set({ phase: 'boot-error', bootError: errorMessage(error) });
    }
  }

  async function login(password: string) {
    const result = await api.login(password);
    client.setCsrf(result.csrf_token || '');
    authenticated = true;
    await initializeLibrary();
  }

  async function logout() {
    await api.logout();
    authenticated = false;
    client.setCsrf('');
    requestSeq += 1;
    set({ phase: 'signed-out', loginNotice: '', items: [], total: 0, selected: new Set(), selecting: false });
  }

  async function initializeLibrary() {
    set({ phase: 'ready', loginNotice: '', list: 'loading', listError: '' });
    try {
      await refreshMetadata();
      // A collection view needs the collection list to know its platform.
      set({ filters: filtersFor(here, get().collections) });
      await loadItems();
    } catch (error) {
      if (authenticated) set({ list: 'error', listError: errorMessage(error), busy: false });
    }
  }

  async function refreshMetadata() {
    // The feature list is optional: an older server, or the demo, simply does not have it.
    const [stats, collections, tags, settings, features] = await Promise.all([api.stats(), api.collections(), api.tags(), api.settings(), api.features().catch(() => null)]);
    set({ stats, collections: collections.collections || [], tags: tags.tags || [], settings, features: authenticated ? features : null, featuresKnown: true });
  }

  async function loadItems(append = false, { preserveLoaded = false }: { preserveLoaded?: boolean } = {}) {
    const request = ++requestSeq;
    const filters = { ...get().filters };
    const offset = append ? get().items.length : 0;
    const target = preserveLoaded ? Math.max(PAGE, get().items.length) : PAGE;
    if (!append && !preserveLoaded) set({ list: 'loading', listError: '', selected: new Set(), busy: true });
    else set({ busy: true, loadingMore: append });
    try {
      const items: Item[] = [];
      let total = 0;
      // Keep the loaded window without exceeding the server's page limit.
      do {
        const result = await api.items(filters, offset + items.length, Math.min(SERVER_PAGE_LIMIT, target - items.length));
        if (request !== requestSeq || !authenticated) return;
        items.push(...result.items);
        total = result.total;
        if (!result.items.length || filters.sort === 'random') break;
      } while (items.length < target && offset + items.length < total);
      const next = append ? [...get().items, ...items] : items;
      const loaded = new Set(next.map(item => item.id));
      const selected = new Set([...get().selected].filter(id => loaded.has(id)));
      set(state => ({ items: next, total, list: 'ready', listError: '', selected, revision: state.revision + 1 }));
    } catch (error) {
      if (request === requestSeq && authenticated) {
        if (preserveLoaded || append) notify(`Your loaded saves are still here. ${errorMessage(error)}`, { error: true });
        else set({ list: 'error', listError: errorMessage(error) });
      }
    } finally {
      if (request === requestSeq) set({ busy: false, loadingMore: false });
    }
  }

  async function refreshLibrary() {
    await refreshMetadata();
    await loadItems();
  }

  async function refreshEditedItem(updated: Item) {
    const request = requestSeq;
    const before = get().items.find(item => item.id === updated.id);
    const affectsView = Boolean(before) && itemChangeAffectsView(before!, updated, get().filters);
    await refreshMetadata();
    // A filter or search change made while saving owns the new view.
    if (request !== requestSeq || !authenticated) return;
    if (!before || affectsView) await loadItems(false, { preserveLoaded: true });
    else set(state => ({ items: state.items.map(item => (item.id === updated.id ? updated : item)), revision: state.revision + 1 }));
  }

  function applyLoc(next: Loc) {
    const previous = here;
    here = next;
    const changed = listChanged(previous, next);
    // Returning to the wall from the save that was just added: its card gets a one-off welcome.
    const welcome = previous.item && !next.item && previous.item === pendingSaved;
    if (welcome) pendingSaved = '';
    const apply = () => {
      // A view transition runs this a frame late. If a newer move has been decided since, it must not be undone.
      if (here !== next) return;
      set({ ...(welcome ? { justSaved: previous.item } : {}), loc: next, filters: filtersFor(next, get().collections), ...(changed ? { selected: new Set<string>(), selecting: false } : {}) });
    };
    if (transition && !changed && previous.item !== next.item) transition(apply, next.item || previous.item);
    else apply();
    if (changed && next.screen === 'library' && get().phase === 'ready') void loadItems();
  }

  function navigate(patch: Partial<Loc>, { replace = false }: { replace?: boolean } = {}) {
    const current = here;
    const next = { ...current, ...patch };
    if (sameLoc(next, current)) return;
    history.write(formatHash(next), replace ? 'replace' : 'push');
    applyLoc(next);
  }

  function goView(view: string) {
    const next: Loc = { ...HOME, view };
    if (sameLoc(next, here)) { if (get().phase === 'ready') void loadItems(); return; }
    history.write(formatHash(next), 'push');
    applyLoc(next);
  }

  function goScreen(screen: SeamScreen, rest = '', { replace = false }: { replace?: boolean } = {}) {
    const next: Loc = { ...HOME, screen, rest };
    if (sameLoc(next, here)) return;
    history.write(formatHash(next), replace ? 'replace' : 'push');
    applyLoc(next);
  }

  const passGuard = async () => !leaveGuard || leaveGuard();

  async function openItem(id: string, { reviewScope }: { reviewScope?: Scope } = {}) {
    let current = here;
    if (current.item && current.item !== id && !(await passGuard())) return false;
    set({ reviewScope: reviewScope ?? libraryScope(get().filters, 'view') });
    current = here; // the guard may have taken a moment
    if (current.item === id) return true;
    const next = { ...current, screen: 'library' as const, rest: '', item: id };
    // Moving from one open save to the next replaces the entry, so Back still leaves the detail in one step.
    history.write(formatHash(next), current.item ? 'replace' : 'push', current.item ? history.mark() ?? undefined : 'item');
    applyLoc(next);
    return true;
  }

  async function closeItem({ force = false }: { force?: boolean } = {}) {
    if (!here.item) return true;
    if (!force && !(await passGuard())) return false;
    const current = here;
    if (!current.item) return true;
    leaveGuard = null;
    const next = { ...current, item: '' };
    if (history.mark() === 'item') { applyLoc(next); history.back(); }
    else { history.write(formatHash(next), 'replace'); applyLoc(next); }
    return true;
  }

  const stopListening = history.listen(() => {
    void (async () => {
      const next = parseHash(history.hash());
      const previous = here;
      if (sameLoc(next, previous)) return;
      if (previous.item && next.item !== previous.item && !(await passGuard())) {
        // Back was pressed over unsaved edits and the person chose to stay: put the open save back.
        history.write(formatHash(previous), 'push', 'item');
        return;
      }
      if (previous.item && !next.item) leaveGuard = null;
      applyLoc(next);
    })();
  });

  const stopShare = backend.onShare(fields => set({ pendingShare: parseSharedContent(fields) }));

  // The app can get an unlock accepted on its own (a purchase approved later, one left over from the last start). What the
  // account may use has changed, so look again; the server decides what that is.
  const stopPurchases = backend.purchases?.onUnlocked?.(() => {
    if (!authenticated) return;
    void refreshMetadata().then(() => notify('Your unlock arrived. Everything is open.'), () => {});
  });

  function select(id: string, on: boolean) {
    const selected = new Set(get().selected);
    if (on) {
      if (selected.size >= MAX_SELECTED) return false;
      selected.add(id);
    } else selected.delete(id);
    set({ selected });
    return true;
  }

  return {
    backend, api, store, boot, login, logout, refreshMetadata, loadItems, refreshLibrary, refreshEditedItem, navigate, goView, goScreen, openItem, closeItem,
    setLeaveGuard: guard => { leaveGuard = guard; },
    select,
    selectLoaded() {
      const selected = new Set(get().selected);
      for (const item of get().items) { if (selected.size >= MAX_SELECTED) break; selected.add(item.id); }
      set({ selected });
    },
    clearSelection: () => set({ selected: new Set(), selecting: false }),
    setSelecting: on => set(on ? { selecting: true } : { selecting: false, selected: new Set() }),
    takeShare() {
      const pending = get().pendingShare;
      if (pending) set({ pendingShare: null });
      return pending;
    },
    forgetShare: () => history.forgetShare(),
    setSettings: settings => set(state => ({ settings, revision: state.revision + 1 })),
    markSaved: id => { pendingSaved = id; set({ justSaved: '' }); },
    dispose() { stopListening(); stopShare(); stopPurchases?.(); },
  };
}
