// Small things several screens do the same way.
import { createQuery } from '@web/utils.js';
import { openDialog, toast } from '@/app/ui-state';
import type { Scope } from '@/data/api';
import type { Archive } from '@/data/archive';
import type { ItemList } from '@/data/types';

/** Opens the oldest save in a scope that still needs review, or says there is none. Unloaded pages are included. */
export async function openReview(archive: Archive, scope: Scope = {}): Promise<boolean> {
  const result = await archive.api.items({ ...scope, needs_review: true, sort: 'oldest' }, 0, 1) as ItemList;
  const next = result.items[0];
  if (next) return archive.openItem(next.id, { reviewScope: scope });
  toast('You are caught up. No saves in this scope need review.');
  return false;
}

/** Copies text, or shows it for copying by hand where the clipboard is not available. */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard.');
  } catch {
    openDialog({ kind: 'copy-text', text });
  }
}

/** Fetches a download and hands it to the browser or the phone's share sheet. */
export async function downloadFile(archive: Archive, path: string, fallbackName: string) {
  const { blob, filename } = await archive.api.download(path, fallbackName);
  const how = await archive.backend.saveFile(blob, filename);
  if (how === 'downloaded') toast('Your download is ready.');
}

export { createQuery };
