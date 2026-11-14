// The feature screens, each loaded only when its address is opened. A screen is a default export that takes
// these props; `rest` is whatever follows the screen's own path in the address (#/recipes/<rest>).
import { lazy, Suspense, type ComponentType } from 'react';
import { AsciiSpinner } from '@/components/fx/ascii';
import type { SeamScreen as ScreenName } from '@/data/location';

export interface FeatureScreenProps {
  demo: boolean;
  /** The part of the address after the screen's own path, already validated: segments of letters, digits, - and _. */
  rest: string;
}

const SCREENS: Record<ScreenName, ComponentType<FeatureScreenProps>> = {
  recipes: lazy(() => import('./recipes/screen')),
  places: lazy(() => import('./places/screen')),
  ask: lazy(() => import('./ask/screen')),
  'guided-import': lazy(() => import('./guided-import/screen')),
  unlock: lazy(() => import('./unlock/screen')),
};

export function FeatureScreen({ screen, demo, rest }: FeatureScreenProps & { screen: ScreenName }) {
  const Screen = SCREENS[screen];
  return (
    <Suspense fallback={<p role="status" className="flex items-center justify-center gap-2 py-24 text-sm text-ink-soft"><AsciiSpinner />Opening…</p>}>
      <Screen demo={demo} rest={rest} />
    </Suspense>
  );
}
