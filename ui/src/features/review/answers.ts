// The answers given in the review queue. Kept outside the screen: an answer is sent a few seconds after it is
// given (it can be undone until then), and by that time the screen may have been left.
import { errorMessage, hostLabel } from '@web/utils.js';
import { create } from 'zustand';
import { toast } from '@/app/ui-state';
import { holdWithUndo } from '@/app/undo';
import type { Archive } from '@/data/archive';
import { ApiError } from '@/data/client';
import type { Item } from '@/data/types';
import { answerWords, pendingSuggestion } from './queue';

export type Answer = 'accept' | 'keep';

interface ReviewState {
  accepted: number;
  kept: number;
  /** Saves that have been answered: held for Undo, or being sent. They are out of the queue. */
  gone: ReadonlySet<string>;
  /** Saves left for later in this visit. */
  later: ReadonlySet<string>;
  /** The answer the server refused. The save is back in the queue, unchanged. */
  failure: { id: string; title: string; kind: Answer; message: string } | null;
  /** Whether the queue is on screen, so a refusal that arrives after it was left is still said somewhere. */
  shown: boolean;
}

export const useReview = create<ReviewState>(() => ({ accepted: 0, kept: 0, gone: new Set<string>(), later: new Set<string>(), failure: null, shown: false }));

const without = (set: ReadonlySet<string>, id: string) => { const next = new Set(set); next.delete(id); return next; };
const count = (kind: Answer, by: 1 | -1) => (state: ReviewState) => (kind === 'accept' ? { accepted: Math.max(0, state.accepted + by) } : { kept: Math.max(0, state.kept + by) });

/** Gives one answer for one save. Counted as accepted only when there was a suggestion to accept. */
export function answer(archive: Pick<Archive, 'api' | 'refreshEditedItem'>, item: Item, kind: Answer) {
  const ai = pendingSuggestion(item);
  const tallied: Answer = ai ? kind : 'keep';
  const title = item.title || hostLabel(item.url);
  useReview.setState(state => ({ ...count(tallied, 1)(state), gone: new Set(state.gone).add(item.id), later: without(state.later, item.id), failure: null }));
  holdWithUndo(answerWords(kind, ai), {
    undo: () => useReview.setState(state => ({ ...count(tallied, -1)(state), gone: without(state.gone, item.id) })),
    commit: async () => {
      let updated: Item;
      try {
        updated = !ai ? await archive.api.patchItem(item.id, { needs_review: false }) : kind === 'accept' ? await archive.api.acceptAi(item.id) : await archive.api.dismissAi(item.id);
      } catch (error) {
        // A sign-in that ran out is told on the sign-in screen.
        if (error instanceof ApiError && error.status === 401) return;
        const message = errorMessage(error);
        useReview.setState(state => ({ ...count(tallied, -1)(state), gone: without(state.gone, item.id), failure: { id: item.id, title, kind, message } }));
        if (!useReview.getState().shown) toast(`“${title}” was not saved and is still in Needs review. ${message}`, { error: true });
        return;
      }
      // The answer is saved. If the list cannot be brought up to date just now, the save stays out of the queue all
      // the same: it is never offered again as if it had not been answered.
      try {
        await archive.refreshEditedItem(updated);
        useReview.setState(state => ({ gone: without(state.gone, item.id) }));
      } catch { /* The next load of the view drops it. */ }
    },
  });
}
