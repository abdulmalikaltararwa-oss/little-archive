import type { BackendKind, ServerMode } from '@/data/backend';

/**
 * The reassurance under the library. It says only what is true of where the library is kept. On a hosted
 * account the operator runs the server and can read it (docs/hosted-mode.md), so it is the person's account,
 * not their server, and it is not called private. The demo has no server and no account at all.
 */
export function keptLine(kind: BackendKind, mode: ServerMode): string {
  if (kind === 'demo') return 'A demo collection, to look around in.';
  return mode === 'hosted'
    ? 'Your collection. Your account. A little more peace of mind.'
    : 'Your collection. Your server. A little more peace of mind.';
}
