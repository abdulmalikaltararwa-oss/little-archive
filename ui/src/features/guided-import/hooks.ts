// The React side of the guided import: the guides, the list of earlier imports, one import being watched, and
// the upload. Each follows the pattern of the activity dialog: a question is asked in an effect, its answer is
// set from the promise (never from the effect's own body), and an answer to a question that has since changed
// is dropped. The import's state lives on the server; what is held here is only the latest thing it said.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { errorMessage } from '@web/utils.js';
import { toast } from '@/app/ui-state';
import { ApiError } from '@/data/client';
import type { Guide, GuidedApi, GuidedImport, Preview } from './api';
import { expandRanges, missingPieces } from './chunks';
import { describeFileName, type Choice } from './flow';
import { IDLE, isBusy, uploadReducer } from './upload-state';
import { CONCURRENCY, isAbort, readPiece, retrying, RETRIES, sendPieces, type ReadPiece } from './upload';
import { explainError, REJECTION_CODES } from './words';

/** A running import is asked about this often. */
export const POLL_MS = 1000;
/** After this many answers in a row with no progress, it is called slow (about fifteen seconds). */
export const STALLED_AFTER = 15;

/* The guides -------------------------------------------------------------------------------------------- */

export type GuidesState = { status: 'loading' } | { status: 'ready'; guides: Guide[] } | { status: 'error'; message: string };

export function useGuides(api: GuidedApi) {
  const [state, setState] = useState<GuidesState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api.guides(controller.signal).then(
      result => { if (!controller.signal.aborted) setState({ status: 'ready', guides: result.platforms }); },
      error => { if (!controller.signal.aborted) setState({ status: 'error', message: errorMessage(error) }); },
    );
    return () => controller.abort();
  }, [api, attempt]);
  const retry = useCallback(() => { setState({ status: 'loading' }); setAttempt(value => value + 1); }, []);
  return [state, retry] as const;
}

/* Earlier imports -------------------------------------------------------------------------------------------- */

export function useImportList(api: GuidedApi) {
  const [state, setState] = useState<{ imports: GuidedImport[] | null; error: string }>({ imports: null, error: '' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api.list(20, controller.signal).then(
      result => { if (!controller.signal.aborted) setState({ imports: result.imports, error: '' }); },
      error => { if (!controller.signal.aborted) setState(previous => ({ imports: previous.imports, error: errorMessage(error) })); },
    );
    return () => controller.abort();
  }, [api, tick]);
  const refresh = useCallback(() => setTick(value => value + 1), []);
  return { imports: state.imports, error: state.error, refresh };
}

/* One import -------------------------------------------------------------------------------------------------- */

interface Held {
  id: string;
  view: GuidedImport | null;
  error: string;
  gone: boolean;
  /** How many answers in a row said the same number processed while it was importing. */
  same: number;
}

/**
 * Watches one import. While it is importing it is asked about once a second (asking is also what keeps a job
 * that a restart interrupted going); otherwise it is asked about once, and `put` takes the answer of any
 * action. An older answer never replaces a newer one, and `onCompleted` is called once, when this page sees
 * an import finish.
 */
export function useImportView(api: GuidedApi, id: string | null, onCompleted: (view: GuidedImport) => void) {
  const [held, setHeld] = useState<Held | null>(null);
  const [tick, setTick] = useState(0);
  const lastState = useRef(new Map<string, string>());

  const accept = useCallback((view: GuidedImport) => {
    const before = lastState.current.get(view.id);
    lastState.current.set(view.id, view.state);
    setHeld(previous => {
      const current = previous?.id === view.id ? previous.view : null;
      if (current && current.updated_at > view.updated_at) return previous;
      const same = current && view.state === 'importing' && current.progress.processed === view.progress.processed ? (previous?.same ?? 0) + 1 : 0;
      return { id: view.id, view, error: '', gone: false, same };
    });
    // Seen finishing in this page: from importing, or from previewed when the job was over before the first answer. A completed import that is merely opened is not news.
    if (before && before !== 'completed' && view.state === 'completed') onCompleted(view);
  }, [onCompleted]);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    api.get(id, controller.signal).then(
      view => {
        if (controller.signal.aborted) return;
        accept(view);
        if (view.state === 'importing') timer = setTimeout(() => setTick(value => value + 1), POLL_MS);
      },
      error => {
        if (controller.signal.aborted) return;
        const gone = error instanceof ApiError && error.status === 404;
        setHeld(previous => ({ id, view: previous?.id === id ? previous.view : null, error: errorMessage(error), gone, same: 0 }));
        // A running import is not given up on because one answer was lost.
        if (!gone && lastState.current.get(id) === 'importing') timer = setTimeout(() => setTick(value => value + 1), 3 * POLL_MS);
      },
    );
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, id, tick, accept]);

  const put = useCallback((view: GuidedImport) => {
    accept(view);
    if (view.state === 'importing') setTick(value => value + 1);
  }, [accept]);
  const refresh = useCallback(() => setTick(value => value + 1), []);
  /** The preview, fetched on its own, for a previewed import whose answer did not carry it. */
  const attachPreview = useCallback((importId: string, preview: Preview) => {
    setHeld(previous => (previous?.id === importId && previous.view ? { ...previous, view: { ...previous.view, preview } } : previous));
  }, []);

  const current = id && held?.id === id ? held : null;
  return {
    view: current?.view ?? null,
    error: current?.error ?? '',
    gone: current?.gone ?? false,
    loading: id !== null && current === null,
    slow: (current?.same ?? 0) >= STALLED_AFTER,
    put,
    refresh,
    attachPreview,
  };
}

/* The upload ---------------------------------------------------------------------------------------------------- */

export interface StartRequest { platform: Choice; sourceAccount: string }

/**
 * Sends a file to the server in pieces and then asks it to read the file. Every stop (a lost connection, a piece
 * the server refuses, the person leaving) keeps what already arrived on the server, and carrying on asks the
 * server what it holds and sends only the rest. Leaving the screen stops the sending; it never discards it.
 */
export function useUpload({ api, concurrency = CONCURRENCY, onCreated, onView, onRejected }: {
  api: GuidedApi;
  concurrency?: number;
  /** The import was just made, and pieces are about to go out. */
  onCreated(view: GuidedImport): void;
  /** Every later answer about the import: the read file, a refreshed state. */
  onView(view: GuidedImport): void;
  /** The file was read and cannot be used. */
  onRejected(id: string, code: string): void;
}) {
  const [state, dispatch] = useReducer(uploadReducer, IDLE);
  const control = useRef<AbortController | null>(null);
  const source = useRef<File | null>(null);
  const alive = useRef(true);

  const drive = useCallback(async (view: GuidedImport, file: File | null) => {
    const controller = new AbortController();
    control.current = controller;
    const { signal } = controller;
    const { chunk_size: chunkSize, chunks_total: total } = view.upload;
    try {
      dispatch({ type: 'sending', id: view.id, fileName: view.filename, size: view.size_bytes, chunkSize, total, received: expandRanges(view.upload.received, total), at: Date.now() });
      const missing = missingPieces(total, view.upload.received);
      if (missing.length && !file) throw new Error('Choose the file again to send the rest of it.');
      if (missing.length && file) {
        await sendPieces<ReadPiece>({
          missing,
          signal,
          concurrency,
          read: index => readPiece(file, index, chunkSize),
          send: (index, piece, inner) => api.putChunk(view.id, index, piece.body, { sha256: piece.sha256, signal: inner }),
          onStart: index => dispatch({ type: 'piece-started', index }),
          onPiece: index => dispatch({ type: 'piece-done', index, at: Date.now() }),
          onRetry: () => dispatch({ type: 'retry' }),
        });
      }
      dispatch({ type: 'finishing' });
      const read = await retrying(() => api.finish(view.id, signal), { retries: RETRIES, signal });
      onView(read);
      dispatch({ type: 'reset' });
    } catch (error) {
      if (isAbort(error)) { dispatch({ type: 'stopped', error: null }); return; }
      if (error instanceof ApiError && REJECTION_CODES.includes(error.code)) {
        // The file arrived and was read, and cannot be used. The import is now `rejected`; ask for it as it stands.
        onRejected(view.id, error.code);
        try { onView(await api.get(view.id)); } catch { /* The import's own view asks again. */ }
        dispatch({ type: 'reset' });
        return;
      }
      dispatch({ type: 'stopped', error: explainError(error) });
    } finally {
      if (control.current === controller) control.current = null;
    }
  }, [api, concurrency, onView, onRejected]);

  /** Makes the import, then sends the file. */
  const begin = useCallback(async (file: File, request: StartRequest) => {
    source.current = file;
    dispatch({ type: 'creating', fileName: file.name, size: file.size });
    let view: GuidedImport;
    try {
      view = await api.start({
        platform: request.platform,
        filename: describeFileName(file.name),
        size_bytes: file.size,
        ...(request.sourceAccount ? { source_account: request.sourceAccount } : {}),
      });
    } catch (error) {
      dispatch({ type: 'stopped', error: explainError(error) });
      return;
    }
    // Left the screen while it was being made: the import waits on the server, listed with the unfinished ones.
    if (!alive.current) return;
    onCreated(view);
    await drive(view, file);
  }, [api, drive, onCreated]);

  /** Sends the rest of an upload that was begun earlier, from the file handed over again. */
  const resume = useCallback(async (view: GuidedImport, file: File | null) => {
    source.current = file ?? source.current;
    await drive(view, source.current);
  }, [drive]);

  /** After a stop: ask what the server holds now, and carry on from there. */
  const carryOn = useCallback(async (id: string) => {
    try {
      const view = await api.get(id);
      onView(view);
      if (view.state === 'uploading') await drive(view, source.current);
      else dispatch({ type: 'reset' });
    } catch (error) {
      dispatch({ type: 'stopped', error: explainError(error) });
    }
  }, [api, drive, onView]);

  const halt = useCallback(() => {
    const running = control.current;
    if (running) running.abort();
    return Boolean(running);
  }, []);
  const clear = useCallback(() => dispatch({ type: 'reset' }), []);

  // Leaving the screen stops the sending and says so. Nothing is thrown away: the pieces that arrived stay on
  // the server, and the earlier-imports list offers to carry on.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (halt()) toast('Upload paused. What already arrived is kept: add the same file again to carry on.');
    };
  }, [halt]);

  return { state, busy: isBusy(state), begin, resume, carryOn, halt, clear };
}
