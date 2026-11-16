import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { ArchiveProvider } from '@/app/archive-context';
import { useConfirm, useDialogs, useIsland } from '@/app/ui-state';
import type { Archive, ArchiveState } from '@/data/archive';
import type { Collection, Item } from '@/data/types';
import { showSaveMoment, useSaveMoment } from './store';
import { SaveTray } from './tray';
import { TRAY_MS } from './words';

const YEAR = new Date().getFullYear();
const NOW = `${YEAR}-11-16T09:00:00+00:00`;
const COLLECTIONS: Collection[] = [
  { id: 'dinners', name: 'Weeknight dinners', kind: 'local', count: 58 },
  { id: 'baking', name: 'Baking', kind: 'local', count: 12 },
  { id: 'plants', name: 'Home & plants', kind: 'local', count: 3 },
  { id: 'ig', name: 'Saved on Instagram', kind: 'source', platform: 'instagram', count: 400 },
];

const save = (changes: Partial<Item> = {}): Item => ({
  id: 'item-1', platform: 'tiktok', url: 'https://www.tiktok.com/@a/video/1', title: 'Brown butter chocolate chip cookies', creator: '', caption: '', summary: '', notes: '',
  content_type: 'video', preview_url: null, thumbnail_url: null, tags: [], collections: [], favorite: false, status: 'inbox', needs_review: true,
  saved_at: null, created_at: NOW, updated_at: NOW, last_seen_at: NOW, ...changes,
});

function setup(collections: Collection[] = COLLECTIONS) {
  const store = createStore(() => ({ collections, loc: { screen: 'library', view: 'all', item: '' } }) as unknown as ArchiveState);
  // The stand-in server: applies a patch the way the real one answers it.
  let current: Item | null = null;
  const patchItem = vi.fn(async (_id: string, patch: Record<string, unknown>) => {
    const base = current ?? useSaveMoment.getState().moment!.item;
    const next: Item = { ...base };
    if (Array.isArray(patch.collection_ids)) {
      const ids = patch.collection_ids as string[];
      next.collections = [...base.collections.filter(c => c.kind === 'source'), ...collections.filter(c => ids.includes(c.id)).map(c => ({ id: c.id, name: c.name, kind: c.kind }))];
    }
    if (typeof patch.status === 'string') next.status = patch.status as Item['status'];
    current = next;
    return next;
  });
  const archive = { store, api: { patchItem }, refreshEditedItem: vi.fn(async () => {}), openItem: vi.fn(async () => true) } as unknown as Archive;
  render(<ArchiveProvider archive={archive}><SaveTray /></ArchiveProvider>);
  return { archive, store, patchItem };
}

const show = (item: Item, options?: { carried?: boolean }) => act(() => showSaveMoment(item, options));
const press = async (name: string | RegExp) => { await act(async () => { fireEvent.click(screen.getByRole('button', { name })); }); };
const tray = () => screen.queryByRole('region');
const buttons = () => screen.getAllByRole('button').map(button => button.getAttribute('aria-label') || button.textContent);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useSaveMoment.getState().close();
  useDialogs.getState().closeAll();
  useConfirm.getState().settle(false);
  for (const message of useIsland.getState().messages) useIsland.getState().dismiss(message.id);
});

describe('the tray after a save', () => {
  it('says the link was kept, names it, and offers the fullest collections and To revisit', () => {
    setup();
    show(save());
    expect(screen.getByRole('region', { name: 'Just saved' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Kept in your archive.');
    expect(screen.getByRole('status')).toHaveTextContent('Brown butter chocolate chip cookies · TikTok');
    expect(screen.getByText('File it in')).toBeInTheDocument();
    expect(buttons()).toEqual(['Done', 'Weeknight dinners', 'Baking', 'To revisit', 'Another collection', 'Open it']);
    expect(screen.queryByRole('button', { name: 'Saved on Instagram' })).toBeNull();
  });

  it('leaves by itself after five seconds when nobody touches it', () => {
    setup();
    show(save());
    expect(screen.getByTestId('save-tray-countdown')).toHaveAttribute('aria-hidden', 'true');
    act(() => { vi.advanceTimersByTime(TRAY_MS - 1); });
    expect(tray()).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    expect(tray()).toBeNull();
  });

  it('stays once it is touched, until Done', async () => {
    setup();
    show(save());
    fireEvent.pointerDown(screen.getByRole('region'));
    expect(screen.queryByTestId('save-tray-countdown')).toBeNull();
    act(() => { vi.advanceTimersByTime(TRAY_MS * 4); });
    expect(tray()).toBeInTheDocument();
    await press('Done');
    expect(tray()).toBeNull();
  });

  it('stays once focus reaches one of its buttons without a touch or a key, as a screen reader moves', () => {
    setup();
    show(save());
    // Focus put on the tray itself when the save form closes is not the person acting: the clock keeps running.
    act(() => screen.getByRole('region').focus());
    expect(screen.getByTestId('save-tray-countdown')).toBeInTheDocument();
    act(() => screen.getByRole('button', { name: 'Baking' }).focus());
    expect(screen.queryByTestId('save-tray-countdown')).toBeNull();
    act(() => { vi.advanceTimersByTime(TRAY_MS * 2); });
    expect(tray()).toBeInTheDocument();
  });

  it('stays once a key is pressed in it, and Escape closes it', () => {
    setup();
    show(save());
    fireEvent.keyDown(screen.getByRole('region'), { key: 'Tab' });
    act(() => { vi.advanceTimersByTime(TRAY_MS * 2); });
    expect(tray()).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(tray()).toBeNull();
  });

  it('files the save in a collection with one tap, marks the chip with more than colour, and can be undone', async () => {
    const { patchItem, archive } = setup();
    show(save());
    await press('Baking');
    expect(patchItem).toHaveBeenLastCalledWith('item-1', { collection_ids: ['baking'] });
    expect(screen.getByRole('status')).toHaveTextContent('Filed in Baking.');
    expect(screen.getByRole('button', { name: 'Baking' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Weeknight dinners' })).toHaveAttribute('aria-pressed', 'false');
    expect(archive.refreshEditedItem).toHaveBeenCalledTimes(1);
    // Undo takes Done's place beside the words, and Done moves to the end: there is always a way out.
    expect(buttons()).toEqual(['Undo', 'Weeknight dinners', 'Baking', 'To revisit', 'Another collection', 'Open it', 'Done']);
    expect(screen.queryByText('File it in')).toBeNull();
    // A save can go in more than one; the list sent is always the whole of the local memberships.
    await press('Weeknight dinners');
    expect(patchItem).toHaveBeenLastCalledWith('item-1', { collection_ids: ['baking', 'dinners'] });
    await press('Undo');
    expect(patchItem).toHaveBeenLastCalledWith('item-1', { collection_ids: ['baking'] });
    expect(screen.getByRole('status')).toHaveTextContent('Kept in your archive.');
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('takes a save back out when a chosen chip is tapped again', async () => {
    const { patchItem } = setup();
    show(save({ collections: [{ id: 'baking', name: 'Baking', kind: 'local' }, { id: 'ig', name: 'Saved on Instagram', kind: 'source' }] }));
    // Chosen in the save form, so it is shown as chosen and comes first.
    expect(buttons().slice(1, 3)).toEqual(['Baking', 'Weeknight dinners']);
    expect(screen.getByRole('button', { name: 'Baking' })).toHaveAttribute('aria-pressed', 'true');
    await press('Baking');
    expect(patchItem).toHaveBeenLastCalledWith('item-1', { collection_ids: [] });
    expect(screen.getByRole('status')).toHaveTextContent('Taken out of Baking.');
  });

  it('marks a save to revisit and puts it back as it was', async () => {
    const { patchItem } = setup();
    show(save());
    await press('To revisit');
    expect(patchItem).toHaveBeenLastCalledWith('item-1', { status: 'to_revisit' });
    expect(screen.getByRole('status')).toHaveTextContent('Marked to revisit.');
    await press('To revisit');
    expect(patchItem).toHaveBeenLastCalledWith('item-1', { status: 'inbox' });
  });

  it('says so when filing fails, and changes nothing', async () => {
    const { patchItem } = setup();
    patchItem.mockRejectedValueOnce(new Error('The archive did not answer.'));
    show(save());
    await press('Baking');
    expect(useIsland.getState().messages.at(-1)).toMatchObject({ text: 'The archive did not answer.', tone: 'error' });
    expect(screen.getByRole('status')).toHaveTextContent('Kept in your archive.');
    expect(screen.getByRole('button', { name: 'Baking' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('offers no collection chips when there are no collections', () => {
    setup([]);
    show(save());
    expect(screen.queryByText('File it in')).toBeNull();
    expect(buttons()).toEqual(['Done', 'To revisit', 'Open it']);
  });

  it('opens the save from the tray', async () => {
    const { archive } = setup();
    show(save());
    await press('Open it');
    expect(archive.openItem).toHaveBeenCalledWith('item-1');
    expect(tray()).toBeNull();
  });

  it('hands the choice of another collection to the collection dialog, and steps aside for it', async () => {
    setup();
    show(save());
    await press('Another collection');
    expect(useDialogs.getState().stack.at(-1)).toMatchObject({ kind: 'bulk', action: 'collection', ids: ['item-1'] });
    expect(tray()).toBeNull();
  });

  it('leaves when the page moves to another view', () => {
    const { store } = setup();
    show(save());
    act(() => store.setState({ loc: { screen: 'library', view: 'favorites', item: '' } } as unknown as ArchiveState));
    expect(tray()).toBeNull();
  });
});

describe('the tray for a link that was already kept', () => {
  const first = save({ created_at: `${YEAR}-03-12T12:00:00+00:00`, saved_at: `${YEAR}-03-12T12:00:00+00:00`, collections: [{ id: 'baking', name: 'Baking', kind: 'local' }] });

  it('says so, with when and where the first copy is, and does not count down', () => {
    setup();
    show(first);
    expect(screen.getByRole('region', { name: 'Already saved' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('You already kept this.');
    expect(screen.getByRole('status')).toHaveTextContent('Saved on 12 March, in Baking. No second copy was made.');
    expect(buttons()).toEqual(['Open it', 'Mark to revisit', 'Done']);
    expect(screen.queryByTestId('save-tray-countdown')).toBeNull();
    act(() => { vi.advanceTimersByTime(TRAY_MS * 4); });
    expect(tray()).toBeInTheDocument();
  });

  it('says the first save was updated when the form carried something', () => {
    setup();
    show(first, { carried: true });
    expect(screen.getByRole('status')).toHaveTextContent('the first one was updated with what you entered');
  });

  it('marks the first copy to revisit', async () => {
    const { patchItem } = setup();
    show(first);
    await press('Mark to revisit');
    expect(patchItem).toHaveBeenLastCalledWith('item-1', { status: 'to_revisit' });
    expect(screen.getByRole('button', { name: 'Mark to revisit' })).toHaveAttribute('aria-pressed', 'true');
  });
});
