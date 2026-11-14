// Light, dark, or whatever the device prefers. Both themes are first-class: every token has a value in each.
// The choice is remembered in this browser under the same key the buildless interface uses, so switching
// interfaces does not forget it. The demo remembers nothing.
import { create } from 'zustand';

export type Theme = 'light' | 'dark' | 'system';

export const THEME_KEY = 'little-archive-theme';
const THEMES: readonly Theme[] = ['light', 'dark', 'system'];

export function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return THEMES.includes(value as Theme) ? (value as Theme) : 'system';
  } catch {
    return 'system';
  }
}

export function resolveTheme(theme: Theme): 'light' | 'dark' {
  return theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}

function paint(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(theme);
  // The browser's own chrome (and an installed app's title bar) follows the page's paper.
  const paper = getComputedStyle(root).getPropertyValue('--paper').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', paper || (root.dataset.theme === 'dark' ? '#1a211d' : '#f8f3ea'));
}

interface ThemeState {
  theme: Theme;
  remember: boolean;
  init(remember: boolean): void;
  set(theme: Theme): void;
}

export const useTheme = create<ThemeState>((set, get) => ({
  theme: 'system',
  remember: true,
  init(remember) {
    const theme = remember ? storedTheme() : 'system';
    set({ theme, remember });
    paint(theme);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (get().theme === 'system') paint('system'); });
  },
  set(theme) {
    set({ theme });
    paint(theme);
    if (get().remember) try { localStorage.setItem(THEME_KEY, theme); } catch { /* Storage is optional for appearance. */ }
  },
}));
