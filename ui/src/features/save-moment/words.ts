// What the tray says and offers right after a link is saved. Everything here is worked out from what the
// server sent back; nothing is guessed.
import { hostLabel, PLATFORM_NAMES } from '@web/utils.js';
import type { Collection, Item, Status } from '@/data/types';

/** How long an untouched tray stays. */
export const TRAY_MS = 5_000;

/**
 * Whether the link was already in the library. The server keeps one save per link: saving it again answers with the
 * first save and makes no second copy. A save that was just made carries one timestamp in `created_at` and
 * `last_seen_at`; one that was there before has just had `last_seen_at` moved to now. The server's timestamps are whole
 * seconds, so a link saved twice within the same second reads as new (there is still only one copy).
 */
export function alreadyKept(item: Pick<Item, 'created_at' | 'last_seen_at'>): boolean {
  return Boolean(item.created_at && item.last_seen_at && item.created_at !== item.last_seen_at);
}

/** The line under the headline: the save's own name and where it came from. */
export function savedLine(item: Pick<Item, 'title' | 'url' | 'platform'>): string {
  return `${item.title || hostLabel(item.url)} · ${PLATFORM_NAMES[item.platform] ?? hostLabel(item.url)}`;
}

/**
 * The collections offered as one-tap chips. Only the person's own (local) collections can be filed into. The ones the
 * save is already in come first, so a choice made in the save form shows as chosen; the rest of the room goes to the
 * collections with the most saves, the fullest first. With no collections there are no chips.
 */
export function suggestCollections(collections: readonly Collection[], item: Pick<Item, 'collections'>, room = 2): Collection[] {
  const locals = collections.filter(collection => collection.kind === 'local');
  const inIds = new Set(item.collections.map(collection => collection.id));
  const chosen = locals.filter(collection => inIds.has(collection.id)).slice(0, 3);
  const rest = locals
    .filter(collection => !inIds.has(collection.id))
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.name.localeCompare(b.name));
  return [...chosen, ...rest.slice(0, Math.max(0, room - chosen.length))];
}

/** The ids of the local collections a save is in: what `collection_ids` edits. */
export function localIds(item: Pick<Item, 'collections'>): string[] {
  return item.collections.filter(collection => collection.kind === 'local').map(collection => collection.id);
}

/**
 * When and where the first copy is. The date is the one the source gave for the save, or failing that the day it reached
 * this library. `carried` says the form held a title, notes, topics or collections, which the server puts on the first
 * save (a title and notes replace its own, topics are added, ticked collections become its collections); so the line
 * never claims that nothing changed when something did.
 */
export function alreadyLine(item: Pick<Item, 'saved_at' | 'created_at' | 'collections'>, carried: boolean): string {
  const time = Date.parse(item.saved_at || item.created_at);
  const when = Number.isNaN(time) ? '' : new Date(time).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', ...(new Date(time).getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) });
  const names = item.collections.map(collection => collection.name);
  const where = names.length === 0 ? '' : names.length === 1 ? `in ${names[0]}` : `in ${names[0]} and ${names.length - 1} more`;
  const first = when ? `Saved on ${when}${where ? `, ${where}` : ''}.` : where ? `It is ${where}.` : '';
  const second = carried ? 'No second copy was made; the first one was updated with what you entered.' : 'No second copy was made.';
  return first ? `${first} ${second}` : second;
}

/** One change made from the tray, with what it takes to put it back. */
export interface TrayChange {
  headline: string;
  undo: { collection_ids: string[] } | { status: Status };
}

export const filedHeadline = (name: string, on: boolean) => (on ? `Filed in ${name}.` : `Taken out of ${name}.`);
export const revisitHeadline = (on: boolean) => (on ? 'Marked to revisit.' : 'No longer marked to revisit.');
