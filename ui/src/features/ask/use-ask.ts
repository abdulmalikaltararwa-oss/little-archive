// Reads one slice of the visit's questions from the session, which lives outside React (see session.ts).
import { useSyncExternalStore } from 'react';
import type { Session } from './logic';
import type { AskSession } from './session';

/** The selector must return something stable for an unchanged session (a field, not a new object). */
export function useAskState<T>(session: AskSession, select: (state: Session) => T): T {
  return useSyncExternalStore(session.subscribe, () => select(session.getState()));
}
