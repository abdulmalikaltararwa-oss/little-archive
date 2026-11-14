import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/data/client';
import { backoffMs, hex, isAbort, isRetryable, readPiece, retrying, sendPieces, type Delay } from './upload';

const never = new AbortController().signal;
const instant: Delay = async () => {};
const network = () => new ApiError('Could not reach your archive.', 0);
const refused = (code: string, status = 422) => new ApiError('no', status, code);
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
/** Waits like a request on its way: until `ms` pass, or an abort rejects it (at once, if it has already happened). */
const request = (signal: AbortSignal, ms: number) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(aborted()); return; }
    signal.addEventListener('abort', () => reject(aborted()), { once: true });
    setTimeout(resolve, ms);
  });

afterEach(() => vi.unstubAllGlobals());

describe('which failures are worth another go', () => {
  it('retries a dropped connection, a gateway having a moment, and a damaged piece', () => {
    for (const status of [0, 408, 429, 500, 502, 503, 504]) expect(isRetryable(new ApiError('x', status)), String(status)).toBe(true);
    expect(isRetryable(refused('chunk_checksum_mismatch'))).toBe(true);
  });

  it('does not retry what would fail the same way again', () => {
    expect(isRetryable(refused('bad_chunk_size'))).toBe(false);
    expect(isRetryable(refused('not_uploading', 409))).toBe(false);
    expect(isRetryable(refused('import_not_found', 404))).toBe(false);
    expect(isRetryable(new ApiError('Sign in', 401))).toBe(false);
    expect(isRetryable(new Error('plain'))).toBe(false);
  });

  it('waits a little longer each time, up to four seconds', () => {
    expect([0, 1, 2, 3, 4, 9].map(backoffMs)).toEqual([400, 800, 1600, 3200, 4000, 4000]);
  });
});

describe('retrying', () => {
  it('returns at once when it works', async () => {
    const attempt = vi.fn().mockResolvedValue('ok');
    await expect(retrying(attempt, { retries: 2, signal: never, delay: instant })).resolves.toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('tries again after a network failure and reports each retry', async () => {
    const attempt = vi.fn().mockRejectedValueOnce(network()).mockRejectedValueOnce(network()).mockResolvedValue('ok');
    const retries: number[] = [];
    await expect(retrying(attempt, { retries: 2, signal: never, delay: instant, onRetry: n => retries.push(n) })).resolves.toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(retries).toEqual([1, 2]);
  });

  it('gives up after the retries are used and throws the last error', async () => {
    const attempt = vi.fn().mockRejectedValue(network());
    await expect(retrying(attempt, { retries: 2, signal: never, delay: instant })).rejects.toMatchObject({ status: 0 });
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('does not retry an answer that would not change', async () => {
    const attempt = vi.fn().mockRejectedValue(refused('bad_chunk_size'));
    await expect(retrying(attempt, { retries: 2, signal: never, delay: instant })).rejects.toMatchObject({ code: 'bad_chunk_size' });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('does not start when it was already told to stop', async () => {
    const controller = new AbortController();
    controller.abort();
    const attempt = vi.fn();
    await expect(retrying(attempt, { retries: 2, signal: controller.signal, delay: instant })).rejects.toSatisfy(isAbort);
    expect(attempt).not.toHaveBeenCalled();
  });
});

describe('sending the missing pieces', () => {
  const run = (missing: number[], overrides: Partial<Parameters<typeof sendPieces<string>>[0]> = {}) => {
    const sent: number[] = [];
    const finished: number[] = [];
    const options = {
      missing,
      read: async (index: number) => `piece-${index}`,
      send: async (index: number) => { sent.push(index); },
      signal: never,
      delay: instant,
      onPiece: (index: number) => { finished.push(index); },
      ...overrides,
    };
    return { sent, finished, promise: sendPieces<string>(options) };
  };

  it('sends exactly the pieces it is given, each once', async () => {
    const { sent, finished, promise } = run([4, 5, 7, 8, 9]);
    await promise;
    expect([...sent].sort()).toEqual([4, 5, 7, 8, 9]);
    expect([...finished].sort()).toEqual([4, 5, 7, 8, 9]);
  });

  it('sends nothing, and succeeds, when nothing is missing', async () => {
    const { sent, promise } = run([]);
    await expect(promise).resolves.toBeUndefined();
    expect(sent).toEqual([]);
  });

  it('hands each piece to send as it was read', async () => {
    const seen: string[] = [];
    await run([2, 3], { send: async (_index, piece) => { seen.push(piece); } }).promise;
    expect(seen.sort()).toEqual(['piece-2', 'piece-3']);
  });

  it('never has more pieces in flight than the pool allows', async () => {
    let flying = 0;
    let most = 0;
    await run(Array.from({ length: 12 }, (_, index) => index), {
      concurrency: 3,
      send: async () => { flying += 1; most = Math.max(most, flying); await tick(); flying -= 1; },
    }).promise;
    expect(most).toBe(3);
  });

  it('reads a piece only when a worker reaches it, not all at once', async () => {
    const reads: number[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { promise } = run([0, 1, 2, 3, 4, 5], {
      concurrency: 2,
      read: async index => { reads.push(index); return `p${index}`; },
      send: async () => { await gate; },
    });
    await tick();
    expect(reads.length).toBe(2);
    release();
    await promise;
    expect(reads.length).toBe(6);
  });

  it('sends a piece again after a network failure and carries on', async () => {
    let first = true;
    const retries: [number, number][] = [];
    const { finished, promise } = run([0, 1], {
      concurrency: 1,
      send: async index => { if (index === 0 && first) { first = false; throw network(); } },
      onRetry: (index, attempt) => { retries.push([index, attempt]); },
    });
    await promise;
    expect(finished).toEqual([0, 1]);
    expect(retries).toEqual([[0, 1]]);
  });

  it('stops at the first piece that cannot be sent, and says why', async () => {
    const attempted: number[] = [];
    const { finished, promise } = run([0, 1, 2, 3, 4], {
      concurrency: 1,
      send: async index => { attempted.push(index); if (index === 2) throw refused('bad_chunk_size'); },
    });
    await expect(promise).rejects.toMatchObject({ code: 'bad_chunk_size' });
    expect(finished).toEqual([0, 1]);
    expect(attempted).toEqual([0, 1, 2]);
  });

  it('calls the other workers off when one gives up, and reports the real failure rather than the cancellations', async () => {
    const started: number[] = [];
    const { promise } = run([0, 1, 2, 3, 4, 5, 6, 7], {
      concurrency: 3,
      delay: instant,
      send: async (index, _piece, signal) => {
        started.push(index);
        if (index === 1) throw refused('not_uploading', 409);
        await request(signal, 50);
      },
    });
    await expect(promise).rejects.toMatchObject({ code: 'not_uploading' });
    expect(started.length).toBeLessThan(8);
  });

  it('is stopped by the caller’s signal and says so', async () => {
    const controller = new AbortController();
    const { promise } = run([0, 1, 2], {
      concurrency: 1,
      signal: controller.signal,
      send: async (_index, _piece, signal) => { controller.abort(); await request(signal, 1000); },
    });
    await expect(promise).rejects.toSatisfy(isAbort);
  });

  it('does nothing if it was stopped before it began', async () => {
    const controller = new AbortController();
    controller.abort();
    const { sent, promise } = run([0, 1], { signal: controller.signal });
    await expect(promise).rejects.toSatisfy(isAbort);
    expect(sent).toEqual([]);
  });

  it('tells the caller when each piece starts', async () => {
    const started: number[] = [];
    await run([3, 4], { concurrency: 1, onStart: index => { started.push(index); } }).promise;
    expect(started).toEqual([3, 4]);
  });
});

describe('reading a piece', () => {
  const fake = (size: number) => ({
    size,
    slice: (start: number, end: number) => ({ size: end - start, start, end, arrayBuffer: async () => new Uint8Array([start % 256, end % 256]).buffer }) as unknown as Blob,
  });

  it('writes bytes as hex', () => {
    expect(hex(new Uint8Array([0, 1, 15, 16, 255]).buffer)).toBe('00010f10ff');
  });

  it('cuts the right range, and without hashing sends the slice as it is', async () => {
    const piece = await readPiece(fake(2500), 2, 1000, false);
    expect(piece.sha256).toBeUndefined();
    expect(piece.body).toMatchObject({ start: 2000, end: 2500 });
  });

  it('hashes the one piece it read, and sends that same buffer', async () => {
    const digest = vi.fn(async () => new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer);
    vi.stubGlobal('crypto', { subtle: { digest } });
    const piece = await readPiece(fake(2500), 1, 1000, true);
    expect(piece.sha256).toBe('deadbeef');
    expect(digest).toHaveBeenCalledTimes(1);
    expect(digest.mock.calls[0]).toHaveLength(2);
    expect(piece.body).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(piece.body as ArrayBuffer))).toEqual([1000 % 256, 2000 % 256]);
  });
});
