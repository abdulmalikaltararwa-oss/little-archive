// What is known about one save's recipe, asked once and shared by the two places in the save's detail that show
// it: the recipe section in the body and the way into cook mode pinned to the footer (detail-entry.tsx).
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { errorMessage } from '@web/utils.js';
import { useArchive } from '@/app/archive-context';
import { isLocked } from '@/data/client';
import { useFeature, type FeatureState } from '../feature-kit';
import { getRecipe, type Recipe, type RecipeResponse } from './api';

export type Known =
  | { id: string; phase: 'ready'; response: RecipeResponse }
  | { id: string; phase: 'locked' }
  | { id: string; phase: 'error'; message: string };

/** What the save's detail knows about its recipe. */
export interface SaveRecipe {
  feature: FeatureState;
  /** The answer for this save, or null while it is on its way (and always, where recipes cannot be used). */
  current: Known | null;
  locked: boolean;
  response: RecipeResponse | null;
  /** The save's recipe card, when it has one that is a recipe. */
  recipe: Recipe | null;
  setKnown: Dispatch<SetStateAction<Known | null>>;
  retry(): void;
}

/** Asks once whether a save has a recipe. Nothing is asked without an id, or while recipes are locked or not offered here. */
export function useSaveRecipe(id: string): SaveRecipe {
  const archive = useArchive();
  const feature = useFeature('recipes');
  const [known, setKnown] = useState<Known | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (feature !== 'available' || !id) return;
    let stale = false;
    getRecipe(archive, id).then(
      response => { if (!stale) setKnown({ id, phase: 'ready', response }); },
      (error: unknown) => { if (!stale) setKnown(isLocked(error) ? { id, phase: 'locked' } : { id, phase: 'error', message: errorMessage(error) }); },
    );
    return () => { stale = true; };
  }, [archive, feature, id, reload]);

  const current = known && known.id === id ? known : null;
  const response = current?.phase === 'ready' ? current.response : null;
  return {
    feature,
    current,
    locked: feature === 'locked' || current?.phase === 'locked',
    response,
    recipe: response?.recipe && response.recipe.is_recipe && (response.status === 'extracted' || response.status === 'edited') ? response.recipe : null,
    setKnown,
    retry: () => setReload(count => count + 1),
  };
}

/** Whether cook mode can be entered from this answer: a card that is a recipe, with steps to cook from, on an account that may use it. */
export function canCook(state: Pick<SaveRecipe, 'feature' | 'locked' | 'recipe'>): boolean {
  return state.feature === 'available' && !state.locked && Boolean(state.recipe?.steps.length);
}
