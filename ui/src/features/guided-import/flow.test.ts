import { describe, expect, it } from 'vitest';
import { canResumeWith, checkFile, describeFileName, findResumable, listAccepts, nextFor, parseRoute, routeRest, stepOf, type Route } from './flow';
import { makeImport } from './testing';

const MIB = 1024 * 1024;
const ACCEPTS = ['.zip', '.json', '.html', '.txt'];

describe('the address', () => {
  it('reads each screen', () => {
    expect(parseRoute('')).toEqual({ kind: 'choose' });
    expect(parseRoute('instagram')).toEqual({ kind: 'guide', platform: 'instagram' });
    expect(parseRoute('tiktok/add')).toEqual({ kind: 'add', platform: 'tiktok' });
    expect(parseRoute('auto/add')).toEqual({ kind: 'add', platform: 'auto' });
    expect(parseRoute('5f0c2a1e-3b7d-4c68-9a10-7d2e6b1f4a90')).toEqual({ kind: 'import', id: '5f0c2a1e-3b7d-4c68-9a10-7d2e6b1f4a90' });
  });

  it('sends anything it does not know back to the first screen', () => {
    for (const rest of ['instagram/elsewhere', 'auto', 'instagram/add/more', 'a/b', 'x y', '../..']) {
      expect(parseRoute(rest), rest).toEqual({ kind: 'choose' });
    }
  });

  it('writes the address it reads', () => {
    const routes: Route[] = [{ kind: 'choose' }, { kind: 'guide', platform: 'tiktok' }, { kind: 'add', platform: 'auto' }, { kind: 'add', platform: 'instagram' }, { kind: 'import', id: 'abc-123' }];
    for (const route of routes) expect(parseRoute(routeRest(route))).toEqual(route);
  });
});

describe('which of the five stages is current', () => {
  it('follows the address before there is an import', () => {
    expect(stepOf({ kind: 'choose' }, null)).toEqual({ current: 0, done: false });
    expect(stepOf({ kind: 'guide', platform: 'instagram' }, null)).toEqual({ current: 1, done: false });
    expect(stepOf({ kind: 'add', platform: 'instagram' }, null)).toEqual({ current: 2, done: false });
  });

  it('follows the server’s state once there is one', () => {
    const route: Route = { kind: 'import', id: 'x' };
    expect(stepOf(route, makeImport({ state: 'uploading' })).current).toBe(2);
    expect(stepOf(route, makeImport({ state: 'previewed' })).current).toBe(3);
    expect(stepOf(route, makeImport({ state: 'importing' })).current).toBe(4);
    expect(stepOf(route, makeImport({ state: 'failed' })).current).toBe(4);
    expect(stepOf(route, makeImport({ state: 'completed' }))).toEqual({ current: 4, done: true });
  });

  it('puts a rejected or cancelled import back at handing the file over', () => {
    expect(stepOf({ kind: 'import', id: 'x' }, makeImport({ state: 'rejected' })).current).toBe(2);
    expect(stepOf({ kind: 'import', id: 'x' }, makeImport({ state: 'cancelled' })).current).toBe(2);
  });

  it('does not guess while the import is still loading', () => {
    expect(stepOf({ kind: 'import', id: 'x' }, null).current).toBe(2);
  });
});

describe('what to do next, from the state alone', () => {
  it('asks for the file again while pieces are missing, and says how many', () => {
    const view = makeImport({ upload: { chunk_size: MIB, chunks_total: 10, received: [[0, 3]], received_count: 4, complete: false } });
    expect(nextFor(view)).toEqual({ kind: 'send', missing: 6, total: 10 });
  });

  it('needs no file when every piece has arrived but the file was never read', () => {
    const view = makeImport({ upload: { chunk_size: MIB, chunks_total: 10, received: [[0, 9]], received_count: 10, complete: true } });
    expect(nextFor(view)).toEqual({ kind: 'read' });
  });

  it('reviews, watches, continues, finishes or starts again', () => {
    expect(nextFor(makeImport({ state: 'previewed' })).kind).toBe('review');
    expect(nextFor(makeImport({ state: 'importing' })).kind).toBe('watch');
    expect(nextFor(makeImport({ state: 'failed' })).kind).toBe('continue');
    expect(nextFor(makeImport({ state: 'completed' })).kind).toBe('done');
    expect(nextFor(makeImport({ state: 'rejected' }))).toEqual({ kind: 'again', why: 'rejected' });
    expect(nextFor(makeImport({ state: 'cancelled' }))).toEqual({ kind: 'again', why: 'cancelled' });
  });
});

describe('checking a file before anything is sent', () => {
  const upload = { accepts: ACCEPTS, max_bytes: 64 * MIB };

  it('lets a ZIP of a fine size through', () => {
    expect(checkFile({ name: 'instagram-me-2026.zip', size: 20 * MIB }, upload)).toBeNull();
    expect(checkFile({ name: 'Saved_Posts.JSON', size: 4000 }, upload)).toBeNull();
  });

  it('refuses an empty file', () => {
    expect(checkFile({ name: 'a.zip', size: 0 }, upload)?.code).toBe('empty');
  });

  it('refuses a file over the limit and says both sizes', () => {
    const problem = checkFile({ name: 'a.zip', size: 65 * MIB }, upload);
    expect(problem?.code).toBe('too_big');
    expect(problem?.words).toContain('65 MiB');
    expect(problem?.words).toContain('64 MiB');
  });

  it('allows exactly the limit', () => {
    expect(checkFile({ name: 'a.zip', size: 64 * MIB }, upload)).toBeNull();
  });

  it('refuses a type the server does not read, naming the types it does', () => {
    const problem = checkFile({ name: 'holiday.pdf', size: 1000 }, upload);
    expect(problem?.code).toBe('type');
    expect(problem?.words).toContain('ZIP, JSON, HTML or TXT');
    expect(problem?.words).toContain('.pdf');
  });

  it('refuses a name with no extension', () => {
    expect(checkFile({ name: 'export', size: 1000 }, upload)?.words).toContain('no extension');
  });

  it('writes the accepted types as a sentence', () => {
    expect(listAccepts(['.zip'])).toBe('ZIP');
    expect(listAccepts(['.zip', '.json'])).toBe('ZIP or JSON');
    expect(listAccepts(ACCEPTS)).toBe('ZIP, JSON, HTML or TXT');
  });
});

describe('carrying on an upload with the same file', () => {
  const file = { name: 'instagram-example_user-2026-11-10-AbCdEf.zip', size: 10 * MIB };

  it('finds the unfinished upload of the same file on the same platform', () => {
    const other = makeImport({ id: 'other', filename: 'something-else.zip' });
    const mine = makeImport({ id: 'mine' });
    expect(findResumable([other, mine], file, 'instagram')?.id).toBe('mine');
  });

  it('does not reuse an import of another platform, another size, or one that is not uploading', () => {
    expect(findResumable([makeImport({ platform: 'tiktok' })], file, 'instagram')).toBeNull();
    expect(findResumable([makeImport({ size_bytes: 11 * MIB })], file, 'instagram')).toBeNull();
    expect(findResumable([makeImport({ state: 'previewed' })], file, 'instagram')).toBeNull();
    expect(findResumable([makeImport({ state: 'cancelled' })], file, 'instagram')).toBeNull();
  });

  it('does not reuse an upload whose pieces have all arrived', () => {
    const complete = makeImport({ upload: { chunk_size: MIB, chunks_total: 10, received: [[0, 9]], received_count: 10, complete: true } });
    expect(findResumable([complete], file, 'instagram')).toBeNull();
  });

  it('matches a file name the server cut to 200 characters', () => {
    const long = `${'x'.repeat(250)}.zip`;
    const cut = describeFileName(long);
    expect(cut.length).toBe(200);
    expect(cut.endsWith('.zip')).toBe(true);
    expect(findResumable([makeImport({ filename: cut, size_bytes: 5 })], { name: long, size: 5 }, 'instagram')).not.toBeNull();
  });

  it('accepts a file of the same size, even under another name', () => {
    expect(canResumeWith(makeImport(), { size: 10 * MIB })).toEqual({ ok: true });
  });

  it('refuses a file of another size, naming both', () => {
    const result = canResumeWith(makeImport(), { size: 9 * MIB });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.words).toContain('9 MiB');
      expect(result.words).toContain('10 MiB');
    }
  });
});
