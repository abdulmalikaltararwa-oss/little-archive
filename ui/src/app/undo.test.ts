import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHeld, hasHeld, holdWithUndo, UNDO_MS } from './undo';
import { toast, useIsland } from './ui-state';

const messages = () => useIsland.getState().messages;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  flushHeld();
  for (const message of messages()) useIsland.getState().dismiss(message.id);
  vi.useRealTimers();
});

describe('a change held back so it can be undone', () => {
  it('is sent once, when the time to undo has passed', () => {
    const commit = vi.fn();
    const undo = vi.fn();
    holdWithUndo('Deleted “A save”', { commit, undo });
    expect(messages().at(-1)).toMatchObject({ text: 'Deleted “A save”', action: { label: 'Undo' } });
    vi.advanceTimersByTime(UNDO_MS - 1);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(undo).not.toHaveBeenCalled();
    expect(messages()).toHaveLength(0);
    vi.advanceTimersByTime(60_000);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('is never sent when Undo is pressed', () => {
    const commit = vi.fn();
    const undo = vi.fn();
    holdWithUndo('Deleted', { commit, undo });
    messages().at(-1)!.action!.run();
    expect(undo).toHaveBeenCalledTimes(1);
    expect(hasHeld()).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(commit).not.toHaveBeenCalled();
    expect(messages()).toHaveLength(0);
  });

  it('is sent at once when the next change is made, and each is sent once', () => {
    const first = vi.fn();
    const second = vi.fn();
    holdWithUndo('One', { commit: first, undo: vi.fn() });
    holdWithUndo('Two', { commit: second, undo: vi.fn() });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(messages().map(message => message.text)).toEqual(['Two']);
    vi.advanceTimersByTime(UNDO_MS);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('is sent when its message is put away by hand, and when asked to', () => {
    const commit = vi.fn();
    holdWithUndo('One', { commit, undo: vi.fn() });
    useIsland.getState().dismiss(messages().at(-1)!.id);
    expect(commit).toHaveBeenCalledTimes(1);

    const next = vi.fn();
    holdWithUndo('Two', { commit: next, undo: vi.fn() });
    flushHeld();
    expect(next).toHaveBeenCalledTimes(1);
    expect(hasHeld()).toBe(false);
  });

  it('keeps its Undo on the island while other things are said', () => {
    const commit = vi.fn();
    holdWithUndo('Deleted', { commit, undo: vi.fn() });
    toast('Marked as done.');
    expect(messages().map(message => message.text)).toEqual(['Deleted', 'Marked as done.']);
    expect(commit).not.toHaveBeenCalled();
  });

  it('an Undo pressed after the change was sent does nothing', () => {
    const commit = vi.fn();
    const undo = vi.fn();
    holdWithUndo('Deleted', { commit, undo });
    const action = messages().at(-1)!.action!;
    vi.advanceTimersByTime(UNDO_MS);
    action.run();
    expect(undo).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
