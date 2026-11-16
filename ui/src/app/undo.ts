// Undo for things the server cannot take back (a delete, an answer to a suggestion). The change is shown at once
// and the server is only told when the chance to undo has passed: after eight seconds, when the message is put
// away, when the next such change is made, or when the page is left. One change is held at a time.
import { toast, useIsland } from './ui-state';

export const UNDO_MS = 8_000;

interface Held {
  message: number;
  timer: ReturnType<typeof setTimeout>;
  commit(): unknown;
}

let held: Held | null = null;

function settle(entry: Held, commit: boolean) {
  if (held !== entry) return;
  held = null;
  clearTimeout(entry.timer);
  useIsland.getState().dismiss(entry.message);
  if (commit) void entry.commit();
}

/**
 * Says what was done, with Undo beside it. `undo` puts the interface back and nothing is sent; otherwise `commit`
 * runs once. `commit` reports its own failures: by then there is nobody waiting on this call.
 */
export function holdWithUndo(text: string, { commit, undo }: { commit(): unknown; undo(): void }) {
  flushHeld();
  const entry: Held = { message: 0, commit, timer: setTimeout(() => settle(entry, true), UNDO_MS) };
  held = entry;
  // The island keeps the message a little longer than the wait, so it is this timer that ends it, not the island's.
  entry.message = toast(text, { duration: UNDO_MS + 2_000, action: { label: 'Undo', run: () => { if (held === entry) { settle(entry, false); undo(); } } } });
}

/** Sends the held change now, if there is one. */
export function flushHeld() {
  if (held) settle(held, true);
}

/** Whether a change is waiting to be sent. */
export const hasHeld = () => held !== null;

// A message put away by hand (its own close button) is the chance to undo given up: the change is sent.
useIsland.subscribe(state => {
  const entry = held;
  if (entry && entry.message && !state.messages.some(message => message.id === entry.message)) settle(entry, true);
});

if (typeof addEventListener === 'function') addEventListener('pagehide', flushHeld);
