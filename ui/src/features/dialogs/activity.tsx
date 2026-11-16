// A little activity: what arrived by import, and what the AI queue is doing. While anything is running the
// list refreshes itself every three seconds; a slow answer to an old question is dropped.
import { useEffect, useState } from 'react';
import { errorMessage, formatDate, PLATFORM_NAMES } from '@web/utils.js';
import { cn } from 'cn';
import { Activity, ArrowLeft, ArrowRight, Check, CircleCheck, RotateCw, Sparkles, Upload, X } from 'lucide-react';
import { useArchive, useArchiveState, useBusy } from '@/app/archive-context';
import { confirm, toast } from '@/app/ui-state';
import { allowAi } from '@/features/ai-permission/gate';
import { FormError, Notice } from '@/components/field';
import { AsciiProgress, AsciiSpinner } from '@/components/fx/ascii';
import { Modal } from '@/components/modal';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import type { AiJob, AiJobList, ImportRun, JobStatus } from '@/data/types';
import { openReview } from '../actions';
import type { DialogProps } from './basic';

type Tab = 'imports' | 'ai';
const PAGE = 25;
const COUNTS: [JobStatus, string][] = [['queued', 'Queued'], ['running', 'Running'], ['completed', 'Completed'], ['failed', 'Failed'], ['cancelled', 'Cancelled']];

function StatusPill({ status }: { status?: string }) {
  return (
    <span className={cn('label-mono shrink-0 rounded-full px-2 py-0.5', status === 'completed' ? 'bg-sage-pale !text-sage dark:!text-sage-deep' : status === 'failed' ? 'bg-danger-pale !text-danger' : status === 'running' || status === 'queued' ? 'bg-butter-pale !text-butter-ink' : 'bg-card-2')}>
      {status || 'unknown'}
    </span>
  );
}

export function ActivityDialog({ spec, close }: DialogProps<'activity'>) {
  const archive = useArchive();
  const demo = archive.backend.kind === 'demo';
  const aiEnabled = useArchiveState(state => state.settings.ai_enabled);
  const [tab, setTab] = useState<Tab>(spec.tab === 'ai' ? 'ai' : 'imports');
  const [offset, setOffset] = useState(0);
  const [imports, setImports] = useState<ImportRun[] | null>(null);
  const [jobs, setJobs] = useState<AiJobList | null>(null);
  const [error, setError] = useState('');
  // Bumping `tick` asks again; `settled` names the last question that was answered.
  const [tick, setTick] = useState(0);
  const [settled, setSettled] = useState('');
  const [reviewBusy, runReview] = useBusy();
  const question = `${tab}:${offset}:${tick}`;
  const loading = settled !== question;
  const reload = () => setTick(value => value + 1);

  useEffect(() => {
    let stale = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const again = (running: boolean) => { if (running) timer = setTimeout(() => setTick(value => value + 1), 3000); };
    const failed = (caught: unknown) => { if (!stale) { setError(errorMessage(caught)); setSettled(question); } };
    if (tab === 'ai') {
      archive.api.aiJobs(PAGE, offset).then(result => {
        if (stale) return;
        setJobs(result);
        setError('');
        setSettled(question);
        again((result.counts?.queued || 0) + (result.counts?.running || 0) > 0);
      }, failed);
    } else {
      archive.api.imports().then(result => {
        if (stale) return;
        setImports(result.imports || []);
        setError('');
        setSettled(question);
        again((result.imports || []).some(row => row.status === 'running'));
      }, failed);
    }
    return () => { stale = true; clearTimeout(timer); };
  }, [archive, tab, offset, question]);

  const done = () => {
    close();
    // Suggestions may have arrived while this was open.
    if (archive.store.getState().phase === 'ready') archive.refreshLibrary().catch(caught => toast(errorMessage(caught), { error: true }));
  };

  const counts = jobs?.counts ?? { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
  const total = Number(jobs?.total) || 0;
  const running = tab === 'ai' ? counts.queued + counts.running > 0 : (imports || []).some(row => row.status === 'running');
  const rows: (AiJob | ImportRun)[] = tab === 'ai' ? jobs?.jobs ?? [] : imports ?? [];
  const ready = tab === 'ai' ? jobs !== null : imports !== null;

  const cancelJobs = () => confirm({
    title: 'Cancel pending classification?',
    message: 'Queued and running jobs will be cancelled. Existing saves and accepted topics stay in your library. Cancelled jobs can be retried.',
    action: async () => {
      const result = await archive.api.cancelAi();
      toast(`${result.cancelled} jobs cancelled.`);
      reload();
    },
  });

  return (
    <Modal
      open={spec.open}
      onClose={done}
      title="A little activity"
      description="See what arrived, what changed, and anything that needs another look."
      opener={spec.opener}
      footer={
        <>
          <Button aria-busy={loading || undefined} onClick={reload}><Activity />Refresh</Button>
          <Button variant="primary" onClick={done}><Check />Done</Button>
        </>
      }
    >
      {demo ? <Notice className="mb-4">This public demo does not run real imports or AI jobs. These activity lists are empty by design.</Notice> : null}
      <Segmented
        label="Activity kind"
        value={tab}
        onValueChange={next => { setTab(next); setOffset(0); }}
        options={[{ value: 'imports', label: 'Imports', icon: <Upload aria-hidden="true" /> }, { value: 'ai', label: 'AI jobs', icon: <Sparkles aria-hidden="true" /> }]}
      />

      <div aria-busy={loading || undefined} className="mt-4 flex flex-col gap-2.5">
        {error ? <FormError message={error} /> : null}
        {!ready && !error ? <p role="status" className="flex items-center gap-2 py-6 text-sm text-ink-soft"><AsciiSpinner />Looking…</p> : null}

        {tab === 'ai' && jobs ? (
          <section aria-label="Classification progress" role="status" className="rounded-lg border border-line p-4">
            <h3 className="mb-3 text-sm font-semibold text-ink">All classification jobs</h3>
            <div className="mb-3 flex flex-wrap gap-x-6 gap-y-2">
              {COUNTS.map(([key, label]) => (
                <span key={key} className="flex flex-col">
                  <strong className="num text-xl font-medium text-ink">{String(counts[key] || 0)}</strong>
                  <span className="label-mono">{label}</span>
                </span>
              ))}
            </div>
            {total ? (
              <>
                <AsciiProgress label="Classification jobs finished" value={counts.completed + counts.failed + counts.cancelled} max={total} />
                <p className="mt-2 text-xs text-ink-soft">{total} jobs in total. {running ? 'Progress refreshes automatically.' : 'No jobs are running.'}</p>
              </>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {running ? <Button variant="ghost" size="sm" onClick={() => void cancelJobs()}><X />Cancel pending jobs</Button> : null}
              <Button variant="soft" size="sm" aria-busy={reviewBusy || undefined} disabled={reviewBusy} onClick={() => void runReview(async () => { close(); await openReview(archive); })}><CircleCheck />Review your saves</Button>
            </div>
          </section>
        ) : null}

        {tab === 'imports' && imports ? (
          <p className="text-xs leading-relaxed text-ink-soft">{running ? 'An import is running. Counts refresh automatically as batches arrive.' : 'Showing the most recent imports. Coverage describes only the supplied file or observed source view.'}</p>
        ) : null}

        {ready && !rows.length ? (
          <p className="py-4 text-sm text-ink-soft">{tab === 'ai' ? 'No classification jobs yet. Use Organize to queue your library or a filtered view.' : 'No imports yet. Bring in an export file or use the companion extension.'}</p>
        ) : null}

        {tab === 'ai'
          ? (jobs?.jobs ?? []).map(row => <JobRow key={row.id} row={row} canRetry={!demo && aiEnabled} onChanged={reload} onOpen={() => { close(); void archive.openItem(row.item_id!); }} />)
          : (imports ?? []).map(row => (
              <article key={row.id} className="rounded-md border border-line px-4 py-3">
                <div className="mb-1.5 flex items-center justify-between gap-3">
                  <strong dir="auto" className="text-sm font-semibold text-ink">{PLATFORM_NAMES[row.source] || row.source || 'File'} import</strong>
                  <StatusPill status={row.status} />
                </div>
                <p className="num text-xs text-ink-soft">{formatDate(row.started_at || row.created_at)}</p>
                <p className="mt-1 text-xs text-ink-soft">{row.created || 0} new · {row.updated || 0} updated · {row.skipped || 0} skipped</p>
                <p className="text-xs text-ink-soft">Coverage: {String(row.coverage || 'partial').replaceAll('_', ' ')}</p>
                {row.source_account && row.source_account !== 'default' ? <p dir="auto" className="text-xs text-ink-soft">Source account: {row.source_account}</p> : null}
                {row.error ? <p className="mt-1.5 text-xs text-danger">{row.error}</p> : null}
              </article>
            ))}

        {tab === 'ai' && jobs && total > PAGE ? (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="num text-xs text-ink-soft">{offset + 1}–{offset + jobs.jobs.length} of {total} jobs</p>
            <div className="flex gap-2">
              <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}><ArrowLeft />Previous jobs</Button>
              <Button size="sm" disabled={offset + jobs.jobs.length >= total} onClick={() => setOffset(offset + PAGE)}>Next jobs<ArrowRight /></Button>
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function JobRow({ row, canRetry, onChanged, onOpen }: { row: AiJob; canRetry: boolean; onChanged(): void; onOpen(): void }) {
  const archive = useArchive();
  const [busy, run] = useBusy();
  return (
    <article className="rounded-md border border-line px-4 py-3">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <strong dir="auto" className="min-w-0 truncate text-sm font-semibold text-ink">{row.title || 'Local classification'}</strong>
        <StatusPill status={row.status} />
      </div>
      <p className="num text-xs text-ink-soft">{formatDate(row.started_at || row.created_at)}</p>
      {row.error ? <p className="mt-1.5 text-xs text-danger">{row.error}</p> : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {row.item_id ? <Button variant="ghost" size="sm" className="-ms-2" onClick={onOpen}><ArrowRight />Open save</Button> : null}
        {row.status === 'failed' || row.status === 'cancelled' ? (
          <Button
            variant="soft"
            size="sm"
            disabled={!canRetry || busy}
            aria-busy={busy || undefined}
            onClick={() => void (async () => {
              if (!(await allowAi(archive, 'suggest'))) return;
              await run(async () => {
                const result = await archive.api.retryAi(row.id);
                toast(result.queued ? 'Fresh suggestions queued.' : 'A matching job is already current.');
                onChanged();
              });
            })()}
          >
            <RotateCw />
            Retry with current text
          </Button>
        ) : null}
      </div>
    </article>
  );
}
