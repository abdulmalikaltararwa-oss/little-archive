import { afterEach, describe, expect, it } from 'vitest';
import { addRecent, clearRecent, parseRecent, readRecent, RECENT_KEPT, withRecent } from './recent';

afterEach(() => {
  clearRecent(true);
  clearRecent(false);
});

describe('recent searches', () => {
  it('puts the newest first and counts the same words in other capitals as one search', () => {
    expect(withRecent(['kyoto', 'machboos'], 'Desk lamp')).toEqual(['Desk lamp', 'kyoto', 'machboos']);
    expect(withRecent(['kyoto', 'machboos'], ' MACHBOOS ')).toEqual(['MACHBOOS', 'kyoto']);
  });
  it('ignores an empty search and keeps only so many', () => {
    expect(withRecent(['kyoto'], '   ')).toEqual(['kyoto']);
    const many = Array.from({ length: 20 }, (_, index) => `search ${index}`);
    expect(withRecent(many, 'new')).toHaveLength(RECENT_KEPT);
  });
  it('reads only a list of short strings from storage', () => {
    expect(parseRecent('["kyoto", 4, "", "Kyoto", {"q":"x"}, "machboos"]')).toEqual(['kyoto', 'machboos']);
    expect(parseRecent('{"kyoto":1}')).toEqual([]);
    expect(parseRecent('not json')).toEqual([]);
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent(JSON.stringify(['x'.repeat(500)]))[0]).toHaveLength(200);
  });
  it('is kept on the device where the app remembers', () => {
    addRecent(true, 'kyoto');
    addRecent(true, 'machboos');
    expect(readRecent(true)).toEqual(['machboos', 'kyoto']);
    expect(JSON.parse(localStorage.getItem('la:search:recent')!)).toEqual(['machboos', 'kyoto']);
    expect(clearRecent(true)).toEqual([]);
    expect(localStorage.getItem('la:search:recent')).toBeNull();
    expect(readRecent(true)).toEqual([]);
  });
  it('lasts only for the visit where the app does not remember (the demo)', () => {
    addRecent(false, 'kyoto');
    expect(readRecent(false)).toEqual(['kyoto']);
    expect(localStorage.getItem('la:search:recent')).toBeNull();
  });
});
