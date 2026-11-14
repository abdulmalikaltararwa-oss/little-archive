import { describe, expect, it } from 'vitest';
import { clusterPoints } from './cluster';

describe('clusterPoints', () => {
  it('keeps points in different cells apart', () => {
    const result = clusterPoints([{ id: 'a', x: 5, y: 5 }, { id: 'b', x: 105, y: 5 }], 60);
    expect(result.map(cluster => cluster.ids)).toEqual([['a'], ['b']]);
    expect(result.every(cluster => cluster.key.startsWith('p:'))).toBe(true);
  });

  it('merges points in one cell into one marker at their average', () => {
    const [only, ...rest] = clusterPoints([{ id: 'b', x: 10, y: 10 }, { id: 'a', x: 20, y: 30 }, { id: 'c', x: 30, y: 20 }], 60);
    expect(rest).toEqual([]);
    expect(only!.ids).toEqual(['a', 'b', 'c']);
    expect(only!.x).toBeCloseTo(20, 6);
    expect(only!.y).toBeCloseTo(20, 6);
    expect(only!.key.startsWith('c:')).toBe(true);
  });

  it('never groups the selected place with its neighbours', () => {
    const result = clusterPoints([{ id: 'a', x: 10, y: 10 }, { id: 'b', x: 12, y: 12 }, { id: 'c', x: 14, y: 14 }], 60, new Set(['b']));
    expect(result.map(cluster => cluster.ids).sort()).toEqual([['a', 'c'], ['b']]);
  });

  it('gives the same answer for the same points in any order', () => {
    const points = [{ id: 'a', x: 1, y: 1 }, { id: 'b', x: 400, y: 300 }, { id: 'c', x: 2, y: 2 }, { id: 'd', x: 401, y: 301 }];
    const forward = clusterPoints(points, 60);
    const backward = clusterPoints([...points].reverse(), 60);
    expect(backward).toEqual(forward);
  });

  it('handles negative positions and no points', () => {
    expect(clusterPoints([], 60)).toEqual([]);
    const result = clusterPoints([{ id: 'a', x: -5, y: -5 }, { id: 'b', x: -50, y: -50 }], 60);
    expect(result).toHaveLength(1);
    expect(result[0]!.ids).toEqual(['a', 'b']);
  });

  it('treats a zero or negative cell as one unit rather than dividing by it', () => {
    expect(clusterPoints([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 5, y: 5 }], 0)).toHaveLength(2);
  });
});
