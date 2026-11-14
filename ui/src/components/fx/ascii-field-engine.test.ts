import { describe, expect, it } from 'vitest';
import { buildScene, EDGE, EMPTY, HEART, noise, PAPER, PETAL, STEM } from './ascii-field-engine';

const count = (scene: ReturnType<typeof buildScene>, kind: number) => scene.kind.reduce((total, value) => total + (value === kind ? 1 : 0), 0);

describe('the flower field', () => {
  it('is the same on every visit', () => {
    expect(noise(3, 9)).toBe(noise(3, 9));
    expect(noise(3, 9)).toBeGreaterThanOrEqual(0);
    expect(noise(3, 9)).toBeLessThan(1);
    const a = buildScene(80, 24, 7.2, 14.6, 0.64);
    const b = buildScene(80, 24, 7.2, 14.6, 0.64);
    expect(Array.from(a.kind)).toEqual(Array.from(b.kind));
    expect(a.glyph).toEqual(b.glyph);
  });

  it('settles into the mark: a heart, petals around it, on a bookmark', () => {
    const scene = buildScene(80, 24, 7.2, 14.6, 0.5);
    const { focus } = scene;
    expect(scene.kind[focus.row * scene.cols + focus.col]).toBe(HEART);
    expect(count(scene, HEART)).toBeGreaterThan(3);
    expect(count(scene, PETAL)).toBeGreaterThan(count(scene, HEART));
    expect(count(scene, PAPER)).toBeGreaterThan(20);
    expect(count(scene, EDGE)).toBeGreaterThan(10);
    // The petals reach out on both sides of the heart and above it.
    const petalCols = [...scene.kind.keys()].filter(index => scene.kind[index] === PETAL).map(index => index % scene.cols);
    expect(Math.min(...petalCols)).toBeLessThan(focus.col - 3);
    expect(Math.max(...petalCols)).toBeGreaterThan(focus.col + 3);
  });

  it('follows its anchor across the width', () => {
    expect(buildScene(100, 24, 7, 14, 0.25).focus.col).toBeLessThan(buildScene(100, 24, 7, 14, 0.75).focus.col);
  });

  it('plants a few small flowers away from the mark, and only draws characters it can align', () => {
    const scene = buildScene(120, 26, 7.2, 14.6, 0.6);
    expect(count(scene, STEM)).toBeGreaterThan(0);
    for (let index = 0; index < scene.kind.length; index++) {
      if (scene.kind[index] === EMPTY) expect(scene.glyph[index]).toBe('');
      else expect([...scene.glyph[index]!]).toHaveLength(1);
    }
  });

  it('survives a box with no room', () => {
    expect(buildScene(0, 0, 7, 14)).toMatchObject({ cols: 0, rows: 0 });
    expect(buildScene(1, 1, 7, 14).kind).toHaveLength(1);
  });
});
