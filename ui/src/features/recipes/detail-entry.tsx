// A save's recipe, from inside the save's detail: a small section that says whether the save has a recipe
// card, opens it, starts cook mode, or looks for one in the save's text. It shows nothing at all while the
// recipes feature is not on this server, and a quiet locked line when this account has not unlocked it.
//
// The detail panel also pins a way into cook mode to its footer (CookBar). Both read one answer about the save
// (useSaveRecipe), so the bar appears the moment a card is found and never without one. Cook mode is part of the
// unlock: a locked account is never asked about the save, so it gets no bar, only the line that leads to the unlock.
import { useState } from 'react';
import { Lock, Play, Sparkles } from 'lucide-react';
import { useArchive, useBusy } from '@/app/archive-context';
import { toast } from '@/app/ui-state';
import { allowAi } from '@/features/ai-permission/gate';
import { Whisper } from '@/components/field';
import { AsciiSpinner } from '@/components/fx/ascii';
import { Button } from '@/components/ui/button';
import type { Archive } from '@/data/archive';
import type { SeamScreen } from '@/data/location';
import type { Item } from '@/data/types';
import { extractRecipe } from './api';
import { cardRest, cookRest, countOf, formatDuration, formatServings, noRecipeSentence, readingLabel } from './model';
import { canCook, useSaveRecipe, type SaveRecipe } from './use-save-recipe';

/**
 * Closes the open save, asking about unsaved edits first, and then opens a recipe page. Closing a save that
 * was opened from the wall asks the browser to go Back one step; the new address waits until that has
 * happened, or the browser would carry it back to the save.
 */
async function leaveTo(archive: Archive, screen: SeamScreen, rest = '') {
  if (!(await archive.closeItem())) return;
  await new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); removeEventListener('popstate', done); resolve(); };
    const timer = setTimeout(done, 200);
    addEventListener('popstate', done, { once: true });
  });
  archive.goScreen(screen, rest);
}

/**
 * The way into cook mode that the save's detail pins to its footer: what the cooking takes, and one button. It is
 * drawn only for a save whose recipe can be cooked from (canCook); it leaves through the same door as every other
 * way out of the save, so unsaved edits are asked about first. `quiet` hands the footer's one strong button to Save.
 */
export function CookBar({ item, state, quiet = false }: { item: Pick<Item, 'id'>; state: SaveRecipe; quiet?: boolean }) {
  const archive = useArchive();
  const recipe = state.recipe;
  if (!recipe || !canCook(state)) return null;
  const timers = recipe.steps.filter(step => step.timer_seconds).length;
  return (
    <>
      <p data-testid="cook-facts" className="order-first flex basis-full flex-wrap gap-x-3.5 gap-y-0.5 text-sm text-ink-soft">
        {recipe.time.total_seconds ? <span><span className="num font-medium text-ink">{formatDuration(recipe.time.total_seconds)}</span> total</span> : null}
        <span><span className="num font-medium text-ink">{recipe.steps.length}</span> {recipe.steps.length === 1 ? 'step' : 'steps'}</span>
        {timers ? <span><span className="num font-medium text-ink">{timers}</span> {timers === 1 ? 'timer' : 'timers'}</span> : null}
      </p>
      <Button variant={quiet ? 'outline' : 'primary'} className="max-sm:flex-1" onClick={() => void leaveTo(archive, 'recipes', cookRest(item.id))}><Play className="fill-current" />Start cooking</Button>
    </>
  );
}

export function RecipeEntry({ item }: { item: Item }) {
  return <RecipeSection item={item} state={useSaveRecipe(item.id)} />;
}

/** The recipe section itself. `pinned` says a CookBar is on show beside it, so the card does not offer cook mode twice. */
export function RecipeSection({ item, state, pinned = false }: { item: Item; state: SaveRecipe; pinned?: boolean }) {
  const archive = useArchive();
  const { feature, current, locked, response, recipe, setKnown } = state;
  const [lookBusy, runLook] = useBusy();
  const [note, setNote] = useState('');

  if (feature === 'loading' || feature === 'unavailable') return null;

  const look = async () => {
    if (!(await allowAi(archive, 'recipe'))) return;
    await runLook(async () => {
      const result = await extractRecipe(archive, item.id, { method: 'auto' });
      setKnown({ id: item.id, phase: 'ready', response: result });
      if (result.extraction_result.found && result.status !== 'not_a_recipe') {
        setNote('');
        toast('A recipe card is ready.', { tone: 'saved' });
      } else {
        setNote(result.extraction_result.found ? 'The text was read, and it does not read like a recipe.' : noRecipeSentence(result.extraction_result.reason, result.extraction_result.ai_available));
      }
    });
  };

  return (
    <section aria-label="Recipe" data-testid="recipe-entry" className="mt-6 border-t border-line pt-5">
      <h3 className="mb-3"><Whisper>recipe</Whisper></h3>

      {locked ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-soft">
          <Lock className="size-4 shrink-0" aria-hidden="true" />
          <span>Recipe cards are part of the one-time unlock.</span>
          <Button variant="link" size="sm" onClick={() => void leaveTo(archive, 'unlock')}>About the unlock</Button>
        </p>
      ) : !current ? (
        <p role="status" className="flex items-center gap-2 text-sm text-ink-soft"><AsciiSpinner />Checking for a recipe…</p>
      ) : current.phase === 'error' ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ink-soft">
          <span role="alert">{current.message}</span>
          <Button size="sm" onClick={state.retry}>Try again</Button>
        </div>
      ) : recipe ? (
        <div className="rounded-lg bg-sage-pale/60 p-4">
          <p className="label-mono">{readingLabel(recipe.provenance.method, recipe.confidence)}{response?.edited ? ' · edited' : ''}</p>
          <p dir="auto" className="display mt-1.5 text-lg leading-snug text-ink">{recipe.title || item.title}</p>
          <p className="mt-1 text-xs text-ink-soft">
            {recipe.servings !== null ? `${formatServings(recipe.servings)} ${recipe.servings === 1 ? 'serving' : 'servings'} · ` : ''}{countOf(recipe.ingredients.length, 'ingredient')} · {countOf(recipe.steps.length, 'step')}
          </p>
          <div className="mt-3.5 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => void leaveTo(archive, 'recipes', cardRest(item.id))}>Open recipe card</Button>
            {pinned && canCook(state) ? null : (
              <Button variant="primary" size="sm" disabled={recipe.steps.length === 0} title={recipe.steps.length ? undefined : 'This card has no steps to cook from'} onClick={() => void leaveTo(archive, 'recipes', cookRest(item.id))}><Play className="fill-current" />Cook</Button>
            )}
          </div>
        </div>
      ) : response?.status === 'not_a_recipe' ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ink-soft">
          <span>{response.edited ? 'You marked this save as not a recipe.' : 'This save’s text does not read like a recipe.'}</span>
          <Button size="sm" onClick={() => void leaveTo(archive, 'recipes', cardRest(item.id))}>See the card</Button>
        </div>
      ) : (
        <div>
          <p className="text-sm leading-relaxed text-ink-soft">No recipe card yet. A card is read from this save’s own text: an ingredients list and a method in the caption, notes or page.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" aria-busy={lookBusy || undefined} disabled={lookBusy} onClick={() => void look()}>{lookBusy ? <AsciiSpinner /> : <Sparkles />}Look for a recipe</Button>
          </div>
          {note ? <p role="status" className="mt-3 rounded-md bg-card-2 px-3.5 py-2.5 text-sm leading-relaxed text-ink">{note}</p> : null}
        </div>
      )}
    </section>
  );
}
