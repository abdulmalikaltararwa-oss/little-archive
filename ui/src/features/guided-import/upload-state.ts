// What the upload in this page is doing, as a reducer: pure, so the rules are tested without a file or a
// network. It only describes THIS page's session. Which pieces the server holds is the server's answer
// (`upload.received`), and a page that is reloaded starts again from that, not from here.
import { bytesOfPieces, chunkLength } from './chunks';
import type { Explanation } from './words';

export type Phase = 'idle' | 'creating' | 'sending' | 'finishing' | 'paused';

export interface UploadState {
  phase: Phase;
  importId: string | null;
  fileName: string;
  size: number;
  chunkSize: number;
  total: number;
  /** Pieces the server holds: what it already had, plus what this session sent. */
  done: ReadonlySet<number>;
  /** Pieces on their way right now. */
  inflight: ReadonlySet<number>;
  /** How many times a piece was sent again in this session. */
  retries: number;
  /** Bytes sent in this session (not counting pieces the server already had), for the speed. */
  sessionBytes: number;
  startedAt: number | null;
  lastAt: number | null;
  /** Why it stopped, when it stopped on its own. */
  error: Explanation | null;
}

export const IDLE: UploadState = {
  phase: 'idle', importId: null, fileName: '', size: 0, chunkSize: 0, total: 0,
  done: new Set(), inflight: new Set(), retries: 0, sessionBytes: 0, startedAt: null, lastAt: null, error: null,
};

export type UploadAction =
  | { type: 'creating'; fileName: string; size: number }
  | { type: 'sending'; id: string; fileName: string; size: number; chunkSize: number; total: number; received: readonly number[]; at: number }
  | { type: 'piece-started'; index: number }
  | { type: 'piece-done'; index: number; at: number }
  | { type: 'retry' }
  | { type: 'finishing' }
  | { type: 'stopped'; error: Explanation | null }
  | { type: 'reset' };

export function uploadReducer(state: UploadState, action: UploadAction): UploadState {
  switch (action.type) {
    case 'creating':
      return { ...IDLE, phase: 'creating', fileName: action.fileName, size: action.size };
    case 'sending':
      return {
        ...IDLE, phase: 'sending', importId: action.id, fileName: action.fileName, size: action.size, chunkSize: action.chunkSize, total: action.total,
        done: new Set(action.received), startedAt: action.at, lastAt: action.at,
      };
    case 'piece-started': {
      if (state.done.has(action.index) || state.inflight.has(action.index)) return state;
      return { ...state, inflight: new Set(state.inflight).add(action.index) };
    }
    case 'piece-done': {
      const inflight = new Set(state.inflight);
      inflight.delete(action.index);
      // A piece counts once, however many times it was sent.
      if (state.done.has(action.index)) return { ...state, inflight };
      return {
        ...state, inflight, done: new Set(state.done).add(action.index), lastAt: action.at,
        sessionBytes: state.sessionBytes + chunkLength(action.index, state.size, state.chunkSize),
      };
    }
    case 'retry':
      return { ...state, retries: state.retries + 1 };
    case 'finishing':
      return { ...state, phase: 'finishing', inflight: new Set() };
    case 'stopped':
      // Before an import exists there is nothing to continue: go back to the start with the reason.
      return { ...state, phase: state.importId ? 'paused' : 'idle', inflight: new Set(), error: action.error };
    case 'reset':
      return IDLE;
  }
}

/* Reading it -------------------------------------------------------------------------------------------- */

export const isBusy = (state: UploadState) => state.phase === 'creating' || state.phase === 'sending' || state.phase === 'finishing';

export function doneBytes(state: UploadState): number {
  return bytesOfPieces(state.done, state.size, state.chunkSize);
}

/** How much of the file the server holds, 0 to 1. */
export function fraction(state: UploadState): number {
  return state.size > 0 ? Math.min(1, doneBytes(state) / state.size) : 0;
}

/** Bytes per second over this session, or null until there is enough to say (a second of sending, a piece landed). */
export function bytesPerSecond(state: UploadState): number | null {
  if (state.startedAt == null || state.lastAt == null || state.sessionBytes <= 0) return null;
  const seconds = (state.lastAt - state.startedAt) / 1000;
  return seconds >= 1 ? state.sessionBytes / seconds : null;
}

/** An estimate of the seconds left at the speed so far, or null when there is no speed yet. */
export function secondsLeft(state: UploadState): number | null {
  const rate = bytesPerSecond(state);
  if (rate == null) return null;
  return Math.max(0, (state.size - doneBytes(state)) / rate);
}
