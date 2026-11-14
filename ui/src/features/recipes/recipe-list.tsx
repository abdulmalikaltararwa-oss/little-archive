// All the recipe cards: the saves whose recipe is a recipe, newest change first. Each tile opens its card;
// Cook goes straight to cook mode. Nothing here guesses: a tile says how its card was read (page data, text
// rules or AI) and how sure the server is, and an empty list says how a recipe gets here.
import { useEffect, useState } from 'react';
import { errorMessage } from '@web/utils.js';
import { cn } from 'cn';
import { ArrowDown, Clock, ListChecks, Play, RotateCcw, Users } from 'lucide-react';
import { useArchive, useArchiveState, useBusy } from '@/app/archive-context';
import { AsciiSpinner } from '@/components/fx/ascii';
import { NumberTicker } from '@/components/fx/number-ticker';
import { Button } from '@/components/ui/button';
import { isLocked } from '@/data/client';
import { FeatureHeader, LockedCard, StateCard } from '../feature-kit';
import { listRecipes, type RecipeRow } from './api';
import { markCookFromCard } from './memory';
import { cardRest, cookRest, countOf, formatDuration, formatServings, readingLabel } from './model';
import { RecipeCover } from './recipe-cover';

const PAGE = 24;

type ListState =
  | { phase: 'loading' }
  | { phase: 'locked' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; rows: RecipeRow[]; total: number };

function Tile({ row, index }: { row: RecipeRow; index: number }) {
  const archive = useArchive();
  const title = row.title || row.item_title || 'A recipe';
  const open = () => archive.goScreen('recipes', cardRest(row.item_id));
  const cook = () => { markCookFromCard(); archive.goScreen('recipes', cookRest(row.item_id)); };
  return (
    <article
      data-item-id={row.item_id}
      aria-labelledby={`recipe-${row.item_id}`}
      className={cn(
        'group/card relative flex w-full flex-col rounded-lg border border-line bg-card p-1.5 shadow-xs',
        'transition-[transform,box-shadow,border-color] duration-300 ease-spring hov:-translate-y-1 hov:border-sage/35 hov:shadow-md',
        index % 2 ? 'hov:rotate-[0.5deg]' : 'hov:-rotate-[0.5deg]',
        'has-[[data-card-control=open]:active]:scale-[0.985]',
      )}
    >
      <div className="aspect-[16/10] overflow-hidden rounded-[16px] sm:aspect-[4/3]">
        <RecipeCover thumbnailUrl={row.thumbnail_url} title={title} />
      </div>
      <div className="flex flex-1 flex-col px-2 pt-3 pb-1.5">
        <div className="flex items-center justify-between gap-2">
          <span data-testid="reading-label" className="label-mono truncate">{readingLabel(row.method, row.confidence)}</span>
          {row.edited ? <span className="shrink-0 rounded-full bg-petal-pale px-2 py-0.5 text-2xs font-medium text-petal-ink">Edited</span> : null}
        </div>
        <h3 id={`recipe-${row.item_id}`} dir="auto" className="display mt-1.5 line-clamp-2 text-lg leading-snug text-ink">
          <button
            type="button"
            data-card-control="open"
            aria-label={`Open the recipe card for ${title}`}
            onClick={open}
            className="rounded-sm text-start outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:outline-[2.5px] focus-visible:after:outline-offset-2 focus-visible:after:outline-sage"
          >
            {title}
          </button>
        </h3>
        <ul className="mt-2.5 flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-ink-soft">
          {row.servings !== null ? <li className="flex items-center gap-1.5"><Users className="size-3.5" aria-hidden="true" />{formatServings(row.servings)} {row.servings === 1 ? 'serving' : 'servings'}</li> : null}
          {row.total_seconds ? <li className="flex items-center gap-1.5"><Clock className="size-3.5" aria-hidden="true" />{formatDuration(row.total_seconds)}</li> : null}
          <li className="flex items-center gap-1.5"><ListChecks className="size-3.5" aria-hidden="true" /><bdi>{countOf(row.ingredient_count, 'ingredient')} · {countOf(row.step_count, 'step')}</bdi></li>
        </ul>
        <div className="mt-auto flex pt-3.5">
          <Button variant="soft" size="sm" className="relative z-[2]" disabled={row.step_count === 0} aria-label={`Cook ${title}`} onClick={cook}><Play className="fill-current" />Cook</Button>
        </div>
      </div>
    </article>
  );
}

function Ghosts() {
  return (
    <div aria-hidden="true" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="rounded-lg border border-line bg-card p-1.5">
          <div className="aspect-[4/3] rounded-[16px] bg-card-2" />
          <div className="space-y-2.5 px-2 pt-3 pb-3"><div className="h-3 w-1/3 rounded-full bg-card-2" /><div className="h-5 w-4/5 rounded-full bg-card-2" /><div className="h-3 w-3/5 rounded-full bg-card-2" /></div>
        </div>
      ))}
    </div>
  );
}

export function RecipeList() {
  const archive = useArchive();
  const aiOnServer = useArchiveState(state => state.features?.recipes.ai);
  const [state, setState] = useState<ListState>({ phase: 'loading' });
  const [reload, setReload] = useState(0);
  const [moreBusy, runMore] = useBusy();

  useEffect(() => { document.title = 'Recipes — Little Archive'; }, []);

  useEffect(() => {
    const controller = new AbortController();
    listRecipes(archive, { limit: PAGE, offset: 0 }, controller.signal).then(
      result => setState({ phase: 'ready', rows: result.recipes, total: result.total }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState(isLocked(error) ? { phase: 'locked' } : { phase: 'error', message: errorMessage(error) });
      },
    );
    return () => controller.abort();
  }, [archive, reload]);

  const showMore = () => runMore(async () => {
    if (state.phase !== 'ready') return;
    const result = await listRecipes(archive, { limit: PAGE, offset: state.rows.length });
    setState(current => (current.phase === 'ready' ? { phase: 'ready', rows: [...current.rows, ...result.recipes.filter(row => !current.rows.some(known => known.item_id === row.item_id))], total: result.total } : current));
  });

  if (state.phase === 'locked') return <LockedCard feature="recipes" />;
  const ready = state.phase === 'ready' ? state : null;

  return (
    <div data-testid="recipe-list" className="pb-10">
      <FeatureHeader
        whisper="your recipes"
        title="Recipes, ready to cook"
        lede="Cards read from the saves that hold a recipe. Every card says how it was read and what it rests on, and you can correct any of it."
        actions={ready && ready.total > 0 ? (
          <p className="label-mono rounded-full border border-line bg-card px-3.5 py-2 !text-ink"><NumberTicker value={ready.total} className="text-sm" /> {ready.total === 1 ? 'recipe card' : 'recipe cards'}</p>
        ) : undefined}
      />

      {state.phase === 'loading' ? <div role="status" aria-label="Loading your recipes"><Ghosts /></div> : null}

      {state.phase === 'error' ? (
        <StateCard art="cloud" title="The recipes did not load" actions={<Button variant="primary" onClick={() => { setState({ phase: 'loading' }); setReload(count => count + 1); }}><RotateCcw />Try again</Button>}>{state.message}</StateCard>
      ) : null}

      {ready && ready.rows.length === 0 ? (
        <StateCard
          art="bowl"
          title="No recipe cards yet"
          actions={<Button variant="primary" onClick={() => archive.goView('all')}>Go to your library</Button>}
        >
          A recipe card appears when a save holds a recipe. Open a save and choose “Look for a recipe”: captions that set out ingredients and a method are read by plain rules, with no AI.
          <span className="mt-3 block text-xs text-ink-soft">{aiOnServer ? 'This server also has an AI set up, which can read looser captions.' : 'No AI is set up on this server, so only captions with a clear ingredients list and method are read.'}</span>
        </StateCard>
      ) : null}

      {ready && ready.rows.length > 0 ? (
        <>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {ready.rows.map((row, index) => <li key={row.item_id} className="flex"><Tile row={row} index={index} /></li>)}
          </ul>
          <div className="mt-8 flex flex-col items-center gap-3">
            <p role="status" className="label-mono">showing {ready.rows.length.toLocaleString()} of {ready.total.toLocaleString()}</p>
            {ready.rows.length < ready.total ? <Button aria-busy={moreBusy || undefined} disabled={moreBusy} onClick={() => void showMore()}>{moreBusy ? <AsciiSpinner /> : <ArrowDown />}Show more recipes</Button> : null}
          </div>
          <p className="mx-auto mt-8 max-w-2xl text-center text-xs leading-relaxed text-ink-soft">A card is only a reading of the save’s text. It never claims more than the text says, and nothing in it is made up to fill a gap.</p>
        </>
      ) : null}
    </div>
  );
}
