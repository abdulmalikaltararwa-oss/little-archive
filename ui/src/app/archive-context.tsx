import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { errorMessage } from '@web/utils.js';
import { useStore } from 'zustand';
import type { Archive, ArchiveState } from '@/data/archive';
import { toast } from './ui-state';

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
      toast(errorMessage(error), { error: true });
      return undefined;
    } finally {
      running.current = false;
      setPending(false);
    }
  }, []);
  return [pending, run] as const;
}
