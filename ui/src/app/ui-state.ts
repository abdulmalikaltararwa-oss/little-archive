// Interface state that is not the library: which dialogs are open, what the island is saying, and the one
// question waiting for a yes or no. Kept apart from src/data so the data layer stays free of presentation.
import { create } from 'zustand';
import type { Collection, SharedLink } from '@/data/types';

/* The island ------------------------------------------------------------------------------------------- */

export type IslandTone = 'ok' | 'error' | 'saved';

export interface IslandMessage {
  id: number;
  text: string;
  tone: IslandTone;
}

interface IslandState {
  messages: IslandMessage[];
  push(text: string, tone: IslandTone): number;
  dismiss(id: number): void;
}

let messageSeq = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export const useIsland = create<IslandState>((set, get) => ({
  messages: [],
  push(text, tone) {
    const id = ++messageSeq;
    // The island holds one thought at a time, plus any errors still waiting to be read.
    set(state => ({ messages: [...state.messages.filter(message => message.tone === 'error'), { id, text, tone }].slice(-3) }));
    timers.set(id, setTimeout(() => get().dismiss(id), tone === 'error' ? 10_000 : tone === 'saved' ? 4_200 : 5_000));
    return id;
  },
  dismiss(id) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    set(state => ({ messages: state.messages.filter(message => message.id !== id) }));
  },
}));

/** Short feedback for something that just happened. Errors stay twice as long and are announced assertively. */
export function toast(text: string, options: { error?: boolean; tone?: IslandTone } = {}) {
  return useIsland.getState().push(text, options.tone ?? (options.error ? 'error' : 'ok'));
}

/* Dialogs ---------------------------------------------------------------------------------------------- */

export type DialogSpec =
  | { kind: 'save-link'; share?: SharedLink | null }
  | { kind: 'collection'; collection?: Collection | null }
  | { kind: 'bulk'; action: 'tag' | 'collection'; ids: string[] }
  | { kind: 'organize' }
  | { kind: 'import' }
  | { kind: 'activity'; tab?: 'imports' | 'ai' }
  | { kind: 'settings'; section?: 'connections' | '' }
  | { kind: 'delete-account' }
  | { kind: 'copy-text'; text: string }
  | { kind: 'browse' }
  | { kind: 'palette' };

/** `open` turns false a moment before the entry is removed, so the dialog can leave gracefully. */
export type OpenDialog = DialogSpec & { id: number; opener: Element | null; open: boolean };

export const DIALOG_EXIT_MS = 220;

interface DialogState {
  stack: OpenDialog[];
  open(spec: DialogSpec): number;
  close(id: number): void;
  closeAll(): void;
}

let dialogSeq = 0;

export const useDialogs = create<DialogState>(set => ({
  stack: [],
  open(spec) {
    const id = ++dialogSeq;
    const opener = typeof document === 'undefined' ? null : document.activeElement;
    set(state => ({
      // One of a kind at a time: asking for an open dialog again brings a fresh one instead of stacking two.
      stack: [...state.stack.filter(entry => entry.kind !== spec.kind), { ...spec, id, opener, open: true }],
    }));
    return id;
  },
  close(id) {
    set(state => ({ stack: state.stack.map(entry => (entry.id === id ? { ...entry, open: false } : entry)) }));
    setTimeout(() => set(state => ({ stack: state.stack.filter(entry => entry.id !== id) })), DIALOG_EXIT_MS);
  },
  closeAll: () => set({ stack: [] }),
}));

export const openDialog = (spec: DialogSpec) => useDialogs.getState().open(spec);

/* Confirmation ----------------------------------------------------------------------------------------- */

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** Runs while the confirm button shows progress. If it throws, the question stays open and the error is shown. */
  action?: () => Promise<unknown> | unknown;
}

interface ConfirmState {
  request: (ConfirmRequest & { resolve: (value: boolean) => void; opener: Element | null }) | null;
  ask(request: ConfirmRequest): Promise<boolean>;
  settle(value: boolean): void;
}

export const useConfirm = create<ConfirmState>((set, get) => ({
  request: null,
  ask(request) {
    get().request?.resolve(false);
    return new Promise<boolean>(resolve => {
      set({ request: { ...request, resolve, opener: typeof document === 'undefined' ? null : document.activeElement } });
    });
  },
  settle(value) {
    const pending = get().request;
    if (!pending) return;
    set({ request: null });
    pending.resolve(value);
  },
}));

/** Asks one yes/no question in the app's own dialog and resolves with the answer. */
export const confirm = (request: ConfirmRequest) => useConfirm.getState().ask(request);

export const confirmDiscard = () =>
  confirm({ title: 'Discard your unsaved changes?', message: 'The edits you made to this save have not been kept yet.', confirmLabel: 'Discard changes', cancelLabel: 'Keep editing', danger: true });
