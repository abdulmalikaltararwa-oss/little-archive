import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { ArchiveProvider } from '@/app/archive-context';
import { useIsland } from '@/app/ui-state';
import { flushHeld, UNDO_MS } from '@/app/undo';
import type { Archive, ArchiveState } from '@/data/archive';
import { ApiError } from '@/data/client';
import { HOME } from '@/data/location';
import { EMPTY_FILTERS, type Item } from '@/data/types';
import { useReview } from './answers';
import { ReviewScreen } from './review-screen';

const save = (id: string, title: string, extra: Partial<Item> = {}) => ({ id, title, url: `https://example.com/${id}`, platform: 'web', creator: '', caption: '', summary: '', tags: [], collections: [], evidence: [], content_type: 'article', thumbnail_url: null, preview_url: null, needs_review: true, created_at: '2026-11-14T10:00:00Z', ai: null, ...extra }) as unknown as Item;

const SUGGESTED = save('a', 'Machboos deyay', { caption: '2 cups basmati, 1 whole chicken', ai: { topics: ['chicken', 'rice'], category: 'Recipes', suggested_folder: 'Weeknight dinners', evidence_level: 'caption-based', evidence_note: 'The video was not seen.' } });
const PLAIN = save('b', 'Failaka Island', { tags: ['kuwait'] });
const THIRD = save('c', 'Sourdough for beginners');

function queue(items: Item[], overrides: Record<string, unknown> = {}, state: Partial<ArchiveState> = {}) {
  const store = createStore(() => ({ loc: { ...HOME, view: 'review' }, filters: { ...EMPTY_FILTERS, needs_review: true }, collections: [], items, total: items.length, list: 'ready', listError: '', busy: false, settings: { remote_previews: false }, ...state }) as unknown as ArchiveState);
  // The server's answer takes the save out of the view, as a refetch of the review view would.
  const leave = (id: string) => store.setState(current => ({ items: current.items.filter(item => item.id !== id), total: current.total - 1 }));
  const api = {
    acceptAi: vi.fn(async (id: string) => ({ ...items.find(item => item.id === id)!, needs_review: false })),
    dismissAi: vi.fn(async (id: string) => ({ ...items.find(item => item.id === id)!, needs_review: false, ai: null })),
    patchItem: vi.fn(async (id: string) => ({ ...items.find(item => item.id === id)!, needs_review: false })),
    ...overrides,
  };
  const archive = {
    store, api, backend: { kind: 'browser', thumbnail: () => null },
    refreshEditedItem: vi.fn(async (updated: Item) => leave(updated.id)),
    loadItems: vi.fn(async () => {}), refreshLibrary: vi.fn(async () => {}), openItem: vi.fn(async () => true), goView: vi.fn(), navigate: vi.fn(),
  } as unknown as Archive;
  render(<ArchiveProvider archive={archive}><ReviewScreen demo={false} /></ArchiveProvider>);
  return { archive, api, store };
}

const messages = () => useIsland.getState().messages;
const tap = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const position = () => screen.getByTestId('review-position').textContent;
const strip = () => screen.getByRole('progressbar', { name: 'Reviewed' });
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  cleanup();
  flushHeld();
  for (const message of messages()) useIsland.getState().dismiss(message.id);
  useReview.setState({ accepted: 0, kept: 0, gone: new Set(), later: new Set(), failure: null, shown: false });
  vi.useRealTimers();
});

describe('the review queue', () => {
  it('shows one save: what would change, what that rests on, and both answers', () => {
    queue([SUGGESTED, PLAIN, THIRD]);
    expect(screen.getByRole('heading', { level: 1, name: 'Needs review' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Machboos deyay' })).toBeInTheDocument();
    expect(position()).toBe('1 of 3');
    expect(strip()).toHaveAttribute('aria-valuenow', '0');
    expect(strip()).toHaveAttribute('aria-valuemax', '3');
    expect(screen.getByText('Recipes')).toBeInTheDocument();
    expect(screen.getByText('Weeknight dinners')).toBeInTheDocument();
    expect(screen.getByText('chicken')).toBeInTheDocument();
    expect(screen.getByTestId('evidence-label')).toHaveTextContent('From the caption');
    expect(screen.getByText('2 cups basmati, 1 whole chicken')).toHaveAttribute('dir', 'auto');
    expect(screen.getByText(/The video was not seen\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep as it is' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Leave it for later' })).toBeNull();
  });

  it('Accept moves on at once and tells the server only after the time to undo', async () => {
    const { api, archive } = queue([SUGGESTED, PLAIN, THIRD]);
    tap('Accept');
    expect(screen.getByRole('heading', { level: 2, name: 'Failaka Island' })).toBeInTheDocument();
    expect(position()).toBe('2 of 3');
    expect(strip()).toHaveAttribute('aria-valuenow', '1');
    expect(messages().at(-1)).toMatchObject({ text: 'Filed in Weeknight dinners', action: { label: 'Undo' } });
    expect(api.acceptAi).not.toHaveBeenCalled();
    await wait(UNDO_MS);
    expect(api.acceptAi).toHaveBeenCalledWith('a');
    expect(archive.refreshEditedItem).toHaveBeenCalled();
    expect(position()).toBe('2 of 3');
  });

  it('Undo brings the save back with nothing sent', async () => {
    const { api } = queue([SUGGESTED, PLAIN]);
    tap('Accept');
    act(() => messages().at(-1)!.action!.run());
    expect(screen.getByRole('heading', { level: 2, name: 'Machboos deyay' })).toBeInTheDocument();
    expect(position()).toBe('1 of 2');
    await wait(UNDO_MS * 2);
    expect(api.acceptAi).not.toHaveBeenCalled();
  });

  it('Keep as it is dismisses the suggestion; the next answer sends the one before it', async () => {
    const { api } = queue([SUGGESTED, PLAIN, THIRD]);
    tap('Keep as it is');
    expect(messages().at(-1)!.text).toBe('Kept as it was');
    expect(api.dismissAi).not.toHaveBeenCalled();
    // A save with no suggestion has one answer, which only clears the flag.
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(screen.getByText(/There is no suggestion for this save/)).toBeInTheDocument();
    tap('Mark as reviewed');
    expect(api.dismissAi).toHaveBeenCalledWith('a');
    expect(api.patchItem).not.toHaveBeenCalled();
    await wait(UNDO_MS);
    expect(api.patchItem).toHaveBeenCalledWith('b', { needs_review: false });
    expect(api.acceptAi).not.toHaveBeenCalled();
  });

  it('says so when everything is answered, with what was decided', async () => {
    const { archive } = queue([SUGGESTED, PLAIN]);
    tap('Accept');
    tap('Mark as reviewed');
    expect(screen.getByRole('heading', { level: 2, name: 'All reviewed.' })).toBeInTheDocument();
    expect(screen.getByText(/1 accepted, 1 kept as it was\./)).toBeInTheDocument();
    expect(strip()).toHaveAttribute('aria-valuenow', '2');
    await wait(UNDO_MS);
    expect(screen.getByRole('heading', { level: 2, name: 'All reviewed.' })).toBeInTheDocument();
    tap('Back to your library');
    expect(archive.goView).toHaveBeenCalledWith('all');
  });

  it('an empty queue says there is nothing to review, without a count', () => {
    queue([]);
    expect(screen.getByRole('heading', { level: 2, name: 'Nothing to review.' })).toBeInTheDocument();
    expect(screen.queryByText(/accepted|kept/)).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('a refused answer brings the save back, says nothing changed, and offers to try again or leave it', async () => {
    const acceptAi = vi.fn(async () => { throw new ApiError('This item\'s information changed.', 409); });
    const { api } = queue([SUGGESTED, PLAIN], { acceptAi });
    tap('Accept');
    await wait(UNDO_MS);
    expect(screen.getByRole('alert')).toHaveTextContent('That was not saved. This item\'s information changed. “Machboos deyay” is unchanged. Your other answers are safe.');
    expect(screen.getByRole('heading', { level: 2, name: 'Machboos deyay' })).toBeInTheDocument();
    expect(position()).toBe('1 of 2');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep as it is' })).toBeInTheDocument();

    tap('Leave it for later');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Failaka Island' })).toBeInTheDocument();
    tap('Mark as reviewed');
    await wait(UNDO_MS);
    expect(api.patchItem).toHaveBeenCalledWith('b', { needs_review: false });
    expect(screen.getByRole('heading', { level: 2, name: 'That is the end of the queue.' })).toBeInTheDocument();
    expect(screen.getByText(/1 kept as it was\. One save was left for later\./)).toBeInTheDocument();
    tap('Go through it again');
    expect(screen.getByRole('heading', { level: 2, name: 'Machboos deyay' })).toBeInTheDocument();
  });

  it('draws nothing from the last view\'s saves while the queue is loading', () => {
    queue([SUGGESTED, PLAIN], {}, { list: 'loading', busy: true });
    expect(screen.getByRole('status')).toHaveTextContent('Finding what needs review…');
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    expect(screen.queryByTestId('review-position')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark as reviewed' })).toBeNull();
  });

  it('an answer the server took is never called unsaved, even when the list cannot be refreshed after it', async () => {
    const { api, archive } = queue([SUGGESTED, PLAIN]);
    vi.mocked(archive.refreshEditedItem).mockRejectedValueOnce(new Error('offline'));
    tap('Accept');
    await wait(UNDO_MS);
    expect(api.acceptAi).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Failaka Island' })).toBeInTheDocument();
    expect(useReview.getState()).toMatchObject({ accepted: 1, failure: null });
  });

  it('opens the usual save detail to change something first', () => {
    const { archive } = queue([SUGGESTED]);
    tap('Change something first');
    expect(archive.openItem).toHaveBeenCalledWith('a');
  });

  it('draws one bar instead of a segment each when the queue is long, and says when it is narrowed', () => {
    const many = Array.from({ length: 30 }, (_, index) => save(`m${index}`, `Save ${index}`));
    const { archive } = queue(many, {}, { total: 205, loc: { ...HOME, view: 'review', q: 'sample' } });
    expect(position()).toBe('1 of 205');
    expect(strip().children).toHaveLength(1);
    expect(screen.getByText('Only saves matching “sample”.')).toBeInTheDocument();
    tap('Show all');
    expect(archive.navigate).toHaveBeenCalledWith({ q: '', tag: '', platform: '' }, { replace: true });
  });

  it('asks for the next page when every loaded save is answered and the server has more', () => {
    const { archive } = queue([PLAIN], {}, { total: 3 });
    tap('Mark as reviewed');
    expect(archive.loadItems).toHaveBeenCalledWith(true);
    expect(screen.getByRole('status')).toHaveTextContent('Finding what needs review…');
  });

  it('sends the waiting answer when the queue is left', () => {
    const { api } = queue([PLAIN, THIRD]);
    tap('Mark as reviewed');
    cleanup();
    expect(api.patchItem).toHaveBeenCalledWith('b', { needs_review: false });
  });
});
