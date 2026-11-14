// Cook mode: the recipe one step at a time, in large type, on a screen that stays awake. It is the product's
// quietest moment, so it is mostly paper: the step, its timer, the few ingredients it uses, and two big
// buttons. Timers run side by side and keep running between steps; they are timestamps, so they are right
// after the tab has been in the background. Everything here is optional apart from the step itself: where
// the browser has no wake lock, no sound or no vibration, cook mode goes without and says nothing.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { cn } from 'cn';
import { ArrowLeft, ArrowRight, ListChecks, Pencil, RotateCcw, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useArchive } from '@/app/archive-context';
import { Whisper } from '@/components/field';
import { Ascii, AsciiProgress, AsciiSpinner } from '@/components/fx/ascii';
import { Button } from '@/components/ui/button';
import { LockedCard, StateCard } from '../feature-kit';
import type { Recipe, RecipeResponse } from './api';
import { buzz, playChime, primeAudio, useWakeLock, useWide } from './cook-effects';
import { keyIntent, moveStep, stepCounter, stepTextSize, swipeIntent, type Intent } from './cook-nav';
import { IngredientsPanel, StepIngredients } from './cook-ingredients';
import { OtherTimers, StepTimer } from './cook-timer';
import { clearSession, EMPTY_SESSION, leaveCookToCard, readSession, readSound, writeSession, writeSound } from './memory';
import { cardRest, formatServings, scaleFactor, spokenDuration, stepIngredients } from './model';
import { isActive } from './timers';
import { useRecipe, type UseRecipe } from './use-recipe';
import { useTimers } from './use-timers';

const TEXT_SIZE = {
  large: 'text-[2.1rem] leading-[1.12] sm:text-5xl lg:text-6xl',
  medium: 'text-[1.7rem] leading-[1.18] sm:text-4xl lg:text-5xl',
  small: 'text-[1.3rem] leading-snug sm:text-3xl lg:text-4xl',
} as const;

// The paper's dots, as on every page, so cook mode is still the same desk.
const DOTTED = '[background-image:radial-gradient(circle,var(--dot)_1.1px,transparent_1.5px)] [background-size:26px_26px]';

interface SessionProps {
  id: string;
  state: UseRecipe;
  recipe: Recipe;
  response: RecipeResponse;
}

function scaleLabel(state: UseRecipe, recipe: Recipe, response: RecipeResponse): string {
  const base = recipe.servings;
  const factor = scaleFactor(state.scale, base);
  if (base !== null) {
    const target = state.scale.kind === 'servings' ? state.scale.value : base * state.scale.value;
    return `${formatServings(target)} ${target === 1 ? 'serving' : 'servings'}`;
  }
  return Math.abs(factor - 1) < 1e-9 || !response.scaled ? 'as written' : `×${formatServings(factor)}`;
}

function CookSession({ id, state, recipe, response }: SessionProps) {
  const archive = useArchive();
  const stamp = `${response.edited_at ?? ''}|${response.extraction?.at ?? ''}`;
  const steps = recipe.steps;
  const total = steps.length;
  const [saved] = useState(() => readSession(id, stamp) ?? EMPTY_SESSION(stamp));
  const [step, setStep] = useState(() => Math.min(saved.step, total));
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');
  const [checked, setChecked] = useState<ReadonlySet<number>>(() => new Set(saved.checked));
  const [panelOpen, setPanelOpen] = useState(false);
  const [sound, setSound] = useState(readSound);
  const [announcement, setAnnouncement] = useState('');
  const wide = useWide();
  const held = useWakeLock(true);
  const stepRef = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const swipe = useRef<{ x: number; y: number; time: number; pointer: number } | null>(null);

  const timers = useTimers(saved.timers, index => {
    setAnnouncement(`The timer for step ${index + 1} is done.`);
    if (sound) playChime();
    buzz();
  });

  // What was done is kept for this tab, so a reload (or a slip of the thumb) does not lose the step, the ticks or the timers.
  useEffect(() => {
    writeSession(id, { stamp, step, checked: [...checked], timers: timers.stored });
  }, [id, stamp, step, checked, timers.stored]);

  // Each step starts at the top of its own page.
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [step]);

  // The ingredients sheet takes focus when it opens and gives it back to its button when it closes.
  useEffect(() => {
    if (!panelOpen || wide) return;
    panelRef.current?.focus({ preventScroll: true });
    const button = opener.current;
    return () => button?.focus({ preventScroll: true });
  }, [panelOpen, wide]);

  const sheet = panelOpen && !wide;
  const current = steps[step];
  const done = step >= total;
  const lines = response.scaled?.ingredients ?? recipe.ingredients;
  const here = current ? stepIngredients(current, lines) : [];
  const timer = current && timers.timers[step];
  const others = Object.entries(timers.timers)
    .filter(([index, entry]) => Number(index) !== step && entry.status !== 'idle')
    .map(([index, entry]) => ({ step: Number(index), timer: entry }))
    .sort((a, b) => a.step - b.step);
  const rescaled = Boolean(response.scaled) && Math.abs((response.scaled?.factor_float ?? 1) - 1) > 1e-9;
  const title = recipe.title || 'Recipe';

  const move = useCallback((intent: Intent) => {
    const next = moveStep(step, total, intent);
    if (next === step) return;
    setDirection(intent === 'next' ? 'forward' : 'back');
    setStep(next);
  }, [step, total]);
  const goTo = (target: number) => {
    setDirection(target >= step ? 'forward' : 'back');
    setStep(Math.max(0, Math.min(total, target)));
  };

  const toggleTick = (index: number) => setChecked(previous => {
    const next = new Set(previous);
    if (next.has(index)) next.delete(index); else next.add(index);
    return next;
  });
  const toggleSound = () => {
    const next = !sound;
    setSound(next);
    writeSound(next);
    if (next) primeAudio();
  };

  const startTimer = () => {
    if (!current?.timer_seconds) return;
    primeAudio();
    timers.start(step, current.timer_seconds);
    setAnnouncement(`Timer for step ${step + 1} started: ${spokenDuration(current.timer_seconds)}.`);
  };
  const pauseTimer = () => {
    timers.pause(step);
    setAnnouncement(`Timer for step ${step + 1} paused.`);
  };
  const resetTimer = () => {
    if (!current?.timer_seconds) return;
    timers.reset(step, current.timer_seconds);
    setAnnouncement(`Timer for step ${step + 1} reset.`);
  };

  const exit = () => {
    if (leaveCookToCard() === 'back') history.back();
    else archive.goScreen('recipes', cardRest(id), { replace: true });
  };
  const finishCooking = () => {
    clearSession(id);
    exit();
  };
  const again = () => {
    timers.clear();
    setChecked(new Set());
    setDirection('back');
    setStep(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    // A radio group (the scale) uses the arrow keys itself.
    if (target.closest('[role="radiogroup"], textarea, select, input[type="text"]')) return;
    const intent = keyIntent(event.key, getComputedStyle(event.currentTarget).direction === 'rtl');
    if (intent) { event.preventDefault(); move(intent); return; }
    const key = event.key.toLowerCase();
    if (key === 'i' && !wide) { setPanelOpen(open => !open); return; }
    if (key === 't' && current?.timer_seconds) {
      if (timer?.status === 'running') pauseTimer(); else startTimer();
    }
  };

  // A flick across the step. Only fingers and pens: a mouse drag is a text selection.
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' || (event.target as HTMLElement).closest('button, a, label, input')) return;
    swipe.current = { x: event.clientX, y: event.clientY, time: event.timeStamp, pointer: event.pointerId };
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start || start.pointer !== event.pointerId) return;
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const intent = swipeIntent(event.clientX - start.x, event.clientY - start.y, event.timeStamp - start.time, rtl);
    if (intent) move(intent);
  };

  const enter = direction === 'forward' ? 'slide-in-from-right-6 rtl:slide-in-from-left-6' : 'slide-in-from-left-6 rtl:slide-in-from-right-6';
  const panelProps = { ingredients: lines, checked, onToggle: toggleTick, onClearTicks: () => setChecked(new Set()), base: recipe.servings, scale: state.scale, onScale: state.setScale, busy: state.busy, notes: rescaled ? response.scaled?.notes ?? [] : [] };
  const activeTimers = Object.values(timers.timers).filter(isActive).length;

  return (
    <Dialog.Root open onOpenChange={open => { if (!open) exit(); }}>
      <Dialog.Portal>
        <Dialog.Content
          data-testid="cook-mode"
          aria-describedby={undefined}
          onOpenAutoFocus={event => { event.preventDefault(); stepRef.current?.focus({ preventScroll: true }); }}
          onEscapeKeyDown={event => { if (sheet) { event.preventDefault(); setPanelOpen(false); } }}
          onPointerDownOutside={event => event.preventDefault()}
          onKeyDown={onKeyDown}
          className={cn('fixed inset-0 z-50 flex flex-col bg-paper text-ink outline-none duration-300 data-[state=open]:animate-in data-[state=open]:fade-in-0', DOTTED)}
        >
          <Dialog.Title className="sr-only">Cooking {title}</Dialog.Title>

          <div inert={sheet} className="flex min-h-0 flex-1 flex-col">
            <header className="flex shrink-0 items-center gap-2 px-3 pt-[calc(var(--safe-top)+0.5rem)] pb-1 sm:gap-3 sm:px-6">
              <Button variant="outline" aria-label="Exit cook mode and go back to the recipe" onClick={exit}><X />Exit</Button>
              <div className="min-w-0 flex-1 px-1">
                <p dir="auto" className="display truncate text-base text-ink sm:text-lg">{title}</p>
                <p className="label-mono truncate">{scaleLabel(state, recipe, response)}{held ? <span className="max-sm:hidden"> · screen stays on</span> : null}</p>
              </div>
              {!wide ? (
                <Button ref={opener} variant="outline" aria-expanded={sheet} aria-label={`Ingredients, ${checked.size} of ${lines.length} ready`} onClick={() => setPanelOpen(true)}>
                  <ListChecks /><span className="num">{checked.size}/{lines.length}</span>
                </Button>
              ) : null}
            </header>

            {!done ? (
              <div className="flex shrink-0 items-center justify-between gap-4 px-4 pt-1 pb-3 sm:px-6">
                <AsciiProgress label="Progress through the recipe" value={step + 1} max={total} width={16} />
                {activeTimers ? <p className="label-mono">{activeTimers} {activeTimers === 1 ? 'timer' : 'timers'} going</p> : null}
              </div>
            ) : null}
            {others.length ? <div className="shrink-0 px-4 pb-3 sm:px-6"><OtherTimers entries={others} now={timers.now} onGo={goTo} /></div> : null}

            <div className="flex min-h-0 flex-1 lg:grid lg:grid-cols-[minmax(0,1fr)_25rem]">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div ref={scroller} onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => { swipe.current = null; }} className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain [mask-image:linear-gradient(to_bottom,#000_calc(100%-1.5rem),transparent)]">
                  <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-3 pb-8 sm:px-10 sm:pt-6">
                    <div ref={stepRef} tabIndex={-1} aria-live="polite" aria-atomic="true" className="outline-none">
                      <div key={step} className={cn('animate-in duration-300 fade-in-0', enter)}>
                        {done ? (
                          <div className="flex flex-col items-center pt-8 text-center sm:pt-14">
                            <Ascii name="bowl" className="mb-8 text-start text-lg text-sage dark:text-sage-deep" />
                            <p className="label-mono"><Whisper>all done</Whisper></p>
                            <p className="display mt-4 text-5xl text-ink sm:text-6xl">That’s everything.</p>
                            <p className="mt-4 max-w-md text-lg text-ink-soft">Every step is behind you. Enjoy it.</p>
                          </div>
                        ) : current ? (
                          <>
                            <p className="flex items-baseline gap-3">
                              <span aria-hidden="true" className="display text-6xl leading-none text-sage sm:text-7xl dark:text-sage-deep">{step + 1}</span>
                              <span aria-hidden="true" className="label-mono">of {total}</span>
                              <span className="sr-only">{stepCounter(step, total)}.</span>
                              {current.section ? <span dir="auto" className="label-mono ms-auto self-start">{current.section}</span> : null}
                            </p>
                            <p dir="auto" className={cn('display mt-4 text-pretty text-ink [overflow-wrap:anywhere]', TEXT_SIZE[stepTextSize(current.text)])}>{current.text}</p>
                          </>
                        ) : null}
                      </div>
                    </div>

                    {current?.timer_seconds ? (
                      <StepTimer stepNumber={step + 1} seconds={current.timer_seconds} timer={timer} now={timers.now} sound={sound} onToggleSound={toggleSound} onStart={startTimer} onPause={pauseTimer} onReset={resetTimer} />
                    ) : null}
                    {!done ? <StepIngredients lines={here} checked={checked} onToggle={toggleTick} /> : null}
                  </div>
                </div>

                <footer className="mx-auto flex w-full max-w-3xl shrink-0 items-center gap-3 px-4 pt-3 pb-[calc(var(--safe-bottom)+1rem)] sm:px-10 lg:pb-3">
                  {done ? (
                    <>
                      <Button variant="outline" size="lg" className="h-14 sm:px-7" onClick={() => move('previous')}><ArrowLeft className="rtl:rotate-180" />Last step</Button>
                      <Button variant="ghost" size="lg" className="h-14 sm:px-7" onClick={again}><RotateCcw />Cook it again</Button>
                      <Button variant="primary" size="lg" className="h-14 flex-1 text-lg" onClick={finishCooking}>Back to the recipe</Button>
                    </>
                  ) : (
                    <>
                      <Button variant="outline" size="lg" className="h-14 max-sm:w-14 max-sm:px-0 sm:px-7" aria-label="Previous step" disabled={step === 0} onClick={() => move('previous')}><ArrowLeft className="rtl:rotate-180" /><span className="max-sm:sr-only">Back</span></Button>
                      <Button variant="primary" size="lg" className="h-14 flex-1 text-lg" onClick={() => move('next')}>{step === total - 1 ? 'Finish' : 'Next step'}<ArrowRight className="rtl:rotate-180" /></Button>
                    </>
                  )}
                </footer>
                <p aria-hidden="true" className="label-mono hidden shrink-0 justify-center pb-4 lg:flex">← → steps · T timer · Esc exit</p>
              </div>

              {wide ? (
                <aside aria-label="Ingredients" className="flex min-h-0 flex-col border-s border-line bg-card/70">
                  <IngredientsPanel {...panelProps} />
                </aside>
              ) : null}
            </div>
          </div>

          {sheet ? (
            <div className="absolute inset-0 z-[1] flex items-end bg-scrim backdrop-blur-[3px] animate-in duration-200 fade-in-0" onClick={event => { if (event.target === event.currentTarget) setPanelOpen(false); }}>
              <IngredientsPanel {...panelProps} panelRef={panelRef} onClose={() => setPanelOpen(false)} className="max-h-[86dvh] w-full animate-in rounded-t-xl border border-line bg-card pb-[var(--safe-bottom)] shadow-lg duration-300 slide-in-from-bottom-10" />
            </div>
          ) : null}

          {/* Timers speak politely: a start, a pause, an end. The time itself is on the timer's face, for anyone who asks. */}
          <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Loading() {
  return <p role="status" className="flex items-center justify-center gap-2 py-24 text-sm text-ink-soft"><AsciiSpinner />Getting the recipe ready…</p>;
}

export function CookMode({ id }: { id: string }) {
  const archive = useArchive();
  const state = useRecipe(id);
  const { phase, response } = state;

  useEffect(() => { document.title = `Cooking — ${response?.recipe?.title || 'Recipe'} — Little Archive`; }, [response?.recipe?.title]);

  if (phase === 'locked') return <LockedCard feature="recipes" />;
  if (phase === 'error') {
    return <StateCard art="cloud" title="Cook mode could not open" actions={<><Button variant="primary" onClick={state.refresh}><RotateCcw />Try again</Button><Button onClick={() => archive.goScreen('recipes', cardRest(id))}>Back to the recipe</Button></>}>{state.error}</StateCard>;
  }
  if (!response) return <Loading />;
  const recipe = response.recipe;
  if (!recipe || !recipe.is_recipe || response.status === 'none' || response.status === 'not_a_recipe') {
    return <StateCard art="search" title="Nothing to cook from" actions={<Button variant="primary" onClick={() => archive.goScreen('recipes', cardRest(id))}>Open the save’s recipe page</Button>}>This save has no recipe card. Look for a recipe in it first.</StateCard>;
  }
  if (!recipe.steps.length) {
    return <StateCard art="pot" title="This card has no steps" actions={<Button variant="primary" onClick={() => archive.goScreen('recipes', cardRest(id))}><Pencil />Back to the recipe</Button>}>Cook mode goes one step at a time, and this recipe has none yet. Open the card and edit it to write the method.</StateCard>;
  }
  return <CookSession key={id} id={id} state={state} recipe={recipe} response={response} />;
}
