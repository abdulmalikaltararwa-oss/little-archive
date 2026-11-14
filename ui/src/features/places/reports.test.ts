import { describe, expect, it } from 'vitest';
import type { ExtractedPlaces, GeocodingResult, Place } from './api';
import { describeExtraction, describeGeocoding, describeMethod } from './reports';

const PLACE: Place = {
  id: 'a1b2c3d4e5f6', name: 'Prater', kind: 'park', city: null, region: null, country: null, address: null, note: null, coordinates: null, evidence: { source: 'caption', quote: 'Prater' }, origin: 'rules',
};

function result(over: Partial<ExtractedPlaces> = {}, found: Partial<ExtractedPlaces['extraction_result']> = {}): ExtractedPlaces {
  return {
    item_id: 'x', status: 'extracted', edited: false, places: [PLACE], extracted: [PLACE], extraction: { method: 'rules', at: '2026-11-13T10:00:00Z' }, edited_at: null,
    available: { jsonld: true, rules: true, ai: false, geocoding: { enabled: false, attribution: null } },
    extraction_result: { found: true, tried: ['jsonld', 'rules'], ai_available: false, unattached_coordinates: 0, ai: null, ...found },
    ...over,
  };
}

describe('describeMethod', () => {
  it('names each way of reading, and joins them', () => {
    expect(describeMethod('rules')).toBe('the pin lines and map links in the text');
    expect(describeMethod('jsonld+rules')).toBe('the page’s own data and the pin lines and map links in the text');
    expect(describeMethod('')).toBe('the text');
  });
});

describe('describeExtraction', () => {
  it('says what was found, and how', () => {
    const report = describeExtraction(result());
    expect(report.tone).toBe('ok');
    expect(report.lines).toEqual(['Found 1 place in the pin lines and map links in the text.']);
  });

  it('says an empty result is empty, and gives the server’s reason', () => {
    const report = describeExtraction(result({ places: [], extracted: [] }, { found: false, reason: 'ai_not_configured', ai_available: false }));
    expect(report.tone).toBe('note');
    expect(report.lines[0]).toMatch(/no AI provider set up/);
  });

  it('handles a save with no text', () => {
    expect(describeExtraction(result({ places: [] }, { found: false, reason: 'no_text' })).lines[0]).toMatch(/no text/);
  });

  it('says plainly that AI reading is not set up when nothing was found and the reason is another one', () => {
    const lines = describeExtraction(result({ places: [] }, { found: false, ai_available: false })).lines;
    expect(lines.join(' ')).toContain('AI reading is not set up on this server.');
  });

  it('does not run again when nothing changed, and says so: the server sends no extraction_result then', () => {
    const report = describeExtraction(result({ unchanged: true, extraction_result: undefined }));
    expect(report.tone).toBe('note');
    expect(report.lines).toEqual(['The save’s text has not changed since the last look, so nothing was run again.']);
  });

  it('still says the owner’s edit hides anything new when nothing changed', () => {
    expect(describeExtraction(result({ unchanged: true, edited: true, extraction_result: undefined })).lines.join(' ')).toMatch(/Discard my edits/);
  });

  it('reports coordinates that were not attached to any place', () => {
    expect(describeExtraction(result({}, { unattached_coordinates: 1 })).lines.join(' ')).toMatch(/1 pair of coordinates .* was not on the same line as a place/);
    expect(describeExtraction(result({}, { unattached_coordinates: 3 })).lines.join(' ')).toMatch(/3 pairs of coordinates .* were not on the same line/);
  });

  it('reports what the checks on a model’s answer threw away', () => {
    const lines = describeExtraction(result({}, { ai: { dropped: 2, unstated_fields_cleared: 1 } })).lines.join(' ');
    expect(lines).toMatch(/2 places the text does not name; they were dropped/);
    expect(lines).toMatch(/1 detail a model added .* was removed/);
  });

  it('warns that the owner’s edit hides a new find', () => {
    expect(describeExtraction(result({ edited: true })).lines.join(' ')).toMatch(/Discard my edits/);
  });
});

describe('describeGeocoding', () => {
  const base: GeocodingResult = { requested: true, enabled: true, resolved: 0, not_found: 0, skipped: 0 };

  it('says there is no geocoder', () => {
    expect(describeGeocoding({ ...base, enabled: false, reason: 'geocoder_not_configured' }).lines[0]).toMatch(/no geocoder/);
  });

  it('reports what was found, what was not and what was left for next time', () => {
    const report = describeGeocoding({ ...base, resolved: 2, not_found: 1, skipped: 3 }, 'Data © OpenStreetMap contributors');
    expect(report.tone).toBe('ok');
    expect(report.lines).toEqual([
      'Found coordinates for 2 places.',
      '1 place could not be found and stays without coordinates.',
      '3 places were left for next time: the geocoder takes at most five at once.',
      'Data © OpenStreetMap contributors',
    ]);
  });

  it('does not credit a source when nothing was looked up', () => {
    expect(describeGeocoding({ ...base, not_found: 1 }, 'Data © OpenStreetMap contributors').lines.join(' ')).not.toContain('OpenStreetMap');
  });

  it('turns a geocoder failure into an error, and says whether to retry', () => {
    const report = describeGeocoding({ ...base, error: { message: 'It was busy.', retryable: true } });
    expect(report.tone).toBe('error');
    expect(report.lines[0]).toMatch(/busy.*Try again/);
  });
});
