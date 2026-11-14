// The questions asked on this visit, kept in memory and nowhere else. They live outside the screen on
// purpose: opening a save from an answer leaves this screen, and Back should bring the answer you were reading
// to the same place, not an empty page. Nothing is written to storage, and signing out forgets everything.
import { errorMessage } from '@web/utils.js';
import type { Archive } from '@/data/archive';
import { ApiError, isLocked } from '@/data/client';
import { askArchive } from './api';
import { checkQuestion, EMPTY_SESSION, filterBody, NO_FILTERS, sessionReducer, type Entry, type Session, type SessionAction } from './logic';

export interface AskSession {
  getState(): Session;
  subscribe(listener: () => void): () => void;
  dispatch(action: SessionAction): void;
  /** Sends the question in the form, if it may be sent. Returns whether it was. */
  submit(): boolean;
  /** Asks a failed or finished question again. */
  retry(id: string): void;
  /** Stops the question that is waiting. */
  stop(): void;
  /** Forgets every question, answer and draft. */
  reset(): void;
  /** The save that was opened from an answer, so focus can go back to its card when the screen returns. */
  markOpened(id: string): void;
  takeOpened(): string;
}

let counter = 0;

export function createAskSession(archive: Pick<Archive, 'api'>): AskSession {
  let state: Session = EMPTY_SESSION;
  let controller: AbortController | null = null;
  let opened = '';
  const listeners = new Set<() => void>();

  const apply = (action: SessionAction) => {
    const next = sessionReducer(state, action);
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };

  const cancelWaiting = (except = '') => {
    for (const entry of state.entries) if (entry.id !== except && entry.state.status === 'pending') apply({ type: 'cancelled', id: entry.id });
  };

  /** Sends one entry's question. A newer question always replaces an older one still on its way. */
  const send = (entry: Entry) => {
    controller?.abort();
    cancelWaiting(entry.id);
    const mine = new AbortController();
    controller = mine;
    askArchive(archive.api, { question: entry.question, ...filterBody(entry.filters) }, mine.signal).then(
      response => { if (!mine.signal.aborted) apply({ type: 'answered', id: entry.id, response }); },
      (error: unknown) => {
        if (mine.signal.aborted) return;
        if (isLocked(error)) apply({ type: 'locked', id: entry.id });
        else apply({ type: 'failed', id: entry.id, message: errorMessage(error), httpStatus: error instanceof ApiError ? error.status : 0 });
      },
    );
  };

  const stop = () => {
    controller?.abort();
    controller = null;
    cancelWaiting();
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispatch: apply,
    submit() {
      const check = checkQuestion(state.draft);
      if (!check.ok) return false;
      const entry: Entry = { id: `ask-${++counter}`, question: check.question, filters: state.filters, state: { status: 'pending' } };
      apply({ type: 'asked', entry });
      send(entry);
      return true;
    },
    retry(id) {
      const entry = state.entries.find(old => old.id === id);
      if (!entry || (entry.state.status !== 'error' && entry.state.status !== 'done')) return;
      apply({ type: 'restarted', id });
      send(entry);
    },
    stop,
    reset() {
      stop();
      apply({ type: 'cleared' });
      apply({ type: 'drafted', text: '' });
      apply({ type: 'narrowed', filters: NO_FILTERS });
      opened = '';
    },
    markOpened(id) { opened = id; },
    takeOpened() {
      const id = opened;
      opened = '';
      return id;
    },
  };
}

const sessions = new WeakMap<object, AskSession>();

const ON_ASK = /^#\/ask(?:[/?]|$)/;

/**
 * Closing a save that was opened from this screen should land back here. When the browser can animate the
 * move, the library's own "close" is re-applied a frame after the address has already gone back to #/ask, and
 * it wins: the address says Ask while the library is drawn (the deferred `apply` in applyLoc, data/archive.ts;
 * see the report). That state contradicts itself, so it is mended here by moving the screen to where the
 * address says. Once applyLoc ignores a stale apply this never triggers.
 */
function mend(archive: Archive) {
  const { loc, phase } = archive.store.getState();
  if (phase !== 'ready' || loc.screen !== 'library' || loc.item || !ON_ASK.test(location.hash)) return;
  archive.navigate({ screen: 'library' }, { replace: true });
  archive.goScreen('ask', '', { replace: true });
}

/** Opens a save from an answer, remembering which one so that coming back puts the cursor on its card. */
export function openSave(archive: Archive, id: string): Promise<boolean> {
  askSessionFor(archive).markOpened(id);
  return archive.openItem(id);
}

/** The one session for this library. A different library (another sign-in) never sees this one's questions. */
export function askSessionFor(archive: Archive): AskSession {
  let session = sessions.get(archive);
  if (!session) {
    const created = createAskSession(archive);
    session = created;
    archive.store.subscribe(next => {
      // Leaving the library (signing out, a session that ended) forgets what was asked and what was answered.
      if (next.phase !== 'ready') created.reset();
      else if (next.loc.screen === 'library' && !next.loc.item && ON_ASK.test(location.hash)) setTimeout(() => mend(archive), 0);
    });
    sessions.set(archive, session);
  }
  return session;
}
