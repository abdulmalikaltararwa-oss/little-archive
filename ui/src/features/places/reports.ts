// What to tell the owner after "Look for places" and "Find coordinates". The server's answer says exactly what
// it did and did not do (what it found, what a model offered and the checks threw away, which coordinates were
// left alone), and these turn that into sentences without adding to it: an empty result is said to be empty,
// and the reason is the server's reason, not a guess.
import type { ExtractedPlaces, GeocodingResult } from './api';

export interface Report {
  tone: 'ok' | 'note' | 'error';
  lines: string[];
}

const METHODS: Record<string, string> = {
  jsonld: 'the page’s own data',
  rules: 'the pin lines and map links in the text',
  ai: 'a model reading the text',
};

/** `jsonld+rules` as "the page’s own data and the pin lines and map links in the text". */
export function describeMethod(method: string): string {
  const parts = method.split('+').map(part => METHODS[part] ?? part).filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? 'the text';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function describeExtraction(result: ExtractedPlaces): Report {
  const found = result.extraction_result;
  const lines: string[] = [];
  let tone: Report['tone'] = 'ok';

  // When the same text was already read the server sends the stored view with no `extraction_result` at all.
  if (!found) {
    tone = 'note';
    lines.push(result.unchanged ? 'The save’s text has not changed since the last look, so nothing was run again.' : 'The server did not say what it found.');
    if (result.edited) lines.push('You have edited this list, so a new find is kept beside it. Choose “Discard my edits” to see it.');
    if (result.geocoding) lines.push(...describeGeocoding(result.geocoding).lines);
    return { tone, lines };
  }

  if (result.unchanged) {
    tone = 'note';
    lines.push('The save’s text has not changed since the last look, so nothing was run again.');
  } else if (found.found) {
    const n = result.extracted?.length ?? result.places.length;
    lines.push(`Found ${count(n, 'place')} in ${describeMethod(result.extraction?.method ?? found.tried.join('+'))}.`);
  } else {
    tone = 'note';
    if (found.reason === 'no_text') lines.push('There is no text in this save to look through yet. Add a caption or notes first.');
    else if (found.reason === 'ai_not_configured') lines.push('No place was found by the page’s data or the fixed rules, and this server has no AI provider set up to read any further.');
    else lines.push(`No place was found${found.tried.length ? ` (tried ${found.tried.join(', ')})` : ''}.`);
    if (!found.ai_available && found.reason !== 'ai_not_configured') lines.push('AI reading is not set up on this server.');
  }

  if (found.unattached_coordinates > 0) {
    lines.push(`${count(found.unattached_coordinates, 'pair')} of coordinates in the text ${found.unattached_coordinates === 1 ? 'was' : 'were'} not on the same line as a place, so ${found.unattached_coordinates === 1 ? 'it was' : 'they were'} not used.`);
  }
  if (found.ai) {
    if (found.ai.dropped > 0) lines.push(`A model offered ${count(found.ai.dropped, 'place')} the text does not name; ${found.ai.dropped === 1 ? 'it was' : 'they were'} dropped.`);
    if (found.ai.unstated_fields_cleared > 0) lines.push(`${count(found.ai.unstated_fields_cleared, 'detail')} a model added (a city, country or address the text never states) ${found.ai.unstated_fields_cleared === 1 ? 'was' : 'were'} removed.`);
  }
  if (result.edited && (found.found || result.unchanged)) lines.push('You have edited this list, so a new find is kept beside it. Choose “Discard my edits” to see it.');
  if (result.geocoding) lines.push(...describeGeocoding(result.geocoding).lines);
  return { tone, lines };
}

export function describeGeocoding(geocoding: GeocodingResult, attribution?: string | null): Report {
  if (!geocoding.enabled || geocoding.reason === 'geocoder_not_configured') {
    return { tone: 'note', lines: ['This server has no geocoder set up, so no coordinates were looked up.'] };
  }
  if (geocoding.error) {
    return { tone: 'error', lines: [`The geocoder could not answer: ${geocoding.error.message}${geocoding.error.retryable ? ' Try again in a little while.' : ''}`] };
  }
  const lines: string[] = [];
  if (geocoding.resolved > 0) lines.push(`Found coordinates for ${count(geocoding.resolved, 'place')}.`);
  else lines.push('No coordinates were found.');
  if (geocoding.not_found > 0) lines.push(`${count(geocoding.not_found, 'place')} could not be found and ${geocoding.not_found === 1 ? 'stays' : 'stay'} without coordinates.`);
  if (geocoding.skipped > 0) lines.push(`${count(geocoding.skipped, 'place')} ${geocoding.skipped === 1 ? 'was' : 'were'} left for next time: the geocoder takes at most five at once.`);
  if (geocoding.resolved > 0 && attribution) lines.push(attribution);
  return { tone: geocoding.resolved > 0 ? 'ok' : 'note', lines };
}
