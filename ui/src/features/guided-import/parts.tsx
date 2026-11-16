// The small pieces the guided import's views share: the five-step rail, a panel, a heading, a tally, a state
// chip, an external link, and the place a file is dropped. They draw; they decide nothing.
import { Fragment, useId, useState, type DragEvent, type ReactNode } from 'react';
import { safeURL } from '@web/utils.js';
import { cn } from 'cn';
import { Check, ChevronRight, ExternalLink as ExternalLinkIcon, FileArchive } from 'lucide-react';
import { useServerWords } from '@/app/archive-context';
import { Whisper } from '@/components/field';
import { Ascii } from '@/components/fx/ascii';
import { NumberTicker } from '@/components/fx/number-ticker';
import type { ImportState } from './api';
import { STEPS } from './flow';
import { formatBytes, STATE_WORDS } from './words';

/** "your server" inside a sentence, or "the service" on a hosted account. */
export function ServerName({ capital = false }: { capital?: boolean }) {
  return <>{useServerWords()(capital ? 'Your server' : 'your server')}</>;
}

/** The five stages, so a person always knows where they are. Not a control: each view has its own way back. */
export function Rail({ current, done }: { current: number; done: boolean }) {
  return (
    <nav aria-label="Import steps" className="mb-7">
      <ol className="flex items-start">
        {STEPS.map((step, index) => {
          const state = done || index < current ? 'done' : index === current ? 'current' : 'next';
          return (
            <li key={step.id} aria-current={state === 'current' ? 'step' : undefined} data-step={step.id} data-state={state} className="relative flex min-w-0 flex-1 flex-col items-center gap-1.5 text-center">
              {index > 0 ? (
                <span aria-hidden="true" className={cn('absolute top-4 -translate-y-1/2 start-[-50%] end-1/2 h-0.5 rounded-full transition-colors duration-300', state === 'next' ? 'bg-line' : 'bg-sage')} />
              ) : null}
              <span
                className={cn(
                  'num relative z-[1] grid size-8 place-items-center rounded-full text-xs transition-[background-color,box-shadow,color] duration-300',
                  state === 'done' && 'bg-sage text-on-sage',
                  state === 'current' && 'bg-card text-sage shadow-xs ring-2 ring-sage dark:text-sage-deep',
                  state === 'next' && 'bg-card-2 text-ink-soft ring-1 ring-line',
                )}
              >
                {state === 'done' ? <Check className="size-4" aria-hidden="true" strokeWidth={2.6} /> : index + 1}
              </span>
              <span className={cn('label-mono hidden max-w-full truncate px-0.5 sm:block', state === 'current' && '!text-ink')}>
                {step.label}
                <span className="sr-only">{state === 'done' ? ' (done)' : state === 'current' ? ' (current step)' : ''}</span>
              </span>
            </li>
          );
        })}
      </ol>
      {/* On a phone there is no room for five labels: the current one is named under the rail. */}
      <p className="label-mono mt-3 text-center sm:hidden" aria-hidden="true">
        {done ? 'all done' : `step ${current + 1} of ${STEPS.length} · ${STEPS[current]?.label.toLowerCase()}`}
      </p>
    </nav>
  );
}

export function Panel({ children, className, tone = 'plain', ...props }: { children: ReactNode; className?: string; tone?: 'plain' | 'sage' } & React.ComponentProps<'section'>) {
  return (
    <section
      {...props}
      className={cn(
        'animate-in rounded-lg border p-5 shadow-xs duration-300 fade-in-0 slide-in-from-bottom-2 sm:p-7',
        tone === 'sage' ? 'border-transparent bg-sage-pale' : 'border-line bg-card',
        className,
      )}
    >
      {children}
    </section>
  );
}

/** A view's heading. It takes focus when the step changes, so a screen reader announces where it is now. */
export function StepHeading({ whisper, title, lede, className }: { whisper?: string; title: string; lede?: ReactNode; className?: string }) {
  const w = useServerWords();
  return (
    <header className={cn('mb-5', className)}>
      {whisper ? <Whisper>{w(whisper)}</Whisper> : null}
      <h2 data-step-heading tabIndex={-1} dir="auto" className={cn('display text-2xl text-ink outline-none sm:text-3xl', whisper && 'mt-1.5')}>{w(title)}</h2>
      {lede ? <p className="mt-2 max-w-xl text-sm leading-relaxed text-ink-soft sm:text-base">{typeof lede === 'string' ? w(lede) : lede}</p> : null}
    </header>
  );
}

/** A number that counts up, what it counts, and (optionally) one line on what that means. */
export function Stat({ value, label, gloss, strong = false, className }: { value: number; label: string; gloss?: string; strong?: boolean; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5 rounded-md px-4 py-3', strong ? 'bg-sage-pale' : 'bg-card-2', className)}>
      <NumberTicker value={value} className={cn('text-ink', strong ? 'text-3xl sm:text-4xl' : 'text-2xl sm:text-3xl')} />
      <span className="label-mono">{label}</span>
      {gloss ? <span className="text-xs leading-snug text-ink-soft">{gloss}</span> : null}
    </div>
  );
}

const CHIP: Record<ImportState, string> = {
  uploading: 'bg-butter-pale !text-butter-ink',
  previewed: 'bg-butter-pale !text-butter-ink',
  importing: 'bg-butter-pale !text-butter-ink',
  completed: 'bg-sage-pale !text-sage dark:!text-sage-deep',
  failed: 'bg-danger-pale !text-danger',
  rejected: 'bg-danger-pale !text-danger',
  cancelled: 'bg-card-2',
};

/** A state, in words. The colour only helps. */
export function StateChip({ state }: { state: ImportState }) {
  return <span className={cn('label-mono shrink-0 rounded-full px-2 py-0.5', CHIP[state])}>{STATE_WORDS[state].label}</span>;
}

/** A list with a small petal asterisk, the way the placeholder screens mark theirs. */
export function Bullets({ items, className }: { items: readonly ReactNode[]; className?: string }) {
  return (
    <ul className={cn('flex flex-col gap-2 text-sm leading-relaxed text-ink', className)}>
      {items.map((item, index) => (
        <li key={index} className="flex gap-3">
          <span aria-hidden="true" className="font-mono text-petal-ink">*</span>
          <span dir="auto" className="min-w-0">{item}</span>
        </li>
      ))}
    </ul>
  );
}

/** A link to somewhere else. The address is checked (http or https only) and opens with no way back to this page. */
export function ExternalLink({ href, children }: { href: string | null | undefined; children: ReactNode }) {
  const safe = safeURL(href);
  if (!safe) return null;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1.5 rounded-sm text-sm font-semibold text-sage underline-offset-4 hov:underline dark:text-sage-deep">
      {children}
      <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/** The turning arrow at the start of a `<summary>`; its `<details>` is a `group/d`. */
export function Chevron() {
  return <ChevronRight className="size-4 shrink-0 text-ink-soft transition-transform duration-200 group-open/d:rotate-90 rtl:-scale-x-100" aria-hidden="true" />;
}

/** A file path that may break after a slash and nowhere else, so it never splits in the middle of a name. */
export function Path({ value, className }: { value: string; className?: string }) {
  const parts = value.split('/');
  return (
    <code dir="auto" className={cn('num [overflow-wrap:anywhere]', className)}>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {part}
          {index < parts.length - 1 ? <>/<wbr /></> : null}
        </Fragment>
      ))}
    </code>
  );
}

/** A titled block in the guide's side column. */
export function Aside({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-lg border border-line bg-card p-5', className)}>
      <h3 className="mb-3"><Whisper>{title}</Whisper></h3>
      {children}
    </section>
  );
}

/**
 * Where a file is dropped or chosen. The whole region is the label of a real file input, so it is reachable by
 * keyboard and by a screen reader and opens the system picker; dropping a file works too. It never reads the file.
 */
export function DropZone({ accept, disabled, onFile, title, hint, compact = false, children }: {
  accept: string;
  disabled?: boolean;
  onFile(file: File): void;
  title: string;
  hint: ReactNode;
  compact?: boolean;
  children?: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const id = useId();
  const take = (files: FileList | null | undefined) => {
    const file = files?.[0];
    if (file && !disabled) onFile(file);
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    take(event.dataTransfer.files);
  };
  return (
    <label
      htmlFor={id}
      onDragOver={event => { event.preventDefault(); if (!disabled) setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      className={cn(
        'flex flex-col items-center gap-3 rounded-lg border-2 border-dashed text-center transition-[background-color,border-color] duration-200 has-[:focus-visible]:outline-[2.5px] has-[:focus-visible]:outline-offset-3 has-[:focus-visible]:outline-sage',
        compact ? 'px-5 py-6' : 'px-5 py-9 sm:py-12',
        over ? 'border-sage bg-sage-pale' : 'border-line-strong bg-card-2/70 hov:border-sage hov:bg-card-2',
        disabled && 'pointer-events-none opacity-60',
      )}
    >
      {compact ? null : <Ascii name="box" className={cn('text-start text-sm text-sage transition-transform duration-300 ease-spring dark:text-sage-deep', over && '-translate-y-1 scale-105')} />}
      <span className="display text-xl text-ink">{title}</span>
      <span className="max-w-sm text-sm text-ink-soft">{hint}</span>
      <span className="inline-flex h-10.5 items-center rounded-full bg-sage px-5 text-sm font-semibold text-on-sage shadow-[0_10px_18px_-10px_var(--sage)] coarse:h-11" aria-hidden="true">Choose a file</span>
      <input id={id} type="file" accept={accept} disabled={disabled} className="sr-only" aria-label={title} onChange={event => { take(event.target.files); event.target.value = ''; }} />
      {children}
    </label>
  );
}

/** Something went wrong: what happened, what it means for the file, what to do. An alert, so it is read out when it appears. */
export function Problem({ title, what, next, children, className }: { title: string; what: string; next?: string; children?: ReactNode; className?: string }) {
  const w = useServerWords();
  return (
    <div role="alert" className={cn('rounded-md border border-danger/30 bg-danger-pale px-4 py-3.5 text-sm leading-relaxed text-danger', className)}>
      <p dir="auto" className="font-semibold">{title}</p>
      <p dir="auto" className="mt-1">{w(what)}</p>
      {next ? <p dir="auto" className="mt-1.5 text-ink">{w(next)}</p> : null}
      {children}
    </div>
  );
}

/** The file that was chosen, as a line: its name (untrusted), its size and what the server will cut it into. */
export function FileLine({ name, size, detail }: { name: string; size: number; detail?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-md border border-line bg-card-2 px-4 py-3">
      <FileArchive className="size-5 shrink-0 text-sage dark:text-sage-deep" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p dir="auto" className="truncate text-sm font-semibold text-ink">{name}</p>
        <p className="num text-xs text-ink-soft">{formatBytes(size)}{detail ? <> · {detail}</> : null}</p>
      </div>
    </div>
  );
}
