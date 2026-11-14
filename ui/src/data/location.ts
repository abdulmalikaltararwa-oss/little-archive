// Where you are, as an address. The part after # names the screen, the library view and its filters, and
// the open save, so a view can be bookmarked, reloaded and left with the Back button. The server never sees
// it (a fragment is not sent), which also keeps search words out of server logs.
//
//   #/                       all saves             #/favorites   #/revisit   #/review   #/rediscover   #/archived
//   #/source/instagram       one source            #/collection/<id>
//   #/recipes  #/places  #/ask  #/import/guided  #/unlock      screens arriving in the next wave
//   ?q=&platform=&tag=&sort=&item=                 filters and the open save, on any library view
import { PLATFORM_NAMES } from '@web/utils.js';
import { EMPTY_FILTERS, type Collection, type Filters, type Platform, type Sort } from './types';

export type Screen = 'library' | 'recipes' | 'places' | 'ask' | 'guided-import' | 'unlock';
export type SeamScreen = Exclude<Screen, 'library'>;

export interface Loc {
  screen: Screen;
  /** 'all' | 'favorites' | 'revisit' | 'review' | 'rediscover' | 'archived' | 'platform:<p>' | 'collection:<id>' */
  view: string;
  q: string;
  platform: '' | Platform;
  tag: string;
  /** '' means the view's own order. */
  sort: '' | Sort;
  /** The open save, or ''. */
  item: string;
  /** On a feature screen, the rest of the path (for example a save's id, or `<id>/cook`). The screen reads it. */
  rest: string;
}

export const HOME: Loc = { screen: 'library', view: 'all', q: '', platform: '', tag: '', sort: '', item: '', rest: '' };

const PLATFORMS: readonly Platform[] = ['instagram', 'tiktok', 'web'];
const SORTS: readonly Sort[] = ['recent', 'oldest', 'title', 'random'];
const SIMPLE_VIEWS = ['favorites', 'revisit', 'review', 'rediscover', 'archived'] as const;
const SCREEN_PATHS: Record<SeamScreen, string> = { recipes: 'recipes', places: 'places', ask: 'ask', 'guided-import': 'import/guided', unlock: 'unlock' };
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const REST = /^[A-Za-z0-9_-]{1,80}(\/[A-Za-z0-9_-]{1,80}){0,3}$/;
const LIMITS = { q: 200, tag: 80 };

const isPlatform = (value: string): value is Platform => (PLATFORMS as readonly string[]).includes(value);
const isSort = (value: string): value is Sort => (SORTS as readonly string[]).includes(value);

/** Reads an address fragment. Anything it does not recognise is the home view; nothing in it is trusted as markup. */
export function parseHash(hash: string): Loc {
  const text = hash.startsWith('#') ? hash.slice(1) : hash;
  const [rawPath = '', rawQuery = ''] = text.split('?');
  const path = rawPath.replace(/^\/+|\/+$/g, '');
  const loc: Loc = { ...HOME };

  // A feature screen owns everything after its own path: #/recipes/<id>/cook is the recipes screen with rest "<id>/cook".
  const seam = (Object.entries(SCREEN_PATHS) as [SeamScreen, string][]).find(([, value]) => path === value || path.startsWith(`${value}/`));
  if (seam) {
    const rest = path.slice(seam[1].length + 1);
    return { ...loc, screen: seam[0], rest: REST.test(rest) ? rest : '' };
  }

  const [head = '', tail = ''] = path.split('/');
  if ((SIMPLE_VIEWS as readonly string[]).includes(head) && !tail) loc.view = head;
  else if (head === 'source' && isPlatform(tail)) loc.view = `platform:${tail}`;
  else if (head === 'collection' && ID.test(tail)) loc.view = `collection:${tail}`;

  let params: URLSearchParams;
  try { params = new URLSearchParams(rawQuery); } catch { return loc; }
  loc.q = (params.get('q') ?? '').trim().slice(0, LIMITS.q);
  loc.tag = (params.get('tag') ?? '').slice(0, LIMITS.tag);
  const platform = params.get('platform') ?? '';
  // A source view already names its platform; a second one in the query would contradict it.
  if (isPlatform(platform) && !loc.view.startsWith('platform:')) loc.platform = platform;
  const sort = params.get('sort') ?? '';
  if (isSort(sort)) loc.sort = sort;
  const item = params.get('item') ?? '';
  if (ID.test(item)) loc.item = item;
  return loc;
}

/** Writes an address fragment. The home view is the empty string, so the plain address stays plain. */
export function formatHash(loc: Loc): string {
  if (loc.screen !== 'library') return `#/${SCREEN_PATHS[loc.screen]}${loc.rest ? `/${loc.rest}` : ''}`;
  let path = '';
  if ((SIMPLE_VIEWS as readonly string[]).includes(loc.view)) path = loc.view;
  else if (loc.view.startsWith('platform:')) path = `source/${loc.view.slice(9)}`;
  else if (loc.view.startsWith('collection:')) path = `collection/${loc.view.slice(11)}`;
  const params = new URLSearchParams();
  if (loc.q) params.set('q', loc.q);
  if (loc.platform) params.set('platform', loc.platform);
  if (loc.tag) params.set('tag', loc.tag);
  if (loc.sort) params.set('sort', loc.sort);
  if (loc.item) params.set('item', loc.item);
  const query = params.toString();
  if (!path && !query) return '';
  return `#/${path}${query ? `?${query}` : ''}`;
}

export function sameLoc(a: Loc, b: Loc): boolean {
  return formatHash(a) === formatHash(b) && a.screen === b.screen;
}

/** The filters a view stands for, before the person narrows it further. */
function viewFilters(view: string, collections: readonly Collection[]): Partial<Filters> {
  if (view === 'favorites') return { favorite: true };
  if (view === 'revisit') return { status: 'to_revisit' };
  if (view === 'review') return { needs_review: true };
  if (view === 'rediscover') return { sort: 'random' };
  if (view === 'archived') return { status: 'archived' };
  if (view.startsWith('platform:')) {
    const platform = view.slice(9);
    return isPlatform(platform) ? { platform } : {};
  }
  if (view.startsWith('collection:')) {
    const id = view.slice(11);
    const collection = collections.find(entry => entry.id === id);
    // A source collection belongs to one platform; naming it keeps the source tabs honest.
    return { collection_id: id, ...(collection?.kind === 'source' && collection.platform ? { platform: collection.platform } : {}) };
  }
  return {};
}

/** The exact filter set sent to GET /api/items for an address. */
export function filtersFor(loc: Loc, collections: readonly Collection[] = []): Filters {
  const filters: Filters = { ...EMPTY_FILTERS, ...viewFilters(loc.view, collections) };
  if (loc.q) filters.q = loc.q;
  if (loc.tag) filters.tag = loc.tag;
  if (loc.platform) filters.platform = loc.platform;
  if (loc.sort) filters.sort = loc.sort;
  return filters;
}

const VIEW_TITLES: Record<string, string> = {
  all: 'All saves', favorites: 'Your favorites', revisit: 'A little later', review: 'Needs a little review', rediscover: 'Rediscover something good', archived: 'Archived saves',
};

export function viewTitle(loc: Loc, filters: Filters, collections: readonly Collection[]): string {
  if (filters.collection_id) return collections.find(entry => entry.id === filters.collection_id)?.name || 'Collection';
  return VIEW_TITLES[loc.view] ?? `${PLATFORM_NAMES[filters.platform] || 'All'} saves`;
}

/** Picking a source tab. Inside a source view it moves between source views; anywhere else it narrows the view. */
export function withPlatform(loc: Loc, platform: '' | Platform): Loc {
  if (loc.view.startsWith('platform:')) return { ...loc, view: platform ? `platform:${platform}` : 'all', platform: '' };
  return { ...loc, platform };
}

/** Whether moving between two addresses changes which saves are listed (as opposed to only opening or closing one). */
export function listChanged(a: Loc, b: Loc): boolean {
  return formatHash({ ...a, item: '' }) !== formatHash({ ...b, item: '' }) || a.screen !== b.screen;
}
