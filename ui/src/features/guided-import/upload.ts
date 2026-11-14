// Sending the pieces. A small pool of workers takes the missing pieces in order; each piece is read from the
// file only when its worker reaches it (Blob.slice does not copy), hashed on its own when the browser can,
// and sent again a couple of times if the network or a gateway let it down. The first piece that cannot be
// sent stops the rest, and everything that already arrived stays on the server for the next try.
//
// The engine is generic over what a piece is and how it is sent, so it is tested with plain functions.
import { ApiError } from '@/data/client';
import { chunkBounds } from './chunks';

export const CONCURRENCY = 3;
/** Each piece is tried once and sent again twice. */
export const RETRIES = 2;

const RETRYABLE_STATUS = new Set([0, 408, 425, 429, 500, 502, 503, 504]);

export function abortError(): Error {
  return typeof DOMException === 'function' ? new DOMException('The upload was stopped.', 'AbortError') : Object.assign(new Error('The upload was stopped.'), { name: 'AbortError' });
}

export const isAbort = (error: unknown): boolean => (error as { name?: string } | null)?.name === 'AbortError';

/**
 * Worth sending again: the network dropped (status 0), a gateway or the server was briefly unwell, or a piece
 * was damaged on the way (its checksum did not match). Everything else (a wrong size, a closed import, a
 * refused session) would fail the same way again.
 */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return RETRYABLE_STATUS.has(error.status) || error.code === 'chunk_checksum_mismatch';
}

/** A short wait that grows: 0.4 s, 0.8 s, 1.6 s, never more than 4 s. */
export function backoffMs(attempt: number): number {
  return Math.min(4000, 400 * 2 ** attempt);
}

export type Delay = (ms: number, signal: AbortSignal) => Promise<void>;

/** A wait that ends early, with an abort, when the signal fires. */
export const wait: Delay = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(abortError()); };
    signal.addEventListener('abort', stop, { once: true });
  });

export interface RetryOptions {
  retries: number;
  signal: AbortSignal;
  delay?: Delay;
  onRetry?: (attempt: number, error: unknown) => void;
}

/** Runs `attempt`, and runs it again after a wait if it fails in a way worth another go, up to `retries` more times. */
export async function retrying<T>(attempt: () => Promise<T>, { retries, signal, delay = wait, onRetry }: RetryOptions): Promise<T> {
  for (let tries = 0; ; tries += 1) {
    if (signal.aborted) throw abortError();
    try {
      return await attempt();
    } catch (error) {
      if (isAbort(error) || tries >= retries || !isRetryable(error)) throw error;
      onRetry?.(tries + 1, error);
      await delay(backoffMs(tries), signal);
    }
  }
}

export interface SendPiecesOptions<Piece> {
  /** The piece numbers to send, in the order to send them. */
  missing: readonly number[];
  /** Cuts one piece out of the file. Called by a worker only when it reaches that piece. */
  read(index: number): Promise<Piece>;
  /** Sends one piece. It is given the signal so an abort cancels a request on its way. */
  send(index: number, piece: Piece, signal: AbortSignal): Promise<unknown>;
  signal: AbortSignal;
  concurrency?: number;
  retries?: number;
  delay?: Delay;
  onStart?(index: number): void;
  onPiece(index: number): void;
  onRetry?(index: number, attempt: number, error: unknown): void;
}

/**
 * Sends `missing` with at most `concurrency` pieces in flight. Resolves when every piece has been sent; rejects
 * with the first real failure (after the others have been called off), or with an AbortError if the caller's
 * signal fired.
 */
export async function sendPieces<Piece>(options: SendPiecesOptions<Piece>): Promise<void> {
  const { missing, read, send, signal, concurrency = CONCURRENCY, retries = RETRIES, delay = wait, onStart, onPiece, onRetry } = options;
  const inner = new AbortController();
  const stop = () => inner.abort();
  if (signal.aborted) throw abortError();
  signal.addEventListener('abort', stop, { once: true });

  let cursor = 0;
  let failure: unknown;
  let failed = false;

  const worker = async () => {
    while (!inner.signal.aborted) {
      const at = cursor;
      cursor += 1;
      if (at >= missing.length) return;
      const index = missing[at]!;
      try {
        const piece = await read(index);
        onStart?.(index);
        await retrying(() => send(index, piece, inner.signal), { retries, signal: inner.signal, delay, onRetry: (attempt, error) => onRetry?.(index, attempt, error) });
        onPiece(index);
      } catch (error) {
        // The first failure is the real one; the aborts it causes in the other workers are not news.
        if (!failed) { failed = true; failure = error; }
        inner.abort();
        return;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, missing.length)) }, worker));
  } finally {
    signal.removeEventListener('abort', stop);
  }
  if (failed) throw failure;
  if (signal.aborted) throw abortError();
}

/* Reading a piece ------------------------------------------------------------------------------------------ */

export interface ReadPiece { body: Blob | ArrayBuffer; sha256?: string }

/** True where the browser can hash (a secure page: https or localhost). */
export function canHash(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.subtle?.digest === 'function';
}

export function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Cuts one piece out of `file`. With hashing, the piece is read into memory once (a few hundred KiB to a
 * MiB), hashed, and that same buffer is what is sent; without it the slice goes out as it is and the browser
 * streams it from disk. Either way no more than one piece per worker is held at a time.
 */
export async function readPiece(file: Pick<Blob, 'slice' | 'size'>, index: number, chunkSize: number, hash = canHash()): Promise<ReadPiece> {
  const { start, end } = chunkBounds(index, file.size, chunkSize);
  const slice = file.slice(start, end);
  if (!hash) return { body: slice };
  const buffer = await slice.arrayBuffer();
  return { body: buffer, sha256: hex(await crypto.subtle.digest('SHA-256', buffer)) };
}
