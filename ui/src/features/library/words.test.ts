import { describe, expect, it } from 'vitest';
import { emptyLibraryWords, endLine, firstSaveMonth, keptLine, wallEnded } from './words';

describe('the line under the library', () => {
  it('says "your server" only where the person runs the server', () => {
    expect(keptLine('browser', 'self-hosted')).toBe('Your collection. Your server. A little more peace of mind.');
    expect(keptLine('native', 'self-hosted')).toBe('Your collection. Your server. A little more peace of mind.');
  });
  it('does not claim a server or privacy on a hosted account', () => {
    const line = keptLine('native', 'hosted');
    expect(line).toBe('Your collection. Your account. A little more peace of mind.');
    expect(line).not.toMatch(/server|private/i);
  });
  it('does not claim a server for the demo, which has none', () => {
    expect(keptLine('demo', 'self-hosted')).not.toMatch(/server|account|private/i);
  });
});

describe('the end of the wall', () => {
  const ended = { list: 'ready', count: 60, total: 60, loadingMore: false, sort: 'recent' } as const;
  it('is reached only when every save of the view is loaded and nothing is on its way', () => {
    expect(wallEnded(ended)).toBe(true);
    expect(wallEnded({ ...ended, list: 'loading' })).toBe(false);
    expect(wallEnded({ ...ended, list: 'error' })).toBe(false);
    expect(wallEnded({ ...ended, count: 59 })).toBe(false);
    expect(wallEnded({ ...ended, loadingMore: true })).toBe(false);
    expect(wallEnded({ ...ended, count: 0, total: 0 })).toBe(false);
    expect(wallEnded({ ...ended, sort: 'random' })).toBe(false);
  });

  it('counts the saves, and names the first month only when it is given one', () => {
    expect(endLine(1284)).toBe('that is all 1,284');
    expect(endLine(1284, 'March 2023')).toBe('that is all 1,284 · your first save was in March 2023');
    expect(endLine(1, 'March 2023')).toBe('that is the only one');
  });

  it('finds the first month only when every save carries its own date', () => {
    expect(firstSaveMonth([{ saved_at: '2024-06-15T12:00:00Z' }, { saved_at: '2023-03-15T12:00:00Z' }])).toBe('March 2023');
    expect(firstSaveMonth([{ saved_at: '2024-06-15T12:00:00Z' }, { saved_at: null }])).toBeNull();
    expect(firstSaveMonth([{ saved_at: 'not a date' }])).toBeNull();
    expect(firstSaveMonth([])).toBeNull();
  });
});

describe('what an empty library teaches', () => {
  const text = (kind: Parameters<typeof emptyLibraryWords>[0]) => {
    const words = emptyLibraryWords(kind);
    return [words.title, ...words.steps.flatMap(step => [step.title, step.body]), words.extension ?? ''].join(' ');
  };

  it('teaches the share sheet inside the phone app, in three steps', () => {
    const words = emptyLibraryWords('native');
    expect(words.steps.map(step => step.title)).toEqual(['Tap Share on a post, a video or a page', 'Choose Little Archive', 'Check it and tap Save']);
    expect(words.extension).toBeNull();
  });

  it('does not say a shared link is saved by itself: the app opens and waits for Save', () => {
    expect(text('native')).toMatch(/Nothing is kept until you tap Save/);
    expect(text('native')).not.toMatch(/without leaving|stay where you were|That is it/i);
  });

  it('names no phone and no app that it cannot vouch for', () => {
    expect(text('native')).not.toMatch(/iPhone|iOS|Android|TikTok|Instagram/);
  });

  it('does not describe a share sheet in a browser or in the demo, which are not in one', () => {
    for (const kind of ['browser', 'demo'] as const) {
      expect(text(kind)).not.toMatch(/share|row of apps/i);
      expect(emptyLibraryWords(kind).steps.map(step => step.title)).toEqual(['Copy the link', 'Choose Save a link and paste it', 'It is kept here']);
      expect(emptyLibraryWords(kind).steps.every(step => !step.picture)).toBe(true);
    }
  });

  it('mentions the extension only on a self-hosted server in a browser, and says what it really does', () => {
    expect(emptyLibraryWords('browser').extension).toMatch(/experimental/);
    expect(emptyLibraryWords('browser').extension).toMatch(/Instagram saved view or TikTok favorites/);
    expect(emptyLibraryWords('demo').extension).toBeNull();
    expect(emptyLibraryWords('native').extension).toBeNull();
  });
});
