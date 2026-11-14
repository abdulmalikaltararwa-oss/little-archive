// The questions asked on this visit, newest first. Opening one shows its answer again without asking again.
// Nothing here is stored: it is the page's memory, and "Forget these" empties it. On a phone it is a row of
// chips under the question field; beside the answer on a wide screen it is a short list.
import { cn } from 'cn';
import { Whisper } from '@/components/field';
import { Button } from '@/components/ui/button';
import { entryTag, type Entry } from './logic';

export function History({ entries, activeId, onOpen, onClear, variant, className }: {
  entries: readonly Entry[];
  activeId: string;
  onOpen(id: string): void;
  onClear(): void;
  variant: 'chips' | 'rail';
  className?: string;
}) {
  if (!entries.length) return null;
  const rail = variant === 'rail';
  return (
    <section aria-label={rail ? 'Questions asked this visit' : 'Questions asked this visit, as a row'} className={cn('min-w-0', className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2><Whisper>this visit</Whisper></h2>
        <Button variant="ghost" size="sm" className="-me-2 text-ink-soft" onClick={onClear}>Forget these</Button>
      </div>
      <ol className={cn(rail ? 'flex flex-col gap-1.5' : 'scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:px-6')}>
        {entries.map(entry => {
          const active = entry.id === activeId;
          return (
            <li key={entry.id} className={cn('min-w-0', !rail && 'shrink-0')}>
              <button
                type="button"
                aria-current={active ? 'true' : undefined}
                onClick={() => onOpen(entry.id)}
                className={cn(
                  'flex min-h-11 flex-col justify-center gap-0.5 rounded-md border px-3.5 py-2 text-start outline-none transition-colors duration-200',
                  rail ? 'w-full' : 'w-52',
                  active ? 'border-sage/50 bg-sage-pale' : 'border-line bg-card hov:border-line-strong hov:bg-card-2',
                )}
              >
                <span dir="auto" className="line-clamp-2 text-sm leading-snug text-ink [overflow-wrap:anywhere]">{entry.question}</span>
                <span className="label-mono">{entryTag(entry)}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
