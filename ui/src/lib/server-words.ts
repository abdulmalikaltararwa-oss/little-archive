// "Your server" is true only where the person runs the server. On a hosted account the operator runs it
// (docs/hosted-mode.md), so the same sentences say "the service". The same switch as keptLine in
// features/library/words.ts.
import type { ServerMode } from '@/data/backend';

/** Rewrites "your server", "your own server" and "Your server" for a hosted account; leaves a self-hosted sentence as it is. */
export function serverWords(text: string, mode: ServerMode | undefined): string {
  if (mode !== 'hosted') return text;
  return text.replace(/\bYour (?:own )?server\b/g, 'The service').replace(/\byour (?:own )?server\b/g, 'the service');
}
