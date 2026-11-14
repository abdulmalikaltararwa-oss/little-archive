// Every timer of a cook session, together. Timers are kept by step, so they run side by side and keep running
// as the cook moves between steps. The state is timestamps (see timers.ts); this hook adds the two things a
// state machine cannot do by itself: show the time passing, and notice the moment a timer ends, even when
// the tab was in the background, and ring.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { tickNow, useClock } from './use-clock';
import { newTimer, nextEnd, pauseTimer, resetTimer, settleTimer, startTimer, type TimerState } from './timers';

export interface TimerApi {
  /** Each timer as it is at this moment: one whose time has passed is already finished. */
  timers: Record<number, TimerState>;
  /** What to save: only what was set, as it was last stored. */
  stored: Record<number, TimerState>;
  now: number;
  start(step: number, seconds: number): void;
  pause(step: number): void;
  reset(step: number, seconds: number): void;
  /** Forgets every timer (cooking it again from the top). */
  clear(): void;
}

export function useTimers(initial: Record<number, TimerState>, onFinish: (step: number) => void): TimerApi {
  const [stored, setStored] = useState(initial);
  const running = useMemo(() => Object.values(stored).some(timer => timer.status === 'running'), [stored]);
  const now = useClock(running);
  const finish = useRef(onFinish);
  useEffect(() => { finish.current = onFinish; });

  // The alarm. One timeout for the earliest end, set again whenever the timers change. A hidden tab may run
  // it late, so it also checks the moment the tab is shown again; the time on the face is right either way.
  useEffect(() => {
    const end = nextEnd(stored);
    if (end === null) return;
    const check = () => {
      const moment = Date.now();
      const ended = Object.entries(stored).filter(([, timer]) => timer.status === 'running' && moment >= timer.endsAt).map(([step]) => Number(step));
      if (!ended.length) return;
      setStored(current => {
        const next = { ...current };
        for (const step of ended) { const timer = next[step]; if (timer) next[step] = settleTimer(timer, moment); }
        return next;
      });
      for (const step of ended) finish.current(step);
    };
    const handle = setTimeout(check, Math.max(0, end - Date.now()));
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearTimeout(handle); document.removeEventListener('visibilitychange', onVisible); };
  }, [stored]);

  const timers = useMemo(() => {
    const view: Record<number, TimerState> = {};
    for (const [step, timer] of Object.entries(stored)) view[Number(step)] = settleTimer(timer, now);
    return view;
  }, [stored, now]);

  const start = useCallback((step: number, seconds: number) => {
    tickNow();
    const moment = Date.now();
    setStored(current => ({ ...current, [step]: startTimer(current[step] ?? newTimer(seconds), moment) }));
  }, []);
  const pause = useCallback((step: number) => {
    tickNow();
    const moment = Date.now();
    setStored(current => (current[step] ? { ...current, [step]: pauseTimer(current[step], moment) } : current));
  }, []);
  const reset = useCallback((step: number, seconds: number) => {
    setStored(current => ({ ...current, [step]: resetTimer(current[step] ?? newTimer(seconds)) }));
  }, []);

  const clear = useCallback(() => setStored({}), []);

  return { timers, stored, now, start, pause, reset, clear };
}
