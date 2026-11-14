// The shared-element move between a card's cover and the detail's cover, done by the browser's View
// Transitions API: no measuring, no clones, and where it is missing (or motion is reduced) the change simply
// happens. Exactly one element may carry the name at a time, so the card that is the origin is recorded here.
import { flushSync } from 'react-dom';
import { create } from 'zustand';

export const COVER_TRANSITION = 'save-cover';

export const useMorph = create<{ coverId: string; active: boolean }>(() => ({ coverId: '', active: false }));

export function canMorph(): boolean {
  return typeof document !== 'undefined' && typeof document.startViewTransition === 'function' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Runs a state change inside a view transition. `coverId` names the save whose card is the other end of the move. */
export function morph(apply: () => void, coverId: string) {
  if (!canMorph()) { apply(); return; }
  flushSync(() => useMorph.setState({ coverId, active: true }));
  try {
    const transition = document.startViewTransition(() => { flushSync(apply); });
    const done = () => useMorph.setState({ active: false });
    // A newer transition replaces this one; that is not an error worth reporting.
    transition.ready.catch(() => {});
    transition.updateCallbackDone.catch(() => {});
    transition.finished.then(done, done);
  } catch {
    useMorph.setState({ active: false });
    apply();
  }
}
