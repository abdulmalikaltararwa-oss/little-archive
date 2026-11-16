// The gallery's layout, as arithmetic. Every card's height is known from its data before anything is
// drawn (a fixed text block under a cover whose shape depends on the kind of save), so the whole wall can be
// positioned without measuring the page: no layout shift, and only the cards near the screen are rendered.
import { stableHue } from '@web/utils.js';
import type { Item } from '@/data/types';

export interface Tile {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Wall {
  tiles: Tile[];
  height: number;
  columns: number;
  columnWidth: number;
  gap: number;
  compact: boolean;
}

/** How many columns fit, and the gap between them. Two columns is the floor: a phone shows a wall, not a list. */
export function columnsFor(width: number): { columns: number; gap: number; compact: boolean } {
  const compact = width < 560;
  const gap = compact ? 12 : width < 1100 ? 18 : 22;
  const ideal = compact ? 164 : width < 1100 ? 204 : width < 1700 ? 228 : 252;
  return { columns: Math.max(2, Math.floor((width + gap) / (ideal + gap))), gap, compact };
}

// Cover shapes (height over width). A video stands tall, an article lies wide, a picture is nearly square.
const SHAPES: Record<string, readonly number[]> = {
  video: [1.28, 1.2, 1.28],
  image: [1, 1.18, 0.88],
  post: [1, 1.14, 1],
  article: [0.74, 0.82, 0.9],
  link: [0.76, 0.84, 1],
};

export function coverRatio(item: Pick<Item, 'id' | 'content_type'>): number {
  const shapes = SHAPES[item.content_type] ?? SHAPES.link!;
  return shapes[stableHue(item.id) % shapes.length]!;
}

export const CARD_PADDING = 6;
export const BODY_HEIGHT = { compact: 92, regular: 124 };

export function cardHeight(item: Pick<Item, 'id' | 'content_type'>, columnWidth: number, compact: boolean): number {
  const cover = Math.round((columnWidth - CARD_PADDING * 2) * coverRatio(item));
  return CARD_PADDING * 2 + cover + (compact ? BODY_HEIGHT.compact : BODY_HEIGHT.regular);
}

/** Shortest-column-first masonry. Reading order is kept: a later card is never placed above an earlier one's top. */
export function layoutWall(items: readonly Pick<Item, 'id' | 'content_type'>[], width: number): Wall {
  const { columns, gap, compact } = columnsFor(width);
  const columnWidth = Math.max(0, (width - gap * (columns - 1)) / columns);
  const heights = new Array<number>(columns).fill(0);
  const tiles: Tile[] = [];
  for (const item of items) {
    let column = 0;
    for (let index = 1; index < columns; index++) if (heights[index]! < heights[column]! - 0.5) column = index;
    const height = cardHeight(item, columnWidth, compact);
    tiles.push({ x: Math.round(column * (columnWidth + gap)), y: heights[column]!, width: Math.round(columnWidth), height });
    heights[column] = heights[column]! + height + gap;
  }
  return { tiles, height: Math.max(0, Math.max(...heights) - gap), columns, columnWidth, gap, compact };
}

/**
 * The first and last card that touch the band [top, bottom]. Everything between them is rendered: in a
 * shortest-column wall a card's top never precedes an earlier card's by more than one card, so the run is tight.
 */
export function windowRange(tiles: readonly Tile[], top: number, bottom: number): [number, number] {
  let first = -1;
  let last = -1;
  for (let index = 0; index < tiles.length; index++) {
    const tile = tiles[index]!;
    if (tile.y + tile.height < top || tile.y > bottom) continue;
    if (first < 0) first = index;
    last = index;
  }
  return first < 0 ? [0, -1] : [first, last];
}

export const ROW_HEIGHT = 64;

/** The list: one save to a line, each line the same height. The same shape as the wall, so the same window draws it. */
export function layoutList(items: readonly unknown[], width: number): Wall {
  const tiles = items.map((_, index) => ({ x: 0, y: index * ROW_HEIGHT, width: Math.round(width), height: ROW_HEIGHT }));
  return { tiles, height: items.length * ROW_HEIGHT, columns: 1, columnWidth: width, gap: 0, compact: width < 560 };
}
