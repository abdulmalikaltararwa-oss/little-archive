import { describe, expect, it } from 'vitest';
import { boundsOf } from './geo';
import { fitProjection, graticuleLabel, graticuleLines, graticuleStep } from './projection';

const VIENNA = boundsOf([{ lat: 48.1986, lon: 16.3629 }, { lat: 48.2166, lon: 16.3959 }, { lat: 48.2104, lon: 16.3655 }])!;

describe('fitProjection', () => {
  it('puts north up and east to the right', () => {
    const view = fitProjection(VIENNA, 800, 600);
    expect(view.y(48.2166)).toBeLessThan(view.y(48.1986));
    expect(view.x(16.3959)).toBeGreaterThan(view.x(16.3629));
  });

  it('keeps every point on the sheet, inside the padding', () => {
    const view = fitProjection(VIENNA, 800, 600, 56);
    for (const [lat, lon] of [[48.1986, 16.3629], [48.2166, 16.3959], [48.2104, 16.3655]] as const) {
      expect(view.x(lon)).toBeGreaterThanOrEqual(56 - 1e-6);
      expect(view.x(lon)).toBeLessThanOrEqual(744 + 1e-6);
      expect(view.y(lat)).toBeGreaterThanOrEqual(56 - 1e-6);
      expect(view.y(lat)).toBeLessThanOrEqual(544 + 1e-6);
    }
  });

  it('draws a degree of longitude narrower than a degree of latitude away from the equator', () => {
    const view = fitProjection(VIENNA, 800, 600);
    expect(view.scaleX / view.scale).toBeCloseTo(Math.cos((48.2076 * Math.PI) / 180), 2);
  });

  it('fills the sheet: the visible box reaches every edge', () => {
    const view = fitProjection(VIENNA, 800, 600);
    expect(view.x(view.visible.minLon)).toBeCloseTo(0, 5);
    expect(view.x(view.visible.maxLon)).toBeCloseTo(800, 5);
    expect(view.y(view.visible.maxLat)).toBeCloseTo(0, 5);
    expect(view.y(view.visible.minLat)).toBeCloseTo(600, 5);
  });

  it('centres a single place instead of failing on a box with no size', () => {
    const view = fitProjection(boundsOf([{ lat: 48.2104, lon: 16.3655 }])!, 800, 600);
    expect(view.x(16.3655)).toBeCloseTo(400, 3);
    expect(view.y(48.2104)).toBeCloseTo(300, 3);
    expect(Number.isFinite(view.scale)).toBe(true);
  });

  it('draws places either side of the antimeridian next to each other', () => {
    const box = boundsOf([{ lat: -17.7, lon: 178 }, { lat: -36.85, lon: 174.76 }, { lat: -14.3, lon: -170.7 }])!;
    const view = fitProjection(box, 800, 600);
    expect(view.x(-170.7)).toBeGreaterThan(view.x(178));
    expect(view.x(178)).toBeGreaterThan(view.x(174.76));
    expect(view.x(-170.7)).toBeLessThanOrEqual(744 + 1e-6);
  });

  it('survives the poles', () => {
    const view = fitProjection(boundsOf([{ lat: 89, lon: 0 }, { lat: 88, lon: 90 }])!, 800, 600);
    expect(Number.isFinite(view.x(45))).toBe(true);
  });
});

describe('graticule', () => {
  it('chooses a step that keeps the line count near the target', () => {
    expect(graticuleStep(0.2)).toBe(0.05);
    expect(graticuleStep(40)).toBe(10);
    expect(graticuleStep(360)).toBe(90);
    expect(graticuleStep(1_000_000)).toBe(90);
  });

  it('lists the multiples of the step, without floating-point noise', () => {
    expect(graticuleLines(16.3, 16.5, 0.05)).toEqual([16.3, 16.35, 16.4, 16.45, 16.5]);
    expect(graticuleLines(-12, 12, 10)).toEqual([-10, 0, 10]);
  });

  it('never returns an endless list', () => {
    expect(graticuleLines(0, 1000, 0.001).length).toBeLessThanOrEqual(41);
  });

  it('labels with as many decimals as the step needs', () => {
    expect(graticuleLabel(48.25, 'lat', 0.05)).toBe('48.25° N');
    expect(graticuleLabel(16.4, 'lon', 0.1)).toBe('16.4° E');
    expect(graticuleLabel(-10, 'lon', 10)).toBe('10° W');
    expect(graticuleLabel(185, 'lon', 5)).toBe('175° W');
    expect(graticuleLabel(0, 'lat', 10)).toBe('0° N');
  });
});
