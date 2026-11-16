// The save that was just made, while its tray is on screen. One at a time: a newer save replaces it.
import { create } from 'zustand';
import type { Item } from '@/data/types';
import { alreadyKept } from './words';

export interface SaveMoment {
  id: number;
  item: Item;
  /** The link was in the library before; no second copy was made. */
  already: boolean;
  /** The save form held something besides the link. */
  carried: boolean;
}

interface SaveMomentState {
  moment: SaveMoment | null;
  show(item: Item, options?: { carried?: boolean }): void;
  close(): void;
}

let seq = 0;

export const useSaveMoment = create<SaveMomentState>(set => ({
  moment: null,
  show: (item, { carried = false } = {}) => set({ moment: { id: ++seq, item, already: alreadyKept(item), carried } }),
  close: () => set({ moment: null }),
}));

export const SAVE_TRAY_ID = 'save-tray';

/** Shows the tray for a save the server just answered with. */
export const showSaveMoment = (item: Item, options?: { carried?: boolean }) => useSaveMoment.getState().show(item, options);
