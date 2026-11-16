// The searches made on this device, newest first. They are a convenience for this person and this browser:
// kept in local storage where the app is allowed to remember, in memory for the visit where it is not (the demo),
// and never sent anywhere. Storage can be missing or refuse writes, so every access is guarded.

export const RECENT_KEPT = 8;
export const RECENT_SHOWN = 3;
const KEY = 'la:search:recent';
const MAX_LENGTH = 200;

let memory: string[] = [];

function local(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** Reads what storage holds. Anything that is not a list of short strings is treated as nothing. */
export function parseRecent(text: string | null): string[] {
  if (!text) return [];
  let value: unknown;
  try { value = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const list: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const query = entry.trim().slice(0, MAX_LENGTH);
    const key = query.toLowerCase();
    if (!query || seen.has(key)) continue;
    seen.add(key);
    list.push(query);
  }
  return list.slice(0, RECENT_KEPT);
}

/** Puts a search at the front. The same words in other capitals are the same search. */
export function withRecent(list: readonly string[], query: string): string[] {
  const clean = query.trim().slice(0, MAX_LENGTH);
  if (!clean) return [...list];
  return [clean, ...list.filter(entry => entry.toLowerCase() !== clean.toLowerCase())].slice(0, RECENT_KEPT);
}

export function readRecent(remembers: boolean): string[] {
  if (!remembers) return memory;
  try { return parseRecent(local()?.getItem(KEY) ?? null); } catch { return memory; }
}

function writeRecent(remembers: boolean, list: string[]) {
  memory = list;
  if (!remembers) return;
  try {
    if (list.length) local()?.setItem(KEY, JSON.stringify(list));
    else local()?.removeItem(KEY);
  } catch { /* Not remembered past this visit; nothing depends on it. */ }
}

export function addRecent(remembers: boolean, query: string): string[] {
  const next = withRecent(readRecent(remembers), query);
  writeRecent(remembers, next);
  return next;
}

export function clearRecent(remembers: boolean): string[] {
  writeRecent(remembers, []);
  return [];
}
