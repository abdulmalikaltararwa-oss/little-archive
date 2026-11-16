// What search offers before anything is typed, and how a result says where the words were found. Every
// suggestion is a finished search built from counts the library already holds (topics, collections, sources and
// the view totals); nothing here guesses at what a save is about.
import { hostLabel, PLATFORM_NAMES } from '@web/utils.js';
import type { Loc } from '@/data/location';
import type { Collection, Item, Platform, Stats, Tag } from '@/data/types';

export interface Suggestion {
  id: string;
  label: string;
  /** How many saves it leads to, when the library knows. */
  count?: number;
  icon: 'tag' | 'folder' | 'clock' | 'heart' | Platform;
  /** Where it goes. Fields left out are cleared. */
  to: Partial<Loc>;
}

const byCount = <T extends { count?: number; name: string }>(a: T, b: T) => (b.count ?? 0) - (a.count ?? 0) || a.name.localeCompare(b.name);

/**
 * The searches offered from the library itself: its two most used topics, its fullest collection, its largest source,
 * the favourites, and the saves marked to revisit with the oldest first. Anything with no saves behind it is left out.
 */
export function librarySuggestions({ stats, tags, collections }: { stats: Stats; tags: readonly Tag[]; collections: readonly Collection[] }): Suggestion[] {
  const list: Suggestion[] = [];
  for (const tag of [...tags].filter(tag => tag.count > 0).sort(byCount).slice(0, 2)) {
    list.push({ id: `tag-${tag.name}`, label: tag.name, count: tag.count, icon: 'tag', to: { tag: tag.name } });
  }
  const collection = collections.filter(entry => entry.kind === 'local' && (entry.count ?? 0) > 0).sort(byCount)[0];
  if (collection) list.push({ id: `collection-${collection.id}`, label: `In ${collection.name}`, count: collection.count, icon: 'folder', to: { view: `collection:${collection.id}` } });
  const source = (Object.entries(stats.platforms ?? {}) as [Platform, number][]).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (source) list.push({ id: `source-${source[0]}`, label: `From ${PLATFORM_NAMES[source[0]] ?? source[0]}`, count: source[1], icon: source[0], to: { view: `platform:${source[0]}` } });
  if (stats.favorites > 0) list.push({ id: 'favorites', label: 'Favorites', count: stats.favorites, icon: 'heart', to: { view: 'favorites' } });
  if (stats.to_revisit > 0) list.push({ id: 'revisit-oldest', label: 'To revisit, oldest first', icon: 'clock', to: { view: 'revisit', sort: 'oldest' } });
  return list;
}

/** For a search that found nothing: the most used topics, which do have saves. They are not guesses at what was meant. */
export function topTopics(tags: readonly Tag[], room = 2): Tag[] {
  return [...tags].filter(tag => tag.count > 0).sort(byCount).slice(0, room);
}

/* Where the words were found ---------------------------------------------------------------------------------------- */

/** The words of a search, as the server splits them: runs of letters and digits, lower case. */
export function queryWords(query: string): string[] {
  return [...new Set((query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []))];
}

export type Segment = { text: string; hit: boolean };

/**
 * Splits text around the places a searched word begins a word in it, which is how the server matches. The comparison is
 * literal (apart from capitals): where the server matched through its own folding of accents or Arabic letter forms and
 * the word is not there letter for letter, nothing is marked.
 */
export function markWords(text: string, words: readonly string[]): Segment[] {
  if (!text || !words.length) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  // Lowercasing can change a string's length in a few scripts; then positions would not line up, so nothing is marked.
  if (lower.length !== text.length) return [{ text, hit: false }];
  const hits: [number, number][] = [];
  const isWordChar = (char: string | undefined) => Boolean(char && /[\p{L}\p{N}_]/u.test(char));
  for (const word of [...words].sort((a, b) => b.length - a.length)) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(word, from);
      if (at < 0) break;
      from = at + word.length;
      if (isWordChar(lower[at - 1])) continue;
      if (hits.some(([start, end]) => at < end && at + word.length > start)) continue;
      hits.push([at, at + word.length]);
    }
  }
  if (!hits.length) return [{ text, hit: false }];
  hits.sort((a, b) => a[0] - b[0]);
  const segments: Segment[] = [];
  let cursor = 0;
  for (const [start, end] of hits) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), hit: false });
    segments.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });
  return segments;
}

const hasHit = (segments: readonly Segment[]) => segments.some(segment => segment.hit);

/** A short stretch of text around the first found word, cut at word edges, with … where it was cut. */
export function excerpt(text: string, words: readonly string[], room = 56): Segment[] | null {
  const flat = text.replace(/\s+/g, ' ').trim();
  const whole = markWords(flat, words);
  if (!hasHit(whole)) return null;
  if (flat.length <= room) return whole;
  const first = whole.findIndex(segment => segment.hit);
  const at = whole.slice(0, first).reduce((sum, segment) => sum + segment.text.length, 0);
  let start = Math.max(0, at - Math.floor(room / 3));
  if (start > 0) { const space = flat.indexOf(' ', start); start = space >= 0 && space < at ? space + 1 : at; }
  let end = Math.min(flat.length, start + room);
  if (end < flat.length) { const space = flat.lastIndexOf(' ', end); if (space > at) end = space; }
  const cut = markWords(flat.slice(start, end), words);
  if (start > 0) cut.unshift({ text: '…', hit: false });
  if (end < flat.length) cut.push({ text: '…', hit: false });
  return cut;
}

const FOUND: Record<string, string> = {
  caption: 'In the caption', notes: 'In your note', summary: 'In the summary', tags: 'In its topics', creator: 'In the creator’s name',
  transcript: 'In the transcript', alt_text: 'In the picture’s description',
};

export interface FoundLine {
  /** "In the caption", or the save's source when the words are in the title itself. */
  label: string;
  /** The stretch of text holding the word, when the interface has that text. */
  quote: Segment[] | null;
}

/** The save's source: where it is from and who made it. */
export function sourceLine(item: Pick<Item, 'platform' | 'creator' | 'url'>): string {
  const from = PLATFORM_NAMES[item.platform] ?? hostLabel(item.url);
  const creator = item.creator.trim();
  if (creator) return `${from} · ${creator}`;
  return item.platform === 'web' ? `${from} · ${hostLabel(item.url)}` : from;
}

/**
 * The line under a result. When the title itself holds the words (they are marked there), it is the save's source.
 * Otherwise it names the first place the server says it found them (`match_in`), and quotes that place only if the words
 * are literally in the text the interface holds; a transcript or a picture's description is named but never quoted.
 */
export function foundLine(item: Pick<Item, 'title' | 'caption' | 'notes' | 'summary' | 'tags' | 'creator' | 'platform' | 'url' | 'match_in'>, words: readonly string[]): FoundLine {
  const places = item.match_in ?? [];
  if (!places.length || places.includes('title') || hasHit(markWords(item.title, words))) return { label: sourceLine(item), quote: null };
  const texts: Record<string, string> = { caption: item.caption, notes: item.notes, summary: item.summary, tags: item.tags.join(', '), creator: item.creator };
  for (const place of places) {
    const label = FOUND[place];
    if (!label) continue;
    const text = texts[place];
    return { label, quote: text ? excerpt(text, words) : null };
  }
  return { label: sourceLine(item), quote: null };
}

/**
 * One-tap ways to narrow a search by source. Offered only when every result is in hand, so the counts are exact, and
 * only when the results come from more than one source.
 */
export function narrowBySource(items: readonly Pick<Item, 'platform'>[], total: number): { platform: Platform; label: string; count: number }[] {
  if (!items.length || total > items.length) return [];
  const counts = new Map<Platform, number>();
  for (const item of items) counts.set(item.platform, (counts.get(item.platform) ?? 0) + 1);
  if (counts.size < 2) return [];
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([platform, count]) => ({ platform, label: `Only ${PLATFORM_NAMES[platform] ?? platform}`, count }));
}

/** The line that says what is being looked at: the whole library, or how much of it a search found. */
export function searchWhisper(total: number, found: number | null): string {
  const all = total.toLocaleString('en');
  return found == null ? `search · ${all} ${total === 1 ? 'save' : 'saves'}` : `search · ${found.toLocaleString('en')} of ${all}`;
}
