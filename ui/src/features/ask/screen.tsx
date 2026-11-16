// Ask your archive: a question in your own words, answered only from what was saved, with the quotes the
// answer rests on. Every outcome the server can give is shown for what it is: an answer, a ranked list because
// no AI is set up, nothing saved, or a reason the answer was not shown. The server does not stream, so nothing
// here pretends to type; the answer arrives once, with one gentle reveal.
import { useEffect, useMemo, useRef } from 'react';
import { ArrowUp, Info, Plus } from 'lucide-react';
import { useArchive, useArchiveState } from '@/app/archive-context';
import { openDialog } from '@/app/ui-state';
import { Whisper } from '@/components/field';
import { Button } from '@/components/ui/button';
import { VIEW_TITLE_ID } from '@/lib/focus';
import { serverWords } from '@/lib/server-words';
import { FeatureGate, FeatureHeader, LockedCard } from '../feature-kit';
import type { FeatureScreenProps } from '../screens';
import { Composer } from './composer';
import { History } from './history';
import { aiNote, askCapability, buildExamples, COMPOSER_ID } from './logic';
import { Echo, Evidence, Outcome } from './result';
import { askSessionFor } from './session';
import { useAskState } from './use-ask';

const STEPS = [
  'Your words become search terms, matched against the text of your saves.',
  'If an AI is set up, it is asked to answer only from the best matches, in a few sentences.',
  'Every quote shown under an answer was checked, word for word, against the save it names. An answer whose quotes cannot be checked is not shown.',
];

function HowItWorks() {
  return (
    <section aria-labelledby="ask-how" className="relative rounded-lg border border-line bg-card/60 p-4">
      <h2 id="ask-how"><Whisper>how asking works</Whisper></h2>
      <ol className="mt-3 flex flex-col gap-3 text-sm leading-relaxed text-ink-soft">
        {STEPS.map((step, index) => (
          <li key={step} className="flex gap-3">
            <span aria-hidden="true" className="num pt-px text-petal-ink">{index + 1}</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function AskPage({ demo }: { demo: boolean }) {
  const archive = useArchive();
  const session = useMemo(() => askSessionFor(archive), [archive]);
  const entries = useAskState(session, state => state.entries);
  const activeId = useAskState(session, state => state.activeId);
  const active = entries.find(entry => entry.id === activeId);
  const features = useArchiveState(state => state.features);
  const settings = useArchiveState(state => state.settings);
  const total = useArchiveState(state => state.stats.total);
  const tags = useArchiveState(state => state.tags);
  const collections = useArchiveState(state => state.collections);
  const results = useRef<HTMLDivElement>(null);
  const settled = active ? active.state.status !== 'pending' : false;
  // What is on show: a question, and whether its answer has arrived. Either one changing is a reason to look.
  const onShow = `${activeId}:${settled}`;
  const shown = useRef(onShow);

  useEffect(() => { document.title = `Ask your archive — Little Archive${demo ? ' demo' : ''}`; }, [demo]);

  // A new question, and then its answer, bring the result into view (on a phone it starts below the form).
  // Coming back to the screen with an answer already on show leaves the page where it is.
  useEffect(() => {
    if (activeId && shown.current !== onShow) {
      const top = results.current?.getBoundingClientRect().top ?? 0;
      if (top > innerHeight * 0.55 || top < 0) {
        const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        results.current?.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' });
      }
    }
    shown.current = onShow;
  }, [activeId, onShow]);

  // Coming back from a save opened out of an answer: the cursor goes back to that save's card. The detail panel
  // tries to do this too but this screen is not on the page yet when it closes; it only steps in if focus has
  // been left on the page's heading or nowhere.
  useEffect(() => {
    const timer = setTimeout(() => {
      const id = session.takeOpened();
      const now = document.activeElement;
      if (!id || (now && now !== document.body && now.id !== VIEW_TITLE_ID)) return;
      document.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"] [data-card-control="open"]`)?.focus();
    }, 450);
    return () => clearTimeout(timer);
  }, [session]);

  const capability = askCapability(features, settings);
  const examples = useMemo(() => buildExamples({ tags, collections }), [tags, collections]);

  const fillExample = (text: string) => {
    session.dispatch({ type: 'drafted', text });
    // The words go in the box and nothing is sent: a question can use up an AI allowance, so Ask stays a deliberate press.
    if (typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches) {
      requestAnimationFrame(() => {
        const box = document.getElementById(COMPOSER_ID) as HTMLTextAreaElement | null;
        box?.focus();
        box?.setSelectionRange(text.length, text.length);
      });
    }
  };
  const open = (id: string) => session.dispatch({ type: 'opened', id });
  const clear = () => session.dispatch({ type: 'cleared' });
  const history = { entries, activeId, onOpen: open, onClear: clear };

  const pending = active?.state.status === 'pending';
  return (
    <div data-seam="ask" className="mx-auto max-w-5xl pb-10">
      <FeatureHeader
        whisper="from what you kept"
        title="Ask your archive"
        lede="A question in your own words, answered only from the things you saved, with the quotes it rests on."
      />
      <div className="grid gap-x-10 gap-y-10 xl:grid-cols-[minmax(0,1fr)_15.5rem]">
        <div className="min-w-0">
          <Composer session={session} />
          <p className="mt-3 flex gap-2 text-xs leading-relaxed text-ink-soft">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>{serverWords(aiNote(capability, settings), archive.backend.mode)}</span>
          </p>

          <History {...history} variant="chips" className="mt-6 xl:hidden" />

          {!entries.length ? (
            total === 0 ? (
              <div className="mt-8 rounded-lg border border-dashed border-line-strong bg-card/50 px-5 py-6 text-center">
                <p className="text-sm text-ink-soft">Your archive is empty, so there is nothing to ask about yet.</p>
                <Button variant="soft" size="sm" className="mt-3" onClick={() => openDialog({ kind: 'save-link' })}><Plus />Save a link</Button>
              </div>
            ) : examples.length ? (
              <section aria-labelledby="ask-examples" className="mt-8">
                <h2 id="ask-examples"><Whisper>try asking</Whisper></h2>
                <ul className="mt-3 flex flex-wrap gap-2">
                  {examples.map(example => (
                    <li key={example.id} className="max-w-full">
                      <button
                        type="button"
                        onClick={() => fillExample(example.text)}
                        className="flex min-h-11 max-w-full items-center gap-2.5 rounded-full border border-line bg-card px-4 py-2 text-start text-sm text-ink outline-none transition-[transform,border-color,background-color] duration-200 ease-spring hov:-translate-y-px hov:border-sage/40 hov:bg-sage-pale active:scale-[0.97]"
                      >
                        <span aria-hidden="true" className="font-mono text-petal-ink">&gt;</span>
                        <span dir="auto" className="min-w-0 [overflow-wrap:anywhere]">{example.text}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="mt-2.5 text-xs text-ink-soft">These use your own topics and collections. They fill the box; nothing is sent until you press Ask.</p>
              </section>
            ) : null
          ) : null}

          <div ref={results} className="mt-8" style={{ scrollMarginBlockStart: 'calc(var(--safe-top) + 16px)' }}>
            {active ? (
              <>
                <Echo key={`echo:${active.id}`} entry={active} />
                {/* Whatever became of the question is announced politely when it arrives; the evidence below is read at the reader's pace. */}
                <div aria-live="polite" aria-busy={pending || undefined}>
                  {active.state.status === 'locked' ? <LockedCard feature="ask" /> : <Outcome key={`${active.id}:${active.state.status}`} entry={active} session={session} />}
                </div>
                <Evidence key={`evidence:${active.id}`} entry={active} />
                {active.state.status === 'done' ? (
                  <div className="mt-8">
                    <Button variant="ghost" size="sm" className="-ms-2" onClick={() => { const box = document.getElementById(COMPOSER_ID); box?.scrollIntoView({ block: 'center' }); box?.focus({ preventScroll: true }); }}><ArrowUp />Ask something else</Button>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </div>

        <aside aria-label="About asking" className="flex min-w-0 flex-col gap-8 xl:sticky xl:top-6 xl:max-h-[calc(100dvh-3rem)] xl:self-start xl:overflow-y-auto">
          <History {...history} variant="rail" className="max-xl:hidden" />
          <HowItWorks />
        </aside>
      </div>
    </div>
  );
}

export default function AskScreen({ demo }: FeatureScreenProps) {
  return (
    <FeatureGate feature="ask">
      <AskPage demo={demo} />
    </FeatureGate>
  );
}
