// What the recipe screens remember between pages. All of it is a convenience for this tab and this person:
// the scale chosen on a card (so cook mode opens at the same number of servings), and the state of a cook
// session (the step, the ticked ingredients and the timers, which are timestamps and so survive a reload).
// Storage can be missing or refuse writes (a private window, blocked site data), so every access is guarded
// and every screen works without it. Nothing here is sent anywhere.
import type { Scale } from './api';
import { parseTimerState, type TimerState } from './timers';

function session(): Storage | null {
  try { return globalThis.sessionStorage ?? null; } catch { return null; }
}

function local(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/* Scale ------------------------------------------------------------------------------------------------------- */

export function formatScale(scale: Scale): string {
  return `${scale.kind === 'servings' ? 's' : 'f'}:${scale.value}`;
}

export function parseScale(text: string | null): Scale | null {
  const match = /^([sf]):(\d+(?:\.\d+)?)$/.exec(text ?? '');
  if (!match) return null;
  const value = Number(match[2]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return { kind: match[1] === 's' ? 'servings' : 'factor', value };
}

const scaleKey = (id: string) => `la:recipes:scale:${id}`;

export function readScale(id: string): Scale | null {
  try { return parseScale(session()?.getItem(scaleKey(id)) ?? null); } catch { return null; }
}

export function writeScale(id: string, scale: Scale) {
  try { session()?.setItem(scaleKey(id), formatScale(scale)); } catch { /* Not remembered; nothing depends on it. */ }
}

/* Cook session ------------------------------------------------------------------------------------------------ */

export interface CookSession {
  /** Says which version of the recipe this belongs to; a session for another version is forgotten. */
  stamp: string;
  step: number;
  /** Indexes of ingredients that have been ticked off. */
  checked: number[];
  /** Timers by step index. */
  timers: Record<number, TimerState>;
}

export const EMPTY_SESSION = (stamp: string): CookSession => ({ stamp, step: 0, checked: [], timers: {} });

const sessionKey = (id: string) => `la:recipes:cook:${id}`;

export function parseSession(text: string | null, stamp: string): CookSession | null {
  if (!text) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  if (entry.stamp !== stamp) return null;
  const whole = (field: unknown): field is number => typeof field === 'number' && Number.isInteger(field) && field >= 0 && field < 1000;
  if (!whole(entry.step)) return null;
  const checked = Array.isArray(entry.checked) ? entry.checked.filter(whole) : [];
  const timers: Record<number, TimerState> = {};
  if (entry.timers && typeof entry.timers === 'object') {
    for (const [key, raw] of Object.entries(entry.timers as Record<string, unknown>)) {
      const index = Number(key);
      const timer = parseTimerState(raw);
      if (whole(index) && timer) timers[index] = timer;
    }
  }
  return { stamp, step: entry.step, checked, timers };
}

export function readSession(id: string, stamp: string): CookSession | null {
  try { return parseSession(session()?.getItem(sessionKey(id)) ?? null, stamp); } catch { return null; }
}

export function writeSession(id: string, value: CookSession) {
  try { session()?.setItem(sessionKey(id), JSON.stringify(value)); } catch { /* Not remembered; the cook session still works. */ }
}

export function clearSession(id: string) {
  try { session()?.removeItem(sessionKey(id)); } catch { /* Nothing to forget. */ }
}

/* Alarm sound ------------------------------------------------------------------------------------------------- */

const SOUND_KEY = 'la:recipes:alarm-sound';

/** Whether a finished timer may make a sound. On unless the person turned it off. */
export function readSound(): boolean {
  try { return local()?.getItem(SOUND_KEY) !== 'off'; } catch { return true; }
}

export function writeSound(on: boolean) {
  try { local()?.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch { /* The choice lasts until the page is closed. */ }
}

/* How cook mode was reached ----------------------------------------------------------------------------------- */

// Cook mode is its own address (#/recipes/<id>/cook). When it was opened from the card, leaving it is the
// browser's Back, which lands on the card without stacking a second copy. Opened any other way (a reload, a
// shared address) there is nothing to go back to, so the card replaces it.
let cookedFromCard = false;

export function markCookFromCard() {
  cookedFromCard = true;
}

/** How to leave cook mode for the card. Asking once also forgets the answer. */
export function leaveCookToCard(): 'back' | 'replace' {
  const back = cookedFromCard;
  cookedFromCard = false;
  return back ? 'back' : 'replace';
}
