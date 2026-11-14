// Every call the places feature makes, typed against API_CONTRACT.md ("Recipes, places, ask and guided import" →
// Places). Nothing here is invented: a field the contract does not name is not typed. The calls go through the
// data layer's `request`, so they reach the right backend and carry the CSRF token or bearer token.
import type { Api } from '@/data/api';
import { bboxParam, type Bounds } from './geo';

export const PLACE_KINDS = [
  'restaurant', 'cafe', 'bar', 'bakery', 'hotel', 'attraction', 'landmark', 'museum', 'park', 'beach', 'shop', 'market', 'venue', 'neighborhood', 'city', 'region', 'country', 'other',
] as const;

export type PlaceKind = (typeof PLACE_KINDS)[number];

export type CoordinateSource = 'source' | 'geocoder' | 'user';

export interface Coordinates {
  lat: number;
  lon: number;
  /** Where they came from: the save states them, the operator's geocoder returned them, or the owner typed them. */
  source: CoordinateSource;
  /** `jsonld`, `maps_link`, `text_coordinates`, `nominatim` or `owner`. */
  detail: string;
  provider: string;
  /** `area` is the middle of a district or city, not a spot. */
  precision: 'point' | 'area';
  display_name?: string;
  attribution?: string;
}

export interface PlaceEvidence {
  /** The field of the save the words came from: `caption`, `title`, `notes`, `page`, `jsonld`, `transcript`, `user`… */
  source: string;
  quote: string;
}

/** What a model-found place rests on. The same labels as any suggestion. */
export interface PlaceProvenance {
  evidence_level?: string;
  evidence_sources?: string[];
  evidence_note?: string;
  provider?: string;
  model?: string;
}

export interface Place {
  id: string;
  name: string;
  kind: PlaceKind;
  city: string | null;
  region: string | null;
  country: string | null;
  address: string | null;
  note: string | null;
  coordinates: Coordinates | null;
  evidence: PlaceEvidence;
  origin: 'jsonld' | 'rules' | 'ai' | 'user';
  provenance?: PlaceProvenance;
}

/** A place in the library-wide list, with the save it came from. */
export interface PlaceRow extends Place {
  item_id: string;
  item_title: string;
  url: string;
  thumbnail_url: string | null;
}

export interface PlacesPage {
  places: PlaceRow[];
  total: number;
  limit: number;
  offset: number;
  bbox: number[] | null;
}

export interface GeocodingCapability {
  enabled: boolean;
  attribution: string | null;
}

export interface ItemPlaces {
  item_id: string;
  status: 'none' | 'extracted' | 'edited';
  edited: boolean;
  places: Place[];
  extracted: Place[] | null;
  extraction: { method: string; at: string } | null;
  edited_at: string | null;
  available: { jsonld: boolean; rules: boolean; ai: boolean; geocoding: GeocodingCapability };
}

export interface ExtractionResult {
  found: boolean;
  tried: string[];
  ai_available: boolean;
  /** Coordinates written in the text that were not on the same line as a place, so were not attached to any. */
  unattached_coordinates: number;
  /** What the checks on a model's answer threw away. Null when no model was asked. */
  ai: { dropped: number; unstated_fields_cleared: number } | null;
  reason?: string;
}

export interface GeocodingResult {
  requested: boolean;
  enabled: boolean;
  resolved: number;
  not_found: number;
  skipped: number;
  reason?: 'geocoder_not_configured';
  error?: { message: string; retryable: boolean };
}

export interface ExtractedPlaces extends ItemPlaces {
  /** Absent when `unchanged` is true: the server answers with the stored view and nothing was run. */
  extraction_result?: ExtractionResult;
  /** True when the same text was already read, so nothing was run again. */
  unchanged?: boolean;
  geocoding?: GeocodingResult;
}

export interface GeocodedPlaces extends ItemPlaces {
  geocoding: GeocodingResult;
}

export interface ExtractBody {
  method?: 'auto' | 'jsonld' | 'rules' | 'ai';
  geocode?: boolean;
  force?: boolean;
}

/** What a PUT accepts for one place. The read-only fields a GET returned (evidence, origin, provenance, how coordinates were found) are left out. */
export interface PlaceInput {
  id?: string;
  name: string;
  kind?: PlaceKind;
  city?: string;
  region?: string;
  country?: string;
  address?: string;
  note?: string;
  coordinates?: { lat: number; lon: number };
}

export interface PlacesQuery {
  bbox?: Bounds | null;
  kind?: PlaceKind | '';
  q?: string;
  /** Only `true` is sent: the contract's `false` means "only places without coordinates", which this interface never asks for. */
  withCoordinates?: boolean;
  limit?: number;
  offset?: number;
}

/** The query string for GET /api/places, with only what was asked for in it. */
export function placesQueryString(query: PlacesQuery): string {
  const params = new URLSearchParams();
  if (query.bbox) params.set('bbox', bboxParam(query.bbox));
  if (query.kind) params.set('kind', query.kind);
  const q = query.q?.trim();
  if (q) params.set('q', q.slice(0, 200));
  if (query.withCoordinates) params.set('with_coordinates', 'true');
  if (query.limit != null) params.set('limit', String(Math.max(1, Math.min(1000, Math.floor(query.limit)))));
  if (query.offset) params.set('offset', String(Math.max(0, Math.floor(query.offset))));
  const text = params.toString();
  return text ? `?${text}` : '';
}

export function placesApi(api: Pick<Api, 'request'>) {
  const request = api.request;
  const itemPath = (id: string) => `/items/${encodeURIComponent(id)}/places`;
  return {
    /** GET /api/places: the whole library's places, for the map and its list. */
    list: (query: PlacesQuery = {}, signal?: AbortSignal) => request<PlacesPage>(`/places${placesQueryString(query)}`, { signal }),
    /** GET /api/items/{id}/places */
    ofItem: (id: string) => request<ItemPlaces>(itemPath(id)),
    /** PUT /api/items/{id}/places. Replaces the owner's list. */
    save: (id: string, places: PlaceInput[]) => request<ItemPlaces>(itemPath(id), { method: 'PUT', body: { places } }),
    /** DELETE /api/items/{id}/places/edits. The extraction shows again. */
    discardEdits: (id: string) => request<ItemPlaces>(`${itemPath(id)}/edits`, { method: 'DELETE' }),
    /** POST /api/items/{id}/places/extract. */
    extract: (id: string, body: ExtractBody = { method: 'auto' }) => request<ExtractedPlaces>(`${itemPath(id)}/extract`, { method: 'POST', body }),
    /** POST /api/items/{id}/places/geocode. At most ten ids; the server looks up at most five a request. */
    geocode: (id: string, placeIds?: string[]) => request<GeocodedPlaces>(`${itemPath(id)}/geocode`, { method: 'POST', body: placeIds?.length ? { place_ids: placeIds.slice(0, 10) } : {} }),
  };
}

export type PlacesApi = ReturnType<typeof placesApi>;
