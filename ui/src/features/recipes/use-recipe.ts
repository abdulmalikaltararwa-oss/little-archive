// One recipe, kept in step with the server: loaded for a save, re-read at a new scale (the server does the
// scaling; this only asks), and re-read after anything changes it. The answer on screen is never thrown away
// while the next one is on its way, so changing servings never blanks the card.
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '@web/utils.js';
import { useArchive } from '@/app/archive-context';
import { toast } from '@/app/ui-state';
import { ApiError, isLocked } from '@/data/client';
import type { Item } from '@/data/types';
import { BASE_SCALE, getRecipe, type RecipeResponse, type Scale } from './api';
import { readScale, writeScale } from './memory';
import { sameScale } from './model';

interface Loaded {
  id: string;
  scale: Scale;
  response: RecipeResponse;
}

export type RecipePhase = 'loading' | 'ready' | 'error' | 'locked';

export interface UseRecipe {
  phase: RecipePhase;
  error: string;
  response: RecipeResponse | null;
  /** The save itself (for its cover and its link), when it could be read. */
  item: Item | null;
  scale: Scale;
  setScale(next: Scale): void;
  /** True while an answer for a newer scale is on its way. */
  busy: boolean;
  /** Reads the recipe again, at once, at the scale on show. */
  refresh(): void;
}

// A run of taps on the servings stepper becomes one request.
const SCALE_DELAY = 160;

export function useRecipe(id: string): UseRecipe {
  const archive = useArchive();
  const [scale, setScaleState] = useState<Scale>(() => readScale(id) ?? BASE_SCALE);
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<{ id: string; message: string; locked: boolean } | null>(null);
  const [save, setSave] = useState<{ id: string; item: Item | null } | null>(null);
  const settled = useRef(false);
  const immediate = useRef(true);

  useEffect(() => {
    const controller = new AbortController();
    const wait = immediate.current || !settled.current ? 0 : SCALE_DELAY;
    const timer = setTimeout(() => {
      immediate.current = false;
      const arrived = (response: RecipeResponse) => {
        settled.current = true;
        setLoaded({ id, scale, response });
        setFailure(null);
      };
      const failed = (error: unknown) => {
        if (controller.signal.aborted) return;
        if (isLocked(error)) { setFailure({ id, message: '', locked: true }); return; }
        if (error instanceof ApiError && error.code === 'no_recipe') {
          // A save with no recipe (or one marked as not a recipe) has nothing to scale, and says so with a 404. Ask for it as it is.
          getRecipe(archive, id, null, controller.signal).then(arrived, (again: unknown) => {
            if (!controller.signal.aborted) setFailure({ id, message: errorMessage(again), locked: isLocked(again) });
          });
          return;
        }
        // A recipe that does not state its servings cannot be scaled by servings. Fall back to a factor.
        if (error instanceof ApiError && error.code === 'servings_unknown') { setScaleState(BASE_SCALE); return; }
        if (error instanceof ApiError && error.code === 'scale_out_of_range') {
          toast('That is too far from the original amounts to scale reliably.', { error: true });
          setScaleState(BASE_SCALE);
          return;
        }
        // With a card already on show, a failed refresh keeps it and says so; with nothing on show, the screen says so.
        if (settled.current) { toast(errorMessage(error), { error: true }); setScaleState(BASE_SCALE); return; }
        setFailure({ id, message: errorMessage(error), locked: false });
      };
      getRecipe(archive, id, scale, controller.signal).then(arrived, failed);
    }, wait);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [archive, id, scale, reload]);

  useEffect(() => {
    let stale = false;
    archive.api.item(id).then(
      item => { if (!stale) setSave({ id, item }); },
      () => { if (!stale) setSave({ id, item: null }); },
    );
    return () => { stale = true; };
  }, [archive, id]);

  const setScale = useCallback((next: Scale) => {
    writeScale(id, next);
    setScaleState(next);
  }, [id]);

  const refresh = useCallback(() => {
    immediate.current = true;
    setReload(count => count + 1);
  }, []);

  const view = loaded && loaded.id === id ? loaded : null;
  const problem = failure && failure.id === id ? failure : null;
  let phase: RecipePhase = 'loading';
  if (problem?.locked) phase = 'locked';
  else if (problem && !view) phase = 'error';
  else if (view) phase = 'ready';

  return {
    phase,
    error: problem?.message ?? '',
    response: view?.response ?? null,
    item: save && save.id === id ? save.item : null,
    scale,
    setScale,
    busy: Boolean(view) && !sameScale(view!.scale, scale),
    refresh,
  };
}
