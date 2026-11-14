import { describe, expect, it } from 'vitest';
import type { Place } from './api';
import { bodyOf, cleanName, MAX_NAME, MAX_PLACES, removeFrom, renamed, toInput } from './edits';

const CAFE: Place = {
  id: 'a1b2c3d4e5f6',
  name: 'Café Central',
  kind: 'cafe',
  city: 'Vienna',
  region: null,
  country: '',
  address: 'Herrengasse 14, Vienna',
  note: null,
  coordinates: { lat: 48.2104, lon: 16.3655, source: 'geocoder', detail: 'nominatim', provider: 'nominatim.example.org', precision: 'point', display_name: 'Café Central, Vienna', attribution: 'Data © OpenStreetMap contributors' },
  evidence: { source: 'caption', quote: '📍 Café Central, Herrengasse 14, Vienna' },
  origin: 'rules',
  provenance: { evidence_level: 'caption-based' },
};
const MARKET: Place = {
  id: 'f6e5d4c3b2a1', name: 'Naschmarkt', kind: 'market', city: null, region: null, country: null, address: null, note: 'Go early', coordinates: null,
  evidence: { source: 'caption', quote: 'Naschmarkt' }, origin: 'rules',
};

describe('toInput', () => {
  it('sends back only what a PUT accepts: no evidence, origin, provenance or coordinate labels', () => {
    expect(toInput(CAFE)).toEqual({
      id: 'a1b2c3d4e5f6', name: 'Café Central', kind: 'cafe', city: 'Vienna', address: 'Herrengasse 14, Vienna', coordinates: { lat: 48.2104, lon: 16.3655 },
    });
  });

  it('leaves out empty and missing fields', () => {
    expect(toInput(MARKET)).toEqual({ id: 'f6e5d4c3b2a1', name: 'Naschmarkt', kind: 'market', note: 'Go early' });
    expect('coordinates' in toInput(MARKET)).toBe(false);
  });
});

describe('cleanName', () => {
  it('folds spaces, trims and caps the length the server allows', () => {
    expect(cleanName('  Café   \n Central  ')).toBe('Café Central');
    expect(cleanName('x'.repeat(300))).toHaveLength(MAX_NAME);
    expect(cleanName('   ')).toBe('');
  });
});

describe('renamed', () => {
  it('renames one place and sends the rest as they were', () => {
    const body = renamed([CAFE, MARKET], MARKET.id, '  The   Naschmarkt ')!;
    expect(body.map(place => place.name)).toEqual(['Café Central', 'The Naschmarkt']);
    expect(body[0]).toEqual(toInput(CAFE));
  });

  it('refuses an empty name instead of sending one the server would reject', () => {
    expect(renamed([CAFE], CAFE.id, '   ')).toBeNull();
  });

  it('changes nothing when the id is not in the list', () => {
    expect(renamed([CAFE], 'nope', 'X')).toEqual([toInput(CAFE)]);
  });
});

describe('removeFrom', () => {
  it('drops one place', () => {
    expect(removeFrom([CAFE, MARKET], CAFE.id)).toEqual([toInput(MARKET)]);
  });
  it('can empty the list, which the server accepts', () => {
    expect(removeFrom([CAFE], CAFE.id)).toEqual([]);
  });
});

describe('bodyOf', () => {
  it('never sends more than the server takes', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ ...MARKET, id: String(index).padStart(12, '0') }));
    expect(bodyOf(many)).toHaveLength(MAX_PLACES);
  });
});
