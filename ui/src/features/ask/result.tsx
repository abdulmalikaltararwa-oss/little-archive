// What is drawn for one question: the question again, what became of it, the quotes an answer rests on and
// the saves that were looked at.
//
// Everything the server sends here was written by someone else (a caption, a title, a model's sentence) and is
// rendered as a text node with `dir="auto"`, never as markup and never as a link built from it. A save opens
// through the archive (openItem); its address is shown, at most, as a host name.
import { Fragment, useEffect, useId, useState, type ReactNode } from 'react';
import { hostLabel, PLATFORM_NAMES } from '@web/utils.js';
import { cn } from 'cn';
import { ArrowUpRight, Check, CircleHelp, Info, Lock, RotateCcw, SearchX, ShieldAlert, Sparkles, Square, TriangleAlert, Unplug, type LucideIcon } from 'lucide-react';
import { useArchive, useArchiveState } from '@/app/archive-context';
import { Whisper } from '@/components/field';
import { Ascii, AsciiProgress, AsciiSpinner } from '@/components/fx/ascii';
import { BorderBeam } from '@/components/fx/border-beam';
import { TextScramble } from '@/components/fx/text-scramble';
import { PlatformIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import type { AskCitation, AskResponse, AskSource } from './api';
import {
  authorLine, collapseSources, COMPOSER_ID, contextLine, describeOutcome, evidenceLabel, fieldLabel, highlight, isNarrowed, matchLabel, narrowingLabels, NO_FILTERS, platformOf, sourceStatus,
  type Entry, type Outcome as OutcomeInfo,
} from './logic';
import { openSave, type AskSession } from './session';

/** One gentle arrival for the whole result. With reduced motion the stylesheet cuts it to nothing. */
const REVEAL = 'animate-in fade-in-0 slide-in-from-bottom-2 duration-500 ease-out';

/** A card that opens a save: lifts a little on hover, shrinks a little when pressed. The open button covers the card. */
const CARD = [
  'group/card relative rounded-lg border border-line bg-card shadow-xs [overflow-wrap:anywhere]',
  'transition-[transform,box-shadow,border-color] duration-300 ease-spring hov:z-10 hov:-translate-y-0.5 hov:border-sage/35 hov:shadow-md',
  'has-[[data-card-control=open]:active]:scale-[0.985]',
].join(' ');

const OPEN_BUTTON = 'rounded-sm text-start outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:outline-[2.5px] focus-visible:after:outline-offset-2 focus-visible:after:outline-sage';

/* The question again ------------------------------------------------------------------------------------ */

export function Echo({ entry }: { entry: Entry }) {
  const collections = useArchiveState(state => state.collections);
  const labels = narrowingLabels(entry.filters, collections);
  const terms = entry.state.status === 'done' ? entry.state.response.terms : [];
  return (
    <header className="mb-4">
      <Whisper>you asked</Whisper>
      <h2 dir="auto" className="display mt-1.5 text-xl text-ink [overflow-wrap:anywhere] sm:text-2xl">{entry.question}</h2>
      {labels.length || terms.length ? (
        <p className="label-mono mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {labels.length ? (
            <span className="flex flex-wrap items-center gap-1.5">
              narrowed to
              {labels.map(label => <span key={label} dir="auto" className="rounded-full bg-card-2 px-2 py-0.5 !text-ink normal-case">{label}</span>)}
            </span>
          ) : null}
          {terms.length ? <span dir="auto">looked for <span className="normal-case !text-ink">{terms.join(' · ')}</span></span> : null}
        </p>
      ) : null}
    </header>
  );
}

/* What became of it ------------------------------------------------------------------------------------- */

function Reading({ onStop }: { onStop(): void }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 6000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div role="status" className={cn('rounded-lg border border-dashed border-line-strong bg-card/60 p-5 sm:p-6', REVEAL)}>
      <p className="label-mono flex items-center gap-2 !text-ink">
        <AsciiSpinner />
        <TextScramble>reading your saves</TextScramble>
      </p>
      <AsciiProgress label="Reading your saves" width={28} className="mt-3.5 max-w-full" />
      <p className="mt-3.5 text-sm leading-relaxed text-ink-soft">{slow ? 'Still reading. An AI on a small machine can take a minute.' : 'Looking through your saves for the words in your question.'}</p>
      <Button variant="ghost" size="sm" className="mt-3 -ms-2" onClick={onStop}><Square className="size-3 fill-current" />Stop</Button>
    </div>
  );
}

function ErrorCard({ entry, message, httpStatus, session }: { entry: Entry; message: string; httpStatus: number; session: AskSession }) {
  return (
    <section role="alert" className={cn('flex gap-4 rounded-lg border border-danger/30 bg-danger-pale p-5 text-danger sm:p-6', REVEAL)}>
      <Unplug className="mt-1 size-5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h3 className="display text-xl">That did not go through</h3>
        <p dir="auto" className="mt-1.5 text-base leading-relaxed">{message}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {/* A refused question (422) will be refused again; only the wording can change that. */}
          {httpStatus === 422 ? null : <Button size="sm" onClick={() => session.retry(entry.id)}><RotateCcw />Try again</Button>}
          <Button variant="ghost" size="sm" className="hov:bg-card/60 text-danger" onClick={() => document.getElementById(COMPOSER_ID)?.focus()}>Change the question</Button>
        </div>
      </div>
    </section>
  );
}

const ICONS: Record<Exclude<OutcomeInfo['key'], 'answer' | 'nothing_saved'>, LucideIcon> = {
  no_ai: Info,
  ai_failed: Unplug,
  ai_invalid: TriangleAlert,
  not_in_saves: SearchX,
  unverified: ShieldAlert,
  contains_instructions: ShieldAlert,
  no_shareable_text: Lock,
  unclear: CircleHelp,
};

/** Every answer that is not an answer, explained: what happened, what was and was not done, what the server said. */
function OutcomeCard({ entry, response, outcome, session }: { entry: Entry; response: AskResponse; outcome: OutcomeInfo; session: AskSession }) {
  const headingId = useId();
  const nothing = outcome.key === 'nothing_saved';
  const Icon = outcome.key === 'answer' || outcome.key === 'nothing_saved' ? Info : ICONS[outcome.key];
  const narrowed = isNarrowed(entry.filters);
  const askWithoutNarrowing = () => {
    session.dispatch({ type: 'drafted', text: entry.question });
    session.dispatch({ type: 'narrowed', filters: NO_FILTERS });
    session.submit();
  };
  return (
    <section aria-labelledby={headingId} className={cn('rounded-lg border p-5 sm:p-6', outcome.tone === 'warn' ? 'border-butter/50 bg-butter-pale/50 text-ink' : 'border-line bg-card-2/70 text-ink', nothing && 'flex flex-col items-center text-center', REVEAL)}>
      {nothing ? <Ascii name="search" className="mb-4 text-start text-sm text-sage dark:text-sage-deep" /> : null}
      <div className="flex items-center gap-3">
        {nothing ? null : (
          <span aria-hidden="true" className={cn('grid size-9 shrink-0 place-items-center rounded-full bg-card', outcome.tone === 'warn' ? 'text-butter-ink' : 'text-ink-soft')}>
            <Icon className="size-[1.15rem]" />
          </span>
        )}
        <h3 id={headingId} dir="auto" className="display min-w-0 text-xl leading-snug">{outcome.heading}</h3>
      </div>
      <p className={cn('mt-3 text-base leading-relaxed', nothing ? 'max-w-md' : 'max-w-prose')}>{outcome.body}</p>
      {response.ai.error ? (
        <p className="mt-3 text-xs leading-relaxed text-ink-soft"><span className="label-mono block">what the AI service said</span><span dir="auto">{response.ai.error}</span></p>
      ) : null}
      {outcome.notice ? (
        <p className={cn('mt-3 max-w-prose border-s-2 border-line-strong ps-3 text-xs leading-relaxed text-ink-soft', nothing && 'max-w-md text-start')}><span className="label-mono block">what the server said</span><span dir="auto">{outcome.notice}</span></p>
      ) : null}
      {outcome.retry || (nothing && narrowed) ? (
        <div className={cn('mt-4 flex flex-wrap gap-2', nothing && 'justify-center')}>
          {outcome.retry ? <Button size="sm" onClick={() => session.retry(entry.id)}><RotateCcw />Try again</Button> : null}
          {nothing && narrowed ? <Button size="sm" onClick={askWithoutNarrowing}>Ask without narrowing</Button> : null}
        </div>
      ) : null}
    </section>
  );
}

/** The answer, labelled with what it rests on the way the detail panel labels an AI suggestion. */
function AnswerCard({ response, outcome }: { response: AskResponse; outcome: OutcomeInfo }) {
  const headingId = useId();
  const author = authorLine(response.ai);
  return (
    <section aria-labelledby={headingId} className={cn('relative rounded-lg bg-sage-pale/70 p-5 sm:p-6', REVEAL)}>
      <BorderBeam />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="flex items-center gap-2 text-sm font-semibold text-ink"><Sparkles className="size-4 text-petal-ink" aria-hidden="true" />{outcome.heading}</h3>
        {/* The evidence label: the words that say what this answer rests on. The moving border only draws the eye to it. */}
        <span data-testid="evidence-label" className="label-mono rounded-full border border-sage/25 bg-card px-2 py-0.5 !text-ink">{evidenceLabel(response.evidence?.level)}</span>
      </div>
      <p dir="auto" data-testid="answer-text" className="mt-4 text-lg leading-relaxed whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">{response.answer}</p>
      <div className="mt-5 border-t border-sage/20 pt-4">
        <p dir="auto" className="text-xs leading-relaxed text-ink-soft">
          {response.evidence?.note ? `${response.evidence.note} ` : ''}{outcome.body}
        </p>
        {author ? <p className="mt-2.5 font-mono text-2xs tracking-wide text-ink-soft"><span className="label-mono">written by </span><span dir="auto" className="text-ink">{author}</span></p> : null}
      </div>
    </section>
  );
}

/** What was asked and how it went: the part of the page that is announced politely when it changes. */
export function Outcome({ entry, session }: { entry: Entry; session: AskSession }) {
  const { state } = entry;
  if (state.status === 'pending') return <Reading onStop={() => session.stop()} />;
  if (state.status === 'error') return <ErrorCard entry={entry} message={state.message} httpStatus={state.httpStatus} session={session} />;
  if (state.status === 'locked') return null;
  const outcome = describeOutcome(state.response, { narrowed: isNarrowed(entry.filters) });
  return outcome.key === 'answer' ? <AnswerCard response={state.response} outcome={outcome} /> : <OutcomeCard entry={entry} response={state.response} outcome={outcome} session={session} />;
}

/* The evidence ------------------------------------------------------------------------------------------ */

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className={cn('mt-9', REVEAL)}>
      <h3><Whisper>{title}</Whisper></h3>
      {hint ? <p className="mt-1.5 max-w-xl text-xs leading-relaxed text-ink-soft">{hint}</p> : null}
      <div className="mt-3.5">{children}</div>
    </section>
  );
}

function CitationCard({ citation, platform, index }: { citation: AskCitation; platform: string; index: number }) {
  const archive = useArchive();
  const title = citation.title || hostLabel(citation.url);
  return (
    <article data-item-id={citation.item_id} className={cn(CARD, 'p-4 sm:p-5', index % 2 ? 'hov:rotate-[0.4deg]' : 'hov:-rotate-[0.4deg]')}>
      <p className="label-mono flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1 !text-sage dark:!text-sage-deep"><Check className="size-3" strokeWidth={3} aria-hidden="true" />checked word for word</span>
        <span aria-hidden="true">·</span>
        <span>from {fieldLabel(citation.field)}</span>
      </p>
      <blockquote dir="auto" className="display mt-3 border-s-[3px] border-petal ps-4 text-lg leading-snug font-normal whitespace-pre-wrap text-ink">{citation.quote}</blockquote>
      <div className="mt-4 flex items-center gap-2 text-sm text-ink-soft">
        <PlatformIcon platform={platform} className="size-4 shrink-0" />
        <h4 dir="auto" className="min-w-0 flex-1 truncate font-semibold text-ink">
          <button type="button" data-card-control="open" aria-label={`Open ${title}`} onClick={() => void openSave(archive, citation.item_id)} className={OPEN_BUTTON}>{title}</button>
        </h4>
        <ArrowUpRight className="size-4 shrink-0" aria-hidden="true" />
      </div>
    </article>
  );
}

function Snippet({ text, terms }: { text: string; terms: readonly string[] }) {
  return (
    <>
      {highlight(text, terms).map((piece, index) => (piece.hit
        ? <mark key={index} className="rounded-xs bg-butter-pale px-0.5 text-ink">{piece.text}</mark>
        : <Fragment key={index}>{piece.text}</Fragment>))}
    </>
  );
}

function SourceCard({ source, rank, response, index }: { source: AskSource; rank: number; response: AskResponse; index: number }) {
  const archive = useArchive();
  const title = source.title || hostLabel(source.url);
  const status = sourceStatus(source, response);
  const matched = matchLabel(source.match_in);
  return (
    <article data-item-id={source.item_id} className={cn(CARD, 'grid grid-cols-[auto_minmax(0,1fr)] gap-x-3.5 p-4', index % 2 ? 'hov:rotate-[0.4deg]' : 'hov:-rotate-[0.4deg]')}>
      <span aria-hidden="true" className="num pt-0.5 text-2xs text-ink-soft">{String(rank).padStart(2, '0')}</span>
      <div className="min-w-0">
        <div className="flex items-start justify-between gap-3">
          <h4 dir="auto" className="min-w-0 text-sm leading-snug font-semibold text-ink">
            <button type="button" data-card-control="open" aria-label={`Open ${title}`} onClick={() => void openSave(archive, source.item_id)} className={OPEN_BUTTON}>{title}</button>
          </h4>
          {status.kind === 'cited' ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sage-pale px-2 py-0.5 text-2xs font-medium text-sage dark:text-sage-deep"><Check className="size-3" strokeWidth={3} aria-hidden="true" />Cited</span>
          ) : null}
        </div>
        <p className="label-mono mt-1 flex flex-wrap items-center gap-x-1.5">
          <PlatformIcon platform={source.platform} className="size-3.5 shrink-0" />
          <span>{PLATFORM_NAMES[source.platform] || 'Web'}</span>
          <span aria-hidden="true">·</span>
          <span dir="auto" className="normal-case">{hostLabel(source.url)}</span>
        </p>
        {source.snippet && source.snippet.trim().toLowerCase() !== title.trim().toLowerCase() ? (
          <p dir="auto" className="mt-2.5 text-sm leading-relaxed text-ink-soft">
            <Snippet text={source.snippet} terms={response.terms} />
            {source.snippet.length >= 240 ? '…' : null}
          </p>
        ) : null}
        {matched ? <p className="label-mono mt-2.5">matched in {matched}</p> : null}
        {status.kind === 'withheld' ? (
          <p className="mt-3 flex gap-2 rounded-md bg-butter-pale px-3 py-2 text-xs leading-relaxed text-ink"><ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-butter-ink" aria-hidden="true" />{status.text}</p>
        ) : null}
        {status.kind === 'read' ? <p className="label-mono mt-2.5">read by the AI, not cited</p> : null}
      </div>
    </article>
  );
}

/** The quotes an answer rests on, then the saves that were looked at, best match first. */
export function Evidence({ entry }: { entry: Entry }) {
  const [all, setAll] = useState(false);
  if (entry.state.status !== 'done') return null;
  const { response } = entry.state;
  const outcome = describeOutcome(response, { narrowed: isNarrowed(entry.filters) });
  const lead = outcome.sources === 'lead';
  const { shown, hidden } = !lead && !all ? collapseSources(response.sources, 4) : { shown: response.sources, hidden: 0 };
  const context = contextLine(response.context);
  return (
    <>
      {response.answered && response.citations.length ? (
        <Section title="quotes from your saves" hint="Each quote was checked, word for word, against the save it came from. These are the evidence; the answer above is only a summary of them.">
          <ul className="flex flex-col gap-3">
            {response.citations.map((citation, index) => (
              <li key={`${citation.item_id}:${index}`}><CitationCard citation={citation} platform={platformOf(citation, response.sources)} index={index} /></li>
            ))}
          </ul>
        </Section>
      ) : null}
      {outcome.sources !== 'none' && response.sources.length ? (
        <Section title={lead ? 'the closest saves' : 'saves it looked at'} hint={lead ? 'Best match first. The lines that matched your words are marked.' : 'Best match first. Only the ones marked Cited are the answer’s source.'}>
          <ol aria-label="Saves, best match first" className="flex flex-col gap-3">
            {shown.map(source => {
              const rank = response.sources.indexOf(source) + 1;
              return <li key={source.item_id}><SourceCard source={source} rank={rank} response={response} index={rank} /></li>;
            })}
          </ol>
          {hidden ? <Button variant="ghost" size="sm" className="mt-2 -ms-2" onClick={() => setAll(true)}>Show the other {hidden}</Button> : null}
          {context ? <p className="mt-4 font-mono text-2xs leading-relaxed text-ink-soft">{context}</p> : null}
        </Section>
      ) : null}
    </>
  );
}
