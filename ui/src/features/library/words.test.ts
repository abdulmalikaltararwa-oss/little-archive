import { describe, expect, it } from 'vitest';
import { endLine, firstSaveMonth, keptLine, wallEnded } from './words';

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
