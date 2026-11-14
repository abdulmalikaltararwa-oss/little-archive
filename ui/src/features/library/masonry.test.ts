import { describe, expect, it } from 'vitest';
import { cardHeight, columnsFor, coverRatio, layoutWall, windowRange } from './masonry';

const TYPES = ['video', 'image', 'post', 'article', 'link'] as const;
const saves = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `save-${index}`, content_type: TYPES[index % TYPES.length]! }));

describe('the wall', () => {
  it('never drops below two columns, and adds columns with width', () => {
    expect(columnsFor(320).columns).toBe(2);
    expect(columnsFor(358)).toMatchObject({ columns: 2, compact: true });
    expect(columnsFor(800).columns).toBeGreaterThan(2);
    expect(columnsFor(1400).columns).toBeGreaterThan(columnsFor(800).columns);
  });

  it('gives a save the same shape every time, from its data alone', () => {
    const save = { id: 'abc', content_type: 'video' as const };
    expect(coverRatio(save)).toBe(coverRatio({ ...save }));
    expect(cardHeight(save, 200, false)).toBe(cardHeight(save, 200, false));
    expect(cardHeight(save, 200, true)).toBeLessThan(cardHeight(save, 200, false));
    expect(coverRatio({ id: 'abc', content_type: 'something-new' as never })).toBeGreaterThan(0);
  });

  it('places every card inside the width without overlapping its column neighbours', () => {
    const wall = layoutWall(saves(200), 1100);
    expect(wall.tiles).toHaveLength(200);
    for (const tile of wall.tiles) {
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.x + tile.width).toBeLessThanOrEqual(1100 + 1);
    }
    const byColumn = new Map<number, typeof wall.tiles>();
    for (const tile of wall.tiles) byColumn.set(tile.x, [...(byColumn.get(tile.x) ?? []), tile]);
    expect(byColumn.size).toBe(wall.columns);
    for (const column of byColumn.values()) {
      for (let index = 1; index < column.length; index++) expect(column[index]!.y).toBeGreaterThanOrEqual(column[index - 1]!.y + column[index - 1]!.height + wall.gap - 0.01);
    }
    expect(wall.height).toBe(Math.max(...wall.tiles.map(tile => tile.y + tile.height)));
  });

  it('keeps reading order: a later card never starts above an earlier card by more than one card', () => {
    const wall = layoutWall(saves(500), 1300);
    const tallest = Math.max(...wall.tiles.map(tile => tile.height));
    for (let index = 1; index < wall.tiles.length; index++) expect(wall.tiles[index]!.y).toBeGreaterThanOrEqual(wall.tiles[index - 1]!.y - tallest);
  });

  it('is empty without saves or without width', () => {
    expect(layoutWall([], 800)).toMatchObject({ tiles: [], height: 0 });
    expect(layoutWall(saves(3), 0).tiles).toHaveLength(3);
  });

  it('renders a window of a 5,000-save wall, not the wall', () => {
    const wall = layoutWall(saves(5000), 1300);
    const [first, last] = windowRange(wall.tiles, 40_000, 41_800);
    expect(first).toBeGreaterThan(0);
    expect(last - first).toBeLessThan(120);
    for (let index = first; index <= last; index++) {
      const tile = wall.tiles[index]!;
      // Everything outside the run is fully outside the band.
      expect(tile.y).toBeLessThan(41_800 + 2_000);
    }
    const outside = wall.tiles.filter((tile, index) => (index < first || index > last) && tile.y + tile.height >= 40_000 && tile.y <= 41_800);
    expect(outside).toHaveLength(0);
    expect(windowRange(wall.tiles, -5000, -4000)).toEqual([0, -1]);
  });

  it('lays out 5,000 saves quickly enough to do on every resize', () => {
    const many = saves(5000);
    const started = performance.now();
    layoutWall(many, 1300);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
