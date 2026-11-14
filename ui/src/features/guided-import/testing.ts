// Shapes for the tests in this folder: an import as the server reports it, with only what a test cares about changed.
import type { GuidedImport, Preview } from './api';

const MIB = 1024 * 1024;

export function makeImport(overrides: Partial<GuidedImport> = {}): GuidedImport {
  return {
    id: '5f0c2a1e-3b7d-4c68-9a10-7d2e6b1f4a90',
    platform: 'instagram',
    source_account: 'default',
    filename: 'instagram-example_user-2026-11-10-AbCdEf.zip',
    size_bytes: 10 * MIB,
    state: 'uploading',
    error: null,
    upload: { chunk_size: MIB, chunks_total: 10, received: [], received_count: 0, complete: false },
    preview: null,
    progress: { total: 0, processed: 0, created: 0, updated: 0, skipped: 0, percent: 0 },
    run_id: null,
    created_at: '2026-11-14T09:00:00.000000+00:00',
    updated_at: '2026-11-14T09:00:00.000000+00:00',
    started_at: null,
    finished_at: null,
    resumable: true,
    ...overrides,
  };
}

export function makePreview(overrides: Partial<Preview> = {}): Preview {
  return {
    platform: 'instagram',
    format: 'json',
    source_account: 'default',
    files: [{ path: 'your_instagram_activity/saved/saved_posts.json', role: 'saved_posts', entries: 7, error: null }],
    totals: { entries: 10, saves: 6, new: 6, already_in_library: 0, in_library_other_account: 0, duplicates_in_archive: 1, unreadable: 3, in_collections_only: 2 },
    collections: [{ name: 'Recipes', count: 3, exists: false }],
    collections_total: 1,
    collections_read: true,
    sections: [{ name: 'Saved posts', count: 7 }],
    ignored: { sections: [], files: 3, nested_archives: 0 },
    date_range: { first: '2024-11-01T10:00:00+00:00', last: '2024-11-07T17:25:00+00:00' },
    unreadable: [],
    unreadable_total: 0,
    sample: [],
    warnings: [],
    digest: 'd'.repeat(64),
    scanned_at: '2026-11-14T09:01:00.000000+00:00',
    ...overrides,
  };
}
