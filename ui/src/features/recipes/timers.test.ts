import { describe, expect, it } from 'vitest';
import { fractionLeft, isActive, newTimer, nextEnd, parseTimerState, pauseTimer, remainingMs, resetTimer, settleTimer, startTimer, type TimerState } from './timers';

const T0 = 1_700_000_000_000;

describe('a timer over timestamps', () => {
  it('starts with all of its time', () => {
    const timer = newTimer(600);
    expect(timer).toEqual({ status: 'idle', total: 600_000 });
    expect(remainingMs(timer, T0)).toBe(600_000);
    expect(fractionLeft(timer, T0)).toBe(1);
  });

  it('counts down from the moment it was started, not from the ticks it saw', () => {
    const running = startTimer(newTimer(600), T0);
    expect(running).toEqual({ status: 'running', total: 600_000, endsAt: T0 + 600_000 });
    expect(remainingMs(running, T0 + 1)).toBe(599_999);
    expect(remainingMs(running, T0 + 125_500)).toBe(474_500);
    expect(fractionLeft(running, T0 + 300_000)).toBe(0.5);
  });

  it('is exact after a stretch in the background: no tick happened, the answer is still right', () => {
    const running = startTimer(newTimer(60), T0);
    // The tab slept for 75 seconds and nothing ran. The first look afterwards finds it finished, at the right moment.
    const later = settleTimer(running, T0 + 75_000);
    expect(later).toEqual({ status: 'finished', total: 60_000, finishedAt: T0 + 60_000 });
    expect(remainingMs(later, T0 + 75_000)).toBe(0);
    // And one that has not finished is simply the time that is left.
    expect(remainingMs(startTimer(newTimer(600), T0), T0 + 75_000)).toBe(525_000);
  });

  it('is finished exactly at its end, not a moment before', () => {
    const running = startTimer(newTimer(10), T0);
    expect(settleTimer(running, T0 + 9_999).status).toBe('running');
    expect(settleTimer(running, T0 + 10_000).status).toBe('finished');
  });

  it('settling something that is not running changes nothing, and returns the same object', () => {
    const idle = newTimer(10);
    expect(settleTimer(idle, T0)).toBe(idle);
    const running = startTimer(idle, T0);
    expect(settleTimer(running, T0 + 1)).toBe(running);
  });

  it('pauses with the time that was left, and continues from there', () => {
    const running = startTimer(newTimer(600), T0);
    const paused = pauseTimer(running, T0 + 200_000);
    expect(paused).toEqual({ status: 'paused', total: 600_000, remaining: 400_000 });
    // However long it stays paused, nothing is used up.
    expect(remainingMs(paused, T0 + 9_000_000)).toBe(400_000);
    const resumed = startTimer(paused, T0 + 9_000_000);
    expect(resumed).toEqual({ status: 'running', total: 600_000, endsAt: T0 + 9_400_000 });
  });

  it('pausing a timer whose time has passed finishes it instead', () => {
    const paused = pauseTimer(startTimer(newTimer(5), T0), T0 + 8_000);
    expect(paused.status).toBe('finished');
  });

  it('starting a timer that is already running does not move its end', () => {
    const running = startTimer(newTimer(60), T0);
    expect(startTimer(running, T0 + 30_000)).toBe(running);
  });

  it('starts over from the full time once it has finished', () => {
    const finished = settleTimer(startTimer(newTimer(60), T0), T0 + 70_000);
    expect(startTimer(finished, T0 + 80_000)).toEqual({ status: 'running', total: 60_000, endsAt: T0 + 140_000 });
  });

  it('resets from any state', () => {
    for (const timer of [newTimer(30), startTimer(newTimer(30), T0), pauseTimer(startTimer(newTimer(30), T0), T0 + 5000), settleTimer(startTimer(newTimer(30), T0), T0 + 99_000)]) {
      expect(resetTimer(timer)).toEqual({ status: 'idle', total: 30_000 });
    }
  });

  it('never shows more than the whole timer when the clock was set back', () => {
    const running = startTimer(newTimer(60), T0);
    expect(remainingMs(running, T0 - 3_600_000)).toBe(60_000);
  });

  it('knows which timers are in use and when the next one ends', () => {
    const a = startTimer(newTimer(60), T0);
    const b = startTimer(newTimer(20), T0);
    const c = pauseTimer(startTimer(newTimer(500), T0), T0 + 1);
    expect(isActive(a) && isActive(c)).toBe(true);
    expect(isActive(newTimer(5))).toBe(false);
    expect(nextEnd({ 0: a, 3: b, 5: c, 6: newTimer(1) })).toBe(T0 + 20_000);
    expect(nextEnd({ 0: newTimer(5) })).toBeNull();
  });
});

describe('timers read back from storage', () => {
  it('round-trips every state', () => {
    const states: TimerState[] = [newTimer(90), startTimer(newTimer(90), T0), pauseTimer(startTimer(newTimer(90), T0), T0 + 1000), settleTimer(startTimer(newTimer(90), T0), T0 + 99_000)];
    for (const state of states) expect(parseTimerState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it('refuses anything that is not exactly a timer', () => {
    for (const bad of [null, 'running', 5, {}, { status: 'running' }, { status: 'running', total: 60_000 }, { status: 'running', total: -1, endsAt: 5 }, { status: 'paused', total: 1000, remaining: 5000 }, { status: 'idle', total: 5 }, { status: 'idle', total: 999_999_999_999 }, { status: 'finished', total: 60_000 }, { status: 'odd', total: 60_000 }, { status: 'running', total: 60_000, endsAt: 'soon' }]) {
      expect(parseTimerState(bad)).toBeNull();
    }
  });
});
