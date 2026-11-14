import { describe, expect, it } from 'vitest';
import { readStoredTiles, TILE_STORAGE_KEY, writeStoredTiles } from './tile-store';

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

const MINE = { mode: 'custom', url: 'https://tiles.example.org/{z}/{x}/{y}.png', attribution: 'Example' } as const;

describe('tile storage', () => {
  it('keeps the choice under the agreed key and reads it back', () => {
    const store = memory();
    expect(TILE_STORAGE_KEY).toBe('little-archive-map-tiles');
    expect(writeStoredTiles(MINE, store)).toBe(true);
    expect(store.data.has('little-archive-map-tiles')).toBe(true);
    expect(readStoredTiles(store)).toEqual(MINE);
  });

  it('forgets the choice with null, which hands control back to the operator’s default', () => {
    const store = memory();
    writeStoredTiles({ mode: 'off' }, store);
    expect(readStoredTiles(store)).toEqual({ mode: 'off' });
    expect(writeStoredTiles(null, store)).toBe(true);
    expect(readStoredTiles(store)).toBeNull();
  });

  it('reads garbage as no setting', () => {
    expect(readStoredTiles(memory({ [TILE_STORAGE_KEY]: 'https://evil.example' }))).toBeNull();
  });

  it('works with no storage at all, and with storage that throws', () => {
    expect(readStoredTiles(null)).toBeNull();
    expect(writeStoredTiles(MINE, null)).toBe(false);
    const broken = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    expect(readStoredTiles(broken)).toBeNull();
    expect(writeStoredTiles(MINE, broken)).toBe(false);
    expect(writeStoredTiles(null, broken)).toBe(false);
  });
});
