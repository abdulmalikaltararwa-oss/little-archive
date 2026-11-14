// What the two maps (tiled and paper) are given and tell back. Types only, so the screen can name them without
// importing the map library.
import type { PlaceKind } from './api';
import type { Bounds } from './geo';

/** A place that has coordinates, reduced to what a map draws. */
export interface MapPoint {
  id: string;
  lat: number;
  lon: number;
  name: string;
  kind: PlaceKind;
  /** `area` is drawn as a flower in a dashed ring: the position is the middle of a larger place. */
  precision: 'point' | 'area';
}

/** How the tile server is answering. `unavailable` means the map library itself could not be loaded. */
export type TileStatus = 'loading' | 'ok' | 'partial' | 'failed' | 'unavailable';

/** Set when the list (not the map) chose a place, so the map goes to it. The nonce makes choosing the same place twice count. */
export interface MapFocus {
  id: string;
  nonce: number;
}

export interface TiledMapProps {
  points: readonly MapPoint[];
  selectedId: string;
  /** Changes when the list was replaced by a different query, so the map frames the new places. */
  fitKey: string;
  focus: MapFocus | null;
  tileUrl: string;
  onSelect(id: string): void;
  onView(bounds: Bounds): void;
  onStatus(status: TileStatus): void;
}
