import { describe, expect, it } from 'vitest';
import { bytesPerSecond, doneBytes, fraction, IDLE, isBusy, secondsLeft, uploadReducer, type UploadAction, type UploadState } from './upload-state';

const sending = (received: number[] = [], at = 0): UploadAction => ({ type: 'sending', id: 'abc', fileName: 'export.zip', size: 2500, chunkSize: 1000, total: 3, received, at });
const run = (...actions: UploadAction[]): UploadState => actions.reduce(uploadReducer, IDLE);

describe('the upload session', () => {
  it('starts idle and not busy', () => {
    expect(IDLE.phase).toBe('idle');
    expect(isBusy(IDLE)).toBe(false);
  });

  it('creating the import is busy work with nothing sent', () => {
    const state = run({ type: 'creating', fileName: 'export.zip', size: 2500 });
    expect(state.phase).toBe('creating');
    expect(isBusy(state)).toBe(true);
    expect(state.fileName).toBe('export.zip');
  });

  it('starts from the pieces the server already holds, which is how a resume looks', () => {
    const state = run(sending([0, 1]));
    expect(state.phase).toBe('sending');
    expect([...state.done]).toEqual([0, 1]);
    expect(doneBytes(state)).toBe(2000);
    expect(state.sessionBytes).toBe(0);
  });

  it('moves a piece from on its way to done, and counts its bytes (the short last piece for what it is)', () => {
    let state = run(sending(), { type: 'piece-started', index: 2 });
    expect([...state.inflight]).toEqual([2]);
    state = uploadReducer(state, { type: 'piece-done', index: 2, at: 500 });
    expect(state.inflight.size).toBe(0);
    expect(state.sessionBytes).toBe(500);
    expect(doneBytes(state)).toBe(500);
  });

  it('counts a piece once, even if it is reported twice', () => {
    const state = run(sending(), { type: 'piece-done', index: 0, at: 100 }, { type: 'piece-done', index: 0, at: 200 });
    expect(state.sessionBytes).toBe(1000);
    expect(state.done.size).toBe(1);
  });

  it('does not count a piece the server already had as sent in this session', () => {
    const state = run(sending([0]), { type: 'piece-done', index: 0, at: 100 });
    expect(state.sessionBytes).toBe(0);
  });

  it('does not show a finished piece as on its way', () => {
    const state = run(sending([1]), { type: 'piece-started', index: 1 });
    expect(state.inflight.size).toBe(0);
  });

  it('counts retries', () => {
    expect(run(sending(), { type: 'retry' }, { type: 'retry' }).retries).toBe(2);
  });

  it('finishing clears what was on its way', () => {
    const state = run(sending(), { type: 'piece-started', index: 0 }, { type: 'finishing' });
    expect(state.phase).toBe('finishing');
    expect(state.inflight.size).toBe(0);
    expect(isBusy(state)).toBe(true);
  });

  it('keeps what was sent when it stops, so continuing is possible', () => {
    const reason = { title: 'The connection was lost', what: 'x', next: 'y' };
    const state = run(sending(), { type: 'piece-done', index: 0, at: 100 }, { type: 'piece-started', index: 1 }, { type: 'stopped', error: reason });
    expect(state.phase).toBe('paused');
    expect([...state.done]).toEqual([0]);
    expect(state.inflight.size).toBe(0);
    expect(state.error).toEqual(reason);
    expect(isBusy(state)).toBe(false);
  });

  it('goes back to idle, with the reason, if it stops before an import exists', () => {
    const reason = { title: 'Too big', what: 'x', next: 'y' };
    const state = run({ type: 'creating', fileName: 'a.zip', size: 1 }, { type: 'stopped', error: reason });
    expect(state.phase).toBe('idle');
    expect(state.error).toEqual(reason);
  });

  it('resets to nothing', () => {
    expect(run(sending([0]), { type: 'reset' })).toEqual(IDLE);
  });
});

describe('progress, speed and what is left', () => {
  it('is a fraction of the file, never more than all of it', () => {
    expect(fraction(IDLE)).toBe(0);
    expect(fraction(run(sending([0, 1])))).toBeCloseTo(0.8);
    expect(fraction(run(sending([0, 1, 2])))).toBe(1);
  });

  it('has no speed until a second has passed and something landed', () => {
    expect(bytesPerSecond(run(sending()))).toBeNull();
    expect(bytesPerSecond(run(sending(), { type: 'piece-done', index: 0, at: 400 }))).toBeNull();
  });

  it('works out a speed and an estimate from what this session sent', () => {
    const state = run(sending([], 1000), { type: 'piece-done', index: 0, at: 3000 }, { type: 'piece-done', index: 1, at: 5000 });
    // 2000 bytes in 4 seconds.
    expect(bytesPerSecond(state)).toBe(500);
    // 500 bytes left at 500 per second.
    expect(secondsLeft(state)).toBe(1);
  });

  it('does not let a resume’s old pieces flatter the speed', () => {
    const state = run(sending([0, 1], 0), { type: 'piece-done', index: 2, at: 2000 });
    expect(bytesPerSecond(state)).toBe(250);
    expect(secondsLeft(state)).toBe(0);
  });
});
