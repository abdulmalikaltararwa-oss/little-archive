import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { ArchiveProvider } from '@/app/archive-context';
import { useDialogs, useIsland } from '@/app/ui-state';
import { flushHeld, UNDO_MS } from '@/app/undo';
import type { Archive, ArchiveState } from '@/data/archive';
import { ApiError } from '@/data/client';
import type { Item } from '@/data/types';
import { deleteWithUndo, useHeldDeletes } from './held-deletes';
import { SaveRow } from './save-row';
import type { Side } from './swipe';

const ITEM = { id: 'a1', title: 'Failaka Island: a day trip', url: 'https://example.com/failaka', platform: 'web', creator: '', content_type: 'article', thumbnail_url: null, preview_url: null, favorite: false, status: 'inbox', needs_review: false, tags: [], collections: [] } as unknown as Item;
const OTHER = { ...ITEM, id: 'b2', title: 'Sourdough for beginners' } as Item;

function library(overrides: Record<string, unknown> = {}) {
  const store = createStore(() => ({ items: [ITEM, OTHER], total: 2, selected: new Set<string>(), revision: 0 }) as unknown as ArchiveState);
  const api = { deleteItem: vi.fn(async () => ({ ok: true })), patchItem: vi.fn(async (_id: string, patch: object) => ({ ...ITEM, ...patch })), ...overrides };
  const archive = { store, api, backend: { kind: 'browser', thumbnail: () => null }, refreshMetadata: vi.fn(async () => {}), refreshEditedItem: vi.fn(async () => {}), openItem: vi.fn(async () => true), select: vi.fn(() => true) } as unknown as Archive;
  return { archive, store, api };
}

function row(archive: Archive, side: Side = '', item: Item = ITEM) {
  const onSide = vi.fn();
  const view = render(
    <ArchiveProvider archive={archive}>
      <SaveRow item={item} tile={{ x: 0, y: 0, width: 358, height: 64 }} index={0} total={2} selected={false} selecting={false} remotePreviews={false} side={side} onSide={onSide} />
    </ArchiveProvider>,
  );
  return { ...view, onSide };
}

const messages = () => useIsland.getState().messages;

afterEach(() => {
  cleanup();
  flushHeld();
  for (const message of messages()) useIsland.getState().dismiss(message.id);
  useHeldDeletes.setState({ ids: new Set() });
  useDialogs.getState().closeAll();
  vi.useRealTimers();
});

describe('a save as a row in the list', () => {
  it('opens the save from its title and says where it is from', () => {
    const { archive } = library();
    row(archive);
    expect(screen.getByText('Web · example.com')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Failaka Island: a day trip' }));
    expect(archive.openItem).toHaveBeenCalledWith('a1');
  });

  it('keeps the actions under it out of reach until that side is open', () => {
    // The test page does not apply `inert` itself, so reach is read from the attribute a browser acts on.
    const reachable = (name: string) => !screen.getByRole('button', { name }).closest('[inert]');
    const { archive } = library();
    const closed = row(archive);
    expect(reachable('Delete')).toBe(false);
    expect(reachable('Done')).toBe(false);
    expect(reachable('File')).toBe(false);
    expect(closed.container.querySelector('article')).not.toHaveAttribute('data-swipe');
    cleanup();

    const start = row(archive, 'start');
    expect(reachable('Done')).toBe(true);
    expect(reachable('File')).toBe(true);
    expect(reachable('Delete')).toBe(false);
    expect(start.container.querySelector('article')).toHaveAttribute('data-swipe', 'start');
    cleanup();

    row(archive, 'end');
    expect(reachable('Delete')).toBe(true);
    expect(reachable('Done')).toBe(false);
  });

  it('a tap on an open row closes it instead of opening the save', () => {
    const { archive } = library();
    const { onSide } = row(archive, 'end');
    fireEvent.click(screen.getByRole('button', { name: 'Open Failaka Island: a day trip' }));
    expect(archive.openItem).not.toHaveBeenCalled();
    expect(onSide).toHaveBeenCalledWith('a1', '');
  });

  it('Done marks the save done, and a done save can be marked not done', async () => {
    const { archive, api } = library();
    const { onSide } = row(archive, 'start');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(api.patchItem).toHaveBeenCalledWith('a1', { status: 'done' }));
    await waitFor(() => expect(archive.refreshEditedItem).toHaveBeenCalled());
    expect(onSide).toHaveBeenCalledWith('a1', '');
    cleanup();

    row(archive, 'start', { ...ITEM, status: 'done' });
    fireEvent.click(screen.getByRole('button', { name: 'Not done' }));
    await waitFor(() => expect(api.patchItem).toHaveBeenCalledWith('a1', { status: 'inbox' }));
  });

  it('File opens the collection dialog for this one save', () => {
    const { archive } = library();
    row(archive, 'start');
    fireEvent.click(screen.getByRole('button', { name: 'File' }));
    expect(useDialogs.getState().stack.at(-1)).toMatchObject({ kind: 'bulk', action: 'collection', ids: ['a1'] });
  });

  it('has a menu button named for the save, for use without the gesture', () => {
    const { archive } = library();
    row(archive);
    expect(screen.getByRole('button', { name: 'Actions for Failaka Island: a day trip' })).toHaveAttribute('aria-haspopup', 'menu');
  });
});

describe('deleting from the list', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('hides the save at once, tells the server only after the time to undo, then drops it from the loaded saves', async () => {
    const { archive, store, api } = library();
    deleteWithUndo(archive, ITEM);
    expect(useHeldDeletes.getState().ids.has('a1')).toBe(true);
    expect(messages().at(-1)).toMatchObject({ text: 'Deleted “Failaka Island: a day trip”', action: { label: 'Undo' } });
    expect(api.deleteItem).not.toHaveBeenCalled();
    expect(store.getState().items).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(UNDO_MS);
    expect(api.deleteItem).toHaveBeenCalledWith('a1');
    expect(store.getState().items.map(item => item.id)).toEqual(['b2']);
    expect(store.getState().total).toBe(1);
    expect(useHeldDeletes.getState().ids.size).toBe(0);
    expect(archive.refreshMetadata).toHaveBeenCalled();
  });

  it('Undo brings the save back and nothing is sent', async () => {
    const { archive, store, api } = library();
    deleteWithUndo(archive, ITEM);
    messages().at(-1)!.action!.run();
    expect(useHeldDeletes.getState().ids.size).toBe(0);
    await vi.advanceTimersByTimeAsync(UNDO_MS * 2);
    expect(api.deleteItem).not.toHaveBeenCalled();
    expect(store.getState().items).toHaveLength(2);
  });

  it('a delete the server refused puts the save back and says so', async () => {
    const { archive, store } = library({ deleteItem: vi.fn(async () => { throw new ApiError('The server is busy.', 503); }) });
    deleteWithUndo(archive, ITEM);
    await vi.advanceTimersByTimeAsync(UNDO_MS);
    expect(useHeldDeletes.getState().ids.size).toBe(0);
    expect(store.getState().items).toHaveLength(2);
    expect(messages().at(-1)).toMatchObject({ tone: 'error', text: '“Failaka Island: a day trip” was not deleted. The server is busy.' });
  });

  it('shortens a long title in the message', () => {
    const { archive } = library();
    deleteWithUndo(archive, { ...ITEM, title: 'Kyoto: Fushimi Inari before sunrise, slowly' });
    expect(messages().at(-1)!.text).toBe('Deleted “Kyoto: Fushimi Inari before…”');
  });
});
