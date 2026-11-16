// Bring your saves home: one export file, read by your own server. While it is read the dialog cannot be
// closed, and the result says plainly what arrived and what the file does and does not establish.
import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import { countLabel, errorMessage } from '@web/utils.js';
import { cn } from 'cn';
import { ArrowRight, Link2, Plus, Route, Sparkles, Upload } from 'lucide-react';
import { useArchive } from '@/app/archive-context';
import { serverWords } from '@/lib/server-words';
import { openDialog, toast } from '@/app/ui-state';
import { FormError, Notice, Section } from '@/components/field';
import { Ascii, AsciiProgress } from '@/components/fx/ascii';
import { NumberTicker } from '@/components/fx/number-ticker';
import { Modal } from '@/components/modal';
import { Button } from '@/components/ui/button';
import type { ImportResult } from '@/data/types';
import type { DialogProps } from './basic';

const LIMIT = 16 * 1024 * 1024;

function Tally({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col">
      <NumberTicker value={value} className="text-2xl text-ink" />
      <span className="label-mono">{label}</span>
    </div>
  );
}

export function ImportDialog({ spec, close }: DialogProps<'import'>) {
  const archive = useArchive();
  const demo = archive.backend.kind === 'demo';
  const [file, setFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const canClose = () => {
    if (importing) toast('Please wait for this import to finish.');
    return !importing;
  };

  if (demo) {
    return (
      <Modal
        open={spec.open}
        onClose={close}
        title="Bring your saves home"
        opener={spec.opener}
        footer={
          <>
            <Button variant="soft" onClick={() => { close(); openDialog({ kind: 'save-link' }); }}><Plus />Save a demo link</Button>
            <Button variant="primary" onClick={close}><ArrowRight />Keep exploring</Button>
          </>
        }
      >
        <Notice>
          <strong className="font-semibold">You are exploring synthetic content.</strong>
          <p className="mt-1 text-ink-soft">Real file imports and browser connections are available in a self-hosted instance. This public demo has no backend, account, or social connection and does not read your files.</p>
        </Notice>
        <h3 className="mt-5 mb-1.5 text-base font-semibold text-ink">What you can explore here</h3>
        <p className="text-sm leading-relaxed text-ink-soft">Try searching, filtering, editing notes, favoriting saves, and making collections. You can also add a link as an in-memory demo record. Everything resets when you reload.</p>
      </Modal>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (!file) { setError('Choose an export file to import.'); return; }
    setImporting(true);
    setResult(null);
    try {
      if (file.size > LIMIT) throw new Error('This file exceeds 16 MiB. Use a smaller export or split it into supported saved-content sections.');
      const data = await archive.api.importFile(file);
      setResult(data);
      await archive.refreshLibrary();
      toast(`${countLabel(data.created, 'new save')} added.`, { tone: data.created ? 'saved' : 'ok' });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setImporting(false);
    }
  };

  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files?.[0];
    if (!dropped || importing) return;
    setFile(dropped);
    // Show the dropped file in the picker too, where the browser allows it.
    try { if (input.current) input.current.files = event.dataTransfer.files; } catch { /* The file is still held in state. */ }
  };

  return (
    <Modal
      open={spec.open}
      onClose={close}
      canClose={canClose}
      title="Bring your saves home"
      description={serverWords('Import an account export, bookmarks, or a previous Little Archive export. Files are processed by your own server.', archive.backend.mode)}
      opener={spec.opener}
    >
      <form noValidate onSubmit={event => void submit(event)} className="flex flex-col gap-4">
        <FormError message={error} />
        <div
          onDragOver={event => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
          className={cn('flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-5 py-7 text-center transition-colors duration-200', dragging ? 'border-sage bg-sage-pale' : 'border-line-strong bg-card-2')}
        >
          <Ascii name="box" className={cn('text-start text-sm text-sage transition-transform duration-300 ease-spring dark:text-sage-deep', dragging && '-translate-y-1 scale-105')} />
          <h3 className="display text-xl text-ink">A fresh start for your saved things</h3>
          <p className="text-sm text-ink-soft">JSON, CSV, bookmarks HTML, or ZIP · up to 16 MiB</p>
          <input
            ref={input}
            type="file"
            accept=".json,.csv,.html,.htm,.zip,.txt"
            required
            disabled={importing}
            aria-label="Choose an export file"
            onChange={event => setFile(event.target.files?.[0] ?? null)}
            className="w-full max-w-sm cursor-pointer rounded-full border border-line-strong bg-card p-1.5 text-sm text-ink-soft file:me-3 file:h-9 file:cursor-pointer file:rounded-full file:border-0 file:bg-sage-pale file:px-4 file:text-sm file:font-semibold file:text-sage dark:file:text-sage-deep"
          />
        </div>
        <p className="text-xs leading-relaxed text-ink-soft">Supported archive sections are read selectively. Missing collections or unavailable media are reported, not invented.</p>
        <div><Button type="submit" variant="primary" disabled={importing} aria-busy={importing || undefined}><Upload />{importing ? 'Importing…' : 'Import file'}</Button></div>

        {importing ? (
          <div role="status" className="flex flex-col gap-2 rounded-md bg-card-2 px-4 py-3.5">
            <AsciiProgress label="Import progress" />
            <p className="text-sm text-ink-soft">Uploading and processing your file. Keep this window open until your results are ready.</p>
          </div>
        ) : null}

        {result ? (
          <div className="flex animate-in flex-col gap-3 rounded-lg bg-sage-pale px-5 py-4 duration-500 fade-in-0 slide-in-from-bottom-2">
            <h3 className="text-base font-semibold text-ink">Your import is ready</h3>
            <div className="flex gap-8">
              <Tally value={result.created} label="new" />
              <Tally value={result.updated} label="updated" />
              <Tally value={result.skipped} label="skipped" />
            </div>
            <p className="sr-only">{`${result.created} new · ${result.updated} updated · ${result.skipped} skipped`}</p>
            <p className="text-sm leading-relaxed text-ink">
              {result.coverage === 'enumeration_exhausted' ? 'The supplied file was processed. This does not establish a complete platform archive.' : 'Coverage is partial. Your existing saves have been preserved.'}
            </p>
            {(result.errors || []).length ? (
              <details className="text-sm text-ink">
                <summary className="min-h-11 cursor-pointer content-center font-semibold">{result.errors.length} import notes</summary>
                <ul className="list-disc space-y-1 ps-5 text-xs leading-relaxed">
                  {result.errors.slice(0, 30).map((note, index) => <li key={index} dir="auto">{String(note)}</li>)}
                </ul>
              </details>
            ) : null}
            <div><Button variant="outline" size="sm" onClick={() => { close(); openDialog({ kind: 'organize' }); }}><Sparkles />Organize your library</Button></div>
          </div>
        ) : null}
      </form>

      <div className="mt-6">
        {archive.backend.mode !== 'hosted' ? (
          <Section title="Import from your browser">
            <p>The companion extension can collect the saved or collection view you open on Instagram or TikTok. Browser adapters are experimental and report their observed coverage.</p>
            <div><Button variant="soft" disabled={importing} onClick={() => { close(); openDialog({ kind: 'settings', section: 'connections' }); }}><Link2 />Set up a connection</Button></div>
          </Section>
        ) : null}
        <Section title="Guided Instagram and TikTok import">
          <p>Ask Instagram or TikTok for your saves, hand the file over, and see what it holds before anything is saved. You can leave and pick it up again.</p>
          <div><Button variant="ghost" size="sm" className="-ms-2" disabled={importing} onClick={() => { close(); archive.goScreen('guided-import'); }}><Route />Start the guided import</Button></div>
        </Section>
      </div>
    </Modal>
  );
}
