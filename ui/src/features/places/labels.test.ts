import { describe, expect, it } from 'vitest';
import { PLACE_KINDS } from './api';
import { coordinateStory, evidenceLabel, KIND_LABELS, KIND_TONES, kindLabel, placeWhere, sourceLabel } from './labels';

describe('kinds', () => {
  it('has a label and a tone for every kind the contract lists, and no others', () => {
    expect(Object.keys(KIND_LABELS).sort()).toEqual([...PLACE_KINDS].sort());
    expect(Object.keys(KIND_TONES).sort()).toEqual([...PLACE_KINDS].sort());
  });
  it('does not stumble on a kind a newer server might add', () => {
    expect(kindLabel('spaceport')).toBe('Other');
    expect(kindLabel('cafe')).toBe('Café');
  });
});

describe('placeWhere', () => {
  it('joins what is there', () => {
    expect(placeWhere({ city: 'Vienna', region: null, country: 'Austria' })).toBe('Vienna, Austria');
    expect(placeWhere({ city: null, region: null, country: null })).toBe('');
  });
  it('does not say the same thing twice', () => {
    expect(placeWhere({ city: 'Singapore', region: 'singapore', country: 'Singapore' })).toBe('Singapore');
  });
  it('ignores blanks', () => {
    expect(placeWhere({ city: '  ', region: '', country: 'Examplia' })).toBe('Examplia');
  });
});

describe('sourceLabel and evidenceLabel', () => {
  it('says which field a quote came from, and degrades to the field’s own name', () => {
    expect(sourceLabel('caption')).toBe('the caption');
    expect(sourceLabel('jsonld')).toBe('the page’s structured data');
    expect(sourceLabel('some_new_field')).toBe('some new field');
  });
  it('says what a model’s place rests on', () => {
    expect(evidenceLabel('caption-based')).toBe('From the caption');
    expect(evidenceLabel('text-only')).toBe('From the title and link only');
    expect(evidenceLabel('page-based')).toBe('From page based');
    expect(evidenceLabel(undefined)).toBe('From the available text');
  });
});

describe('coordinateStory', () => {
  it('credits the save when the save stated them, and says how', () => {
    const story = coordinateStory({ source: 'source', detail: 'maps_link', precision: 'point', provider: '' });
    expect(story.short).toBe('from the save');
    expect(story.long).toContain('a map link in the save');
    expect(story.precision).toBe('A point.');
  });

  it('never presents a geocoder’s answer as the save’s own', () => {
    const story = coordinateStory({ source: 'geocoder', detail: 'nominatim', precision: 'area', provider: 'nominatim.example.org' });
    expect(story.short).toBe('looked up');
    expect(story.long).toContain('The save itself did not give them');
    expect(story.long).toContain('nominatim.example.org');
    expect(story.precision).toMatch(/not a spot/);
  });

  it('says when the owner entered them', () => {
    expect(coordinateStory({ source: 'user', detail: 'owner', precision: 'point', provider: '' }).short).toBe('entered by you');
  });

  it('describes each way a save can state coordinates', () => {
    expect(coordinateStory({ source: 'source', detail: 'jsonld', precision: 'point', provider: '' }).long).toContain('structured data');
    expect(coordinateStory({ source: 'source', detail: 'text_coordinates', precision: 'point', provider: '' }).long).toContain('written next to the place');
  });
});
