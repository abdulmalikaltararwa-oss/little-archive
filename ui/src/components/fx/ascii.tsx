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

// The border garden: a still row of flowers planted where a page ends. Each plant is a head (in a flower colour) on a
// stem (in sage). The lines of one plant are padded to one width, so it stays aligned however it is placed.
const PLANTS = {
  daisy: { tone: 'petal', head: [String.raw`   _`, String.raw` _(_)_`, String.raw`(_)@(_)`, String.raw`  (_)`], stem: [String.raw`   |`, String.raw`  \|/`] },
  tulip: { tone: 'petal', head: [String.raw` _ _`, String.raw`( V )`, String.raw` \_/`], stem: [String.raw`  |`, String.raw`  |/`, String.raw` \|`, String.raw`  |`] },
  sunflower: { tone: 'butter', head: [String.raw` .\|/.`, String.raw`--(@)--`, String.raw` '/|\'`], stem: [String.raw`   |`, String.raw`  \|`, String.raw`   |/`, String.raw`   |`] },
  poppy: { tone: 'clay', head: [String.raw` .--.`, String.raw`( ** )`, String.raw` '--'`], stem: [String.raw`  ||`, String.raw` \||`, String.raw`  ||/`] },
  lavender: { tone: 'lilac', head: [String.raw`  i`, String.raw` i:i`, String.raw` :i:`, String.raw`  :`], stem: [String.raw`  |`, String.raw` \|`, String.raw`  |/`] },
  bell: { tone: 'sky', head: [String.raw`  o`, String.raw` oOo`, String.raw` oOo`, String.raw`  o`], stem: [String.raw`  |`, String.raw` \|/`] },
  puff: { tone: 'butter', head: [String.raw` .:*:.`, String.raw`:*:*:*:`, String.raw` ':*:'`], stem: [String.raw`   |`, String.raw`   |`, String.raw`  \|/`] },
  clover: { tone: 'sage', head: [String.raw` o o`, String.raw`o-+-o`, String.raw` o o`], stem: [String.raw`  |`, String.raw` \|/`] },
  bud: { tone: 'petal', head: [String.raw` ()`], stem: [String.raw` ||`, String.raw`\||/`] },
  sprout: { tone: 'sage', head: [String.raw` ,`], stem: [String.raw` |/`, String.raw`\|`] },
  grass: { tone: 'sage', head: [], stem: [String.raw`\|/`] },
  blade: { tone: 'sage', head: [], stem: [String.raw`,;,`] },
} as const satisfies Record<string, { tone: string; head: readonly string[]; stem: readonly string[] }>;

type Plant = keyof typeof PLANTS;
type PlantSize = 's' | 'm' | 'l';

// Decoration, never text: the colours are thinned until the row is a watermark on the paper, in both themes.
const STEM = 'text-sage/45 dark:text-sage-deep/30';
const HEADS: Record<(typeof PLANTS)[Plant]['tone'], string> = {
  petal: 'text-petal-ink/55 dark:text-petal-ink/40',
  butter: 'text-butter-ink/55 dark:text-butter-ink/40',
  clay: 'text-clay-ink/55 dark:text-clay-ink/40',
  lilac: 'text-lilac-ink/55 dark:text-lilac-ink/40',
  sky: 'text-sky-ink/55 dark:text-sky-ink/40',
  sage: 'text-sage/55 dark:text-sage-deep/40',
};
const PLANT_SIZES: Record<PlantSize, string> = { s: 'text-[9px]', m: 'text-2xs', l: 'text-sm' };

const plan = (text: string) => text.split(' ').map(part => part.split(':') as [Plant, PlantSize?]);

// Where a garden is planted. `wall` is the end of a list of saves, `side` the foot of the sidebar, and `sprouts` goes
// under an empty state: nothing has been saved there, so nothing has bloomed. A bed is as tall as its tallest plant.
// It is planted from the start and takes as many plants as its width holds; the ones after that are not drawn.
const BEDS = {
  wall: { height: 'h-[6.75rem]', plants: plan('grass sprout:s daisy blade tulip:s lavender sunflower:l bud:s grass poppy clover:s blade bell sprout:s grass tulip:l puff:l grass lavender:l bud daisy:l blade poppy:l grass sprout clover bell:l grass') },
  side: { height: 'h-[4.75rem]', plants: plan('grass:s tulip:s blade:s daisy:s sprout:s lavender:s grass:s poppy:s bud:s clover:s blade:s') },
  sprouts: { height: 'h-8', plants: plan('grass:s sprout:s blade:s bud:s grass:s sprout:s blade:s grass:s bud:s sprout:s grass:s blade:s sprout:s grass:s bud:s blade:s sprout:s grass:s sprout:s blade:s bud:s grass:s sprout:s blade:s grass:s') },
} as const;

export type GardenBed = keyof typeof BEDS;

function pad(lines: readonly string[], width: number) {
  return lines.map(line => line.padEnd(width)).join('\n');
}

/**
 * A still row of text-art flowers for the foot of a page. It is decoration only: hidden from assistive technology,
 * never behind text or a card, never fixed to the screen, and it does not move. Every plant stands in a slot as tall
 * as the bed, so the row wraps a whole plant at a time and the wrapped ones are cut off whole, never in half.
 */
export function Garden({ bed, className }: { bed: GardenBed; className?: string }) {
  const { height, plants } = BEDS[bed];
  return (
    <div aria-hidden="true" data-garden={bed} className={cn('pointer-events-none flex flex-wrap content-start justify-around gap-x-1.5 overflow-hidden select-none', height, className)}>
      {plants.map(([name, size = 'm'], index) => {
        const { tone, head, stem } = PLANTS[name];
        const width = Math.max(...head.map(line => line.length), ...stem.map(line => line.length));
        return (
          <span key={index} className={cn('flex shrink-0 items-end', height)}>
            {/* Drawn left to right whatever the page's direction, or the brackets and slashes would flip. */}
            <pre dir="ltr" className={cn('ascii m-0 text-start', PLANT_SIZES[size], 'leading-[1.15]', STEM)}>
              {head.length ? <span className={HEADS[tone]}>{`${pad(head, width)}\n`}</span> : null}
              {pad(stem, width)}
            </pre>
          </span>
        );
      })}
    </div>
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
