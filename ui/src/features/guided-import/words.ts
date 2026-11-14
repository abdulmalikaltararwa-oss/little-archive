// The words this screen uses for what the machine says: sizes and times, why a file was refused, what each
// kind of unreadable entry means, what a state is called. The server's `detail` is English and written for a
// person, but it is one sentence; these say what happened, what it means for the file and what to do next.
// A code the server sends that is not here falls back to the server's own sentence, never to a guess.
import { ApiError } from '@/data/client';
import type { ImportState, UnreadableReason } from './api';

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

/** 1536 -> "1.5 KiB". Binary units, because the server's limits are written that way (512 MiB). */
export function formatBytes(bytes: number): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  let unit = 0;
  let scaled = value;
  while (scaled >= 1024 && unit < UNITS.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(scaled).toLocaleString()} B`;
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toLocaleString(undefined, { maximumFractionDigits: digits })} ${UNITS[unit]}`;
}

/** 3.14 MiB per second, as "3.1 MiB/s". */
export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** A clock-like length for the mono voice: 42s, 1m 05s, 2h 07m. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${pad(Math.floor((seconds % 3600) / 60))}m`;
}

/** What is left, in words and always as an estimate. Null when there is nothing to base one on. */
export function formatRemaining(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 5) return 'a few seconds left';
  if (seconds < 45) return `about ${Math.round(seconds / 5) * 5} seconds left`;
  if (seconds < 90) return 'about a minute left';
  if (seconds < 3600) return `about ${Math.round(seconds / 60)} minutes left`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return `about ${hours} hr${minutes ? ` ${minutes} min` : ''} left`;
}

/* Why something was refused ----------------------------------------------------------------------------- */

export interface Explanation {
  /** A few words: what happened. */
  title: string;
  /** What it means for the file. */
  what: string;
  /** What to do now. */
  next: string;
}

const REJECTIONS: Record<string, Explanation> = {
  checksum_mismatch: {
    title: 'The file arrived damaged',
    what: 'What reached your server does not match the file you chose, so it was thrown away rather than read.',
    next: 'Add the file again. If it happens twice, download a fresh copy of the export first.',
  },
  not_a_zip: {
    title: 'That is not a valid ZIP file',
    what: 'The file reached your server, but it is not a ZIP archive. It may have been unpacked, renamed or cut short while it downloaded.',
    next: 'Add it exactly as Instagram or TikTok gave it to you, still zipped.',
  },
  wrong_platform: {
    title: 'That looks like the other platform’s export',
    what: 'The file looks like it came from a different platform from the one you chose, so nothing was read.',
    next: 'Go back and choose the other platform, or add the right file.',
  },
  ambiguous_platform: {
    title: 'It is not clear which platform this is',
    what: 'This archive holds both Instagram and TikTok data, so there is no telling which one you meant.',
    next: 'Choose one platform and add the file again.',
  },
  no_saved_data: {
    title: 'No saved posts were found inside',
    what: 'We opened the file and looked, and found no saved posts or favorite videos in it. The rest of an export (messages, likes, history) is never read.',
    next: 'Check that you asked the platform for your saved data (the steps show where), then add the file exactly as it was sent.',
  },
  unsafe_archive: {
    title: 'The archive was not safe to read',
    what: 'It holds something we never open: an unsafe file path, a link to another place, a password lock, or data packed far tighter than normal. Nothing was read or saved.',
    next: 'Request a fresh export from the platform and add that, unchanged.',
  },
  too_large: {
    title: 'A file inside is too big to read',
    what: 'One of the saved-data files in this archive is larger than this server reads.',
    next: 'Request the export again with only your saved data selected. TikTok can also send the text format, which is smaller.',
  },
  too_many_files: {
    title: 'The archive holds too many files',
    what: 'It has more files in it than this server will go through.',
    next: 'Request the export again with only your saved data selected.',
  },
  too_many_records: {
    title: 'Too many saves for one go',
    what: 'The export lists more saves than this server imports at once.',
    next: 'If the platform lets you, request a shorter date range and add the parts one after the other.',
  },
  unreadable: {
    title: 'The file could not be read',
    what: 'It is damaged, or its text is in a form we cannot open.',
    next: 'Download the export again and add the new copy.',
  },
  unrecognised: {
    title: 'That is not part of a supported export',
    what: 'This kind of file, or this layout, is not one we read.',
    next: 'Add the whole ZIP you were sent, or the saved-posts file from inside it.',
  },
  invalid_platform: {
    title: 'Choose a platform first',
    what: 'The file has to be read as an Instagram or a TikTok export.',
    next: 'Choose which one it came from and add it again.',
  },
};

/** The codes that finish an import as `rejected`: the file was read and cannot be used. */
export const REJECTION_CODES: readonly string[] = Object.keys(REJECTIONS);

const OTHER: Record<string, (extra: Record<string, unknown>) => Explanation> = {
  upload_incomplete: () => ({
    title: 'Some pieces have not arrived',
    what: 'Your server is still missing parts of the file, so it cannot be read yet.',
    next: 'Continue the upload. Only the missing pieces are sent.',
  }),
  file_too_large: extra => ({
    title: 'That file is larger than this server accepts',
    what: typeof extra.max_bytes === 'number' ? `The most this server takes for an import is ${formatBytes(extra.max_bytes)}.` : 'It is over what this server takes for an import.',
    next: 'Request a smaller export (only your saved data, or a shorter date range) and add that.',
  }),
  import_in_progress: extra => ({
    title: 'Another import is still open',
    what: typeof extra.max_active === 'number' ? `This server keeps up to ${extra.max_active} ${extra.max_active === 1 ? 'import' : 'imports'} open at a time, and that is already the case.` : 'This server keeps only a few imports open at a time, and that is already the case.',
    next: 'Continue or cancel one of the earlier imports, then try again.',
  }),
  digest_mismatch: () => ({
    title: 'The preview has changed',
    what: 'What you confirmed is not the preview this import now holds.',
    next: 'Look at the preview again, then press import.',
  }),
  bad_state: () => ({
    title: 'That step is not possible right now',
    what: 'The import is at a different stage from the one this step expects, perhaps because it was changed somewhere else.',
    next: 'Reload the import to see where it stands.',
  }),
  import_not_found: () => ({
    title: 'That import is not here',
    what: 'This library has no import with that address. Unfinished imports are cleared after a few days.',
    next: 'Start a new one.',
  }),
  not_uploading: () => ({
    title: 'This upload is already closed',
    what: 'The import no longer takes pieces. It may have been cancelled, or its file may already have been read.',
    next: 'Reload the import to see where it stands.',
  }),
  no_preview: () => ({
    title: 'There is nothing to review yet',
    what: 'The whole file has to arrive and be read before there is a preview.',
    next: 'Finish the upload first.',
  }),
  bad_chunk_index: () => ({
    title: 'A piece did not fit the file',
    what: 'A piece was numbered outside the file that was announced. This is usually a different file from the one the upload began with.',
    next: 'Add the same file again, or cancel this import and start a new one.',
  }),
  bad_chunk_size: () => ({
    title: 'A piece was the wrong size',
    what: 'The pieces do not match the file that was announced. This is usually a different file from the one the upload began with.',
    next: 'Add the same file again, or cancel this import and start a new one.',
  }),
  chunk_checksum_mismatch: () => ({
    title: 'A piece kept arriving damaged',
    what: 'It was sent again a few times and still did not arrive intact.',
    next: 'Check your connection and continue. Only the missing pieces are sent.',
  }),
};

const NETWORK: Explanation = {
  title: 'The connection was lost',
  what: 'Your server could not be reached. Everything that already arrived is kept.',
  next: 'Check your connection, then continue. Only what is missing is sent again.',
};

/** What happened, what it means and what to do, for any error a call can throw. */
export function explainError(error: unknown): Explanation & { code: string } {
  if (error instanceof ApiError) {
    if (error.status === 0) return { ...NETWORK, code: 'network' };
    const known = REJECTIONS[error.code] ?? OTHER[error.code]?.(error.extra);
    if (known) return { ...known, code: error.code };
    return { title: 'That did not work', what: error.message, next: 'Try again in a moment.', code: error.code };
  }
  const message = error instanceof Error && error.message ? error.message : typeof error === 'string' ? error : 'Something went wrong.';
  return { title: 'That did not work', what: message, next: 'Try again in a moment.', code: '' };
}

/** The reason an import was rejected, from its code if it is known, else from the server's own sentence on the import. */
export function explainRejection(code: string | undefined, serverSentence: string | null): Explanation {
  const known = code ? REJECTIONS[code] : undefined;
  if (known) return known;
  return {
    title: 'This file could not be used',
    what: serverSentence || 'The file was refused.',
    next: 'Check that it is the export for the platform you chose, then add it again. Nothing was saved.',
  };
}

/* What a state is called ---------------------------------------------------------------------------------- */

export const STATE_WORDS: Record<ImportState, { label: string; hint: string }> = {
  uploading: { label: 'Uploading', hint: 'Part of the file is on your server.' },
  previewed: { label: 'Ready to review', hint: 'The file was read. Nothing is saved until you say so.' },
  importing: { label: 'Importing', hint: 'Saving to your library in the background.' },
  completed: { label: 'Imported', hint: 'Everything in it was brought in.' },
  failed: { label: 'Stopped', hint: 'It stopped part way and can pick up where it left off.' },
  cancelled: { label: 'Cancelled', hint: 'Cancelled. Anything already imported was kept.' },
  rejected: { label: 'Could not use', hint: 'The file could not be used. Nothing was saved from it.' },
};

/* What an unreadable entry means --------------------------------------------------------------------------- */

const UNREADABLE: Record<UnreadableReason, string> = {
  no_post_link: 'No link to a post was found in the entry.',
  not_a_post_or_reel_link: 'The link is not to an Instagram post or reel (it may be a profile or a story).',
  no_video_link: 'No video link was found in the entry.',
  not_a_video_link: 'The link is not a TikTok video link.',
  unrecognised_entry: 'The entry’s layout was not recognised.',
  collection_without_name: 'A collection in the file had no name, so it was left out.',
};

/** One plain sentence for an unreadable entry's reason. An unknown reason is shown as the server wrote it. */
export function unreadableWords(reason: string): string {
  return (UNREADABLE as Record<string, string>)[reason] ?? reason.replaceAll('_', ' ');
}

/** The listed unreadable entries (the server lists the first 50) counted by reason, most common first. */
export function groupUnreadable(entries: readonly { reason: string }[]): { reason: string; count: number; words: string }[] {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count, words: unreadableWords(reason) }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/* What an import does and does not establish ------------------------------------------------------------------ */

/** The honest coverage line, in the same spirit as the single-file import's: what the file held, not the whole account. */
export function coverageSentence(platformName: string): string {
  return `Coverage is partial: this is what the ${platformName} file contained, which does not establish your complete history. Nothing was removed from your library, and the titles, notes and tags you wrote were kept.`;
}
