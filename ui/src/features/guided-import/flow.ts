// Where a person is in the guided import, as plain data: the address says which screen, the import's state
// (as the server reports it) says which stage, and `nextFor` says what the one useful thing to do is. The
// server's `state` is the single source of truth; nothing here remembers a stage of its own, so reloading
// the page, or opening the import on another device, lands in the right place.
//
//   #/import/guided                      choose a platform (and any earlier imports)
//   #/import/guided/instagram            how to get Instagram's export
//   #/import/guided/instagram/add        hand the file over (also: tiktok, or auto to let the server decide)
//   #/import/guided/<import id>          one import, whatever stage it is at
import type { GuidedImport, PlatformId } from './api';
import { formatBytes } from './words';

export type Choice = PlatformId | 'auto';

export type Route =
  | { kind: 'choose' }
  | { kind: 'guide'; platform: PlatformId }
  | { kind: 'add'; platform: Choice }
  | { kind: 'import'; id: string };

const PLATFORMS: readonly string[] = ['instagram', 'tiktok'];
const ID = /^[A-Za-z0-9_-]{1,80}$/;

/** Reads the part of the address after `#/import/guided/`. Anything unrecognised is the first screen. */
export function parseRoute(rest: string): Route {
  const [first = '', second = '', ...more] = rest.split('/');
  if (!first || more.length) return { kind: 'choose' };
  if (PLATFORMS.includes(first)) {
    if (!second) return { kind: 'guide', platform: first as PlatformId };
    return second === 'add' ? { kind: 'add', platform: first as PlatformId } : { kind: 'choose' };
  }
  if (first === 'auto') return second === 'add' ? { kind: 'add', platform: 'auto' } : { kind: 'choose' };
  if (!second && ID.test(first)) return { kind: 'import', id: first };
  return { kind: 'choose' };
}

/** The address part for a route: the inverse of parseRoute. */
export function routeRest(route: Route): string {
  switch (route.kind) {
    case 'choose': return '';
    case 'guide': return route.platform;
    case 'add': return `${route.platform}/add`;
    case 'import': return route.id;
  }
}

/* The five stages --------------------------------------------------------------------------------------- */

export const STEPS = [
  { id: 'choose', label: 'Choose', title: 'Choose where your saves are' },
  { id: 'export', label: 'Get the file', title: 'Get your export' },
  { id: 'upload', label: 'Hand it over', title: 'Hand the file over' },
  { id: 'preview', label: 'Look it over', title: 'Look it over' },
  { id: 'import', label: 'Bring it in', title: 'Bring it in' },
] as const;

export type StepId = (typeof STEPS)[number]['id'];

/** Which of the five stages is current (0 to 4), and whether the last one has been finished. */
export function stepOf(route: Route, view: GuidedImport | null): { current: number; done: boolean } {
  if (route.kind === 'choose') return { current: 0, done: false };
  if (route.kind === 'guide') return { current: 1, done: false };
  if (route.kind === 'add') return { current: 2, done: false };
  switch (view?.state) {
    case 'previewed': return { current: 3, done: false };
    case 'importing':
    case 'failed': return { current: 4, done: false };
    case 'completed': return { current: 4, done: true };
    // Uploading, and also what is waiting for a fresh file: a rejected or cancelled import is back at the handing over.
    default: return { current: 2, done: false };
  }
}

/** The one useful thing to do with an import, from its state alone. */
export type Next =
  | { kind: 'send'; missing: number; total: number }
  | { kind: 'read' }
  | { kind: 'review' }
  | { kind: 'watch' }
  | { kind: 'continue' }
  | { kind: 'done' }
  | { kind: 'again'; why: 'rejected' | 'cancelled' };

export function nextFor(view: GuidedImport): Next {
  switch (view.state) {
    case 'uploading':
      // Every piece is there but the file was never read (the connection dropped as it was being finished).
      if (view.upload.complete) return { kind: 'read' };
      return { kind: 'send', missing: Math.max(0, view.upload.chunks_total - view.upload.received_count), total: view.upload.chunks_total };
    case 'previewed': return { kind: 'review' };
    case 'importing': return { kind: 'watch' };
    case 'failed': return { kind: 'continue' };
    case 'completed': return { kind: 'done' };
    case 'rejected': return { kind: 'again', why: 'rejected' };
    case 'cancelled': return { kind: 'again', why: 'cancelled' };
  }
}

/* The file ------------------------------------------------------------------------------------------------ */

/** The server keeps at most 200 characters of a file name; the end is the part worth keeping (the extension). */
export function describeFileName(name: string): string {
  const trimmed = name.trim() || 'export';
  return trimmed.length > 200 ? trimmed.slice(-200) : trimmed;
}

/** "ZIP, JSON, HTML or TXT" from [".zip", ".json", ".html", ".txt"]. */
export function listAccepts(accepts: readonly string[]): string {
  const names = accepts.map(entry => entry.replace(/^\./, '').toUpperCase());
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

export interface FileProblem { code: 'empty' | 'too_big' | 'type'; words: string }

/** Checks a chosen file against what the guide says the server takes, before anything is sent. */
export function checkFile(file: { name: string; size: number }, upload: { accepts: readonly string[]; max_bytes: number }): FileProblem | null {
  if (file.size < 1) return { code: 'empty', words: 'That file is empty, so there is nothing to read. Add the file exactly as it was sent to you.' };
  if (file.size > upload.max_bytes) {
    return { code: 'too_big', words: `That file is ${formatBytes(file.size)} and this server takes at most ${formatBytes(upload.max_bytes)} for an import. Request a smaller export (only your saved data, or a shorter date range) and add that.` };
  }
  const lower = file.name.toLowerCase();
  if (upload.accepts.length && !upload.accepts.some(extension => lower.endsWith(extension.toLowerCase()))) {
    const dot = lower.lastIndexOf('.');
    return { code: 'type', words: `This server reads ${listAccepts(upload.accepts)} files. “${dot > 0 ? lower.slice(dot) : 'a file with no extension'}” is not one of them. Add the file exactly as Instagram or TikTok gave it to you.` };
  }
  return null;
}

/** An unfinished upload that the same file, handed over again, should carry on instead of starting a second one. */
export function findResumable(imports: readonly GuidedImport[], file: { name: string; size: number }, choice: Choice): GuidedImport | null {
  const name = describeFileName(file.name);
  return imports.find(entry => entry.state === 'uploading' && !entry.upload.complete && entry.size_bytes === file.size && entry.filename === name && entry.platform === choice) ?? null;
}

/** Whether a file can carry on this upload. The size has to match exactly: pieces of another file would be refused or, worse, joined in. */
export function canResumeWith(view: Pick<GuidedImport, 'size_bytes' | 'filename'>, file: { size: number }): { ok: true } | { ok: false; words: string } {
  if (file.size === view.size_bytes) return { ok: true };
  return { ok: false, words: `That file is ${formatBytes(file.size)}, but this upload began with “${view.filename}” at ${formatBytes(view.size_bytes)}. Add the same file to carry on, or cancel this import and start a new one.` };
}
