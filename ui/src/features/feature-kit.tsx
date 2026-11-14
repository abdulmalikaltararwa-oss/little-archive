// What every feature screen (recipes, places, ask, guided import, unlock) shares: knowing whether the
// feature can be used here, a common header, and the two honest dead ends (locked, and not on this server).
//
// The rule for a locked feature: the server is the authority. GET /api/features says what is locked before a
// screen is opened, and any call may still answer 402 with code "unlock_required"; both lead to the same card.
import type { ReactNode } from 'react';
import { ArrowLeft, KeyRound } from 'lucide-react';
import { useArchive, useArchiveState } from '@/app/archive-context';
import { Whisper } from '@/components/field';
import { Ascii, AsciiSpinner, type ArtName } from '@/components/fx/ascii';
import { Button } from '@/components/ui/button';
import type { FeatureName } from '@/data/types';
import { VIEW_TITLE_ID } from '@/lib/focus';

export type FeatureState = 'loading' | 'available' | 'locked' | 'unavailable';

/** Whether a feature can be used on this server by this account, from GET /api/features. */
export function useFeature(name: FeatureName): FeatureState {
  const known = useArchiveState(state => state.featuresKnown);
  const flag = useArchiveState(state => state.features?.[name]);
  if (!known) return 'loading';
  if (!flag) return 'unavailable';
  if (flag.locked) return 'locked';
  return flag.available ? 'available' : 'unavailable';
}

/** The top of a feature screen: a whisper, the title (which takes focus when the screen is reached), a line, and actions. */
export function FeatureHeader({ whisper, title, lede, actions, back }: { whisper?: string; title: string; lede?: ReactNode; actions?: ReactNode; back?: { label: string; onClick(): void } }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-4 pt-2">
      <div className="min-w-0">
        {back ? (
          <Button variant="ghost" size="sm" className="-ms-2 mb-2" onClick={back.onClick}><ArrowLeft />{back.label}</Button>
        ) : whisper ? (
          <Whisper>{whisper}</Whisper>
        ) : null}
        <h1 id={VIEW_TITLE_ID} tabIndex={-1} dir="auto" className="display mt-1.5 text-3xl text-ink outline-none sm:text-[2.4rem] sm:leading-tight">{title}</h1>
        {lede ? <p className="mt-2 max-w-xl text-sm text-ink-soft sm:text-base">{lede}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** A centred card for "nothing to show": an ASCII drawing, a title, a sentence and actions. */
export function StateCard({ art, title, children, actions, tag }: { art: ArtName; title: string; children: ReactNode; actions?: ReactNode; tag?: string }) {
  return (
    <section className="mx-auto flex max-w-xl flex-col items-center rounded-2xl border border-dashed border-line-strong bg-card/50 px-6 py-12 text-center sm:py-16">
      <Ascii name={art} className="mb-6 text-start text-sm leading-[1.15] text-sage dark:text-sage-deep" />
      {tag ? <span className="label-mono mb-3 rounded-full bg-butter-pale px-2.5 py-1 !text-butter-ink">{tag}</span> : null}
      <h2 className="display text-3xl text-ink">{title}</h2>
      <div className="mt-2.5 max-w-sm text-sm leading-relaxed text-ink-soft sm:text-base">{children}</div>
      {actions ? <div className="mt-6 flex flex-wrap justify-center gap-2">{actions}</div> : null}
    </section>
  );
}

const NAMES: Record<FeatureName, string> = { recipes: 'Recipes', places: 'Places', ask: 'Ask your archive', guided_import: 'The guided import' };

/** Shown instead of a feature that this account has not unlocked (a hosted account; self-hosters are never locked). */
export function LockedCard({ feature }: { feature: FeatureName }) {
  const archive = useArchive();
  return (
    <StateCard art="key" tag="part of the one-time unlock" title={`${NAMES[feature]} ${feature === 'recipes' || feature === 'places' ? 'are' : 'is'} locked for now`} actions={<Button variant="primary" onClick={() => archive.goScreen('unlock')}><KeyRound />About the unlock</Button>}>
      Your library, search, import and export stay free. This part opens with a single payment, once.
    </StateCard>
  );
}

/** Shown where the server (or the demo) does not have the feature at all. */
export function UnavailableCard({ feature }: { feature: FeatureName }) {
  const archive = useArchive();
  const demo = archive.backend.kind === 'demo';
  return (
    <StateCard art="cloud" title={demo ? 'Not in the demo' : 'Not on this server yet'} actions={<Button onClick={() => archive.goView('all')}><ArrowLeft />Back to your library</Button>}>
      {demo
        ? `${NAMES[feature]} need${feature === 'recipes' || feature === 'places' ? '' : 's'} a real Little Archive server. This demo keeps everything in the page and talks to nothing.`
        : `This server does not offer ${NAMES[feature].toLowerCase()}. It may be running an earlier version of Little Archive.`}
    </StateCard>
  );
}

/** Wraps a feature screen: shows it when the feature can be used, and the right dead end when it cannot. */
export function FeatureGate({ feature, children }: { feature: FeatureName; children: ReactNode }) {
  const state = useFeature(feature);
  if (state === 'loading') return <p role="status" className="flex items-center justify-center gap-2 py-24 text-sm text-ink-soft"><AsciiSpinner />Checking what this server offers…</p>;
  if (state === 'locked') return <LockedCard feature={feature} />;
  if (state === 'unavailable') return <UnavailableCard feature={feature} />;
  return <>{children}</>;
}
