import { describe, expect, it } from 'vitest';
import { filtersFor, formatHash, HOME, listChanged, parseHash, sameLoc, viewTitle, withPlatform, type Loc } from './location';
import type { Collection } from './types';

const at = (patch: Partial<Loc>): Loc => ({ ...HOME, ...patch });

describe('addresses', () => {
  it('keeps the plain address plain for the home view', () => {
    expect(formatHash(HOME)).toBe('');
    expect(parseHash('')).toEqual(HOME);
    expect(parseHash('#/')).toEqual(HOME);
  });

  it('round-trips every kind of view, filter and open save', () => {
    const cases: Loc[] = [
      at({ view: 'favorites' }), at({ view: 'revisit' }), at({ view: 'review' }), at({ view: 'rediscover' }), at({ view: 'archived' }),
      at({ view: 'platform:tiktok' }), at({ view: 'collection:9f1c2a-b_3' }),
      at({ q: 'lemon pasta', tag: 'weeknight', sort: 'title', platform: 'web' }),
      at({ view: 'favorites', item: 'demo-item-12' }),
      at({ q: 'كرك على أصوله', tag: 'مشروبات' }),
      at({ screen: 'recipes' }), at({ screen: 'recipes', rest: 'abc-1/cook' }), at({ screen: 'guided-import', rest: 'imp_42' }), at({ screen: 'unlock' }),
    ];
    for (const loc of cases) expect(parseHash(formatHash(loc))).toEqual(loc);
  });

  it('falls back to home for anything it does not recognise, and never keeps a hostile value', () => {
    expect(parseHash('#/nonsense/../../etc')).toEqual(HOME);
    expect(parseHash('#/collection/<script>')).toEqual(HOME);
    expect(parseHash('#/?item=<img src=x onerror=alert(1)>').item).toBe('');
    expect(parseHash('#/?sort=drop table&platform=myspace')).toEqual(HOME);
    expect(parseHash('#/recipes/<svg>/cook').rest).toBe('');
    expect(parseHash('#/recipes/a/b/c/d/e/f').rest).toBe('');
    expect(parseHash(`#/?q=${'x'.repeat(900)}`).q).toHaveLength(200);
  });

  it('does not let a query platform contradict a source view', () => {
    expect(parseHash('#/source/instagram?platform=web')).toEqual(at({ view: 'platform:instagram' }));
  });

  it('knows a move that only opens or closes a save from one that changes the list', () => {
    expect(listChanged(at({ view: 'favorites' }), at({ view: 'favorites', item: 'a' }))).toBe(false);
    expect(listChanged(at({ q: 'a' }), at({ q: 'b' }))).toBe(true);
    expect(listChanged(at({}), at({ screen: 'ask' }))).toBe(true);
    expect(sameLoc(at({ item: 'a' }), at({ item: 'a' }))).toBe(true);
  });
});

describe('filters for an address', () => {
  const collections: Collection[] = [
    { id: 'local-1', name: 'Design notes', kind: 'local' },
    { id: 'src-1', name: 'Saved recipes', kind: 'source', platform: 'instagram' },
  ];

  it('maps each view to exactly the filters the server is asked for', () => {
    expect(filtersFor(at({ view: 'favorites' }))).toMatchObject({ favorite: true, status: '', sort: 'recent' });
    expect(filtersFor(at({ view: 'revisit' }))).toMatchObject({ status: 'to_revisit' });
    expect(filtersFor(at({ view: 'review' }))).toMatchObject({ needs_review: true });
    expect(filtersFor(at({ view: 'rediscover' }))).toMatchObject({ sort: 'random' });
    expect(filtersFor(at({ view: 'archived' }))).toMatchObject({ status: 'archived' });
    expect(filtersFor(at({ view: 'platform:web' }))).toMatchObject({ platform: 'web' });
  });

  it('gives a source collection its platform and leaves a local one alone', () => {
    expect(filtersFor(at({ view: 'collection:src-1' }), collections)).toMatchObject({ collection_id: 'src-1', platform: 'instagram' });
    expect(filtersFor(at({ view: 'collection:local-1' }), collections)).toMatchObject({ collection_id: 'local-1', platform: '' });
  });

  it('lets the person narrow and reorder any view', () => {
    expect(filtersFor(at({ view: 'rediscover', sort: 'title', q: 'tea', tag: 'drinks' }))).toMatchObject({ sort: 'title', q: 'tea', tag: 'drinks' });
  });

  it('moves between source views from a source tab, and narrows any other view', () => {
    expect(withPlatform(at({ view: 'platform:instagram' }), 'tiktok')).toMatchObject({ view: 'platform:tiktok', platform: '' });
    expect(withPlatform(at({ view: 'platform:instagram' }), '')).toMatchObject({ view: 'all', platform: '' });
    expect(withPlatform(at({ view: 'favorites' }), 'web')).toMatchObject({ view: 'favorites', platform: 'web' });
  });

  it('titles a view the way the buildless interface does', () => {
    const title = (loc: Loc) => viewTitle(loc, filtersFor(loc, collections), collections);
    expect(title(HOME)).toBe('All saves');
    expect(title(at({ view: 'favorites' }))).toBe('Your favorites');
    expect(title(at({ view: 'platform:tiktok' }))).toBe('TikTok saves');
    expect(title(at({ view: 'collection:local-1' }))).toBe('Design notes');
    expect(title(at({ view: 'collection:gone' }))).toBe('Collection');
  });
});
