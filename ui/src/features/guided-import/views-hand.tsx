// Step three: handing the file over. Choosing it (checked against the guide's limits before anything is
// sent), sending it a piece at a time with the progress drawn, and picking an interrupted upload up again.
import { useState } from 'react';
import { formatDate } from '@web/utils.js';
import { ArrowLeft, ArrowRight, Play, Upload, X } from 'lucide-react';
import { useServerWords } from '@/app/archive-context';
import { Field, Notice } from '@/components/field';
import { Ascii, AsciiProgress } from '@/components/fx/ascii';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Guide, GuidedImport } from './api';
import { chunkCount, expandRanges, pieceMap } from './chunks';
import { canResumeWith, checkFile, findResumable, listAccepts, type Choice } from './flow';
import { Chevron, DropZone, FileLine, Panel, Problem, ServerName, StepHeading } from './parts';
import { bytesPerSecond, doneBytes, secondsLeft, type UploadState } from './upload-state';
import { formatBytes, formatRate, formatRemaining } from './words';

const EMPTY = new Set<number>();

/** A strip of characters, one per piece or group of pieces. Decoration: the numbers around it are the real answer. */
function PieceMap({ total, done, inflight }: { total: number; done: ReadonlySet<number>; inflight: ReadonlySet<number> }) {
  // A few pieces are drawn large and spaced out; many are drawn small and packed, and share a character when there are more than forty.
  const size = total <= 16 ? 'text-xl tracking-[0.12em]' : total <= 40 ? 'text-base tracking-[0.04em]' : 'text-xs';
  return <pre aria-hidden="true" className={`ascii max-w-full overflow-hidden text-sage dark:text-sage-deep ${size}`}>{pieceMap(total, done, inflight, 40)}</pre>;
}

/* Choosing the file --------------------------------------------------------------------------------------- */

export function AddView({ choice, guide, limits, imports, state, onBack, onSend }: {
  choice: Choice;
  guide: Guide | undefined;
  limits: Guide['upload'];
  imports: GuidedImport[] | null;
  state: UploadState;
  onBack(): void;
  onSend(file: File, account: string, resume: GuidedImport | null): void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState('');
  const [account, setAccount] = useState('');
  const creating = state.phase === 'creating';
  const name = choice === 'auto' ? 'export' : `${guide?.name ?? choice} file`;
  const resume = file ? findResumable(imports ?? [], file, choice) : null;
  const pieces = file ? chunkCount(file.size, limits.chunk_bytes) : 0;

  const pick = (chosen: File) => {
    const found = checkFile(chosen, limits);
    setProblem(found?.words ?? '');
    setFile(found ? null : chosen);
  };

  return (
    <>
      <Button variant="ghost" size="sm" className="-ms-2 mb-2" onClick={onBack} disabled={creating}><ArrowLeft />Back</Button>
      <StepHeading
        title={choice === 'auto' ? 'Hand over your file' : `Hand over your ${guide?.name ?? ''} file`}
        lede="Add the file exactly as it was sent to you, still zipped. It goes to your server in small pieces, and nothing is saved until you have seen what is in it."
      />
      <div className="flex max-w-3xl flex-col gap-4">
        {state.error ? <Problem title={state.error.title} what={state.error.what} next={state.error.next} /> : null}
        {problem ? <Problem title="That file cannot be used" what={problem} /> : null}

        {file ? (
          <Panel className="flex flex-col gap-4">
            <FileLine name={file.name} size={file.size} detail={`${pieces.toLocaleString()} ${pieces === 1 ? 'piece' : 'pieces'} of ${formatBytes(limits.chunk_bytes)}`} />
            {resume ? (
              <Notice tone="sage">
                <strong className="font-semibold">You started this one before.</strong>
                <span className="mt-1 block text-ink-soft">{resume.upload.received_count.toLocaleString()} of {resume.upload.chunks_total.toLocaleString()} pieces are already on <ServerName />, so only the rest are sent.</span>
              </Notice>
            ) : null}
            <details className="group/d rounded-md border border-line px-4">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-sm font-semibold text-ink [&::-webkit-details-marker]:hidden"><Chevron />Keep these saves under an account name</summary>
              <div className="pt-1 pb-4">
                <Field label="Account name" help="Optional. Saves are kept per account, and the default is the same one the plain file import uses. Give your handle to keep these apart, for example from saves a browser extension collected under it.">
                  <Input value={account} maxLength={200} dir="auto" autoComplete="off" placeholder="default" disabled={Boolean(resume) || creating} onChange={event => setAccount(event.target.value)} />
                </Field>
                {resume ? <p className="mt-2 text-xs text-ink-soft">This upload already has its account name: {resume.source_account}.</p> : null}
              </div>
            </details>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled={creating} aria-busy={creating || undefined} onClick={() => onSend(file, account.trim(), resume)}>
                {resume ? <Play /> : <Upload />}
                {creating ? 'Getting ready…' : resume ? 'Send the rest' : 'Send to my server'}
              </Button>
              <Button variant="ghost" disabled={creating} onClick={() => setFile(null)}>Choose a different file</Button>
            </div>
          </Panel>
        ) : (
          <DropZone
            accept={limits.accepts.join(',')}
            title={`Drop your ${name} here`}
            hint={<>{listAccepts(limits.accepts)} · up to {formatBytes(limits.max_bytes)}</>}
            onFile={pick}
          />
        )}
        <p className="text-xs leading-relaxed text-ink-soft">The size and type are checked here first, so a file this server would refuse is never sent. Your file is read in pieces and never held in memory whole.</p>
      </div>
    </>
  );
}

/* Sending ---------------------------------------------------------------------------------------------------- */

export function SendingView({ state, onContinue, onCancel }: { state: UploadState; onContinue(): void; onCancel(): void }) {
  const finishing = state.phase === 'finishing';
  const paused = state.phase === 'paused';
  const bytes = doneBytes(state);
  const percent = state.size ? Math.round((bytes / state.size) * 100) : 0;
  // Screen readers hear every tenth, not every piece.
  const w = useServerWords();
  const spoken = w(finishing ? 'All pieces are on your server. Reading the file.' : paused ? 'The upload is paused.' : `${Math.floor(percent / 10) * 10} percent of the file is on your server.`);
  const rate = bytesPerSecond(state);
  const left = formatRemaining(secondsLeft(state));

  return (
    <>
      <StepHeading
        whisper={paused ? 'paused' : finishing ? 'reading' : 'sending'}
        title={paused ? 'Your upload is paused' : finishing ? 'Reading your file' : 'Sending your file'}
        lede={paused ? 'What already arrived is kept on your server. Continue to send the rest.' : finishing ? 'Every piece has arrived. Your server is joining them and reading what is inside. Nothing is saved yet.' : 'Going to your server a piece at a time. If the connection drops or you leave, what arrived is kept, and the same file added again sends only what is missing.'}
      />
      <Panel className="flex max-w-3xl flex-col gap-5">
        <FileLine name={state.fileName} size={state.size} detail={`${state.total.toLocaleString()} ${state.total === 1 ? 'piece' : 'pieces'}`} />
        {state.error ? <Problem title={state.error.title} what={state.error.what} next={state.error.next} /> : null}

        <div className="flex flex-col gap-2.5">
          {finishing ? <AsciiProgress label="Reading your file" /> : <AsciiProgress label="Upload progress" value={bytes} max={Math.max(1, state.size)} />}
          <p role="status" className="sr-only">{spoken}</p>
          {finishing ? (
            <p className="text-xs text-ink-soft">This can take a minute for a large export.</p>
          ) : (
            <>
              <p className="num text-xs text-ink-soft" aria-hidden="true">
                {formatBytes(bytes)} of {formatBytes(state.size)} · {state.done.size.toLocaleString()} of {state.total.toLocaleString()} pieces
              </p>
              <PieceMap total={state.total} done={state.done} inflight={state.inflight} />
              {!paused && (rate != null || state.retries > 0) ? (
                <p className="num text-xs text-ink-soft">
                  {rate != null ? formatRate(rate) : null}
                  {rate != null && left ? ` · ${left}` : null}
                  {state.retries > 0 ? `${rate != null ? ' · ' : ''}${state.retries} sent again after a hiccup` : null}
                </p>
              ) : null}
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {paused ? <Button variant="primary" onClick={onContinue}><Play />Continue the upload</Button> : null}
          {finishing ? null : <Button variant="danger-ghost" onClick={onCancel}><X />Cancel this import</Button>}
        </div>
      </Panel>
    </>
  );
}

/* Picking an interrupted upload up again ------------------------------------------------------------------------ */

export function ResumeView({ view, accept, onFile, onCancel }: { view: GuidedImport; accept: string; onFile(file: File): void; onCancel(): void }) {
  const w = useServerWords();
  const [problem, setProblem] = useState('');
  const have = new Set(expandRanges(view.upload.received, view.upload.chunks_total));
  const missing = Math.max(0, view.upload.chunks_total - view.upload.received_count);

  const pick = (file: File) => {
    const fits = canResumeWith(view, file);
    if (!fits.ok) { setProblem(fits.words); return; }
    setProblem('');
    onFile(file);
  };

  return (
    <>
      <StepHeading
        title="Pick up where you left off"
        lede={<>{view.upload.received_count.toLocaleString()} of {view.upload.chunks_total.toLocaleString()} pieces of <span dir="auto" className="font-semibold text-ink">{view.filename}</span> are already on <ServerName />. Add the same file again and only the other {missing.toLocaleString()} are sent.</>}
      />
      <Panel className="flex max-w-3xl flex-col gap-5">
        <div className="flex flex-col gap-2.5">
          <AsciiProgress label={w('Pieces already on your server')} value={view.upload.received_count} max={Math.max(1, view.upload.chunks_total)} />
          <PieceMap total={view.upload.chunks_total} done={have} inflight={EMPTY} />
          <p className="num text-xs text-ink-soft">{formatBytes(view.size_bytes)} in all · started {formatDate(view.created_at)}</p>
        </div>
        {problem ? <Problem title="That is not the same file" what={problem} /> : null}
        <DropZone compact accept={accept} title="Add the same file again" hint="It only has to be the same file. Its name may be different." onFile={pick} />
        <div><Button variant="danger-ghost" onClick={onCancel}><X />Cancel this import</Button></div>
      </Panel>
    </>
  );
}

/* Everything arrived, nothing read ------------------------------------------------------------------------------- */

export function ReadView({ view, busy, onRead, onCancel }: { view: GuidedImport; busy: boolean; onRead(): void; onCancel(): void }) {
  return (
    <>
      <StepHeading title="Your file is on your server" lede="Every piece arrived, but the file was never read. That needs no file from you: press the button and it will be read and shown to you. Nothing is saved yet." />
      <Panel className="flex max-w-3xl flex-col gap-5">
        <div className="flex items-start gap-5">
          <Ascii name="box" className="shrink-0 text-start text-sm text-sage max-sm:hidden dark:text-sage-deep" />
          <FileLine name={view.filename} size={view.size_bytes} detail={`${view.upload.chunks_total.toLocaleString()} pieces`} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={busy} aria-busy={busy || undefined} onClick={onRead}><ArrowRight />{busy ? 'Reading…' : 'Read my file'}</Button>
          <Button variant="danger-ghost" disabled={busy} onClick={onCancel}><X />Cancel this import</Button>
        </div>
      </Panel>
    </>
  );
}
