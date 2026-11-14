// Placeholder screens for what arrives next: recipes and cook mode, the places map, asking your archive, the
// guided export import, and the one-time unlock. Each has its address, its place in the navigation and a
// screen that says plainly that it is not here yet. None of them calls a server route that does not exist.
import { useEffect } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useArchive } from '@/app/archive-context';
import { Whisper } from '@/components/field';
import { Ascii, type ArtName } from '@/components/fx/ascii';
import { Button } from '@/components/ui/button';
import type { SeamScreen as SeamName } from '@/data/location';
import { VIEW_TITLE_ID } from '@/lib/focus';
import type { SeamContracts } from './contracts';

interface SeamCopy {
  art: ArtName;
  title: string;
  lede: string;
  planned: string[];
  /** The placeholder contract this screen is waiting on (see contracts.ts). */
  waitingOn: keyof SeamContracts;
}

const SEAMS: Record<SeamName, SeamCopy> = {
  recipes: {
    art: 'bowl',
    title: 'Recipes, ready to cook',
    lede: 'The dishes you saved, laid out as a card you can cook from.',
    planned: ['A recipe card with ingredients and steps, drawn from what the post says', 'Cook mode: one step at a time, large type, the screen kept awake', 'Every line labelled with where it came from, like any other suggestion'],
    waitingOn: 'recipes',
  },
  places: {
    art: 'map',
    title: 'Places on a map',
    lede: 'The cafés, trails and little shops you saved, where they actually are.',
    planned: ['A map of the saves that name a place', 'Filter by collection or topic, then open the save', 'Nothing is located without your say-so'],
    waitingOn: 'places',
  },
  ask: {
    art: 'chat',
    title: 'Ask your archive',
    lede: 'A question in your own words, answered from the things you kept.',
    planned: ['Ask across titles, captions, transcripts and your notes', 'Every answer points at the saves it came from', 'Works with the AI your server is set up for'],
    waitingOn: 'ask',
  },
  'guided-import': {
    art: 'box',
    title: 'A guided export import',
    lede: 'A walk through asking Instagram or TikTok for your data, and bringing the file home.',
    planned: ['Step-by-step, with what to tap on each platform', 'A check of the file before anything is imported', 'The same honest coverage report as every import'],
    waitingOn: 'guided-import',
  },
  unlock: {
    art: 'key',
    title: 'A one-time unlock',
    lede: 'Free on your own server, always. For the hosted service: pay once, keep it.',
    planned: ['One payment, no subscription', 'Optional credit packs for closer AI reads', 'Self-hosters never see a paywall'],
    waitingOn: 'unlock',
  },
};

export function SeamScreen({ screen, demo }: { screen: SeamName; demo: boolean }) {
  const archive = useArchive();
  const copy = SEAMS[screen];
  useEffect(() => { document.title = `${copy.title} — Little Archive${demo ? ' demo' : ''}`; }, [copy.title, demo]);
  return (
    <section data-seam={copy.waitingOn} className="mx-auto flex max-w-xl flex-col items-center pt-6 pb-10 text-center sm:pt-12">
      <Ascii name={copy.art} className="mb-7 text-start text-base text-sage dark:text-sage-deep" />
      <span className="label-mono rounded-full bg-butter-pale px-2.5 py-1 !text-butter-ink">arriving in the next wave</span>
      <h1 id={VIEW_TITLE_ID} tabIndex={-1} className="display mt-4 text-4xl text-ink outline-none sm:text-5xl">{copy.title}</h1>
      <p className="mt-3 max-w-md text-base text-ink-soft">{copy.lede}</p>
      <div className="mt-8 w-full rounded-xl border border-dashed border-line-strong bg-card/60 p-6 text-start">
        <Whisper>what is planned</Whisper>
        <ul className="mt-3 flex flex-col gap-2.5 text-sm text-ink">
          {copy.planned.map(line => (
            <li key={line} className="flex gap-3">
              <span aria-hidden="true" className="font-mono text-petal-ink">*</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
        <p className="mt-5 text-xs leading-relaxed text-ink-soft">This is a placeholder. Nothing here works yet, and nothing is sent anywhere.</p>
      </div>
      <Button className="mt-8" onClick={() => archive.goView('all')}><ArrowLeft />Back to your library</Button>
    </section>
  );
}
