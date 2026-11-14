// The paper map: where a longitude and latitude fall on a plain sheet, and which graticule lines to draw. It is
// an equirectangular sheet with one correction: a degree of longitude is drawn narrower than a degree of
// latitude by the cosine of the middle latitude, so a small area keeps roughly its true shape. There are no
// coastlines and no streets, only where the coordinates are, so it makes no claim about distance beyond that.
import { latSpan, lonSpan, unwrapLon, wrapLon, withMinimumSpan, type Bounds } from './geo';

export interface Projection {
  /** Sheet position of a longitude (it may be wrapped or not; the antimeridian is handled). */
  x(lon: number): number;
  /** Sheet position of a latitude. North is up. */
  y(lat: number): number;
  /** What the whole sheet shows, edge to edge. `maxLon` can run past 180 when the sheet crosses the antimeridian. */
  visible: Bounds;
  /** Sheet units per degree of latitude. */
  scale: number;
  /** Sheet units per degree of longitude. */
  scaleX: number;
}

/** Fitting never goes tighter than this, so a single place is a neighbourhood and not a pin on a blank page. */
export const MIN_SPAN_DEGREES = 0.02;

/**
 * Fits `bounds` into a `width` by `height` sheet with `padding` kept clear all round. The content is centred,
 * so the sheet is always full: graticule lines run edge to edge even when the content is wide and short.
 */
export function fitProjection(bounds: Bounds, width: number, height: number, padding = 56): Projection {
  const box = withMinimumSpan(bounds, MIN_SPAN_DEGREES);
  const middle = (box.minLat + box.maxLat) / 2;
  // Near the poles a degree of longitude shrinks to nothing; the floor keeps the sheet drawable.
  const squeeze = Math.max(0.2, Math.cos((middle * Math.PI) / 180));
  const spanLon = lonSpan(box);
  const spanLat = latSpan(box);
  const innerWidth = Math.max(1, width - padding * 2);
  const innerHeight = Math.max(1, height - padding * 2);
  const scale = Math.min(innerWidth / (spanLon * squeeze), innerHeight / spanLat);
  const scaleX = scale * squeeze;
  const left = (width - spanLon * scaleX) / 2;
  const top = (height - spanLat * scale) / 2;
  const minLon = box.minLon - left / scaleX;
  const maxLat = box.maxLat + top / scale;
  const visible: Bounds = { minLon, maxLon: minLon + width / scaleX, maxLat, minLat: maxLat - height / scale };
  return {
    // Longitudes are read from the sheet's west edge, so a graticule line west of the content (or a place on the
    // far side of the antimeridian) lands where it should and not a whole turn away.
    x: lon => left + (unwrapLon(lon, visible) - box.minLon) * scaleX,
    y: lat => top + (box.maxLat - lat) * scale,
    visible,
    scale,
    scaleX,
  };
}

// Steps in degrees a graticule may use: fine enough for a street, coarse enough for the world.
const STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 45, 90];

/** The smallest step that keeps the number of lines across `span` degrees at or under `target`. */
export function graticuleStep(span: number, target = 5): number {
  const wanted = span / Math.max(1, target);
  return STEPS.find(step => step >= wanted) ?? STEPS[STEPS.length - 1]!;
}

/** The multiples of `step` between `from` and `to`, inclusive, in order. Floating-point noise is rounded away. */
export function graticuleLines(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  const places = Math.max(0, Math.ceil(-Math.log10(step)) + 1);
  for (let index = Math.ceil(from / step); index * step <= to + 1e-9; index += 1) {
    out.push(Number((index * step).toFixed(places)));
    if (out.length > 40) break;
  }
  return out;
}

/** A graticule label such as `48.2° N` or `16.4° E`, with only as many decimals as the step needs. */
export function graticuleLabel(value: number, axis: 'lat' | 'lon', step: number): string {
  const decimals = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step) - 1e-9));
  const shown = axis === 'lon' ? wrapLon(value) : value;
  const positive = axis === 'lat' ? 'N' : 'E';
  const negative = axis === 'lat' ? 'S' : 'W';
  const rounded = Number(Math.abs(shown).toFixed(decimals));
  return `${rounded.toFixed(decimals)}° ${shown < 0 && rounded !== 0 ? negative : positive}`;
}
