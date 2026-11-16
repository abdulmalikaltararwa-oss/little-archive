import { stableHue } from '@web/utils.js';
import type { Item } from '@/data/types';

// Six papers. Each pairs a pale ground with an ink that passes AA on it (checked in tokens.test.ts).
export const PAPERS = [
  'bg-sage-pale text-sage dark:text-sage-deep',
  'bg-petal-pale text-petal-ink',
  'bg-butter-pale text-butter-ink',
  'bg-sky-pale text-sky-ink',
  'bg-clay-pale text-clay-ink',
  'bg-lilac-pale text-lilac-ink',
];

/** The paper a save is set on when it has no picture: always the same one for the same save. */
export function paperOf(item: Pick<Item, 'id' | 'title'>): string {
  return PAPERS[stableHue(item.title || item.id)]!;
}
