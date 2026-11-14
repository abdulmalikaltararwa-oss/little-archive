import { describe, expect, it } from 'vitest';
import { bboxParam, boundsOf, crossesAntimeridian, formatCoordinates, inBounds, lonSpan, stripFor, unwrapLon, withMinimumSpan, wrapLon } from './geo';

describe('wrapLon', () => {
  it('leaves a longitude that is already in range alone, 180 included', () => {
    expect(wrapLon(16.3655)).toBe(16.3655);
    expect(wrapLon(180)).toBe(180);
    expect(wrapLon(-180)).toBe(-180);
  });
  it('brings the rest back into range', () => {
    expect(wrapLon(190)).toBe(-170);
    expect(wrapLon(-190)).toBe(170);
    expect(wrapLon(540)).toBe(-180);
  });
});

describe('boundsOf', () => {
  it('has nothing to say about no points', () => {
    expect(boundsOf([])).toBeNull();
  });

  it('wraps an ordinary set in the smallest box', () => {
    expect(boundsOf([{ lat: 51.5, lon: -0.12 }, { lat: 48.85, lon: 2.35 }, { lat: 35.68, lon: 139.69 }])).toEqual({ minLon: -0.12, minLat: 35.68, maxLon: 139.69, maxLat: 51.5 });
  });

  it('is a degenerate box for one place', () => {
    expect(boundsOf([{ lat: 10, lon: 20 }])).toEqual({ minLon: 20, minLat: 10, maxLon: 20, maxLat: 10 });
  });

  it('leaves out the widest empty gap, so the Pacific is crossed and not circled', () => {
    const box = boundsOf([{ lat: -17.7, lon: 178 }, { lat: -36.85, lon: 174.76 }, { lat: -14.3, lon: -170.7 }])!;
    expect(box).toEqual({ minLon: 174.76, minLat: -36.85, maxLon: -170.7, maxLat: -14.3 });
    expect(crossesAntimeridian(box)).toBe(true);
    expect(lonSpan(box)).toBeCloseTo(14.54, 5);
  });
});

describe('inBounds', () => {
  const europe = { minLon: -10, minLat: 35, maxLon: 30, maxLat: 60 };
  it('includes the edges', () => {
    expect(inBounds({ lat: 51.5, lon: -0.12 }, europe)).toBe(true);
    expect(inBounds({ lat: 35, lon: -10 }, europe)).toBe(true);
    expect(inBounds({ lat: 35.68, lon: 139.69 }, europe)).toBe(false);
    expect(inBounds({ lat: 70, lon: 10 }, europe)).toBe(false);
  });
  it('reads a box with minLon greater than maxLon as one that crosses the antimeridian', () => {
    const pacific = { minLon: 170, minLat: -50, maxLon: -170, maxLat: 0 };
    expect(inBounds({ lat: -36.85, lon: 174.76 }, pacific)).toBe(true);
    expect(inBounds({ lat: -17.7, lon: 178 }, pacific)).toBe(true);
    expect(inBounds({ lat: -14, lon: -175 }, pacific)).toBe(true);
    expect(inBounds({ lat: -14, lon: 0 }, pacific)).toBe(false);
    expect(inBounds({ lat: 21.3, lon: -157.8 }, pacific)).toBe(false);
  });
});

describe('bboxParam', () => {
  it('writes the box the way the server reads it', () => {
    expect(bboxParam({ minLon: -10, minLat: 35, maxLon: 30, maxLat: 60 })).toBe('-10,35,30,60');
  });
  it('trims long decimals and keeps a crossing box crossing', () => {
    expect(bboxParam({ minLon: 170.1234567891, minLat: -50, maxLon: -170, maxLat: 0 })).toBe('170.123457,-50,-170,0');
  });
  it('wraps longitudes that ran past 180 while panning', () => {
    expect(bboxParam({ minLon: 170, minLat: -10, maxLon: 190, maxLat: 10 })).toBe('170,-10,-170,10');
  });
  it('spells a box that covers the world as the whole world, and keeps latitude in range', () => {
    expect(bboxParam({ minLon: -200, minLat: -95, maxLon: 200, maxLat: 95 })).toBe('-180,-90,180,90');
  });
});

describe('withMinimumSpan', () => {
  it('gives a single place some room', () => {
    const box = withMinimumSpan({ minLon: 16.37, minLat: 48.2, maxLon: 16.37, maxLat: 48.2 }, 0.02);
    expect(box.maxLon - box.minLon).toBeCloseTo(0.02, 6);
    expect(box.maxLat - box.minLat).toBeCloseTo(0.02, 6);
  });
  it('leaves a box that is big enough alone', () => {
    const box = { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 };
    expect(withMinimumSpan(box, 0.02)).toEqual(box);
  });
});

describe('unwrapLon', () => {
  it('moves western longitudes east of a crossing box’s start', () => {
    const pacific = { minLon: 170, minLat: -50, maxLon: -170, maxLat: 0 };
    expect(unwrapLon(-175, pacific)).toBe(185);
    expect(unwrapLon(178, pacific)).toBe(178);
  });
});

describe('stripFor', () => {
  it('puts both sides of the antimeridian on one strip', () => {
    const strip = stripFor([{ lat: -36.85, lon: 174.76 }, { lat: -14.3, lon: -172.1 }]);
    expect(strip(174.76)).toBe(174.76);
    expect(strip(-172.1)).toBeCloseTo(187.9, 6);
  });
  it('leaves an ordinary set alone', () => {
    const strip = stripFor([{ lat: 51.5, lon: -0.12 }, { lat: 35.68, lon: 139.69 }]);
    expect(strip(-0.12)).toBe(-0.12);
    expect(strip(139.69)).toBe(139.69);
  });
});

describe('formatCoordinates', () => {
  it('writes the hemisphere instead of a minus sign', () => {
    expect(formatCoordinates({ lat: 48.2104, lon: 16.3655 })).toBe('48.2104° N, 16.3655° E');
    expect(formatCoordinates({ lat: -41.0123, lon: -72.5678 })).toBe('41.0123° S, 72.5678° W');
  });
  it('does not claim a hemisphere for a zero', () => {
    expect(formatCoordinates({ lat: 0.00001, lon: -0.00001 })).toBe('0° N, 0° E');
  });
  it('rounds an area to about a kilometre so it does not claim a precision nobody has', () => {
    expect(formatCoordinates({ lat: 51.5007123, lon: -0.1246456 }, 'area')).toBe('51.5° N, 0.12° W');
    expect(formatCoordinates({ lat: 51.5007, lon: -0.1246 }, 'point')).toBe('51.5007° N, 0.1246° W');
  });
});
