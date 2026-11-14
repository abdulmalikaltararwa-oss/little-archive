// The timer on a step, and the chips that keep the other timers in sight. Several can run at once. Each face
// is drawn from timestamps (see timers.ts), so it is right after the tab has been in the background, and a
// finished timer is unmistakable without sound: a different ground, a bell and the words "Time's up".
import type { CSSProperties } from 'react';
import { cn } from 'cn';
import { BellRing, Clock, Pause, Play, RotateCcw, Timer, Volume2, VolumeX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatClock, formatDuration, spokenDuration } from './model';
import { fractionLeft, newTimer, remainingMs, type TimerState } from './timers';

interface StepTimerProps {
  stepNumber: number;
  /** The timer's length as the recipe states it. */
  seconds: number;
  timer: TimerState | undefined;
  now: number;
  /** Whether the alarm may make a sound, and the switch for it. */
  sound: boolean;
  onToggleSound(): void;
  onStart(): void;
  onPause(): void;
  onReset(): void;
}

// The ring that opens around a finished timer repeats a few times, then rests. Reduced motion shows it once.
const RING: CSSProperties = { animationIterationCount: 6 };

export function StepTimer({ stepNumber, seconds, timer, now, sound, onToggleSound, onStart, onPause, onReset }: StepTimerProps) {
  const state = timer ?? newTimer(seconds);
  const left = remainingMs(state, now);
  const fraction = fractionLeft(state, now);
  const { status } = state;
  const finished = status === 'finished';
  const label = finished ? 'time is up' : status === 'running' ? 'running' : status === 'paused' ? 'paused' : `timer · ${formatDuration(seconds)}`;

  return (
    <section
      aria-label={`Timer for step ${stepNumber}`}
      data-timer-status={status}
      style={finished ? RING : undefined}
      className={cn('rounded-xl border p-5 transition-colors duration-300 sm:p-6', finished ? 'animate-welcome border-butter/70 bg-butter-pale text-butter-ink' : 'border-line bg-card shadow-xs')}
    >
      <div className="flex items-start justify-between gap-3">
        <p className={cn('label-mono', finished && '!text-butter-ink')}>{label}</p>
        <Button variant="ghost" size="icon-sm" className={cn('hit-44 -me-1.5 -mt-1.5', finished && 'text-butter-ink hov:text-butter-ink')} aria-label={sound ? 'Turn the alarm sound off' : 'Turn the alarm sound on'} aria-pressed={sound} title={sound ? 'Alarm sound is on' : 'Alarm sound is off'} onClick={onToggleSound}>{sound ? <Volume2 /> : <VolumeX />}</Button>
      </div>
      <div className="mt-1 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div>
          <p role="timer" aria-label={`${spokenDuration(Math.ceil(left / 1000))} left`} className={cn('num text-5xl leading-none sm:text-6xl', status === 'paused' && 'text-ink-soft')}>
            <span aria-hidden="true">{formatClock(left)}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {status === 'idle' ? <Button variant="primary" size="lg" onClick={onStart}><Timer />Start timer</Button> : null}
          {status === 'running' ? <Button variant="soft" size="lg" onClick={onPause}><Pause />Pause</Button> : null}
          {status === 'paused' ? <Button variant="primary" size="lg" onClick={onStart}><Play className="fill-current" />Resume</Button> : null}
          {finished ? <Button variant="primary" size="lg" onClick={onReset}>Dismiss</Button> : null}
          {finished ? <Button variant="outline" size="lg" onClick={onStart}><RotateCcw />Again</Button> : null}
          {status === 'running' || status === 'paused' ? <Button variant="ghost" size="icon" className="size-12" aria-label="Reset timer" title="Reset timer" onClick={onReset}><RotateCcw /></Button> : null}
        </div>
      </div>
      {finished ? (
        <p className="mt-4 flex items-center gap-2 text-lg font-semibold"><BellRing className="size-5 animate-bob" aria-hidden="true" />Time’s up</p>
      ) : (
        <div aria-hidden="true" className="mt-5 h-1.5 overflow-hidden rounded-full bg-card-3">
          <div className="h-full rounded-full bg-sage transition-[width] duration-300 ease-linear dark:bg-sage-deep" style={{ width: `${Math.round(fraction * 1000) / 10}%` }} />
        </div>
      )}
    </section>
  );
}

interface OtherTimersProps {
  entries: { step: number; timer: TimerState }[];
  now: number;
  onGo(step: number): void;
}

/** Timers on the other steps, one chip each. Tapping a chip goes to its step. */
export function OtherTimers({ entries, now, onGo }: OtherTimersProps) {
  if (!entries.length) return null;
  return (
    <ul aria-label="Timers on other steps" className="flex flex-wrap gap-2">
      {entries.map(({ step, timer }) => {
        const finished = timer.status === 'finished';
        const running = timer.status === 'running';
        return (
          <li key={step}>
            <button
              type="button"
              onClick={() => onGo(step)}
              aria-label={`Step ${step + 1}: ${finished ? 'time is up' : `${spokenDuration(Math.ceil(remainingMs(timer, now) / 1000))} left${running ? '' : ', paused'}`}. Go to this step.`}
              className={cn(
                'inline-flex h-9 items-center gap-2 rounded-full border px-3.5 text-sm transition-colors coarse:h-11',
                finished ? 'border-butter/60 bg-butter-pale font-semibold text-butter-ink' : running ? 'border-sage/25 bg-sage-pale text-sage dark:text-sage-deep' : 'border-line bg-card-2 text-ink-soft',
              )}
            >
              {finished ? <BellRing className="size-4" aria-hidden="true" /> : <Clock className="size-4" aria-hidden="true" />}
              <span aria-hidden="true">Step {step + 1}</span>
              <span aria-hidden="true" className="num">{finished ? 'done' : formatClock(remainingMs(timer, now))}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
