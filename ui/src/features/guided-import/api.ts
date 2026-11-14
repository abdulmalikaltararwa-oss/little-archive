// The guided backlog import's calls, one per route in API_CONTRACT.md ("Guided backlog import"), and the
// shapes those routes answer with. A field the contract does not name is not typed here. Every call goes
// through the data layer's one request function, so it reaches the right backend (a browser's own origin, the
// phone app's native client) and failures arrive as ApiError with the server's `code` and extra fields.
import type { Api } from '@/data/api';

/** An inclusive run of piece numbers: [3, 7] is pieces 3, 4, 5, 6 and 7. */
export type Range = [number, number];

export type PlatformId = 'instagram' | 'tiktok';
export type ImportState = 'uploading' | 'previewed' | 'importing' | 'completed' | 'failed' | 'cancelled' | 'rejected';

/* The guide ------------------------------------------------------------------------------------------ */

export interface GuideStep { id: string; title: string; detail: string }
export interface GuideFormat { id: 'json' | 'html' | 'txt' | (string & {}); recommended: boolean; reads: string[]; limitations?: string[] }

export interface Guide {
  id: PlatformId;
  name: string;
  help_url: string | null;
  summary: string;
  steps: GuideStep[];
  /** What to pick in the platform's own form. The server's keys (`information`, `format`, `date_range`) are shown as they come. */
  choose: Record<string, string | string[]>;
  formats: GuideFormat[];
  expect: { file: string; contains: string }[];
  ignored: string;
  caveats: string[];
  upload: { accepts: string[]; keep_zipped: boolean; max_bytes: number; chunk_bytes: number };
  /** The guide's own honesty block: what its instructions rest on, and what has not been checked. */
  verified: { basis: string; real_export_tested: boolean; unverified: string[] };
}

export interface Guides { version: number; platforms: Guide[] }

/* An import ------------------------------------------------------------------------------------------ */

export interface UploadInfo {
  chunk_size: number;
  chunks_total: number;
  received: Range[];
  received_count: number;
  complete: boolean;
}

export interface Progress { total: number; processed: number; created: number; updated: number; skipped: number; percent: number }

export type UnreadableReason = 'no_post_link' | 'not_a_post_or_reel_link' | 'no_video_link' | 'not_a_video_link' | 'unrecognised_entry' | 'collection_without_name';

export interface Preview {
  platform: PlatformId;
  format: 'json' | 'html' | 'txt' | 'mixed';
  source_account: string;
  files: { path: string; role: string; entries: number; error: string | null }[];
  totals: {
    entries: number;
    saves: number;
    new: number;
    already_in_library: number;
    in_library_other_account: number;
    duplicates_in_archive: number;
    unreadable: number;
    in_collections_only: number;
  };
  collections: { name: string; count: number; exists: boolean }[];
  collections_total: number;
  collections_read: boolean;
  sections: { name: string; count: number }[];
  ignored: { sections: { name: string; count: number }[]; files: number; nested_archives: number };
  date_range: { first: string; last: string } | null;
  /** The first 50 only; `unreadable_total` is the real number. */
  unreadable: { file: string; reason: UnreadableReason | (string & {}); index: number }[];
  unreadable_total: number;
  sample: { url: string; creator: string | null; saved_at: string | null; collections: string[] }[];
  warnings: string[];
  digest: string;
  scanned_at: string;
}

export interface GuidedImport {
  id: string;
  platform: PlatformId | 'auto';
  source_account: string;
  filename: string;
  size_bytes: number;
  state: ImportState;
  error: string | null;
  upload: UploadInfo;
  /** Null in the list, and until the file has been read. */
  preview: Preview | null;
  progress: Progress;
  run_id: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  resumable: boolean;
}

export interface ChunkReceipt { index: number; received_count: number; chunks_total: number; complete: boolean; received: Range[] }

export interface StartBody {
  platform?: PlatformId | 'auto';
  filename: string;
  size_bytes: number;
  source_account?: string;
}

/* The calls ------------------------------------------------------------------------------------------ */

const OCTET = { 'Content-Type': 'application/octet-stream' };
const here = (id: string) => `/imports/archives/${encodeURIComponent(id)}`;

export function guidedApi(request: Api['request']) {
  return {
    guides: (signal?: AbortSignal) => request<Guides>('/imports/guides', { signal }),
    list: (limit = 20, signal?: AbortSignal) => request<{ imports: GuidedImport[] }>(`/imports/archives?limit=${limit}`, { signal }),
    start: (body: StartBody) => request<GuidedImport>('/imports/archives', { method: 'POST', body }),
    /** One piece, as raw bytes. Sending a piece again replaces it. */
    putChunk: (id: string, index: number, body: Blob | ArrayBuffer, options: { sha256?: string; signal?: AbortSignal } = {}) =>
      request<ChunkReceipt>(`${here(id)}/chunks/${index}`, {
        method: 'PUT',
        body,
        raw: true,
        headers: options.sha256 ? { ...OCTET, 'X-Chunk-SHA256': options.sha256 } : OCTET,
        signal: options.signal,
      }),
    get: (id: string, signal?: AbortSignal) => request<GuidedImport>(here(id), { signal }),
    finish: (id: string, signal?: AbortSignal) => request<GuidedImport>(`${here(id)}/finish`, { method: 'POST', signal }),
    preview: (id: string, signal?: AbortSignal) => request<{ id: string; state: ImportState; preview: Preview }>(`${here(id)}/preview`, { signal }),
    /** With the preview's digest this starts the job; with none it continues a failed or interrupted one. */
    commit: (id: string, digest?: string) => request<GuidedImport>(`${here(id)}/commit`, { method: 'POST', body: digest ? { digest } : {} }),
    cancel: (id: string) => request<GuidedImport>(here(id), { method: 'DELETE' }),
  };
}

export type GuidedApi = ReturnType<typeof guidedApi>;
