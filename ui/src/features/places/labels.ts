// The words for what the server says about a place: its kind, where it is, and above all where its
// coordinates and its evidence came from. The rule behind every sentence here is the contract's: coordinates
// are never invented, and the interface must not suggest more than the label says (an "area" is not a spot,
// a geocoder's answer is not the save's own).
import type { Coordinates, Place, PlaceKind } from './api';
import { PLACE_KINDS } from './api';

export const KIND_LABELS: Record<PlaceKind, string> = {
  restaurant: 'Restaurant',
  cafe: 'Café',
  bar: 'Bar',
  bakery: 'Bakery',
  hotel: 'Hotel',
  attraction: 'Attraction',
  landmark: 'Landmark',
  museum: 'Museum',
  park: 'Park',
  beach: 'Beach',
  shop: 'Shop',
  market: 'Market',
  venue: 'Venue',
  neighborhood: 'Neighborhood',
  city: 'City',
  region: 'Region',
  country: 'Country',
  other: 'Other',
};

export const isKind = (value: string): value is PlaceKind => (PLACE_KINDS as readonly string[]).includes(value);

export const kindLabel = (kind: string): string => (isKind(kind) ? KIND_LABELS[kind] : 'Other');

/** Each kind belongs to a little family of colours. The label is always there too: colour never carries the kind alone. */
export const KIND_TONES: Record<PlaceKind, 'petal' | 'sky' | 'sage' | 'butter' | 'clay' | 'lilac' | 'plain'> = {
  restaurant: 'petal', cafe: 'petal', bar: 'petal', bakery: 'petal', market: 'petal',
  hotel: 'sky', attraction: 'lilac', landmark: 'lilac', museum: 'lilac', venue: 'lilac',
  park: 'sage', beach: 'sage',
  shop: 'butter',
  neighborhood: 'clay', city: 'clay', region: 'clay', country: 'clay',
  other: 'plain',
};

/** City, region and country as one line, leaving out what is missing and what repeats (a city that is also the region). */
export function placeWhere(place: Pick<Place, 'city' | 'region' | 'country'>): string {
  const parts: string[] = [];
  for (const part of [place.city, place.region, place.country]) {
    const text = part?.trim();
    if (text && !parts.some(existing => existing.toLowerCase() === text.toLowerCase())) parts.push(text);
  }
  return parts.join(', ');
}

/** The field of the save that a quote came from, in words. */
const SOURCES: Record<string, string> = {
  caption: 'the caption',
  title: 'the title',
  notes: 'your notes',
  transcript: 'the transcript',
  alt_text: 'the image’s alt text',
  thumbnail_alt: 'the image’s alt text',
  page: 'the page',
  jsonld: 'the page’s structured data',
  user: 'you',
};

export function sourceLabel(source: string): string {
  return SOURCES[source] ?? source.replaceAll('_', ' ');
}

/** What a model-found place rests on, in plain words. The level comes from the server, never from the model. */
const EVIDENCE: Record<string, string> = {
  'text-only': 'From the title and link only',
  'caption-based': 'From the caption',
  'transcript-based': 'From what is said',
};

export function evidenceLabel(level: string | undefined): string {
  if (!level) return 'From the available text';
  return EVIDENCE[level] ?? `From ${level.replaceAll('-', ' ')}`;
}

/** How a place was found: a rule over the page's data, a fixed rule over the text, a model, or the owner. */
export const ORIGIN_LABELS: Record<Place['origin'], string> = {
  jsonld: 'the page’s own data',
  rules: 'a pin line or map link in the text',
  ai: 'a model reading the text',
  user: 'you',
};

export interface CoordinateStory {
  /** The short mono label: who the coordinates come from. */
  short: string;
  /** A sentence about where they came from, and no more than that. */
  long: string;
  /** What the position stands for. */
  precision: string;
}

const DETAIL: Record<string, string> = {
  jsonld: 'the page’s structured data',
  maps_link: 'a map link in the save',
  text_coordinates: 'coordinates written next to the place in the save’s text',
  nominatim: 'OpenStreetMap’s Nominatim',
  owner: 'you',
};

/** The story of one coordinate: who gave it, how, and how sure the position is. Never more than the server said. */
export function coordinateStory(coordinates: Pick<Coordinates, 'source' | 'detail' | 'precision' | 'provider'>): CoordinateStory {
  const how = DETAIL[coordinates.detail] ?? coordinates.detail.replaceAll('_', ' ');
  const precision = coordinates.precision === 'area' ? 'An area: the middle of a larger place, not a spot.' : 'A point.';
  if (coordinates.source === 'user') return { short: 'entered by you', long: 'You entered these coordinates.', precision };
  if (coordinates.source === 'geocoder') {
    const provider = coordinates.provider ? ` (${coordinates.provider})` : '';
    return { short: 'looked up', long: `Looked up by the geocoder this server uses, ${how}${provider}. The save itself did not give them.`, precision };
  }
  return { short: 'from the save', long: `The save states them, through ${how}.`, precision };
}

/** The short name of a coordinate's precision, for the mono line: `point` or `area`. */
export const precisionWord = (coordinates: Pick<Coordinates, 'precision'>) => (coordinates.precision === 'area' ? 'area' : 'point');
