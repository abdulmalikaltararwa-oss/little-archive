import { describe, expect, it, vi } from 'vitest';
import { placesApi, placesQueryString } from './api';

describe('placesQueryString', () => {
  it('is empty when nothing is asked for', () => {
    expect(placesQueryString({})).toBe('');
  });

  it('carries bbox, kind, q, with_coordinates and the page, and only those', () => {
    const query = placesQueryString({ bbox: { minLon: -10, minLat: 35, maxLon: 30, maxLat: 60 }, kind: 'cafe', q: '  vienna  ', withCoordinates: true, limit: 200, offset: 400 });
    const params = new URLSearchParams(query.slice(1));
    expect(Object.fromEntries(params)).toEqual({ bbox: '-10,35,30,60', kind: 'cafe', q: 'vienna', with_coordinates: 'true', limit: '200', offset: '400' });
  });

  it('leaves out an empty kind, a blank q, an unchecked box and a zero offset', () => {
    expect(placesQueryString({ kind: '', q: '   ', withCoordinates: false, offset: 0 })).toBe('');
  });

  it('keeps the page size inside what the server accepts', () => {
    expect(placesQueryString({ limit: 5000 })).toBe('?limit=1000');
    expect(placesQueryString({ limit: 0 })).toBe('?limit=1');
  });

  it('encodes words that need it', () => {
    expect(placesQueryString({ q: 'café & bar' })).toBe('?q=caf%C3%A9+%26+bar');
  });

  it('keeps a box that crosses the antimeridian crossing', () => {
    expect(new URLSearchParams(placesQueryString({ bbox: { minLon: 170, minLat: -50, maxLon: -170, maxLat: 0 } })).get('bbox')).toBe('170,-50,-170,0');
  });
});

describe('placesApi', () => {
  function recorder() {
    const request = vi.fn(async () => ({}));
    return { request: request as unknown as Parameters<typeof placesApi>[0]['request'], calls: request.mock.calls as unknown as [string, { method?: string; body?: unknown } | undefined][] };
  }

  it('uses the contract’s routes and methods', async () => {
    const { request, calls } = recorder();
    const api = placesApi({ request });
    await api.list({ kind: 'park' });
    await api.ofItem('abc');
    await api.save('abc', [{ name: 'Prater' }]);
    await api.discardEdits('abc');
    await api.extract('abc');
    await api.geocode('abc', ['p1']);
    expect(calls.map(([path, options]) => `${options?.method ?? 'GET'} ${path}`)).toEqual([
      'GET /places?kind=park',
      'GET /items/abc/places',
      'PUT /items/abc/places',
      'DELETE /items/abc/places/edits',
      'POST /items/abc/places/extract',
      'POST /items/abc/places/geocode',
    ]);
  });

  it('sends the owner’s list under `places`, and asks for method auto by default', async () => {
    const { request, calls } = recorder();
    const api = placesApi({ request });
    await api.save('abc', [{ name: 'Prater', coordinates: { lat: 48.2166, lon: 16.3959 } }]);
    await api.extract('abc');
    expect(calls[0]![1]!.body).toEqual({ places: [{ name: 'Prater', coordinates: { lat: 48.2166, lon: 16.3959 } }] });
    expect(calls[1]![1]!.body).toEqual({ method: 'auto' });
  });

  it('names the places to look up, never more than ten, and sends an empty body for "whichever need it"', async () => {
    const { request, calls } = recorder();
    const api = placesApi({ request });
    await api.geocode('abc', Array.from({ length: 14 }, (_, index) => `p${index}`));
    await api.geocode('abc');
    expect((calls[0]![1]!.body as { place_ids: string[] }).place_ids).toHaveLength(10);
    expect(calls[1]![1]!.body).toEqual({});
  });

  it('encodes an item id that is not a plain word', async () => {
    const { request, calls } = recorder();
    await placesApi({ request }).ofItem('a/b c');
    expect(calls[0]![0]).toBe('/items/a%2Fb%20c/places');
  });
});
