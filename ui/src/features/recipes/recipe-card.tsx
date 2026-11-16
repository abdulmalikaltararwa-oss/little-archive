// One recipe, laid out as a card: the title and what it takes, the ingredients (scaled by the server), the
// method with its timers, and, always on the page, where it all came from. Cook mode starts from here.
import { useEffect, useState } from 'react';
import { PLATFORM_NAMES } from '@web/utils.js';
import { cn } from 'cn';
import { ArrowLeft, Bookmark, Clock, ListChecks, Pencil, Play, RotateCcw, Sparkles, Users } from 'lucide-react';
import { useArchive, useArchiveState, useBusy } from '@/app/archive-context';
import { confirm, toast } from '@/app/ui-state';
import { allowAi } from '@/features/ai-permission/gate';
import { Whisper } from '@/components/field';
import { AsciiSpinner } from '@/components/fx/ascii';
import { PlatformIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { VIEW_TITLE_ID } from '@/lib/focus';
import { FeatureHeader, LockedCard, StateCard } from '../feature-kit';
import { discardRecipeEdits, extractRecipe, putRecipe, type ExtractResponse, type Recipe, type RecipeResponse } from './api';
import { IngredientList, ProvenancePanel, ScaleControl, StepList } from './card-parts';
import { EditDialog } from './edit-dialog';
import { markCookFromCard } from './memory';
import { cookRest, countOf, evidenceLabel, formatDuration, formatServings, noRecipeSentence, readingLabel } from './model';
import { RecipeCover } from './recipe-cover';
import { useRecipe, type UseRecipe } from './use-recipe';

/** What to tell the owner after asking the server to look at a save's text again. */
function lookedText(result: ExtractResponse, wasEdited: boolean): string {
  if (!result.extraction_result.found) return noRecipeSentence(result.extraction_result.reason, result.extraction_result.ai_available);
  const kept = wasEdited ? ' Your own version is kept; only the automatic reading beside it was refreshed.' : '';
  if (result.unchanged) return `The text is the same as before, so the reading did not change.${kept}`;
  return `Read the save’s text again.${kept}`;
}

function Loading() {
  return <p role="status" className="flex items-center justify-center gap-2 py-24 text-sm text-ink-soft"><AsciiSpinner />Opening the recipe…</p>;
}

/* A save with no recipe, or one marked as not a recipe ------------------------------------------------------- */

function NoCard({ id, state, kind }: { id: string; state: UseRecipe; kind: 'none' | 'not_a_recipe' }) {
  const archive = useArchive();
  const response = state.response as RecipeResponse;
  const [lookBusy, runLook] = useBusy();
  const [putBusy, runPut] = useBusy();
  const [note, setNote] = useState('');
  const [writing, setWriting] = useState(false);
  const aiAvailable = response.available.ai;
  const owned = response.edited;

  useEffect(() => { document.title = `${state.item?.title || 'Recipe'} — Little Archive`; }, [state.item?.title]);

  const look = async (method: 'auto' | 'ai') => {
    if (!(await allowAi(archive, 'recipe'))) return;
    await runLook(async () => {
      const result = await extractRecipe(archive, id, { method, force: true });
      setNote(lookedText(result, result.edited));
      state.refresh();
      if (result.extraction_result.found && result.status === 'extracted') toast('A recipe card is ready.', { tone: 'saved' });
    });
  };
  const putBack = () => runPut(async () => {
    await discardRecipeEdits(archive, id);
    state.refresh();
    toast('Put back as it was read.');
  });

  const reason = response.recipe?.reason;
  return (
    <div className="mx-auto max-w-2xl pb-10">
      <FeatureHeader back={{ label: 'All recipes', onClick: () => archive.goScreen('recipes') }} title={state.item?.title || 'A save without a recipe card'} />
      <StateCard
        art="search"
        tag={kind === 'not_a_recipe' ? 'marked as not a recipe' : 'no recipe card yet'}
        title={kind === 'not_a_recipe' ? 'Not a recipe' : 'Nothing to cook from yet'}
        actions={
          <>
            {kind === 'not_a_recipe' && owned ? (
              <Button variant="primary" aria-busy={putBusy || undefined} disabled={putBusy} onClick={() => void putBack()}><RotateCcw />Put the card back</Button>
            ) : (
              <Button variant="primary" aria-busy={lookBusy || undefined} disabled={lookBusy} onClick={() => void look('auto')}>{lookBusy ? <AsciiSpinner /> : <Sparkles />}Look for a recipe</Button>
            )}
            <Button onClick={() => setWriting(true)}><Pencil />Write one yourself</Button>
            <Button variant="ghost" onClick={() => void archive.openItem(id)}><Bookmark />Open the save</Button>
          </>
        }
      >
        {kind === 'not_a_recipe'
          ? (owned ? 'You marked this save as not a recipe, so it is not in your recipe list. Nothing was deleted.' : reason === 'too_little_verifiable_content' ? 'The text had too few ingredient lines that it could back up, so no card was made.' : 'The save’s text does not read like a recipe, so no card was made.')
          : 'This save has no recipe card. A card is read from the save’s own text: a caption, notes or page text that sets out ingredients and a method.'}
        {note ? <span role="status" className="mt-3 block rounded-md bg-card-2 px-3.5 py-2.5 text-start text-sm text-ink">{note}</span> : null}
        {aiAvailable && !lookBusy ? <Button variant="ghost" size="sm" className="mt-3" onClick={() => void look('ai')}><Sparkles />Ask the AI to read it</Button> : null}
      </StateCard>
      {writing ? <EditDialog id={id} recipe={null} fallbackTitle={state.item?.title ?? ''} onSaved={state.refresh} onClosed={() => setWriting(false)} /> : null}
    </div>
  );
}

/* The card ------------------------------------------------------------------------------------------------------ */

function Meta({ recipe, base }: { recipe: Recipe; base: number | null }) {
  const all: [string, number | null][] = [['Total', recipe.time.total_seconds], ['Prep', recipe.time.prep_seconds], ['Cook', recipe.time.cook_seconds], ['Active', recipe.time.active_seconds]];
  const times = all.filter((entry): entry is [string, number] => Boolean(entry[1]));
  return (
    <ul className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-sm text-ink">
      {base !== null ? <li className="flex items-center gap-2"><Users className="size-4 text-sage dark:text-sage-deep" aria-hidden="true" />{recipe.servings_text ? <span dir="auto">{recipe.servings_text}</span> : <span>{formatServings(base)} {base === 1 ? 'serving' : 'servings'}</span>}</li> : null}
      {times.map(([label, seconds]) => <li key={label} className="flex items-center gap-2"><Clock className="size-4 text-sage dark:text-sage-deep" aria-hidden="true" /><span><span className="text-ink-soft">{label}</span> {formatDuration(seconds)}</span></li>)}
      <li className="flex items-center gap-2"><ListChecks className="size-4 text-sage dark:text-sage-deep" aria-hidden="true" /><bdi>{countOf(recipe.ingredients.length, 'ingredient')} · {countOf(recipe.steps.length, 'step')}</bdi></li>
    </ul>
  );
}

function CardBody({ id, state, recipe, response }: { id: string; state: UseRecipe; recipe: Recipe; response: RecipeResponse }) {
  const archive = useArchive();
  const remotePreviews = useArchiveState(current => current.settings.remote_previews);
  const [showSources, setShowSources] = useState(false);
  const [editing, setEditing] = useState(false);
  const [lookBusy, runLook] = useBusy();
  const { item, scale, setScale, busy, refresh } = state;
  const scaled = response.scaled ?? null;
  const base = recipe.servings;
  const rescaled = Boolean(scaled) && Math.abs((scaled?.factor_float ?? 1) - 1) > 1e-9;
  const canCook = recipe.steps.length > 0;
  const title = recipe.title || item?.title || 'A recipe';

  useEffect(() => { document.title = `${title} — Little Archive`; }, [title]);

  const cook = () => {
    markCookFromCard();
    archive.goScreen('recipes', cookRest(id));
  };
  const lookAgain = async (method: 'auto' | 'ai' = 'auto') => {
    if (!(await allowAi(archive, 'recipe'))) return;
    await runLook(async () => {
      const result = await extractRecipe(archive, id, { method, force: true });
      refresh();
      toast(lookedText(result, response.edited), { tone: result.extraction_result.found ? 'saved' : 'ok' });
    });
  };
  const notARecipe = () => confirm({
    title: 'Mark this save as not a recipe?',
    message: 'It leaves your recipe list and cook mode. The save itself stays in your library, and you can put the card back from here.',
    confirmLabel: 'Not a recipe',
    action: async () => {
      await putRecipe(archive, id, { is_recipe: false });
      refresh();
      toast('Marked as not a recipe.');
    },
  });
  const discard = () => confirm({
    title: 'Discard your edits?',
    message: response.extracted ? 'Your version of this recipe is removed and the automatic reading beside it comes back. This cannot be undone.' : 'Your version is removed. There is no automatic reading beside it, so the card goes too. This cannot be undone.',
    confirmLabel: 'Discard my edits',
    danger: true,
    action: async () => {
      await discardRecipeEdits(archive, id);
      refresh();
      toast('Your edits are discarded.');
    },
  });

  return (
    <div className="mx-auto max-w-5xl pb-10" data-testid="recipe-card">
      <Button variant="ghost" size="sm" className="-ms-2 mb-3" onClick={() => archive.goScreen('recipes')}><ArrowLeft />All recipes</Button>
      <article aria-labelledby={VIEW_TITLE_ID}>
        <header className="overflow-hidden rounded-xl border border-line bg-card shadow-xs sm:grid sm:grid-cols-[minmax(0,1fr)_17rem] lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="aspect-[16/9] sm:order-last sm:aspect-auto sm:min-h-full">
            <RecipeCover thumbnailUrl={item?.thumbnail_url ?? null} previewUrl={item?.preview_url ?? null} remotePreviews={remotePreviews} title={title} large />
          </div>
          <div className="flex min-w-0 flex-col p-5 sm:p-8">
            <span className="label-mono flex items-center gap-2">
              {item ? <PlatformIcon platform={item.platform} className="size-3.5 shrink-0" /> : null}
              <span dir="auto" className="truncate">{item ? `${PLATFORM_NAMES[item.platform] || 'Web'}${item.creator ? ` · ${item.creator}` : ''}` : 'recipe card'}</span>
            </span>
            <h1 id={VIEW_TITLE_ID} tabIndex={-1} dir="auto" className="display mt-2 text-3xl text-ink outline-none sm:text-4xl">{title}</h1>
            <Meta recipe={recipe} base={base} />
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="label-mono rounded-full border border-line bg-card-2/60 px-2.5 py-1">{readingLabel(recipe.provenance.method, recipe.confidence)}</span>
              <span className="label-mono rounded-full border border-line bg-card-2/60 px-2.5 py-1">{evidenceLabel(recipe.provenance.evidence_level)}</span>
              {response.edited ? <span className="label-mono rounded-full bg-petal-pale px-2.5 py-1 !text-petal-ink">edited by you</span> : null}
            </div>
            <div className="mt-auto grid grid-cols-2 items-center gap-2.5 pt-7 sm:flex sm:flex-wrap">
              <Button variant="primary" size="lg" disabled={!canCook} title={canCook ? undefined : 'This card has no steps to cook from'} onClick={cook}><Play className="fill-current" />Cook</Button>
              <Button size="lg" onClick={() => setEditing(true)}><Pencil />Edit</Button>
              <Button variant="ghost" size="lg" className="col-span-2 sm:col-span-1" onClick={() => void archive.openItem(id)}><Bookmark />Open the save</Button>
            </div>
            {!canCook ? <p className="mt-3 text-xs text-ink-soft">Cook mode needs at least one step. Edit the card to write the method.</p> : null}
          </div>
        </header>

        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,25rem)_minmax(0,1fr)] lg:items-start">
          <section aria-labelledby="ingredients-heading" className="rounded-lg border border-line bg-card p-5 sm:p-6">
            <h2 id="ingredients-heading"><Whisper>ingredients</Whisper></h2>
            <ScaleControl base={base} scale={scale} onScale={setScale} className="mt-4 border-b border-line pb-5" />
            <div aria-busy={busy || undefined} className={cn('mt-3 transition-opacity duration-200', busy && 'opacity-55 delay-150')}>
              {recipe.ingredients.length ? <IngredientList ingredients={scaled?.ingredients ?? recipe.ingredients} showSources={showSources} /> : <p className="py-3 text-sm text-ink-soft">No ingredients were found for this recipe.</p>}
            </div>
            {rescaled && scaled?.notes.length ? <p className="mt-4 text-xs leading-relaxed text-ink-soft">{scaled.notes.join(' ')}</p> : null}
          </section>

          <section aria-labelledby="method-heading" className="rounded-lg border border-line bg-card p-5 sm:p-6">
            <h2 id="method-heading" className="mb-4"><Whisper>method</Whisper></h2>
            {recipe.steps.length ? <StepList steps={recipe.steps} ingredients={recipe.ingredients} showSources={showSources} /> : <p className="py-3 text-sm text-ink-soft">No steps were found for this recipe.</p>}
            {recipe.notes ? (
              <div className="mt-7 border-t border-line pt-5">
                <h3 className="mb-2"><Whisper>notes</Whisper></h3>
                <p dir="auto" className="text-sm leading-relaxed whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">{recipe.notes}</p>
              </div>
            ) : null}
          </section>
        </div>

        <div className="mt-6">
          <ProvenancePanel recipe={recipe} response={response} showSources={showSources} onShowSources={setShowSources} onLookAgain={() => void lookAgain('auto')} lookBusy={lookBusy} />
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button variant="soft" aria-busy={lookBusy || undefined} disabled={lookBusy} onClick={() => void lookAgain('auto')}>{lookBusy ? <AsciiSpinner /> : <RotateCcw />}Look again</Button>
          {response.available.ai ? <Button variant="ghost" disabled={lookBusy} onClick={() => void lookAgain('ai')}><Sparkles />Ask the AI to read it</Button> : null}
          <span className="flex-1" />
          {response.edited ? <Button variant="danger-ghost" onClick={() => void discard()}>Discard my edits</Button> : null}
          <Button variant="danger-ghost" onClick={() => void notARecipe()}>Not a recipe</Button>
        </div>
      </article>
      {editing ? <EditDialog id={id} recipe={recipe} fallbackTitle={item?.title ?? ''} onSaved={refresh} onClosed={() => setEditing(false)} /> : null}
    </div>
  );
}

export function RecipeCardPage({ id }: { id: string }) {
  const archive = useArchive();
  const state = useRecipe(id);
  const { phase, response } = state;
  const ready = phase === 'ready';

  // Arriving on a card, the title takes focus, as on every view.
  useEffect(() => {
    if (!ready) return;
    const frame = requestAnimationFrame(() => document.getElementById(VIEW_TITLE_ID)?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [ready, id]);

  if (phase === 'locked') return <LockedCard feature="recipes" />;
  if (phase === 'error') {
    return (
      <div className="mx-auto max-w-2xl pb-10">
        <FeatureHeader back={{ label: 'All recipes', onClick: () => archive.goScreen('recipes') }} title="This recipe could not be opened" />
        <StateCard art="cloud" title="Something got in the way" actions={<Button variant="primary" onClick={state.refresh}><RotateCcw />Try again</Button>}>{state.error}</StateCard>
      </div>
    );
  }
  if (!response) return <Loading />;
  if (response.status === 'none' || !response.recipe) return <NoCard id={id} state={state} kind="none" />;
  if (response.status === 'not_a_recipe' || !response.recipe.is_recipe) return <NoCard id={id} state={state} kind="not_a_recipe" />;
  return <CardBody id={id} state={state} recipe={response.recipe} response={response} />;
}
