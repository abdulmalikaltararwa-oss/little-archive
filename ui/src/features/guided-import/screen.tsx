// The guided backlog import: #/import/guided. A person asks Instagram or TikTok for their data, hands the file
// to their own server in small pieces, sees what it holds before anything is saved, and then brings it in as a
// job that carries on without this page. The server's state for the import is the one source of truth for where
// they are, so reloading, leaving and coming back, or opening it on another device all land in the right place.
// The five views live beside this file; this one holds what they share and decides which to show.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { countLabel, errorMessage } from '@web/utils.js';
import { ArrowLeft, RotateCw } from 'lucide-react';
import { useArchive, useBusy } from '@/app/archive-context';
import { confirm, openDialog, toast } from '@/app/ui-state';
import { AsciiSpinner } from '@/components/fx/ascii';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/data/client';
import { FeatureGate, FeatureHeader, StateCard } from '../feature-kit';
import type { FeatureScreenProps } from '../screens';
import { guidedApi, type Guide, type GuidedImport } from './api';
import { nextFor, parseRoute, STEPS, stepOf, type Choice } from './flow';
import { useGuides, useImportList, useImportView, useUpload } from './hooks';
import { Rail } from './parts';
import { ChooseView } from './views-choose';
import { GuideView } from './views-guide';
import { AddView, ReadView, ResumeView, SendingView } from './views-hand';
import { PreviewView } from './views-preview';
import { AgainView, DoneView, FailedView, ImportingView } from './views-run';
import { REJECTION_CODES } from './words';

const DEFAULT_LIMITS: Guide['upload'] = { accepts: ['.zip', '.json', '.html', '.txt'], keep_zipped: true, max_bytes: 512 * 1024 * 1024, chunk_bytes: 1024 * 1024 };

/**
 * After a step changes, the page goes back to the top and focus goes to the new step's heading, so a screen
 * reader says where it is now and a long page does not leave the new step half scrolled away. Not on first
 * arrival, and not while something is still loading.
 */
function useStepFocus(panel: string) {
  const previous = useRef(panel);
  useEffect(() => {
    const before = previous.current;
    previous.current = panel;
    if (before === panel || before === 'loading' || panel === 'loading') return;
    scrollTo({ top: 0 });
    document.querySelector<HTMLElement>('[data-step-heading]')?.focus({ preventScroll: true });
  }, [panel]);
}

function Waiting({ children }: { children: string }) {
  return <p role="status" className="flex items-center justify-center gap-2 py-16 text-sm text-ink-soft"><AsciiSpinner />{children}</p>;
}

function Flow({ demo, rest }: FeatureScreenProps) {
  const archive = useArchive();
  const api = useMemo(() => guidedApi(archive.api.request), [archive]);
  const route = parseRoute(rest);
  const id = route.kind === 'import' ? route.id : null;
  // On a phone, and against a hosted service, fewer pieces are in flight at once.
  const concurrency = archive.backend.kind === 'native' || archive.backend.mode === 'hosted' ? 2 : 3;

  const [guides, retryGuides] = useGuides(api);
  const list = useImportList(api);
  const refreshList = list.refresh;
  const [rejections, setRejections] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<{ run: string; lines: string[] } | null>(null);
  const [busy, run] = useBusy();

  /** Moves within the screen: the part of the address after #/import/guided/. */
  const go = useCallback((next: string, options?: { replace?: boolean }) => archive.goScreen('guided-import', next, options), [archive]);

  const onCompleted = useCallback((view: GuidedImport) => {
    toast(`${countLabel(view.progress.created, 'new save')} added.`, { tone: view.progress.created ? 'saved' : 'ok' });
    archive.refreshLibrary().catch(caught => toast(errorMessage(caught), { error: true }));
    refreshList();
  }, [archive, refreshList]);

  const held = useImportView(api, id, onCompleted);
  const { put, attachPreview } = held;

  const onView = useCallback((view: GuidedImport) => { put(view); refreshList(); }, [put, refreshList]);
  const onCreated = useCallback((view: GuidedImport) => {
    put(view);
    refreshList();
    // The address now names this import, so reloading comes back to it. The entry is replaced, not added: Back still leaves the flow.
    archive.goScreen('guided-import', view.id, { replace: true });
  }, [archive, put, refreshList]);
  const onRejected = useCallback((importId: string, code: string) => setRejections(previous => ({ ...previous, [importId]: code })), []);
  const upload = useUpload({ api, concurrency, onCreated, onView, onRejected });

  useEffect(() => { document.title = `Guided import — Little Archive${demo ? ' demo' : ''}`; }, [demo]);

  // A browser's own warning for a reload or a closed tab while pieces are going out. In-app navigation pauses the upload and says so.
  const sending = upload.busy;
  useEffect(() => {
    if (!sending) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    addEventListener('beforeunload', guard);
    return () => removeEventListener('beforeunload', guard);
  }, [sending]);

  // Moving to another part of this screen (the browser's Back button, a link) while pieces are going out pauses the
  // upload and says so, as leaving the screen does. The import stays on the server and its address brings it back.
  const wandered = upload.busy && upload.state.importId !== null && upload.state.importId !== id;
  const { halt } = upload;
  useEffect(() => {
    if (wandered && halt()) toast('Upload paused. What already arrived is kept: open the import again to carry on.');
  }, [wandered, halt]);

  // A previewed import whose answer carried no preview: ask for it on its own.
  const view = held.view;
  const needsPreview = view && view.state === 'previewed' && !view.preview ? view.id : null;
  useEffect(() => {
    if (!needsPreview) return;
    const controller = new AbortController();
    api.preview(needsPreview, controller.signal).then(result => { if (!controller.signal.aborted) attachPreview(needsPreview, result.preview); }, () => {});
    return () => controller.abort();
  }, [api, needsPreview, attachPreview]);

  // What the run says about entries it skipped, for the finished view.
  const doneRun = view && view.state === 'completed' && view.progress.skipped > 0 ? view.run_id : null;
  useEffect(() => {
    if (!doneRun) return;
    let stale = false;
    archive.api.imports().then(result => {
      if (stale) return;
      const found = result.imports.find(entry => entry.id === doneRun);
      setNotes({ run: doneRun, lines: (found?.error ?? '').split('\n').map(line => line.trim()).filter(Boolean) });
    }, () => {});
    return () => { stale = true; };
  }, [archive, doneRun]);

  /* What people can do ------------------------------------------------------------------------------------- */

  const cancel = (target: Pick<GuidedImport, 'id' | 'state' | 'filename'>) => confirm({
    title: 'Cancel this import?',
    message: target.state === 'importing'
      ? 'The import stops. Saves that were already imported are kept, and the copy of your file on the server is removed.'
      : 'The copy of your file on the server is removed. Nothing from it has been saved to your library.',
    confirmLabel: 'Cancel the import',
    cancelLabel: 'Keep it',
    danger: true,
    action: async () => {
      if (upload.state.importId === target.id) { upload.halt(); upload.clear(); }
      onView(await api.cancel(target.id));
      toast('Import cancelled.');
    },
  });

  const commit = (target: GuidedImport) => void run(async () => {
    try {
      put(await api.commit(target.id, target.preview?.digest));
    } catch (caught) {
      if (caught instanceof ApiError && ['digest_mismatch', 'bad_state'].includes(caught.code)) held.refresh();
      throw caught;
    }
  });
  const carryOnImport = (target: GuidedImport) => void run(async () => { put(await api.commit(target.id)); });
  const readFile = (target: GuidedImport) => void run(async () => {
    try {
      onView(await api.finish(target.id));
    } catch (caught) {
      if (!(caught instanceof ApiError) || !REJECTION_CODES.includes(caught.code)) throw caught;
      onRejected(target.id, caught.code);
      onView(await api.get(target.id));
    }
  });

  const library = () => archive.goView('all');

  /* Which view ----------------------------------------------------------------------------------------------- */

  const guideFor = (platform: string): Guide | undefined => (guides.status === 'ready' ? guides.guides.find(entry => entry.id === platform) : undefined);
  const limits = guides.status === 'ready' ? (guides.guides[0]?.upload ?? DEFAULT_LIMITS) : DEFAULT_LIMITS;
  const step = stepOf(route, view);

  const guidesWaiting = (): [string, ReactNode] | null => {
    if (guides.status === 'loading') return ['loading', <Waiting key="w">Asking your server for the guides…</Waiting>];
    if (guides.status === 'error') {
      return ['guides-error', (
        <StateCard key="g" art="cloud" title="The guides did not load" actions={<Button variant="primary" onClick={retryGuides}><RotateCw />Try again</Button>}>
          {guides.message}
        </StateCard>
      )];
    }
    return null;
  };

  const choose = (choice: Choice) => go(`${choice}/add`);

  const first = (): [string, ReactNode] => guidesWaiting() ?? ['choose', (
    <ChooseView
      guides={guides.status === 'ready' ? guides.guides : []}
      imports={list.imports}
      importsError={list.error}
      onGuide={platform => go(platform)}
      onAdd={choose}
      onOpen={target => go(target)}
      onCancel={target => void cancel(target)}
    />
  )];

  const pick = (): [string, ReactNode] => {
    if (route.kind === 'choose') return first();
    if (route.kind === 'guide') {
      const guide = guideFor(route.platform);
      return guidesWaiting() ?? (guide ? ['guide', <GuideView guide={guide} onBack={() => go('')} onAdd={() => choose(route.platform)} />] : first());
    }
    if (route.kind === 'add') {
      const guide = route.platform === 'auto' ? undefined : guideFor(route.platform);
      return guidesWaiting() ?? ['add', (
        <AddView
          key={route.platform}
          choice={route.platform}
          guide={guide}
          limits={guide?.upload ?? limits}
          imports={list.imports}
          state={upload.state}
          onBack={() => (route.platform === 'auto' ? go('') : go(route.platform))}
          onSend={(file, account, resume) => {
            if (resume) { put(resume); archive.goScreen('guided-import', resume.id, { replace: true }); void upload.resume(resume, file); return; }
            void upload.begin(file, { platform: route.platform, sourceAccount: account });
          }}
        />
      )];
    }

    // One import, whatever stage it is at.
    if (held.loading) return ['loading', <Waiting key="w">Opening your import…</Waiting>];
    if (held.gone) {
      return ['gone', (
        <StateCard key="x" art="archive" title="That import is not here" actions={<Button variant="primary" onClick={() => go('')}><ArrowLeft />Back to the start</Button>}>
          This library has no import with that address. Unfinished imports are cleared after a few days.
        </StateCard>
      )];
    }
    if (!view) {
      return ['load-error', (
        <StateCard key="e" art="cloud" title="This import did not load" actions={<Button variant="primary" onClick={held.refresh}><RotateCw />Try again</Button>}>
          {held.error || 'Your server did not answer.'}
        </StateCard>
      )];
    }
    if (upload.state.importId === view.id && upload.state.phase !== 'idle') {
      return ['sending', (
        <SendingView
          state={upload.state}
          onContinue={() => void upload.carryOn(view.id)}
          onCancel={() => void cancel(view)}
        />
      )];
    }
    const next = nextFor(view);
    switch (next.kind) {
      case 'send':
        return ['resume', <ResumeView view={view} accept={limits.accepts.join(',')} onFile={file => void upload.resume(view, file)} onCancel={() => void cancel(view)} />];
      case 'read':
        return ['read', <ReadView view={view} busy={busy} onRead={() => readFile(view)} onCancel={() => void cancel(view)} />];
      case 'review':
        return view.preview
          ? ['review', <PreviewView view={view} busy={busy} onCommit={() => commit(view)} onCancel={() => void cancel(view)} />]
          : ['loading', <Waiting key="w">Opening the preview…</Waiting>];
      case 'watch':
        return ['watch', <ImportingView view={view} slow={held.slow} busy={busy} onNudge={() => carryOnImport(view)} onCancel={() => void cancel(view)} onLibrary={library} />];
      case 'continue':
        return ['continue', <FailedView view={view} busy={busy} onContinue={() => carryOnImport(view)} onCancel={() => void cancel(view)} />];
      case 'done':
        return ['done', <DoneView view={view} notes={notes && notes.run === view.run_id ? notes.lines : []} onLibrary={library} onOrganize={() => openDialog({ kind: 'organize' })} onAnother={() => go('')} />];
      case 'again':
        return [`again-${next.why}`, <AgainView view={view} code={rejections[view.id]} onAdd={choose} onChoose={() => go('')} />];
    }
  };

  const [panel, content] = pick();
  useStepFocus(panel);

  return (
    <div data-seam="guided-import" data-panel={panel} className="mx-auto max-w-4xl pb-10">
      <FeatureHeader
        whisper="guided import"
        title="Bring your whole backlog home."
        lede={route.kind === 'choose' ? 'Instagram and TikTok will each send you a file of everything you saved. Little Archive reads it, shows you what it found, and only then saves it.' : undefined}
      />
      <Rail current={step.current} done={step.done} />
      <p role="status" className="sr-only">{step.done ? 'The import is finished.' : `Step ${step.current + 1} of ${STEPS.length}: ${STEPS[step.current]?.title}.`}</p>
      <div key={panel}>{content}</div>
    </div>
  );
}

export default function GuidedImportScreen(props: FeatureScreenProps) {
  return (
    <FeatureGate feature="guided_import">
      <Flow {...props} />
    </FeatureGate>
  );
}
