// Step one: where are your saves? Two platform cards, a way in for a file of unknown origin, and the list of
// earlier imports (some of which are waiting to be picked up again).
import { formatDate } from '@web/utils.js';
import { ArrowRight, ChevronRight, X } from 'lucide-react';
import { Notice, Whisper } from '@/components/field';
import { AsciiSpinner } from '@/components/fx/ascii';
import { PlatformIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import type { Guide, GuidedImport, PlatformId } from './api';
import type { Choice } from './flow';
import { Panel, StateChip, StepHeading } from './parts';
import { formatBytes, STATE_WORDS } from './words';

function PlatformCard({ guide, onGuide, onAdd }: { guide: Guide; onGuide(): void; onAdd(): void }) {
  return (
    <article data-platform={guide.id} className="flex flex-col rounded-lg border border-line bg-card p-5 shadow-xs transition-[transform,box-shadow] duration-200 ease-out hov:-translate-y-0.5 hov:-rotate-[0.4deg] hov:shadow-md sm:p-6">
      <div className="flex items-center gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-full bg-sage-pale text-sage dark:text-sage-deep"><PlatformIcon platform={guide.id} className="size-5" /></span>
        <h3 dir="auto" className="display text-xl text-ink">{guide.name}</h3>
      </div>
      <p dir="auto" className="mt-3 flex-1 text-sm leading-relaxed text-ink-soft">{guide.summary}</p>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={onGuide}>Show me the steps<ArrowRight /></Button>
        <Button variant="ghost" onClick={onAdd}>I already have the file</Button>
      </div>
    </article>
  );
}

function summaryOf(entry: GuidedImport): string {
  const { upload, progress } = entry;
  switch (entry.state) {
    case 'uploading': return upload.complete ? 'Every piece is on your server and waiting to be read' : `${upload.received_count.toLocaleString()} of ${upload.chunks_total.toLocaleString()} pieces on your server`;
    case 'previewed': return 'Read and waiting for your go-ahead. Nothing is saved';
    case 'importing': return `${progress.processed.toLocaleString()} of ${progress.total.toLocaleString()} saves processed`;
    case 'failed': return `Stopped at ${progress.processed.toLocaleString()} of ${progress.total.toLocaleString()}`;
    case 'completed': return `${progress.created.toLocaleString()} new · ${progress.updated.toLocaleString()} updated · ${progress.skipped.toLocaleString()} skipped`;
    default: return STATE_WORDS[entry.state].hint;
  }
}

const OPEN_LABEL: Record<string, string> = { uploading: 'Continue', previewed: 'Review', importing: 'Watch', failed: 'Continue', completed: 'See the result' };

/** An import that is still going: a card, with what can be done with it. */
function OpenRow({ entry, onOpen, onCancel }: { entry: GuidedImport; onOpen(id: string): void; onCancel(entry: GuidedImport): void }) {
  return (
    <li data-import={entry.id} data-state={entry.state} className="rounded-md border border-line border-s-[5px] border-s-butter bg-card px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <PlatformIcon platform={entry.platform} className="mt-0.5 size-4.5 shrink-0 text-ink-soft" />
          <div className="min-w-0">
            <p dir="auto" className="truncate text-sm font-semibold text-ink">{entry.filename}</p>
            <p className="num text-xs text-ink-soft">{formatBytes(entry.size_bytes)} · {formatDate(entry.updated_at)}</p>
          </div>
        </div>
        <StateChip state={entry.state} />
      </div>
      <p dir="auto" className="mt-2 text-xs leading-relaxed text-ink-soft">{summaryOf(entry)}</p>
      {entry.error && entry.state === 'failed' ? <p dir="auto" className="mt-1 text-xs leading-relaxed text-ink-soft">{entry.error}</p> : null}
      <div className="mt-2.5 flex flex-wrap items-center gap-1">
        <Button variant="soft" size="sm" onClick={() => onOpen(entry.id)}>{OPEN_LABEL[entry.state] ?? 'Open'}<ArrowRight /></Button>
        <Button variant="danger-ghost" size="sm" onClick={() => onCancel(entry)}><X />Cancel</Button>
      </div>
    </li>
  );
}

/** One that is over, as a single quiet line: what it was, how it ended, and (for a finished one) a way to see the result. */
function DoneRow({ entry, onOpen }: { entry: GuidedImport; onOpen(id: string): void }) {
  return (
    <li data-import={entry.id} data-state={entry.state} className="flex items-center gap-3 rounded-md border border-line bg-card/60 px-4 py-2.5">
      <PlatformIcon platform={entry.platform} className="size-4.5 shrink-0 text-ink-soft" />
      <div className="min-w-0 flex-1">
        <p dir="auto" className="truncate text-sm font-semibold text-ink">{entry.filename}</p>
        <p dir="auto" className="line-clamp-2 text-xs leading-relaxed text-ink-soft">
          <span className="num">{formatDate(entry.updated_at)}</span> · {entry.state === 'completed' ? summaryOf(entry) : entry.error || summaryOf(entry)}
        </p>
      </div>
      <StateChip state={entry.state} />
      {entry.state === 'completed' ? <Button variant="ghost" size="sm" className="max-sm:px-2.5" onClick={() => onOpen(entry.id)}><span className="max-sm:sr-only">See the result</span><ArrowRight /></Button> : null}
    </li>
  );
}

export function EarlierImports({ imports, error, onOpen, onCancel }: { imports: GuidedImport[] | null; error: string; onOpen(id: string): void; onCancel(entry: GuidedImport): void }) {
  if (imports === null && !error) return <p role="status" className="mt-10 flex items-center gap-2 text-sm text-ink-soft"><AsciiSpinner />Looking for earlier imports…</p>;
  if (error && !imports) return <Notice className="mt-10">Earlier imports could not be listed: {error}</Notice>;
  if (!imports?.length) return null;
  const open = imports.filter(entry => entry.resumable);
  const over = imports.filter(entry => !entry.resumable);
  return (
    <section aria-labelledby="earlier-imports" className="mt-10">
      <h3 id="earlier-imports" className="mb-3"><Whisper>earlier imports</Whisper></h3>
      {open.length ? <ul className="flex flex-col gap-2.5">{open.map(entry => <OpenRow key={entry.id} entry={entry} onOpen={onOpen} onCancel={onCancel} />)}</ul> : null}
      {over.length ? (
        <details open={over.length <= 3 || undefined} className={open.length ? 'group/over mt-4' : 'group/over'}>
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-sm text-sm font-semibold text-ink [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-4 text-ink-soft transition-transform duration-200 group-open/over:rotate-90 rtl:-scale-x-100" aria-hidden="true" />
            {open.length ? `Finished and refused (${over.length})` : `${over.length} finished or refused`}
          </summary>
          <ul className="mt-1 flex flex-col gap-2">{over.map(entry => <DoneRow key={entry.id} entry={entry} onOpen={onOpen} />)}</ul>
        </details>
      ) : null}
    </section>
  );
}

export function ChooseView({ guides, imports, importsError, onGuide, onAdd, onOpen, onCancel }: {
  guides: Guide[];
  imports: GuidedImport[] | null;
  importsError: string;
  onGuide(platform: PlatformId): void;
  onAdd(choice: Choice): void;
  onOpen(id: string): void;
  onCancel(entry: GuidedImport): void;
}) {
  const waiting = imports?.find(entry => entry.resumable) ?? null;
  return (
    <>
      <StepHeading title="Where did you save things?" />
      {waiting ? (
        <Panel tone="sage" className="mb-5 !p-4 sm:!p-5" aria-label="An import is waiting">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">You have an import waiting.</p>
              <p dir="auto" className="truncate text-sm text-ink-soft">{waiting.filename} · {STATE_WORDS[waiting.state].label.toLowerCase()}</p>
            </div>
            <Button variant="primary" size="sm" onClick={() => onOpen(waiting.id)}>Pick it up<ArrowRight /></Button>
          </div>
        </Panel>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {guides.map(guide => <PlatformCard key={guide.id} guide={guide} onGuide={() => onGuide(guide.id)} onAdd={() => onAdd(guide.id)} />)}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-soft">
        <span>Not sure which platform a file is from?</span>
        <Button variant="link" className="hit-44 text-sm dark:text-sage-deep" onClick={() => onAdd('auto')}>Add it and let Little Archive work it out<ArrowRight className="size-3.5" /></Button>
      </div>
      <Notice tone="sage" className="mt-6">
        <strong className="font-semibold">Nothing is saved until you have seen it.</strong>
        <p className="mt-1 text-ink-soft">Your file goes only to your library’s own server. It is read first and shown to you; saving starts only when you say so.</p>
      </Notice>
      <EarlierImports imports={imports} error={importsError} onOpen={onOpen} onCancel={onCancel} />
    </>
  );
}
