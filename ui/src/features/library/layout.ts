// Wall or list: how the saves are laid out. The wall is the library's face and stays the default; the list is
// one save to a line, for tidying. The choice is remembered in this browser, and the demo remembers nothing.
import { create } from 'zustand';

export type Layout = 'wall' | 'list';

export const LAYOUT_KEY = 'little-archive-layout';

export function storedLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'list' ? 'list' : 'wall';
  } catch {
    return 'wall';
  }
}

export const useLayout = create<{ layout: Layout; set(layout: Layout, remember: boolean): void }>(set => ({
  layout: storedLayout(),
  set(layout, remember) {
    set({ layout });
    if (remember) try { localStorage.setItem(LAYOUT_KEY, layout); } catch { /* Storage is optional for a layout. */ }
  },
}));
