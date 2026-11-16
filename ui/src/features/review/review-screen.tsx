// Needs review, as a short queue: one save at a time, what its suggestion would change and what that rests on,
// and one tap to answer. The server cannot take an answer back (dismissing discards the suggestion, accepting
// overwrites), so an answer is held: the queue moves on at once, the island offers Undo, and the server is told
// only when that chance has passed (src/app/undo.ts). If it then refuses, the save comes back and says so.
import { useEffect } from 'react';
import { errorMessage, hostLabel, PLATFORM_NAMES } from '@web/utils.js';
import { cn } from 'cn';
import { ArrowRight, Check } from 'lucide-react';
import { useArchive, useArchiveState, useBusy } from '@/app/archive-context';
import { flushHeld } from '@/app/undo';
import { Whisper } from '@/components/field';
import { Ascii, AsciiSpinner } from '@/components/fx/ascii';
import { Button } from '@/components/ui/button';
import { viewTitle } from '@/data/location';
import type { Item } from '@/data/types';
import { VIEW_TITLE_ID } from '@/lib/focus';
import { StateCard } from '../feature-kit';
import { Cover } from '../library/cover';
import { paperOf } from '../library/papers';
import { answer, useReview } from './answers';
import { addedAgo, evidenceLabel, evidenceQuote, MAX_SEGMENTS, pendingSuggestion, progress, suggestionRows, tally } from './queue';

function Strip({ done, total }: { done: number; total: number }) {
  const segments = total <= MAX_SEGMENTS;
  return (
    <div role="progressbar" aria-label="Reviewed" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} className={cn('mt-3 flex h-1 gap-1', !segments && 'overflow-hidden rounded-full bg-card-3')}>
      {segments
        ? Array.from({ length: total }, (_, index) => <i key={index} className={cn('flex-1 rounded-full', index < done ? 'bg-sage' : 'bg-card-3')} />)
        : <i className="rounded-full bg-sage" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />}
    </div>
  );
}

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="pt-0.5 text-[0.8125rem] text-ink-soft">{term}</dt>
      <dd className="m-0 flex min-w-0 flex-wrap gap-1.5 text-sm text-ink">{children}</dd>
    </>
  );
}

const TAG = 'max-w-full truncate rounded-full px-2.5 py-0.5 text-xs';

function ReviewCard({ item, remotePreviews }: { item: Item; remotePreviews: boolean }) {
  const ai = pendingSuggestion(item);
  const rows = ai ? suggestionRows(item, ai) : null;
  const quote = ai ? evidenceQuote(item, ai) : '';
  const locals = (item.collections || []).filter(collection => collection.kind === 'local');
  const meta = [PLATFORM_NAMES[item.platform] || 'Web', item.creator || hostLabel(item.url), addedAgo(item.created_at)].filter(Boolean).join(' · ');
  return (
    <article data-item-id={item.id} aria-labelledby="review-title" className="mt-4 rounded-[28px] border border-line bg-card p-1.5 shadow-xs">
      <div className={cn('flex min-h-[150px] items-center gap-4 rounded-[22px] p-5', paperOf(item))}>
        <div className="min-w-0 flex-1">
          <span className="label-mono mb-2 block !text-current opacity-80">{PLATFORM_NAMES[item.platform] || 'Web'}</span>
          <h2 id="review-title" dir="auto" className="display line-clamp-4 text-[1.375rem] leading-tight text-balance">{item.title || hostLabel(item.url)}</h2>
        </div>
        {item.thumbnail_url || (remotePreviews && item.preview_url) ? (
          <span className="size-20 shrink-0 overflow-hidden rounded-[14px]"><Cover item={item} remotePreviews={remotePreviews} mini /></span>
        ) : null}
      </div>
      <div className="grid gap-3 px-3 pt-3.5 pb-2.5">
        <p dir="auto" className="text-xs text-ink-soft">{meta}</p>
        {rows ? (
          <>
            <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2">
              {rows.kind ? <Row term="Kind"><span className={cn(TAG, 'bg-sage-pale text-sage dark:text-sage-deep')}>{rows.kind}</span></Row> : null}
              {rows.folder ? <Row term="File in"><span dir="auto" className={cn(TAG, 'bg-sage-pale text-sage dark:text-sage-deep')}>{rows.folder}</span></Row> : null}
              {rows.topics.length ? <Row term="Topics">{rows.topics.map(topic => <span key={topic} dir="auto" className={cn(TAG, 'bg-card-2 text-ink-soft')}>{topic}</span>)}</Row> : null}
              {rows.title ? <Row term="Title"><span dir="auto">{rows.title}</span></Row> : null}
              {rows.summary ? <Row term="Summary"><span dir="auto" className="line-clamp-3 text-ink-soft">{rows.summary}</span></Row> : null}
            </dl>
            <div className="flex flex-wrap gap-x-2.5 gap-y-1 rounded-[12px] bg-card-2 px-3 py-2.5 text-[0.8125rem] leading-relaxed text-ink-soft">
              <span data-testid="evidence-label" className="label-mono flex-none pt-0.5">{evidenceLabel(ai!)}</span>
              <span className="min-w-[11rem] flex-1">
                {quote ? <q dir="auto" className="text-ink [quotes:'“'_'”']">{quote}</q> : null}
                {quote && ai!.evidence_note ? ' ' : null}
                {ai!.evidence_note}
              </span>
            </div>
            <p className="text-xs leading-relaxed text-ink-soft">Nothing changes until you accept. A title or summary you wrote yourself is kept.</p>
          </>
        ) : (
          <>
            {item.tags?.length || locals.length ? (
              <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2">
                {item.tags?.length ? <Row term="Topics">{item.tags.map(tag => <span key={tag} dir="auto" className={cn(TAG, 'bg-card-2 text-ink-soft')}>{tag}</span>)}</Row> : null}
                {locals.length ? <Row term="Filed in">{locals.map(collection => <span key={collection.id} dir="auto" className={cn(TAG, 'bg-sage-pale text-sage dark:text-sage-deep')}>{collection.name}</span>)}</Row> : null}
              </dl>
            ) : null}
            <p className="rounded-[12px] bg-card-2 px-3 py-2.5 text-[0.8125rem] leading-relaxed text-ink-soft">There is no suggestion for this save. It is here because it is new, or because it was marked for review.</p>
          </>
        )}
      </div>
    </article>
  );
}

export function ReviewScreen({ demo }: { demo: boolean }) {
  const archive = useArchive();
  const loc = useArchiveState(state => state.loc);
  const filters = useArchiveState(state => state.filters);
  const collections = useArchiveState(state => state.collections);
  const items = useArchiveState(state => state.items);
  const total = useArchiveState(state => state.total);
  const list = useArchiveState(state => state.list);
  const listError = useArchiveState(state => state.listError);
  const busy = useArchiveState(state => state.busy);
  const remotePreviews = useArchiveState(state => state.settings.remote_previews);
  const { accepted, kept, gone, later, failure } = useReview();
  const [retrying, runRetry] = useBusy();

  const title = viewTitle(loc, filters, collections);
  useEffect(() => { document.title = `${title} — Little Archive${demo ? ' demo' : ''}`; }, [title, demo]);

  // A visit starts its own count. Leaving sends the answer that was still waiting to be undone.
  useEffect(() => {
    // A delete from the list that could still be undone is sent first, so the queue never shows a save on its way out.
    flushHeld();
    useReview.setState({ accepted: 0, kept: 0, later: new Set(), failure: null, shown: true });
    return () => { useReview.setState({ shown: false }); flushHeld(); };
  }, []);

  // While the view is loading, the saves in hand are the last view's, not the queue: nothing is drawn from them.
  const ready = list === 'ready';
  const waitingLoaded = ready ? items.filter(item => !gone.has(item.id)) : [];
  const waiting = ready ? total - (items.length - waitingLoaded.length) : 0;
  const current = waitingLoaded.find(item => !later.has(item.id)) ?? null;
  const setAside = waitingLoaded.length - waitingLoaded.filter(item => !later.has(item.id)).length;
  const { done, total: all, position } = progress(accepted + kept, waiting);

  // Everything loaded has been answered or set aside, and the server has more: bring the next page.
  const more = ready && !current && !busy && items.length < total;
  useEffect(() => { if (more) void archive.loadItems(true); }, [more, archive]);

  const narrowed = [loc.q ? `“${loc.q}”` : '', loc.tag, loc.platform ? PLATFORM_NAMES[loc.platform] : ''].filter(Boolean);
  const failed = failure && current && failure.id === current.id ? failure : null;
  const ai = current ? pendingSuggestion(current) : null;

  return (
    <div className={cn('mx-auto w-full max-w-xl pt-2', current && 'max-lg:pb-56')}>
      <div className="flex items-center justify-between gap-3">
        <h1 id={VIEW_TITLE_ID} tabIndex={-1} className="rounded-sm outline-none focus-visible:underline focus-visible:decoration-sage focus-visible:decoration-2 focus-visible:underline-offset-4"><Whisper>Needs review</Whisper></h1>
        {current ? <span role="status" data-testid="review-position" className="num text-sm text-ink-soft">{position} of {all}</span> : null}
      </div>
      {ready && all > 0 ? <Strip done={done} total={all} /> : null}
      {narrowed.length ? (
        <p className="mt-3 flex flex-wrap items-center gap-x-2 text-xs text-ink-soft">
          <span dir="auto">Only saves matching {narrowed.join(' · ')}.</span>
          <Button variant="link" className="text-xs" onClick={() => archive.navigate({ q: '', tag: '', platform: '' }, { replace: true })}>Show all</Button>
        </p>
      ) : null}

      {failure && ready ? (
        <div role="alert" className="mt-4 rounded-md border border-danger/30 bg-danger-pale px-3.5 py-2.5 text-sm leading-relaxed text-danger">
          <b>That was not saved.</b> {failure.message} <span dir="auto">“{failure.title}”</span> is unchanged. Your other answers are safe.
        </div>
      ) : null}

      {list === 'error' ? (
        <div className="mt-6">
          <StateCard art="cloud" title="A little interruption." actions={<Button variant="primary" aria-busy={retrying || undefined} onClick={() => void runRetry(() => archive.refreshLibrary())}><ArrowRight />Try again</Button>}>
            {listError || errorMessage(null)}
          </StateCard>
        </div>
      ) : current ? (
        <>
          <ReviewCard key={current.id} item={current} remotePreviews={remotePreviews} />
          {/* On a phone the answers stay in thumb reach, above the dock. On a wide screen they follow the card. */}
          <div className="z-20 grid grid-cols-[1fr_1.4fr] gap-2.5 max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:border-t max-lg:border-line max-lg:bg-paper max-lg:px-4 max-lg:pt-3.5 max-lg:pb-[calc(var(--dock)+var(--safe-bottom)+22px)] lg:mt-5">
            {ai ? (
              <>
                <Button size="lg" className="px-3" onClick={() => answer(archive, current, 'keep')}>{failed?.kind === 'keep' ? 'Try again' : 'Keep as it is'}</Button>
                <Button size="lg" variant="primary" onClick={() => answer(archive, current, 'accept')}><Check />{failed?.kind === 'accept' ? 'Try again' : 'Accept'}</Button>
              </>
            ) : (
              <Button size="lg" variant="primary" className="col-span-2" onClick={() => answer(archive, current, 'keep')}><Check />{failed ? 'Try again' : 'Mark as reviewed'}</Button>
            )}
            <div className="col-span-2 flex justify-center gap-5">
              <Button variant="link" className="min-h-11 text-sm" onClick={() => void archive.openItem(current.id)}>Change something first</Button>
              {failed ? <Button variant="link" className="min-h-11 text-sm" onClick={() => useReview.setState(state => ({ later: new Set(state.later).add(current.id), failure: null }))}>Leave it for later</Button> : null}
            </div>
          </div>
        </>
      ) : list !== 'ready' || more || busy ? (
        <p role="status" className="flex items-center justify-center gap-2 py-24 text-sm text-ink-soft"><AsciiSpinner />Finding what needs review…</p>
      ) : (
        <div className="flex flex-col items-center pt-16 text-center sm:pt-24">
          <Ascii name="flower" className="mb-5 text-start text-sm leading-[1.15] text-petal-ink" />
          {setAside ? (
            <>
              <h2 className="display text-3xl text-ink">That is the end of the queue.</h2>
              <p className="mt-2.5 max-w-[30ch] text-ink-soft">{tally(accepted, kept)} {setAside === 1 ? 'One save was' : `${setAside} saves were`} left for later.</p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                <Button size="lg" variant="primary" onClick={() => useReview.setState({ later: new Set() })}><ArrowRight />Go through {setAside === 1 ? 'it' : 'them'} again</Button>
                <Button size="lg" onClick={() => archive.goView('all')}>Back to your library</Button>
              </div>
            </>
          ) : (
            <>
              <h2 className="display text-3xl text-ink">{accepted + kept ? 'All reviewed.' : 'Nothing to review.'}</h2>
              <p className="mt-2.5 max-w-[30ch] text-ink-soft">{tally(accepted, kept)} New saves, and saves with a new suggestion, appear here.</p>
              <Button size="lg" variant="primary" className="mt-5" onClick={() => archive.goView('all')}>Back to your library</Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
