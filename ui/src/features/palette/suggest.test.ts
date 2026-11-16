import { describe, expect, it } from 'vitest';
import type { Collection, Item, Stats, Tag } from '@/data/types';
import { excerpt, foundLine, librarySuggestions, markWords, narrowBySource, queryWords, searchWhisper, sourceLine, topTopics } from './suggest';

const STATS: Stats = { total: 1284, favorites: 96, to_revisit: 41, needs_review: 7, archived: 3, collections: 4, platforms: { instagram: 700, tiktok: 500, web: 84 } };
const TAGS: Tag[] = [{ name: 'dessert', count: 19 }, { name: 'coffee', count: 8 }, { name: 'chicken', count: 31 }, { name: 'unused', count: 0 }];
const COLLECTIONS: Collection[] = [
  { id: 'c1', name: 'Weeknight dinners', kind: 'local', count: 58 },
  { id: 'c2', name: 'Japan, spring', kind: 'local', count: 74 },
  { id: 's1', name: 'Saved on Instagram', kind: 'source', platform: 'instagram', count: 700 },
];

const text = (segments: { text: string; hit: boolean }[]) => segments.map(segment => (segment.hit ? `[${segment.text}]` : segment.text)).join('');

describe('the searches offered from the library', () => {
  it('are built from counts the library holds, most used first', () => {
    const list = librarySuggestions({ stats: STATS, tags: TAGS, collections: COLLECTIONS });
    expect(list.map(entry => [entry.label, entry.count])).toEqual([
      ['chicken', 31], ['dessert', 19], ['In Japan, spring', 74], ['From Instagram', 700], ['Favorites', 96], ['To revisit, oldest first', undefined],
    ]);
    expect(list.at(-1)!.to).toEqual({ view: 'revisit', sort: 'oldest' });
    expect(list[0]!.to).toEqual({ tag: 'chicken' });
    expect(list[2]!.to).toEqual({ view: 'collection:c2' });
    expect(list[3]!.to).toEqual({ view: 'platform:instagram' });
  });
  it('leave out whatever has no saves behind it', () => {
    const empty: Stats = { total: 0, favorites: 0, to_revisit: 0, needs_review: 0, archived: 0, collections: 0, platforms: {} };
    expect(librarySuggestions({ stats: empty, tags: [{ name: 'unused', count: 0 }], collections: [{ id: 'c', name: 'Empty', kind: 'local', count: 0 }] })).toEqual([]);
  });
  it('never offer a source collection as a place of the person\'s own', () => {
    const list = librarySuggestions({ stats: { ...STATS, platforms: {} }, tags: [], collections: [COLLECTIONS[2]!] });
    expect(list.map(entry => entry.label)).toEqual(['Favorites', 'To revisit, oldest first']);
  });
});

describe('the topics offered when a search finds nothing', () => {
  it('are the most used ones that have saves', () => {
    expect(topTopics(TAGS).map(tag => tag.name)).toEqual(['chicken', 'dessert']);
    expect(topTopics([{ name: 'unused', count: 0 }])).toEqual([]);
  });
});

describe('marking the searched words', () => {
  it('splits a search into its words', () => {
    expect(queryWords('  Karak CHAI, chai!')).toEqual(['karak', 'chai']);
    expect(queryWords('مجبوس دجاج')).toEqual(['مجبوس', 'دجاج']);
    expect(queryWords('—')).toEqual([]);
  });
  it('marks a word where it begins a word, whatever the capitals', () => {
    expect(text(markWords('Karak Chai at home, chai-style', ['chai']))).toBe('Karak [Chai] at home, [chai]-style');
    // The server matches the start of a word, so "chai" finds "chaiwala" but not "machai".
    expect(text(markWords('chaiwala and machai', ['chai']))).toBe('[chai]wala and machai');
  });
  it('marks nothing when the word is not there letter for letter', () => {
    expect(markWords('Crème brûlée', ['creme'])).toEqual([{ text: 'Crème brûlée', hit: false }]);
    expect(markWords('', ['chai'])).toEqual([{ text: '', hit: false }]);
    expect(markWords('Chai', [])).toEqual([{ text: 'Chai', hit: false }]);
  });
  it('cuts a long text down to the stretch around the word', () => {
    const caption = 'We walked the whole of the old market before lunch and found the chai haleeb stall by the spice sellers, which everyone had told us about for years.';
    const cut = excerpt(caption, ['chai'])!;
    expect(text(cut)).toMatch(/^….*\[chai\] haleeb stall.*…$/);
    expect(text(cut).length).toBeLessThan(70);
    expect(excerpt('for chai on the balcony', ['chai'])!.map(segment => segment.text).join('')).toBe('for chai on the balcony');
    expect(excerpt('nothing here', ['chai'])).toBeNull();
  });
});

describe('the line under a found save', () => {
  const item = (changes: Partial<Item>): Item => ({ title: 'Enamel mugs, small batch', caption: '', notes: '', summary: '', tags: [], creator: '', platform: 'web', url: 'https://www.example.com/mugs', ...changes }) as Item;

  it('is the source when the title holds the words', () => {
    expect(foundLine(item({ title: 'Karak chai at home', platform: 'tiktok', creator: '@chaiwithdana', match_in: ['title', 'caption'] }), ['chai'])).toEqual({ label: 'TikTok · @chaiwithdana', quote: null });
    expect(sourceLine(item({}))).toBe('Web · example.com');
    expect(sourceLine(item({ platform: 'instagram' }))).toBe('Instagram');
  });
  it('quotes the caption or the note where the words are', () => {
    const inCaption = foundLine(item({ caption: 'the chai haleeb stall by the gate', match_in: ['caption'] }), ['chai']);
    expect(inCaption.label).toBe('In the caption');
    expect(text(inCaption.quote!)).toBe('the [chai] haleeb stall by the gate');
    const inNote = foundLine(item({ notes: 'for chai on the balcony', match_in: ['notes'] }), ['chai']);
    expect(inNote.label).toBe('In your note');
    expect(text(inNote.quote!)).toBe('for [chai] on the balcony');
  });
  it('names a transcript without quoting it, because the interface does not hold it', () => {
    expect(foundLine(item({ match_in: ['transcript'] }), ['chai'])).toEqual({ label: 'In the transcript', quote: null });
  });
  it('names the place without a quote when the server matched through its own folding of letters', () => {
    expect(foundLine(item({ caption: 'Crème brûlée, torched', match_in: ['caption'] }), ['creme'])).toEqual({ label: 'In the caption', quote: null });
  });
  it('is the source when the server did not say where', () => {
    expect(foundLine(item({}), ['chai'])).toEqual({ label: 'Web · example.com', quote: null });
  });
});

describe('narrowing a search by source', () => {
  const from = (...platforms: Item['platform'][]) => platforms.map(platform => ({ platform }));
  it('offers each source with its exact count when every result is in hand', () => {
    expect(narrowBySource(from('tiktok', 'instagram', 'tiktok'), 3)).toEqual([
      { platform: 'tiktok', label: 'Only TikTok', count: 2 },
      { platform: 'instagram', label: 'Only Instagram', count: 1 },
    ]);
  });
  it('offers nothing when there are more results than are loaded, or only one source', () => {
    expect(narrowBySource(from('tiktok', 'instagram'), 40)).toEqual([]);
    expect(narrowBySource(from('tiktok', 'tiktok'), 2)).toEqual([]);
    expect(narrowBySource([], 0)).toEqual([]);
  });
});

describe('the line that says what search is looking at', () => {
  it('counts the library, then what was found in it', () => {
    expect(searchWhisper(1284, null)).toBe('search · 1,284 saves');
    expect(searchWhisper(1, null)).toBe('search · 1 save');
    expect(searchWhisper(1284, 4)).toBe('search · 4 of 1,284');
    expect(searchWhisper(1284, 0)).toBe('search · 0 of 1,284');
  });
});
