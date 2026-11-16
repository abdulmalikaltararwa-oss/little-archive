import { describe, expect, it } from 'vitest';
import type { Collection, Item } from '@/data/types';
import { alreadyKept, alreadyLine, filedHeadline, localIds, revisitHeadline, savedLine, suggestCollections } from './words';

const local = (id: string, name: string, count = 0): Collection => ({ id, name, kind: 'local', count });
const source = (id: string, name: string, count = 0): Collection => ({ id, name, kind: 'source', platform: 'instagram', count });

describe('whether a link was already kept', () => {
  it('is new when the server made the save just now: one timestamp for both', () => {
    expect(alreadyKept({ created_at: '2026-11-16T09:00:00+00:00', last_seen_at: '2026-11-16T09:00:00+00:00' })).toBe(false);
  });
  it('was there before when the server only saw it again', () => {
    expect(alreadyKept({ created_at: '2026-03-12T08:00:00+00:00', last_seen_at: '2026-11-16T09:00:00+00:00' })).toBe(true);
  });
  it('does not claim a duplicate from a save with no timestamps', () => {
    expect(alreadyKept({ created_at: '', last_seen_at: '' })).toBe(false);
  });
});

describe('the line under "Kept in your archive."', () => {
  it('names the save and its source', () => {
    expect(savedLine({ title: 'Brown butter cookies', url: 'https://www.tiktok.com/@a/video/1', platform: 'tiktok' })).toBe('Brown butter cookies · TikTok');
  });
  it('falls back to the site when the save has no title', () => {
    expect(savedLine({ title: '', url: 'https://www.example.com/a', platform: 'web' })).toBe('example.com · Web');
  });
});

describe('the collections offered as chips', () => {
  const all = [local('a', 'Baking', 4), local('b', 'Weeknight dinners', 58), local('c', 'Home', 29), source('s', 'Saved on Instagram', 900)];
  it('offers the fullest of the person\'s own collections, never a source collection', () => {
    expect(suggestCollections(all, { collections: [] }).map(collection => collection.name)).toEqual(['Weeknight dinners', 'Home']);
  });
  it('puts the collections the save is already in first', () => {
    expect(suggestCollections(all, { collections: [{ id: 'a', name: 'Baking', kind: 'local' }] }).map(collection => collection.name)).toEqual(['Baking', 'Weeknight dinners']);
  });
  it('offers nothing when there are no collections to file into', () => {
    expect(suggestCollections([source('s', 'Saved on Instagram', 900)], { collections: [] })).toEqual([]);
  });
  it('breaks a tie by name, so the order is the same every time', () => {
    expect(suggestCollections([local('x', 'Zed', 2), local('y', 'Alpha', 2)], { collections: [] }).map(collection => collection.name)).toEqual(['Alpha', 'Zed']);
  });
});

describe('what filing edits', () => {
  it('is the local memberships only', () => {
    const item = { collections: [{ id: 'a', name: 'Baking', kind: 'local' }, { id: 's', name: 'Saved', kind: 'source' }] } as Pick<Item, 'collections'>;
    expect(localIds(item)).toEqual(['a']);
  });
});

describe('the line for a link that was already kept', () => {
  const year = new Date().getFullYear();
  it('says when and where the first copy is', () => {
    expect(alreadyLine({ saved_at: `${year}-03-12T12:00:00+00:00`, created_at: `${year}-05-01T12:00:00+00:00`, collections: [{ id: 'a', name: 'Baking', kind: 'local' }] }, false))
      .toBe('Saved on 12 March, in Baking. No second copy was made.');
  });
  it('uses the day it reached the library when the source gave no date, and the year when it is not this one', () => {
    expect(alreadyLine({ saved_at: null, created_at: '2021-05-01T12:00:00+00:00', collections: [] }, false)).toBe('Saved on 1 May 2021. No second copy was made.');
  });
  it('counts further collections instead of listing them', () => {
    const collections = [{ id: 'a', name: 'Baking', kind: 'local' as const }, { id: 'b', name: 'Sweets', kind: 'local' as const }, { id: 'c', name: 'Gifts', kind: 'local' as const }];
    expect(alreadyLine({ saved_at: `${year}-03-12T12:00:00+00:00`, created_at: '', collections }, false)).toContain('in Baking and 2 more.');
  });
  it('does not say nothing changed when the form carried a title, notes or topics', () => {
    const line = alreadyLine({ saved_at: `${year}-03-12T12:00:00+00:00`, created_at: '', collections: [] }, true);
    expect(line).toBe('Saved on 12 March. No second copy was made; the first one was updated with what you entered.');
    expect(line).not.toMatch(/nothing was added/i);
  });
  it('still says there is one copy when no date is known', () => {
    expect(alreadyLine({ saved_at: null, created_at: '', collections: [] }, false)).toBe('No second copy was made.');
  });
});

describe('what the tray says after a tap', () => {
  it('names the collection either way', () => {
    expect(filedHeadline('Baking', true)).toBe('Filed in Baking.');
    expect(filedHeadline('Baking', false)).toBe('Taken out of Baking.');
  });
  it('says whether it is marked to revisit', () => {
    expect(revisitHeadline(true)).toBe('Marked to revisit.');
    expect(revisitHeadline(false)).toBe('No longer marked to revisit.');
  });
});
