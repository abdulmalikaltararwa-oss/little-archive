// Deleting a save from the list. The server cannot bring a deleted save back, so the delete is held: the row
// leaves at once, the island offers Undo, and the server is told only when that chance has passed (src/app/undo.ts).
import { useMemo } from 'react';
import { errorMessage, hostLabel } from '@web/utils.js';
import { create } from 'zustand';
import { useArchiveState } from '@/app/archive-context';
import { toast } from '@/app/ui-state';
import { holdWithUndo } from '@/app/undo';
import type { Archive } from '@/data/archive';
import { ApiError } from '@/data/client';
import type { Item } from '@/data/types';

/** Saves whose delete is being held. They are not drawn and not counted, wherever the list comes from meanwhile. */
export const useHeldDeletes = create<{ ids: ReadonlySet<string> }>(() => ({ ids: new Set<string>() }));

const hold = (id: string) => useHeldDeletes.setState(state => ({ ids: new Set(state.ids).add(id) }));
const release = (id: string) => useHeldDeletes.setState(state => { const ids = new Set(state.ids); ids.delete(id); return { ids }; });

const short = (text: string) => (text.length > 28 ? `${text.slice(0, 27).trimEnd()}…` : text);

export function deleteWithUndo(archive: Pick<Archive, 'api' | 'store' | 'refreshMetadata'>, item: Pick<Item, 'id' | 'title' | 'url'>) {
  const name = `“${short(item.title || hostLabel(item.url))}”`;
  hold(item.id);
  holdWithUndo(`Deleted ${name}`, {
    undo: () => release(item.id),
    commit: async () => {
      try {
        await archive.api.deleteItem(item.id);
      } catch (error) {
        release(item.id);
        // A sign-in that ran out is told on the sign-in screen.
        if (!(error instanceof ApiError && error.status === 401)) toast(`${name} was not deleted. ${errorMessage(error)}`, { error: true });
        return;
      }
      // It is gone from the server: take it out of the loaded saves before it is shown again.
      archive.store.setState(state => {
        if (!state.items.some(entry => entry.id === item.id)) return state;
        const selected = new Set(state.selected);
        selected.delete(item.id);
        return { items: state.items.filter(entry => entry.id !== item.id), total: Math.max(0, state.total - 1), selected, revision: state.revision + 1 };
      });
      release(item.id);
      await archive.refreshMetadata().catch(() => {});
    },
  });
}

/** The loaded saves without the ones whose delete is held, and how many of those there are. */
export function useShownItems(): { items: Item[]; held: number } {
  const all = useArchiveState(state => state.items);
  const ids = useHeldDeletes(state => state.ids);
  return useMemo(() => {
    if (!ids.size) return { items: all, held: 0 };
    const items = all.filter(item => !ids.has(item.id));
    return { items, held: all.length - items.length };
  }, [all, ids]);
}
