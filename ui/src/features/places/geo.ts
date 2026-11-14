// The map arithmetic the places screen needs, with no map library and no React: boxes (including the ones
// that cross the antimeridian, as the server's `bbox` does), what is inside one, and how a coordinate is
// written. Longitude is degrees east, latitude degrees north, both as the server sends them.

export interface Point {
  lat: number;
  lon: number;
}

/**
 * A box in the server's own convention: `minLon` greater than `maxLon` means the box crosses the antimeridian
 * (it runs east from `minLon` through 180 and on from -180 to `maxLon`).
 */
export interface Bounds {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export const crossesAntimeridian = (bounds: Bounds) => bounds.minLon > bounds.maxLon;

/** How many degrees of longitude the box covers, counted the short way across the antimeridian when it crosses. */
export const lonSpan = (bounds: Bounds) => (crossesAntimeridian(bounds) ? bounds.maxLon + 360 - bounds.minLon : bounds.maxLon - bounds.minLon);

export const latSpan = (bounds: Bounds) => bounds.maxLat - bounds.minLat;

/** A longitude brought back into -180 to 180. Values already inside it are returned as they are (180 stays 180). */
export function wrapLon(lon: number): number {
  if (lon >= -180 && lon <= 180) return lon;
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

export const clampLat = (lat: number) => Math.max(-90, Math.min(90, lat));

/**
 * A longitude shifted by whole turns so it sits at or east of the box's `minLon` and within a turn of it. A box
 * that crosses the antimeridian is drawn on a line that runs past 180, and its western points need 360 added.
 */
export function unwrapLon(lon: number, bounds: Bounds): number {
  let value = lon;
  while (value < bounds.minLon) value += 360;
  while (value >= bounds.minLon + 360) value -= 360;
  return value;
}

/**
 * The smallest box that holds every point. Longitude is circular, so the box leaves out the widest empty gap:
 * Fiji and Auckland make a small box over the antimeridian, not one that spans the whole Pacific the long way.
 */
export function boundsOf(points: readonly Point[]): Bounds | null {
  if (!points.length) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const point of points) {
    if (point.lat < minLat) minLat = point.lat;
    if (point.lat > maxLat) maxLat = point.lat;
  }
  const lons = [...new Set(points.map(point => wrapLon(point.lon)))].sort((a, b) => a - b);
  // The gap that closes the circle is from the last longitude, through 180, back to the first.
  let widestGap = lons[0]! + 360 - lons[lons.length - 1]!;
  let at = -1;
  for (let index = 0; index < lons.length - 1; index += 1) {
    const gap = lons[index + 1]! - lons[index]!;
    if (gap > widestGap) {
      widestGap = gap;
      at = index;
    }
  }
  if (at === -1) return { minLon: lons[0]!, minLat, maxLon: lons[lons.length - 1]!, maxLat };
  return { minLon: lons[at + 1]!, minLat, maxLon: lons[at]!, maxLat };
}

/**
 * A function that gives each longitude of this set a value on one flat strip of the world. Where the set crosses
 * the antimeridian the western longitudes get 360 added (Auckland at 175 and Samoa at -172 become 175 and 188), so
 * a flat map can put them side by side; otherwise longitudes are returned as they are.
 */
export function stripFor(points: readonly Point[]): (lon: number) => number {
  const box = boundsOf(points);
  return box && crossesAntimeridian(box) ? lon => unwrapLon(lon, box) : lon => lon;
}

/** Whether a point lies inside a box, on its edge included. */
export function inBounds(point: Point, bounds: Bounds): boolean {
  if (point.lat < bounds.minLat || point.lat > bounds.maxLat) return false;
  const lon = wrapLon(point.lon);
  return crossesAntimeridian(bounds) ? lon >= bounds.minLon || lon <= bounds.maxLon : lon >= bounds.minLon && lon <= bounds.maxLon;
}

/** A box grown to at least `degrees` across each way, around its middle. One place is a point, and a point has no shape to fit. */
export function withMinimumSpan(bounds: Bounds, degrees: number): Bounds {
  let { minLon, maxLon, minLat, maxLat } = bounds;
  const wide = lonSpan(bounds);
  if (wide < degrees) {
    const middle = minLon + wide / 2;
    minLon = wrapLon(middle - degrees / 2);
    maxLon = wrapLon(middle + degrees / 2);
  }
  if (maxLat - minLat < degrees) {
    const middle = (minLat + maxLat) / 2;
    minLat = clampLat(middle - degrees / 2);
    maxLat = clampLat(middle + degrees / 2);
  }
  return { minLon, minLat, maxLon, maxLat };
}

const trim = (value: number) => String(Number(value.toFixed(6)));

/** The box as the server reads it: `minLon,minLat,maxLon,maxLat`. Longitudes are wrapped into range, and a crossing box stays crossing. */
export function bboxParam(bounds: Bounds): string {
  const wide = lonSpan(bounds);
  // A box that covers the whole world is spelled out as the whole world, not as a crossing one.
  if (wide >= 360) return [-180, clampLat(bounds.minLat), 180, clampLat(bounds.maxLat)].map(trim).join(',');
  return [wrapLon(bounds.minLon), clampLat(bounds.minLat), wrapLon(bounds.maxLon), clampLat(bounds.maxLat)].map(trim).join(',');
}

/** Degrees as a person writes them, with the hemisphere: `48.2104° N`. */
function degrees(value: number, positive: string, negative: string, decimals: number): string {
  const rounded = Number(Math.abs(value).toFixed(decimals));
  return `${rounded}° ${value < 0 && rounded !== 0 ? negative : positive}`;
}

/**
 * A coordinate pair for display. An `area` result is the middle of a district or city, so it is rounded to
 * about a kilometre; showing six decimals for it would claim a precision nobody has.
 */
export function formatCoordinates(point: Point, precision: 'point' | 'area' = 'point'): string {
  const decimals = precision === 'area' ? 2 : 4;
  return `${degrees(point.lat, 'N', 'S', decimals)}, ${degrees(wrapLon(point.lon), 'E', 'W', decimals)}`;
}
