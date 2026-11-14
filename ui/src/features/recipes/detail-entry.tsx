// A save's recipe, from inside the save's detail: a small section that says whether the save has a recipe
// card, opens it, starts cook mode, or looks for one in the save's text. It shows nothing at all while the
// recipes feature is not on this server, and a quiet locked line when this account has not unlocked it.
import { useEffect, useState } from 'react';
import { errorMessage } from '@web/utils.js';
import { Lock, Play, Sparkles } from 'lucide-react';
import { useArchive, useBusy } from '@/app/archive-context';
import { toast } from '@/app/ui-state';
import { Whisper } from '@/components/field';
import { AsciiSpinner } from '@/components/fx/ascii';
import { Button } from '@/components/ui/button';
import { isLocked } from '@/data/client';
import type { Archive } from '@/data/archive';
import type { SeamScreen } from '@/data/location';
import type { Item } from '@/data/types';
import { useFeature } from '../feature-kit';
import { extractRecipe, getRecipe, type RecipeResponse } from './api';
import { cardRest, cookRest, countOf, formatServings, noRecipeSentence, readingLabel } from './model';

type Known =
  | { id: string; phase: 'ready'; response: RecipeResponse }
  | { id: string; phase: 'locked' }
  | { id: string; phase: 'error'; message: string };

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

export function RecipeEntry({ item }: { item: Item }) {
  const archive = useArchive();
  const feature = useFeature('recipes');
  const [known, setKnown] = useState<Known | null>(null);
  const [reload, setReload] = useState(0);
  const [lookBusy, runLook] = useBusy();
  const [note, setNote] = useState('');

  useEffect(() => {
    if (feature !== 'available') return;
    let stale = false;
    getRecipe(archive, item.id).then(
      response => { if (!stale) setKnown({ id: item.id, phase: 'ready', response }); },
      (error: unknown) => { if (!stale) setKnown(isLocked(error) ? { id: item.id, phase: 'locked' } : { id: item.id, phase: 'error', message: errorMessage(error) }); },
    );
    return () => { stale = true; };
  }, [archive, feature, item.id, reload]);

  if (feature === 'loading' || feature === 'unavailable') return null;

  const current = known && known.id === item.id ? known : null;
  const locked = feature === 'locked' || current?.phase === 'locked';
  const response = current?.phase === 'ready' ? current.response : null;
  const recipe = response?.recipe && response.recipe.is_recipe && (response.status === 'extracted' || response.status === 'edited') ? response.recipe : null;

  const look = () => runLook(async () => {
    const result = await extractRecipe(archive, item.id, { method: 'auto' });
    setKnown({ id: item.id, phase: 'ready', response: result });
    if (result.extraction_result.found && result.status !== 'not_a_recipe') {
      setNote('');
      toast('A recipe card is ready.', { tone: 'saved' });
    } else {
      setNote(result.extraction_result.found ? 'The text was read, and it does not read like a recipe.' : noRecipeSentence(result.extraction_result.reason, result.extraction_result.ai_available));
    }
  });

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
          <Button size="sm" onClick={() => setReload(count => count + 1)}>Try again</Button>
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
            <Button variant="primary" size="sm" disabled={recipe.steps.length === 0} title={recipe.steps.length ? undefined : 'This card has no steps to cook from'} onClick={() => void leaveTo(archive, 'recipes', cookRest(item.id))}><Play className="fill-current" />Cook</Button>
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
