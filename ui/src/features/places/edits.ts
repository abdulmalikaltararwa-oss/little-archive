// An owner's edit to a save's places is one PUT that replaces the whole list. These build that body from the
// list a GET returned. Only what the contract accepts is sent: the fields a GET adds on its own (the evidence,
// the origin, the provenance, and how a coordinate was found) are left out. A coordinate is sent back as the
// bare pair, which is how the server knows it is unchanged and keeps its original label ("geocoder" stays
// "geocoder"; only a changed pair becomes "entered by you").
import type { Place, PlaceInput } from './api';

export const MAX_PLACES = 30;
export const MAX_NAME = 200;

/** A name as the server will keep it: runs of spaces folded to one, trimmed, and no longer than it allows. */
export function cleanName(raw: string): string {
  return raw.split(/\s+/).filter(Boolean).join(' ').slice(0, MAX_NAME);
}

/** One place as a PUT body entry. Empty and missing fields are omitted, which the server reads as "none". */
export function toInput(place: Place): PlaceInput {
  const input: PlaceInput = { id: place.id, name: place.name, kind: place.kind };
  for (const field of ['city', 'region', 'country', 'address', 'note'] as const) {
    const value = place[field];
    if (value) input[field] = value;
  }
  if (place.coordinates) input.coordinates = { lat: place.coordinates.lat, lon: place.coordinates.lon };
  return input;
}

/** The whole list, unchanged. */
export const bodyOf = (places: readonly Place[]): PlaceInput[] => places.slice(0, MAX_PLACES).map(toInput);

/** The list with one place renamed. Returns null when the new name is empty (the server refuses an empty name). */
export function renamed(places: readonly Place[], id: string, name: string): PlaceInput[] | null {
  const next = cleanName(name);
  if (!next) return null;
  return bodyOf(places).map(input => (input.id === id ? { ...input, name: next } : input));
}

/** The list without one place. */
export const removeFrom = (places: readonly Place[], id: string): PlaceInput[] => bodyOf(places.filter(place => place.id !== id));
