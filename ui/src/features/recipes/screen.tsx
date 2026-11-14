// The recipes screen. One address family, three views:
//   #/recipes               every recipe card
//   #/recipes/<save>        one recipe card
//   #/recipes/<save>/cook   cook mode, one step at a time
// Cook mode is loaded only when it is opened, so the card does not carry its sound, timers or wake lock.
import { lazy, Suspense } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useArchive } from '@/app/archive-context';
import { AsciiSpinner } from '@/components/fx/ascii';
import { Button } from '@/components/ui/button';
import { FeatureGate, StateCard } from '../feature-kit';
import type { FeatureScreenProps } from '../screens';
import { parseRest } from './model';
import { RecipeCardPage } from './recipe-card';
import { RecipeList } from './recipe-list';

const CookMode = lazy(() => import('./cook-mode').then(module => ({ default: module.CookMode })));

function UnknownAddress() {
  const archive = useArchive();
  return (
    <StateCard art="search" title="That is not a recipe page" actions={<Button variant="primary" onClick={() => archive.goScreen('recipes')}><ArrowLeft />All recipes</Button>}>
      This address does not lead to a recipe card. Recipes live at the recipes screen, one card for each save.
    </StateCard>
  );
}

export default function RecipesScreen({ rest }: FeatureScreenProps) {
  const route = parseRest(rest);
  return (
    <div data-seam="recipes">
      <FeatureGate feature="recipes">
        {route.view === 'list' ? <RecipeList /> : null}
        {route.view === 'card' ? <RecipeCardPage key={route.id} id={route.id} /> : null}
        {route.view === 'cook' ? (
          <Suspense fallback={<p role="status" className="flex items-center justify-center gap-2 py-24 text-sm text-ink-soft"><AsciiSpinner />Getting the recipe ready…</p>}>
            <CookMode key={route.id} id={route.id} />
          </Suspense>
        ) : null}
        {route.view === 'unknown' ? <UnknownAddress /> : null}
      </FeatureGate>
    </div>
  );
}
