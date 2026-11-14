// Where the owner's tile choice is kept: this browser's local storage, and only where the backend says
// preferences may outlive the page (the demo's does not). Storage can be missing or refuse to answer (a
// private window, blocked site data), and the screen must work without it, so every call is guarded and a
// failure just means "no saved choice".
import { operatorTiles, parseStoredTiles, serializeStoredTiles, type StoredTiles, type TileConfig } from './tiles';

export const TILE_STORAGE_KEY = 'little-archive-map-tiles';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStore(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readStoredTiles(store: Store | null = defaultStore()): StoredTiles | null {
  try {
    return parseStoredTiles(store?.getItem(TILE_STORAGE_KEY) ?? null);
  } catch {
    return null;
  }
}

/** Saves the choice, or forgets it with `null` (which puts the operator's default back in charge). Returns whether it was kept. */
export function writeStoredTiles(value: StoredTiles | null, store: Store | null = defaultStore()): boolean {
  try {
    if (!store) return false;
    if (value) store.setItem(TILE_STORAGE_KEY, serializeStoredTiles(value));
    else store.removeItem(TILE_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/** The build-time default (`VITE_LA_TILE_URL`, `VITE_LA_TILE_ATTRIBUTION`). Empty unless the operator set them. */
export function buildDefaultEnv(): { url: string; attribution: string } {
  return { url: String(import.meta.env.VITE_LA_TILE_URL ?? ''), attribution: String(import.meta.env.VITE_LA_TILE_ATTRIBUTION ?? '') };
}

export const operatorDefault = (): TileConfig | null => operatorTiles(buildDefaultEnv());
