import { describe, expect, it } from 'vitest';
import type { Range } from './api';
import { bytesOfPieces, chunkBounds, chunkCount, chunkLength, expandRanges, missingPieces, pieceMap, sliceRanges, toRanges } from './chunks';

const MIB = 1024 * 1024;

describe('cutting a file into pieces', () => {
  it('counts pieces the way the server does: the last may be shorter', () => {
    expect(chunkCount(10 * MIB, MIB)).toBe(10);
    expect(chunkCount(10 * MIB + 1, MIB)).toBe(11);
    expect(chunkCount(1, MIB)).toBe(1);
    expect(chunkCount(MIB, MIB)).toBe(1);
  });

  it('has no pieces for an empty file or an impossible piece size', () => {
    expect(chunkCount(0, MIB)).toBe(0);
    expect(chunkCount(100, 0)).toBe(0);
    expect(chunkCount(Number.NaN, 10)).toBe(0);
  });

  it('slices at exact multiples of the piece size and ends at the end of the file', () => {
    expect(chunkBounds(0, 2500, 1000)).toEqual({ start: 0, end: 1000 });
    expect(chunkBounds(1, 2500, 1000)).toEqual({ start: 1000, end: 2000 });
    expect(chunkBounds(2, 2500, 1000)).toEqual({ start: 2000, end: 2500 });
  });

  it('knows how long each piece is', () => {
    expect([0, 1, 2].map(index => chunkLength(index, 2500, 1000))).toEqual([1000, 1000, 500]);
    expect(chunkLength(3, 2500, 1000)).toBe(0);
  });

  it('lists every piece once and covers the file exactly', () => {
    const pieces = sliceRanges(2500, 1000);
    expect(pieces).toEqual([{ index: 0, start: 0, end: 1000 }, { index: 1, start: 1000, end: 2000 }, { index: 2, start: 2000, end: 2500 }]);
    expect(pieces.reduce((sum, piece) => sum + (piece.end - piece.start), 0)).toBe(2500);
  });

  it('adds up bytes for any set of pieces, counting the short one for what it is', () => {
    expect(bytesOfPieces([0, 1, 2], 2500, 1000)).toBe(2500);
    expect(bytesOfPieces([2], 2500, 1000)).toBe(500);
    expect(bytesOfPieces(new Set([0, 2]), 2500, 1000)).toBe(1500);
    expect(bytesOfPieces([], 2500, 1000)).toBe(0);
  });
});

describe('what the server already holds', () => {
  it('reads the server ranges as piece numbers', () => {
    expect(expandRanges([[0, 2], [5, 5], [7, 8]])).toEqual([0, 1, 2, 5, 7, 8]);
  });

  it('forgives overlaps, disorder and nonsense', () => {
    expect(expandRanges([[3, 5], [0, 1], [4, 6]])).toEqual([0, 1, 3, 4, 5, 6]);
    expect(expandRanges([[4, 2], [1.5, 3], [-2, 0]] as Range[])).toEqual([0]);
    expect(expandRanges(null)).toEqual([]);
    expect(expandRanges(undefined)).toEqual([]);
    expect(expandRanges([[1, 2, 3]] as unknown as Range[])).toEqual([]);
  });

  it('never invents pieces beyond the end of the file', () => {
    expect(expandRanges([[0, 99]], 4)).toEqual([0, 1, 2, 3]);
  });

  it('folds piece numbers back into ranges', () => {
    expect(toRanges([5, 0, 1, 2, 7, 8, 2])).toEqual([[0, 2], [5, 5], [7, 8]]);
    expect(toRanges([])).toEqual([]);
  });

  it('works out the pieces still to send, which is all a resumed upload sends', () => {
    expect(missingPieces(10, [[0, 3], [6, 6]])).toEqual([4, 5, 7, 8, 9]);
    expect(missingPieces(4, [])).toEqual([0, 1, 2, 3]);
    expect(missingPieces(4, [[0, 3]])).toEqual([]);
    expect(missingPieces(0, [])).toEqual([]);
  });

  it('is the inverse of what the server reports', () => {
    const have: Range[] = [[0, 1], [4, 5]];
    const missing = missingPieces(8, have);
    expect(toRanges([...expandRanges(have), ...missing])).toEqual([[0, 7]]);
  });
});

describe('the piece map', () => {
  it('draws one character per piece when there are few', () => {
    expect(pieceMap(5, new Set([0, 1]), new Set([2]), 48)).toBe('██▒░░');
  });

  it('groups pieces when there are too many to draw, and only calls a group full when all of it is', () => {
    const done = new Set(Array.from({ length: 100 }, (_, index) => index));
    const map = pieceMap(400, done, new Set(), 4);
    expect(map).toBe('█░░░');
    expect(pieceMap(400, new Set([0]), new Set(), 4)).toBe('▒░░░');
  });

  it('is empty for an empty file', () => {
    expect(pieceMap(0, new Set(), new Set())).toBe('');
  });
});
