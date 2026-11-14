// The pieces of a recipe card that more than one screen draws: the servings control, the ingredient lines,
// the steps, and the panel that says where it all came from. Text from a saved post is untrusted, so every
// line is rendered as text with dir="auto".
import { useId } from 'react';
import { cn } from 'cn';
import { Clock, Minus, Plus, RotateCcw } from 'lucide-react';
import { Notice, Whisper } from '@/components/field';
import { BorderBeam } from '@/components/fx/border-beam';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { BASE_SCALE, type Ingredient, type Recipe, type RecipeResponse, type Scale, type ScaledIngredient, type Step } from './api';
import {
  confidenceSentence, droppedSentence, evidenceLabel, FACTOR_LABELS, FACTORS, formatDuration, formatServings, groupIngredients, groupSteps, incompleteSentence, ingredientLine, readingLabel,
  reasonSentence, saysOptional, servingsBounds, sourceLabel, splitAmount, stepServings, warningText,
} from './model';

/* Servings ------------------------------------------------------------------------------------------------- */

interface ScaleControlProps {
  /** The servings the recipe states, or null when it does not say. */
  base: number | null;
  scale: Scale;
  onScale(next: Scale): void;
  className?: string;
}

/**
 * Servings, scaled by the server: a stepper and the common factors. A recipe that does not say how many it
 * serves can only be scaled by an amount, and says so.
 */
export function ScaleControl({ base, scale, onScale, className }: ScaleControlProps) {
  const heading = useId();
  if (base === null) {
    return (
      <div role="group" aria-labelledby={heading} className={cn('flex flex-col gap-2.5', className)}>
        <h3 id={heading} className="text-sm font-semibold text-ink">Amounts</h3>
        <Segmented<string>
          label="Scale the amounts"
          value={String(scale.kind === 'factor' ? scale.value : 1)}
          onValueChange={value => onScale({ kind: 'factor', value: Number(value) })}
          options={FACTORS.map(factor => ({ value: String(factor), label: FACTOR_LABELS[factor] ?? `×${factor}` }))}
        />
        <p className="text-xs leading-relaxed text-ink-soft">This recipe does not say how many it serves, so it can be scaled by an amount only.</p>
      </div>
    );
  }

  const current = scale.kind === 'servings' ? scale.value : base * scale.value;
  const { min, max } = servingsBounds(base);
  const go = (value: number) => {
    const next = Math.min(max, Math.max(min, value));
    onScale(next === base ? BASE_SCALE : { kind: 'servings', value: next });
  };
  const preset = FACTORS.find(factor => Math.abs(base * factor - current) < 1e-9);
  const changed = Math.abs(current - base) > 1e-9;

  return (
    <div role="group" aria-labelledby={heading} className={cn('flex flex-col gap-3', className)}>
      <h3 id={heading} className="sr-only">Servings</h3>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" className="size-11 rounded-full" aria-label="One serving fewer" disabled={current <= Math.min(1, base)} onClick={() => go(stepServings(current, -1, base))}><Minus /></Button>
          <p role="status" className="min-w-[6.5rem] px-2 text-center">
            <span className="num text-2xl text-ink">{formatServings(current)}</span>
            {' '}<span className="text-sm text-ink-soft">{current === 1 ? 'serving' : 'servings'}</span>
          </p>
          <Button variant="outline" size="icon" className="size-11 rounded-full" aria-label="One serving more" disabled={current >= max} onClick={() => go(stepServings(current, 1, base))}><Plus /></Button>
        </div>
        <Segmented<string>
          label="Scale the recipe"
          value={preset === undefined ? '' : String(preset)}
          onValueChange={value => go(base * Number(value))}
          options={FACTORS.map(factor => ({ value: String(factor), label: FACTOR_LABELS[factor] ?? `×${factor}` }))}
        />
      </div>
      {changed ? (
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-ink-soft">
          <span>Scaled from {formatServings(base)}. Times and temperatures in the steps stay as written.</span>
          <Button variant="ghost" size="sm" className="-ms-2 h-8 px-2.5 text-xs" onClick={() => onScale(BASE_SCALE)}><RotateCcw className="size-3.5" />Back to {formatServings(base)}</Button>
        </p>
      ) : null}
    </div>
  );
}

/* Ingredients ---------------------------------------------------------------------------------------------- */

/** A small mono tag saying where a line came from. */
export function SourceTag({ source, className }: { source: string; className?: string }) {
  return <span className={cn('label-mono shrink-0 rounded-sm bg-card-2 px-1.5 py-px !text-[0.62rem]', className)}><span className="sr-only">Source: </span>{sourceLabel(source)}</span>;
}

/** The words of one ingredient line, its amount set a little heavier, with the gentle marks: optional, about, and what was rounded. */
export function IngredientText({ ingredient, showSources = false, large = false }: { ingredient: Ingredient | ScaledIngredient; showSources?: boolean; large?: boolean }) {
  const line = ingredientLine(ingredient);
  const [amount, rest] = splitAmount(line);
  const approximate = 'approximate' in ingredient && ingredient.approximate;
  const warnings = 'warnings' in ingredient ? ingredient.warnings : [];
  const exact = 'exact' in ingredient && typeof ingredient.exact === 'number' && approximate ? ingredient.exact : null;
  return (
    <span className="min-w-0 flex-1">
      <span dir="auto" className={cn('leading-snug text-ink', large ? 'text-lg' : 'text-base')}>
        {approximate ? <><span aria-hidden="true" className="text-ink-soft">≈ </span><span className="sr-only">about </span></> : null}
        {amount ? <span className="font-semibold">{amount}</span> : null}
        {rest}
      </span>
      {ingredient.optional && !saysOptional(line) ? <span className="ms-2 rounded-full bg-card-2 px-2 py-0.5 align-middle text-2xs text-ink-soft">optional</span> : null}
      {showSources ? <SourceTag source={ingredient.source} className="ms-2 align-middle" /> : null}
      {warnings.length || exact !== null ? (
        <span className="mt-0.5 block text-xs text-ink-soft">
          {[...warnings.map(warningText), exact !== null ? `exactly ${formatServings(exact)}${ingredient.unit ? ` ${ingredient.unit}` : ''}` : ''].filter(Boolean).join(' · ')}
        </span>
      ) : null}
    </span>
  );
}

export function IngredientList({ ingredients, showSources, className }: { ingredients: readonly (Ingredient | ScaledIngredient)[]; showSources: boolean; className?: string }) {
  const groups = groupIngredients(ingredients);
  return (
    <div className={className}>
      {groups.map(group => (
        <div key={group.group ?? '·'} className={group.group ? 'mt-5 first:mt-0' : undefined}>
          {group.group ? <h4 dir="auto" className="label-mono mb-1">{group.group}</h4> : null}
          <ul className="divide-y divide-line/70">
            {group.items.map(({ index, value }) => (
              <li key={index} className="flex gap-3 py-2.5">
                <span aria-hidden="true" className="mt-[0.6rem] size-1.5 shrink-0 rounded-full bg-sage/55 dark:bg-sage-deep/70" />
                <IngredientText ingredient={value} showSources={showSources} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/* Steps ---------------------------------------------------------------------------------------------------- */

export function TimerChip({ seconds, className }: { seconds: number; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full bg-sage-pale px-2.5 py-1 text-xs font-medium text-sage dark:text-sage-deep', className)}>
      <Clock className="size-3.5" aria-hidden="true" />
      <span className="sr-only">Timer: </span>
      <span className="num">{formatDuration(seconds)}</span>
    </span>
  );
}

export function StepList({ steps, ingredients, showSources }: { steps: readonly Step[]; ingredients: readonly Ingredient[]; showSources: boolean }) {
  const sections = groupSteps(steps);
  return (
    <div>
      {sections.map(section => (
        <div key={section.group ?? '·'} className={section.group ? 'mt-6 first:mt-0' : undefined}>
          {section.group ? <h4 dir="auto" className="label-mono mb-2">{section.group}</h4> : null}
          <ol className="flex flex-col gap-5">
            {section.items.map(({ index, value: step }) => {
              const uses = step.ingredient_refs.map(ref => ingredients[ref]?.name).filter((name): name is string => Boolean(name));
              return (
                <li key={index} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3.5">
                  <span aria-hidden="true" className="num mt-0.5 grid size-8 place-items-center rounded-full bg-sage-pale text-sm font-medium text-sage dark:text-sage-deep">{index + 1}</span>
                  <div className="min-w-0">
                    <p dir="auto" className="text-base leading-relaxed text-pretty text-ink [overflow-wrap:anywhere]"><span className="sr-only">Step {index + 1}. </span>{step.text}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      {step.timer_seconds ? <TimerChip seconds={step.timer_seconds} /> : null}
                      {uses.length ? <p dir="auto" className="text-xs text-ink-soft"><span className="sr-only">Uses: </span>{uses.join(' · ')}</p> : null}
                      {showSources ? <SourceTag source={step.source} /> : null}
                    </div>
                    {showSources && step.quote ? <p dir="auto" className="mt-1.5 border-s-2 border-line-strong ps-3 text-xs leading-relaxed text-ink-soft italic">“{step.quote}”</p> : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </div>
  );
}

/* Where it came from ---------------------------------------------------------------------------------------- */

interface ProvenanceProps {
  recipe: Recipe;
  response: RecipeResponse;
  showSources: boolean;
  onShowSources(on: boolean): void;
  onLookAgain(): void;
  lookBusy: boolean;
}

/**
 * The honesty layer: how this card was read, what it rests on, whether the save has changed since, and
 * anything missing or doubtful. It is always on the page; nothing about it is hidden behind a click, except
 * the per-line sources, which a switch turns on.
 */
export function ProvenancePanel({ recipe, response, showSources, onShowSources, onLookAgain, lookBusy }: ProvenanceProps) {
  const heading = useId();
  const sourcesSwitch = useId();
  const { provenance } = recipe;
  const byModel = provenance.method === 'ai';
  const stale = Boolean(response.extraction?.stale);
  const incomplete = incompleteSentence(recipe.incomplete);
  const reason = reasonSentence(recipe.reason);
  const dropped = droppedSentence(recipe.dropped);
  const automatic = response.edited ? response.extracted : null;

  return (
    <section aria-labelledby={heading} className="relative rounded-lg border border-line bg-card-2/55 p-5 sm:p-6">
      {byModel ? <BorderBeam /> : null}
      <h2 id={heading}><Whisper>where this came from</Whisper></h2>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span data-testid="reading-label" className="label-mono rounded-full border border-line bg-card px-2.5 py-1 !text-ink">{readingLabel(provenance.method, recipe.confidence)}</span>
        <span data-testid="evidence-label" className="label-mono rounded-full border border-line bg-card px-2.5 py-1 !text-ink">{evidenceLabel(provenance.evidence_level)}</span>
        {response.edited ? <span className="label-mono rounded-full bg-petal-pale px-2.5 py-1 !text-petal-ink">edited by you</span> : null}
      </div>
      {provenance.evidence_note ? <p dir="auto" className="mt-3.5 text-sm leading-relaxed text-ink">{provenance.evidence_note}</p> : null}
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">{confidenceSentence(recipe.confidence)}</p>
      {byModel && provenance.model ? <p className="label-mono mt-2">read by {provenance.provider ? `${provenance.provider} · ` : ''}{provenance.model}</p> : null}

      <div className="mt-4 flex flex-col gap-2.5 empty:hidden">
        {stale ? (
          <Notice tone="petal" role="status">
            <p><strong className="font-semibold">The save’s text has changed since this was read.</strong> {response.edited ? 'Your own version is kept as it is; looking again only refreshes the automatic reading beside it.' : 'The card may be out of date.'}</p>
            <Button variant="outline" size="sm" className="mt-2.5" aria-busy={lookBusy || undefined} disabled={lookBusy} onClick={onLookAgain}><RotateCcw />Look again</Button>
          </Notice>
        ) : null}
        {incomplete ? <Notice tone="petal">{incomplete}</Notice> : null}
        {reason && recipe.reason !== 'not_a_recipe' ? <Notice>{reason}</Notice> : null}
        {dropped ? <Notice>{dropped}</Notice> : null}
        {automatic ? <Notice>The automatic reading is kept beside your version: {automatic.ingredients.length} {automatic.ingredients.length === 1 ? 'ingredient' : 'ingredients'}, {automatic.steps.length} {automatic.steps.length === 1 ? 'step' : 'steps'}, read by {readingLabel(automatic.provenance.method, automatic.confidence)}.</Notice> : null}
      </div>

      <div className="mt-5 flex min-h-11 items-center justify-between gap-4 border-t border-line pt-4">
        <label htmlFor={sourcesSwitch} className="min-w-0 cursor-pointer text-sm text-ink">
          Show where each line came from
          <span className="mt-0.5 block text-xs text-ink-soft">A small tag beside every ingredient and step.</span>
        </label>
        <Switch id={sourcesSwitch} checked={showSources} onCheckedChange={onShowSources} />
      </div>
    </section>
  );
}
