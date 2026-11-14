// Step five and what follows it: watching the job run, finishing (with the same honest coverage language as
// the single-file import), picking up a job that stopped, and what to do when a file was refused or an import
// was cancelled.
import { countLabel, PLATFORM_NAMES } from '@web/utils.js';
import { ArrowRight, LayoutGrid, RotateCw, Sparkles, Upload, X } from 'lucide-react';
import { Notice } from '@/components/field';
import { Ascii, AsciiProgress } from '@/components/fx/ascii';
import { Button } from '@/components/ui/button';
import type { GuidedImport, PlatformId } from './api';
import type { Choice } from './flow';
import { Chevron, FileLine, Panel, Problem, Stat, StepHeading } from './parts';
import { coverageSentence, explainRejection } from './words';

/* Importing ------------------------------------------------------------------------------------------------- */

export function ImportingView({ view, slow, busy, onNudge, onCancel, onLibrary }: { view: GuidedImport; slow: boolean; busy: boolean; onNudge(): void; onCancel(): void; onLibrary(): void }) {
  const { progress } = view;
  const total = Math.max(1, progress.total);
  const fraction = Math.min(1, progress.processed / total);
  // Screen readers hear every tenth, not every batch.
  const spoken = `Import ${Math.floor(fraction * 10) * 10} percent done. ${progress.processed.toLocaleString()} of ${progress.total.toLocaleString()} saves processed.`;
  return (
    <>
      <StepHeading
        whisper="running on your server"
        title="Bringing your saves home"
        lede="This runs on your server, so you can leave this page and come back to it: it keeps going. What is done is already in your library."
      />
      <Panel className="flex max-w-3xl flex-col gap-5">
        <div className="flex flex-col gap-2.5">
          <AsciiProgress label="Import progress" value={progress.processed} max={total} width={28} />
          <p className="num text-xs text-ink-soft" aria-hidden="true">{progress.processed.toLocaleString()} of {progress.total.toLocaleString()} saves processed</p>
          <p role="status" className="sr-only">{spoken}</p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Stat value={progress.created} label="new" />
          <Stat value={progress.updated} label="updated" />
          <Stat value={progress.skipped} label="skipped" />
        </div>
        {slow ? (
          <Notice tone="petal" role="status">
            <strong className="font-semibold">This is taking longer than usual.</strong>
            <span className="mt-1 block text-ink-soft">Your server may have been restarted. Asking it to continue is safe: it picks up from where it stopped and repeats nothing.</span>
            <Button variant="outline" size="sm" className="mt-3" disabled={busy} aria-busy={busy || undefined} onClick={onNudge}><RotateCw />Continue</Button>
          </Notice>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="soft" onClick={onLibrary}><LayoutGrid />Browse your library meanwhile</Button>
          <Button variant="danger-ghost" onClick={onCancel}><X />Cancel the import</Button>
        </div>
      </Panel>
    </>
  );
}

/* Done ---------------------------------------------------------------------------------------------------------- */

export function DoneView({ view, notes, onLibrary, onOrganize, onAnother }: { view: GuidedImport; notes: string[]; onLibrary(): void; onOrganize(): void; onAnother(): void }) {
  const { progress } = view;
  const name = PLATFORM_NAMES[view.platform] ?? view.filename;
  return (
    <>
      <StepHeading
        whisper="all done"
        title="Welcome home."
        lede={progress.created ? `${countLabel(progress.created, 'new save')} from your ${name} file ${progress.created === 1 ? 'is' : 'are'} now in your library.` : `Everything in your ${name} file was already in your library, so nothing new was added.`}
      />
      <Panel tone="sage" className="flex max-w-3xl flex-col gap-5">
        <div className="flex items-center gap-6">
          <Ascii name="flower" className="shrink-0 text-start text-sm text-sage max-sm:hidden dark:text-sage-deep" />
          <div className="grid flex-1 grid-cols-3 gap-3" role="group" aria-label="What the import did">
            <Stat value={progress.created} label="new" strong className="bg-card" />
            <Stat value={progress.updated} label="updated" strong className="bg-card" />
            <Stat value={progress.skipped} label="skipped" strong className="bg-card" />
          </div>
        </div>
        <p dir="auto" className="text-sm leading-relaxed text-ink">{coverageSentence(name)}</p>
        {notes.length ? (
          <details className="group/d text-sm text-ink">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 font-semibold [&::-webkit-details-marker]:hidden"><Chevron />{countLabel(notes.length, 'import note')}</summary>
            <ul className="list-disc space-y-1 ps-5 text-xs leading-relaxed">
              {notes.slice(0, 30).map((note, index) => <li key={index} dir="auto">{note}</li>)}
            </ul>
          </details>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={onLibrary}><LayoutGrid />See your library</Button>
          <Button variant="outline" onClick={onOrganize}><Sparkles />Organize</Button>
          <Button variant="ghost" onClick={onAnother}><Upload />Import another file</Button>
        </div>
      </Panel>
    </>
  );
}

/* Stopped part way -------------------------------------------------------------------------------------------------- */

export function FailedView({ view, busy, onContinue, onCancel }: { view: GuidedImport; busy: boolean; onContinue(): void; onCancel(): void }) {
  const { progress } = view;
  return (
    <>
      <StepHeading whisper="stopped" title="The import stopped part way" lede="It kept its place. Continue and it picks up from where it stopped, repeating nothing." />
      <Panel className="flex max-w-3xl flex-col gap-5">
        <Problem title="Why it stopped" what={view.error || 'The import stopped before it finished.'} next="What was already saved stays in your library." />
        <div className="grid grid-cols-3 gap-3">
          <Stat value={progress.processed} label={`of ${progress.total.toLocaleString()} processed`} />
          <Stat value={progress.created} label="new" />
          <Stat value={progress.skipped} label="skipped" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={busy} aria-busy={busy || undefined} onClick={onContinue}><RotateCw />{busy ? 'Continuing…' : 'Continue the import'}</Button>
          <Button variant="danger-ghost" disabled={busy} onClick={onCancel}><X />Cancel the import</Button>
        </div>
      </Panel>
    </>
  );
}

/* Refused or cancelled --------------------------------------------------------------------------------------------- */

const OTHER: Record<PlatformId, PlatformId> = { instagram: 'tiktok', tiktok: 'instagram' };

export function AgainView({ view, code, onAdd, onChoose }: { view: GuidedImport; code: string | undefined; onAdd(choice: Choice): void; onChoose(): void }) {
  const own: Choice = view.platform;
  if (view.state === 'cancelled') {
    return (
      <>
        <StepHeading whisper="cancelled" title="This import was cancelled" lede={view.error || 'Anything already imported was kept.'} />
        <Panel className="flex max-w-3xl flex-col gap-4">
          <FileLine name={view.filename} size={view.size_bytes} />
          <div><Button variant="primary" onClick={onChoose}><Upload />Start a new import</Button></div>
        </Panel>
      </>
    );
  }
  const words = explainRejection(code, view.error);
  const other = own === 'auto' ? null : OTHER[own];
  return (
    <>
      <StepHeading whisper="could not use this file" title={words.title} lede="Nothing was saved from it, and the copy on your server has been removed." />
      <Panel className="flex max-w-3xl flex-col gap-5">
        <FileLine name={view.filename} size={view.size_bytes} />
        <Problem title="What happened" what={words.what} next={words.next}>
          {view.error && view.error !== words.what ? <p dir="auto" className="num mt-2.5 border-t border-danger/20 pt-2 text-xs text-ink-soft">Your server said: {view.error}</p> : null}
        </Problem>
        <div className="flex flex-wrap items-center gap-2">
          {code === 'wrong_platform' && other ? (
            <Button variant="primary" onClick={() => onAdd(other)}><ArrowRight />Add it again as {PLATFORM_NAMES[other]}</Button>
          ) : (
            <Button variant="primary" onClick={() => onAdd(own)}><Upload />Add a file again</Button>
          )}
          <Button variant="ghost" onClick={onChoose}>Choose a different platform</Button>
        </div>
      </Panel>
    </>
  );
}
