// The tile choice as the screen sees it: what is in use (the owner's choice, else the operator's build-time
// default, else nothing) and how to change it. The choice is kept in this browser only where the backend allows
// it; in the demo it lasts until the page is left.
import { useCallback, useMemo, useState } from 'react';
import { useArchive } from '@/app/archive-context';
import { buildDefaultEnv, operatorDefault, readStoredTiles, writeStoredTiles } from './tile-store';
import { resolveTiles, type StoredTiles, type TileConfig } from './tiles';

export interface TileSettings {
  /** The tiles in use, or null when the map is a plain sheet. */
  config: TileConfig | null;
  /** What the owner chose, if anything. */
  stored: StoredTiles | null;
  /** The operator's build-time default, if they set a usable one. */
  operator: TileConfig | null;
  /** True where a choice outlives the page. */
  remembers: boolean;
  /** Keeps a choice, or forgets it with null (the operator's default takes over again). */
  save(next: StoredTiles | null): void;
}

export function useTileSettings(): TileSettings {
  const archive = useArchive();
  const remembers = archive.backend.remembers;
  const [stored, setStored] = useState<StoredTiles | null>(() => (remembers ? readStoredTiles() : null));
  const config = useMemo(() => resolveTiles(stored, buildDefaultEnv()), [stored]);
  const operator = useMemo(() => operatorDefault(), []);
  const save = useCallback((next: StoredTiles | null) => {
    setStored(next);
    if (remembers) writeStoredTiles(next);
  }, [remembers]);
  return { config, stored, operator, remembers, save };
}
