import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { errorMessage } from '@web/utils.js';
import { useStore } from 'zustand';
import type { Archive, ArchiveState } from '@/data/archive';
import { ApiError } from '@/data/client';
import { isRefusal } from '@/features/refusals/refusals';
import { serverWords } from '@/lib/server-words';
import { openDialog, toast } from './ui-state';

const ArchiveContext = createContext<Archive | null>(null);

export function ArchiveProvider({ archive, children }: { archive: Archive; children: ReactNode }) {
  return <ArchiveContext.Provider value={archive}>{children}</ArchiveContext.Provider>;
}

/** The library: its API, its actions and the backend it lives on. */
export function useArchive(): Archive {
  const archive = useContext(ArchiveContext);
  if (!archive) throw new Error('useArchive must be used inside <ArchiveProvider>.');
  return archive;
}

/**
 * Says "the service" where a sentence written for a self-hosted library says "your server", when this is a hosted
 * account. Outside a provider (a component rendered alone) the sentence is left as written.
 */
export function useServerWords(): (text: string) => string {
  const mode = useContext(ArchiveContext)?.backend?.mode;
  return useCallback((text: string) => serverWords(text, mode), [mode]);
}

/** Subscribes to one slice of the library's state. */
export function useArchiveState<T>(selector: (state: ArchiveState) => T): T {
  return useStore(useArchive().store, selector);
}

/**
 * Runs one operation for a button: it cannot be started twice, the button reports progress to assistive
 * technology, and a failure is said out loud instead of disappearing.
 */
export function useBusy() {
  const [pending, setPending] = useState(false);
  const running = useRef(false);
  const run = useCallback(async <T,>(operation: () => Promise<T> | T): Promise<T | undefined> => {
    if (running.current) return undefined;
    running.current = true;
    setPending(true);
    try {
      return await operation();
    } catch (error) {
      // A sign-in that ran out is told on the sign-in screen, calmly, not as an error on top of it.
      if (error instanceof ApiError && error.status === 401) return undefined;
      // "Not now" (an allowance used, the unlock, a busy service) gets its own explanation: what, until when, what to do.
      if (isRefusal(error)) openDialog({ kind: 'refusal', error });
      else toast(errorMessage(error), { error: true });
      return undefined;
    } finally {
      running.current = false;
      setPending(false);
    }
  }, []);
  return [pending, run] as const;
}
