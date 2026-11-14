import { describe, expect, it } from 'vitest';
import { ApiError } from '@/data/client';
import { coverageSentence, explainError, explainRejection, formatBytes, formatDuration, formatRate, formatRemaining, groupUnreadable, REJECTION_CODES, STATE_WORDS, unreadableWords } from './words';

describe('sizes and times', () => {
  it('writes bytes in binary units, the way the server writes its limits', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(1024 * 1024)).toBe('1 MiB');
    expect(formatBytes(512 * 1024 * 1024)).toBe('512 MiB');
    expect(formatBytes(48.2 * 1024 * 1024)).toBe('48.2 MiB');
    expect(formatBytes(1.25 * 1024 ** 3)).toBe('1.25 GiB');
  });

  it('treats a nonsense size as nothing', () => {
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });

  it('writes a rate', () => {
    expect(formatRate(3.1 * 1024 * 1024)).toBe('3.1 MiB/s');
  });

  it('writes a duration like a clock', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(42)).toBe('42s');
    expect(formatDuration(65)).toBe('1m 05s');
    expect(formatDuration(3600 + 7 * 60)).toBe('1h 07m');
  });

  it('says what is left in words, as an estimate', () => {
    expect(formatRemaining(null)).toBe('');
    expect(formatRemaining(Number.NaN)).toBe('');
    expect(formatRemaining(2)).toBe('a few seconds left');
    expect(formatRemaining(12)).toBe('about 10 seconds left');
    expect(formatRemaining(60)).toBe('about a minute left');
    expect(formatRemaining(240)).toBe('about 4 minutes left');
    expect(formatRemaining(3 * 3600 + 10 * 60)).toBe('about 3 hr 10 min left');
  });
});

describe('why a file was refused', () => {
  const rejected = ['checksum_mismatch', 'not_a_zip', 'wrong_platform', 'ambiguous_platform', 'no_saved_data', 'unsafe_archive', 'too_large', 'too_many_files', 'too_many_records', 'unreadable'];

  it('has a sentence and a next step for every rejection the contract names', () => {
    for (const code of rejected) {
      const words = explainRejection(code, null);
      expect(REJECTION_CODES, code).toContain(code);
      expect(words.title.length, code).toBeGreaterThan(5);
      expect(words.what.length, code).toBeGreaterThan(20);
      expect(words.next.length, code).toBeGreaterThan(10);
    }
  });

  it('explains an ApiError by its code, not by its words', () => {
    const words = explainError(new ApiError('This looks like a TikTok export.', 422, 'wrong_platform'));
    expect(words.code).toBe('wrong_platform');
    expect(words.title).toMatch(/other platform/);
    expect(words.next).toMatch(/choose the other platform/i);
  });

  it('says how big a file may be when the server says so', () => {
    const words = explainError(new ApiError('too big', 413, 'file_too_large', { max_bytes: 64 * 1024 * 1024 }));
    expect(words.what).toContain('64 MiB');
  });

  it('says how many imports may be open', () => {
    expect(explainError(new ApiError('busy', 409, 'import_in_progress', { max_active: 1 })).what).toContain('1 import ');
    expect(explainError(new ApiError('busy', 409, 'import_in_progress', { max_active: 3 })).what).toContain('3 imports');
  });

  it('explains an incomplete upload as something to continue, not a failure', () => {
    const words = explainError(new ApiError('Some pieces have not arrived yet.', 409, 'upload_incomplete', { missing: [[3, 4]] }));
    expect(words.next).toMatch(/Continue the upload/);
  });

  it('calls a lost connection a lost connection', () => {
    const words = explainError(new ApiError('Could not reach your archive.', 0));
    expect(words.code).toBe('network');
    expect(words.title).toMatch(/connection/);
  });

  it('falls back to the server’s own sentence for a code it does not know', () => {
    const words = explainError(new ApiError('A brand new refusal.', 422, 'something_new'));
    expect(words.what).toBe('A brand new refusal.');
    expect(words.code).toBe('something_new');
  });

  it('copes with a plain error, a string and nothing at all', () => {
    expect(explainError(new Error('boom')).what).toBe('boom');
    expect(explainError('words').what).toBe('words');
    expect(explainError(undefined).what).toBe('Something went wrong.');
  });

  it('explains a reloaded rejection (which has no code) with the server’s sentence and a safe next step', () => {
    const words = explainRejection(undefined, 'The staged file is missing or changed. Add the export again.');
    expect(words.what).toBe('The staged file is missing or changed. Add the export again.');
    expect(words.next).toMatch(/Nothing was saved/);
  });
});

describe('states and unreadable entries', () => {
  it('names every state a person can meet', () => {
    expect(Object.keys(STATE_WORDS).sort()).toEqual(['cancelled', 'completed', 'failed', 'importing', 'previewed', 'rejected', 'uploading']);
  });

  it('puts every unreadable reason the contract names into plain words', () => {
    for (const reason of ['no_post_link', 'not_a_post_or_reel_link', 'no_video_link', 'not_a_video_link', 'unrecognised_entry', 'collection_without_name']) {
      expect(unreadableWords(reason), reason).not.toContain('_');
      expect(unreadableWords(reason).endsWith('.'), reason).toBe(true);
    }
  });

  it('shows an unknown reason as the server wrote it, without underscores', () => {
    expect(unreadableWords('some_new_reason')).toBe('some new reason');
  });

  it('counts the listed entries by reason, most common first', () => {
    const grouped = groupUnreadable([{ reason: 'no_post_link' }, { reason: 'not_a_post_or_reel_link' }, { reason: 'no_post_link' }, { reason: 'collection_without_name' }, { reason: 'collection_without_name' }]);
    expect(grouped.map(entry => [entry.reason, entry.count])).toEqual([['collection_without_name', 2], ['no_post_link', 2], ['not_a_post_or_reel_link', 1]]);
  });

  it('says what the file does and does not establish', () => {
    const sentence = coverageSentence('Instagram');
    expect(sentence).toContain('Instagram');
    expect(sentence).toMatch(/does not establish/);
    expect(sentence).toMatch(/Nothing was removed/);
  });
});
