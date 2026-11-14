// A shared clock for the parts of the screen that show time passing. One interval serves every timer face,
// it runs only while something is counting, and it takes a fresh reading the moment the tab comes back to
// the front: a background tab is throttled by the browser, so the clock never trusts ticks, only Date.now().
import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let now = 0;
let handle: ReturnType<typeof setInterval> | null = null;

function emit() {
  now = Date.now();
  for (const listener of listeners) listener();
}

function onVisible() {
  if (document.visibilityState === 'visible') emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    handle = setInterval(emit, 250);
    document.addEventListener('visibilitychange', onVisible);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      if (handle) clearInterval(handle);
      handle = null;
      document.removeEventListener('visibilitychange', onVisible);
    }
  };
}

const idle = () => () => {};

function snapshot() {
  // Not being listened to, the stored reading can be old; refresh it, but never twice within one render.
  if (!listeners.size && Date.now() - now > 500) now = Date.now();
  return now;
}

/** Takes a fresh reading now, so the render that follows an action starts from the right moment. */
export function tickNow() {
  now = Date.now();
}

/** The current time in milliseconds, updated four times a second while `active`, and not at all otherwise. */
export function useClock(active: boolean): number {
  return useSyncExternalStore(active ? subscribe : idle, snapshot);
}
