// The ASCII accents: small drawings, a progress bar and a spinner, all in the mono face. They are decoration.
// Each one is hidden from assistive technology and the component beside it carries the real words.
import { useEffect, useState } from 'react';
import { cn } from 'cn';
import { useReducedMotion } from 'motion/react';

export const ART = {
  flower: String.raw`
    _
  _(_)_
 (_)@(_)
   (_)
    |
   \|/
`,
  pot: String.raw`
     _
   _(_)_
  (_)@(_)
    (_)
   \ | /
  .-'|'-.
  \_____/
`,
  bookmark: String.raw`
  .-------.
  |   _   |
  | _(_)_ |
  |(_)@(_)|
  |  (_)  |
  |  / \  |
  |/     \|
`,
  search: String.raw`
    .---.
   /     \
  |   ?   |
   \     /
    '---'\
          \
`,
  cloud: String.raw`
     .--.
  .-(    ).
 (___.__)__)
   '  '  '
`,
  box: String.raw`
   _________
  /   \|/  /|
 /________/ |
 |  ~~~~  | /
 |________|/
`,
  bowl: String.raw`
     )  )  )
    (  (  (
  .----------.
   \        /
    '------'
`,
  map: String.raw`
  .----.----.
  | .  ' x  |
  |  \_.-'  |
  | o       |
  '----'----'
`,
  chat: String.raw`
  .---------.
  | > _     |
  '--.------'
     |/
`,
  key: String.raw`
   .--.
  ( () )=====#
   '--'    # #
`,
  archive: String.raw`
  .---------.
  |_________|
  |   [=]   |
  |         |
  '---------'
`,
} as const;

export type ArtName = keyof typeof ART;

export function Ascii({ name, className }: { name: ArtName; className?: string }) {
  return (
    <pre aria-hidden="true" className={cn('ascii m-0 text-xs text-sage', className)}>
      {ART[name].replace(/^\n/, '').replace(/\n$/, '')}
    </pre>
  );
}

const SPINNER = ['·', '✢', '✤', '✿', '❀', '✿', '✤', '✢'];

/** A small turning flower. Say what is happening next to it; this is only the movement. */
export function AsciiSpinner({ className }: { className?: string }) {
  const still = useReducedMotion();
  const [frame, setFrame] = useState(3);
  useEffect(() => {
    if (still) return;
    const timer = setInterval(() => setFrame(value => (value + 1) % SPINNER.length), 110);
    return () => clearInterval(timer);
  }, [still]);
  return (
    <span aria-hidden="true" className={cn('inline-block w-[1.2em] text-center font-mono text-petal-ink', className)}>
      {SPINNER[frame]}
    </span>
  );
}

function bar(fraction: number, width: number) {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

/**
 * A terminal-style progress bar that is also a real one: role, range and value are on the element, the
 * characters are for the eyes. Without `value` it is indeterminate and a block travels along it.
 */
export function AsciiProgress({ value, max = 100, width = 22, label, className }: { value?: number; max?: number; width?: number; label: string; className?: string }) {
  const still = useReducedMotion();
  const indeterminate = value == null;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!indeterminate || still) return;
    const timer = setInterval(() => setTick(step => step + 1), 90);
    return () => clearInterval(timer);
  }, [indeterminate, still]);

  let drawing: string;
  if (indeterminate) {
    const span = 5;
    const travel = width + span;
    const head = still ? Math.floor(width / 2) : tick % travel;
    drawing = Array.from({ length: width }, (_, index) => (index <= head && index > head - span ? '█' : '░')).join('');
  } else drawing = bar(max ? value / max : 0, width);
  const percent = indeterminate ? '' : ` ${String(Math.round((max ? value / max : 0) * 100)).padStart(3, ' ')}%`;

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={indeterminate ? undefined : max}
      aria-valuenow={indeterminate ? undefined : value}
      className={cn('ascii max-w-full overflow-hidden text-sm text-sage', className)}
    >
      <span aria-hidden="true">
        <span className="text-ink-soft">[</span>
        {drawing}
        <span className="text-ink-soft">]</span>
        <span className="text-ink-soft">{percent}</span>
      </span>
    </div>
  );
}
