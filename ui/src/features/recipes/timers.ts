// A kitchen timer as a small state machine over timestamps, never over ticks. A running timer remembers the
// moment it ends (`endsAt`), so what is left is always `endsAt - now`: a tab that was in the background, a
// phone that slept, or a render that was late cannot make it drift. All times are milliseconds; `now` is
// passed in, so every rule can be tested with a made-up clock.

export type TimerState =
  | { status: 'idle'; total: number }
  | { status: 'running'; total: number; endsAt: number }
  | { status: 'paused'; total: number; remaining: number }
  | { status: 'finished'; total: number; finishedAt: number };

export function newTimer(seconds: number): TimerState {
  return { status: 'idle', total: Math.max(1, Math.round(seconds)) * 1000 };
}

/** Starts an idle timer, continues a paused one, and starts a finished one over. Starting a running timer changes nothing. */
export function startTimer(timer: TimerState, now: number): TimerState {
  switch (timer.status) {
    case 'running': return timer;
    case 'paused': return { status: 'running', total: timer.total, endsAt: now + timer.remaining };
    default: return { status: 'running', total: timer.total, endsAt: now + timer.total };
  }
}

/** The state of a timer at `now`. A running timer whose end has passed is finished, and says when it finished. */
export function settleTimer(timer: TimerState, now: number): TimerState {
  if (timer.status === 'running' && now >= timer.endsAt) return { status: 'finished', total: timer.total, finishedAt: timer.endsAt };
  return timer;
}

export function pauseTimer(timer: TimerState, now: number): TimerState {
  const current = settleTimer(timer, now);
  if (current.status !== 'running') return current;
  return { status: 'paused', total: current.total, remaining: Math.max(0, Math.min(current.total, current.endsAt - now)) };
}

export function resetTimer(timer: TimerState): TimerState {
  return { status: 'idle', total: timer.total };
}

/** Milliseconds left, never more than the whole timer even if the clock was set back. */
export function remainingMs(timer: TimerState, now: number): number {
  switch (timer.status) {
    case 'idle': return timer.total;
    case 'paused': return timer.remaining;
    case 'finished': return 0;
    case 'running': return Math.max(0, Math.min(timer.total, timer.endsAt - now));
  }
}

/** How much of the timer is left, from 1 (all of it) to 0. */
export function fractionLeft(timer: TimerState, now: number): number {
  return timer.total ? remainingMs(timer, now) / timer.total : 0;
}

export const isActive = (timer: TimerState) => timer.status === 'running' || timer.status === 'paused';

/** The earliest moment a running timer in the set ends, or null when none is running. */
export function nextEnd(timers: Record<number, TimerState>): number | null {
  let soonest: number | null = null;
  for (const timer of Object.values(timers)) if (timer.status === 'running' && (soonest === null || timer.endsAt < soonest)) soonest = timer.endsAt;
  return soonest;
}

/** Reads a timer back from storage. Anything that is not exactly a timer is refused rather than trusted. */
export function parseTimerState(value: unknown): TimerState | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  const finite = (field: unknown): field is number => typeof field === 'number' && Number.isFinite(field) && field >= 0;
  if (!finite(entry.total) || entry.total < 1000 || entry.total > 259_200_000) return null;
  const total = entry.total;
  switch (entry.status) {
    case 'idle': return { status: 'idle', total };
    case 'running': return finite(entry.endsAt) ? { status: 'running', total, endsAt: entry.endsAt } : null;
    case 'paused': return finite(entry.remaining) && entry.remaining <= total ? { status: 'paused', total, remaining: entry.remaining } : null;
    case 'finished': return finite(entry.finishedAt) ? { status: 'finished', total, finishedAt: entry.finishedAt } : null;
    default: return null;
  }
}
