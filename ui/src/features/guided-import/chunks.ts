// How a file becomes pieces, and which pieces a server still needs. The server numbers pieces from 0, makes
// every piece exactly `chunk_size` bytes except the last, and reports what it holds as inclusive ranges
// ([[0, 4], [7, 7]] is pieces 0 to 4 and 7). Nothing here touches the file's bytes: a range of the file is
// worked out first and only then handed to Blob.slice, so the whole file is never held in memory.
import type { Range } from './api';

/** How many pieces a file of `size` bytes makes. */
export function chunkCount(size: number, chunkSize: number): number {
  if (!(size > 0) || !(chunkSize > 0)) return 0;
  return Math.ceil(size / chunkSize);
}

/** The byte range of one piece: `end` is exclusive, as Blob.slice wants it. */
export function chunkBounds(index: number, size: number, chunkSize: number): { start: number; end: number } {
  const start = index * chunkSize;
  return { start, end: Math.min(size, start + chunkSize) };
}

/** How many bytes the piece holds: `chunkSize`, except the last, which is whatever is left. */
export function chunkLength(index: number, size: number, chunkSize: number): number {
  const { start, end } = chunkBounds(index, size, chunkSize);
  return Math.max(0, end - start);
}

/** Every piece of the file as a byte range, in order. For tests and small files: a large file is walked by index. */
export function sliceRanges(size: number, chunkSize: number): { index: number; start: number; end: number }[] {
  return Array.from({ length: chunkCount(size, chunkSize) }, (_, index) => ({ index, ...chunkBounds(index, size, chunkSize) }));
}

/** Piece numbers from the server's inclusive ranges, sorted and without repeats. Malformed ranges are ignored. */
export function expandRanges(ranges: readonly Range[] | null | undefined, total = Number.POSITIVE_INFINITY): number[] {
  const seen = new Set<number>();
  for (const range of ranges ?? []) {
    if (!Array.isArray(range) || range.length !== 2) continue;
    const [first, last] = range;
    if (!Number.isInteger(first) || !Number.isInteger(last) || last < first) continue;
    for (let index = Math.max(0, first); index <= last && index < total; index += 1) seen.add(index);
  }
  return [...seen].sort((a, b) => a - b);
}

/** The other way round: sorted piece numbers folded into inclusive ranges. */
export function toRanges(indexes: Iterable<number>): Range[] {
  const out: Range[] = [];
  for (const index of [...new Set(indexes)].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && index === last[1] + 1) last[1] = index;
    else out.push([index, index]);
  }
  return out;
}

/** The pieces a file of `total` pieces still has to send, given what the server says it holds. */
export function missingPieces(total: number, received: readonly Range[] | null | undefined): number[] {
  const have = new Set(expandRanges(received, total));
  const out: number[] = [];
  for (let index = 0; index < total; index += 1) if (!have.has(index)) out.push(index);
  return out;
}

/** The bytes that `indexes` add up to, counting the short last piece for what it is. */
export function bytesOfPieces(indexes: Iterable<number>, size: number, chunkSize: number): number {
  let bytes = 0;
  for (const index of indexes) bytes += chunkLength(index, size, chunkSize);
  return bytes;
}

/**
 * A strip of characters, one per piece (or one per group of pieces when there are too many to draw): a full
 * block where every piece of the group is on the server, a medium block where some are or one is on its way,
 * a light block where none are. A decoration for the eyes; the numbers beside it are the real answer.
 */
export function pieceMap(total: number, done: ReadonlySet<number>, inflight: ReadonlySet<number>, cells = 48): string {
  if (total <= 0) return '';
  const width = Math.min(total, Math.max(1, cells));
  const group = total / width;
  let out = '';
  for (let cell = 0; cell < width; cell += 1) {
    const from = Math.floor(cell * group);
    const to = Math.max(from + 1, Math.floor((cell + 1) * group));
    let have = 0;
    let moving = false;
    for (let index = from; index < to; index += 1) {
      if (done.has(index)) have += 1;
      else if (inflight.has(index)) moving = true;
    }
    out += have === to - from ? '█' : have > 0 || moving ? '▒' : '░';
  }
  return out;
}
