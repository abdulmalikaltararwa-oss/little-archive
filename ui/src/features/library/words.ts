import type { BackendKind, ServerMode } from '@/data/backend';
import type { Item, Sort } from '@/data/types';

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

/**
 * Whether the wall has truly ended: every save of this view is on it and nothing more is on its way. A shuffled
 * sample is a draw, not a list with an end, so it never ends.
 */
export function wallEnded({ list, count, total, loadingMore, sort }: { list: 'loading' | 'ready' | 'error'; count: number; total: number; loadingMore: boolean; sort: Sort }): boolean {
  return list === 'ready' && count > 0 && count >= total && !loadingMore && sort !== 'random';
}

/**
 * The month of the oldest save, for the line at the end of the wall, or null when the saves cannot establish it.
 * `saved_at` is the date the source gave for a save, and a save made without one has none; a single undated save
 * could be the oldest, so every save must carry a date. Pass the whole library, not one view of it.
 */
export function firstSaveMonth(items: readonly Pick<Item, 'saved_at'>[]): string | null {
  let first = Infinity;
  for (const item of items) {
    const time = item.saved_at ? Date.parse(item.saved_at) : NaN;
    if (Number.isNaN(time)) return null;
    if (time < first) first = time;
  }
  return Number.isFinite(first) ? new Date(first).toLocaleDateString('en', { month: 'long', year: 'numeric' }) : null;
}

/** The line at the true end of the wall: how many saves that was and, when it is known, when the first was saved. */
export function endLine(total: number, firstMonth: string | null = null): string {
  if (total === 1) return 'that is the only one';
  const all = `that is all ${total.toLocaleString('en')}`;
  return firstMonth ? `${all} · your first save was in ${firstMonth}` : all;
}

export interface EmptyLibraryWords {
  title: string;
  /** Three steps, in order. `picture` names the small drawing beside a step; the words stand without it. */
  steps: { title: string; body: string; picture?: 'share' | 'apps' }[];
  /** The companion extension, where there is one to set up: a self-hosted server opened in a browser. */
  extension: string | null;
}

/**
 * What an empty library teaches, which depends on where it is open. Only the phone app is in the share sheet, so
 * only it describes one; a browser (and the demo) is shown the way that works there, which is pasting a link.
 * Each sentence is true of that place: sharing into the app opens the save dialog with the link filled in and
 * keeps nothing until Save is tapped (docs/mobile-app.md), and the extension brings in a view of saves from
 * Instagram or TikTok to a server you run, it does not save the page you are on (extension/README.md).
 */
export function emptyLibraryWords(kind: BackendKind): EmptyLibraryWords {
  if (kind === 'native') {
    return {
      title: 'Save from any app with Share.',
      steps: [
        { title: 'Tap Share on a post, a video or a page', body: 'In your browser, or in any app that can share a link.', picture: 'share' },
        { title: 'Choose Little Archive', body: 'It is in the row of apps. The first time, it may be near the end of the row.', picture: 'apps' },
        { title: 'Check it and tap Save', body: 'Little Archive opens with the link filled in. Nothing is kept until you tap Save.' },
      ],
      extension: null,
    };
  }
  return {
    title: 'Every collection starts with one link.',
    steps: [
      { title: 'Copy the link', body: 'Of a post, a video or a page you want to find again.' },
      { title: 'Choose Save a link and paste it', body: 'Add a title, topics or a collection if you like.' },
      { title: 'It is kept here', body: 'In your library, ready to search, sort and come back to.' },
    ],
    extension: kind === 'browser'
      ? 'There is also a companion extension for Chrome. It is experimental, and it brings in the Instagram saved view or TikTok favorites you have open, one view at a time.'
      : null,
  };
}
