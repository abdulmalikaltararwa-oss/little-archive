// The ingredients in cook mode: ones that can be ticked off, the few a step uses, and the whole list with its
// servings control. Ticks are kept for the session, so a reload does not lose them.
import type { Ref } from 'react';
import { cn } from 'cn';
import { Check, X } from 'lucide-react';
import { Whisper } from '@/components/field';
import { Button } from '@/components/ui/button';
import type { Ingredient, Scale, ScaledIngredient } from './api';
import { IngredientText, ScaleControl } from './card-parts';
import { groupIngredients } from './model';

type Line = Ingredient | ScaledIngredient;

/** One ingredient with a big round tick. A real checkbox underneath, so the keyboard and screen readers work as they should. */
export function CheckLine({ ingredient, checked, onToggle }: { ingredient: Line; checked: boolean; onToggle(): void }) {
  return (
    <li>
      <label className="flex min-h-12 cursor-pointer items-start gap-3.5 rounded-md px-2 py-2.5 transition-colors hov:bg-card-2/70">
        <input type="checkbox" checked={checked} onChange={onToggle} className="peer sr-only" />
        <span
          aria-hidden="true"
          className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border-[1.5px] border-line-strong bg-card text-on-sage transition-colors duration-200 peer-checked:border-sage peer-checked:bg-sage peer-focus-visible:outline-[2.5px] peer-focus-visible:outline-offset-2 peer-focus-visible:outline-sage peer-checked:[&>svg]:scale-100"
        >
          <Check className="size-3.5 scale-0 transition-transform duration-200 ease-spring" strokeWidth={3} />
        </span>
        <span className="min-w-0 flex-1 transition-opacity duration-200 peer-checked:line-through peer-checked:opacity-55">
          <IngredientText ingredient={ingredient} large />
        </span>
      </label>
    </li>
  );
}

/** What this step uses, from the recipe's own references. Nothing is shown for a step that names none. */
export function StepIngredients({ lines, checked, onToggle }: { lines: { index: number; value: Line }[]; checked: ReadonlySet<number>; onToggle(index: number): void }) {
  if (!lines.length) return null;
  return (
    <section aria-label="Ingredients for this step" className="rounded-xl border border-line bg-card/80 p-2 sm:p-3">
      <h3 className="px-2 pt-2 pb-1"><Whisper>for this step</Whisper></h3>
      <ul>{lines.map(({ index, value }) => <CheckLine key={index} ingredient={value} checked={checked.has(index)} onToggle={() => onToggle(index)} />)}</ul>
    </section>
  );
}

interface PanelProps {
  ingredients: readonly Line[];
  checked: ReadonlySet<number>;
  onToggle(index: number): void;
  onClearTicks(): void;
  base: number | null;
  scale: Scale;
  onScale(next: Scale): void;
  busy: boolean;
  /** Scaling notes from the server, shown once the amounts are no longer the recipe's own. */
  notes: readonly string[];
  /** In a sheet, there is a close button; beside the step there is not. */
  onClose?: () => void;
  panelRef?: Ref<HTMLElement>;
  className?: string;
}

/** The whole ingredient checklist, with the servings control above it. */
export function IngredientsPanel({ ingredients, checked, onToggle, onClearTicks, base, scale, onScale, busy, notes, onClose, panelRef, className }: PanelProps) {
  const groups = groupIngredients(ingredients);
  return (
    <section ref={panelRef} tabIndex={-1} aria-label="Ingredients" className={cn('flex min-h-0 flex-col outline-none', className)}>
      <div className="flex items-start justify-between gap-3 px-5 pt-5 sm:px-6">
        <div>
          <h2><Whisper>ingredients</Whisper></h2>
          <p role="status" className="num mt-1.5 text-sm text-ink-soft">{checked.size} of {ingredients.length} ready</p>
        </div>
        <div className="flex items-center gap-1">
          {checked.size ? <Button variant="ghost" size="sm" onClick={onClearTicks}>Clear ticks</Button> : null}
          {onClose ? <Button variant="ghost" size="icon" aria-label="Close the ingredients" title="Close the ingredients" onClick={onClose}><X /></Button> : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-4 pb-6 sm:px-4">
        <ScaleControl base={base} scale={scale} onScale={onScale} className="px-2 pb-4" />
        <div aria-busy={busy || undefined} className={cn('border-t border-line pt-2 transition-opacity duration-200', busy && 'opacity-55 delay-150')}>
          {groups.map(group => (
            <div key={group.group ?? '·'}>
              {group.group ? <h3 dir="auto" className="label-mono mt-3 px-2">{group.group}</h3> : null}
              <ul>{group.items.map(({ index, value }) => <CheckLine key={index} ingredient={value} checked={checked.has(index)} onToggle={() => onToggle(index)} />)}</ul>
            </div>
          ))}
        </div>
        {notes.length ? <p className="mt-4 px-2 text-xs leading-relaxed text-ink-soft">{notes.join(' ')}</p> : null}
      </div>
    </section>
  );
}
