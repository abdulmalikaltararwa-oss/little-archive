import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ArchiveProvider } from '@/app/archive-context';
import { ConfirmHost } from '@/components/confirm';
import { createArchive, memoryHistory } from '@/data/archive';
import { createBrowserBackend } from '@/data/backends/browser';
import type { Item } from '@/data/types';
import { DetailPanel } from './detail-panel';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('keeps an edit made after the full record is queued and only discards it on confirmation', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const saved: Item = {
    id: 'garden', title: 'Paper Garden', url: 'https://example.com/garden', platform: 'web',
    creator: '', caption: '', summary: '', notes: 'The saved note.', content_type: 'post',
    preview_url: null, thumbnail_url: null, tags: [], collections: [], favorite: true, status: 'inbox',
    needs_review: false, saved_at: null, created_at: '', updated_at: '', last_seen_at: '',
  };
  let deliver!: (item: Item) => void;
  const record = new Promise<Item>(resolve => { deliver = resolve; });
  const history = memoryHistory('#/favorites?q=garden');
  const fetchImpl = vi.fn(async () => { throw new Error('Unexpected request'); });
  const backend = createBrowserBackend({ fetchImpl });
  const archive = createArchive({ backend, history });
  archive.store.setState({ phase: 'ready', items: [saved], featuresKnown: true });
  vi.spyOn(archive.api, 'item').mockReturnValue(record);
  render(<ArchiveProvider archive={archive}><DetailPanel /><ConfirmHost /></ArchiveProvider>);

  try {
    await act(async () => { await archive.openItem(saved.id); });
    const openAddress = '#/favorites?q=garden&item=garden';
    const notes = screen.getByRole('textbox', { name: 'Your notes' });
    expect(notes).toHaveValue('The saved note.');

    // The load handler runs first, but React renders both updates after the input event.
    await act(async () => {
      deliver({ ...saved, title: 'Paper Garden in full' });
      await record;
      fireEvent.change(notes, { target: { value: 'An unsaved thought.' } });
    });
    expect(screen.getByRole('heading', { name: 'Paper Garden in full' })).toBeInTheDocument();

    const goBack = async () => {
      await act(async () => { history.back(); });
      return screen.getByRole('alertdialog', { name: 'Discard your unsaved changes?' });
    };
    const question = await goBack();
    await act(async () => { fireEvent.click(within(question).getByRole('button', { name: 'Keep editing' })); });
    expect(history.hash()).toBe(openAddress);
    expect(screen.getByRole('textbox', { name: 'Your notes' })).toHaveValue('An unsaved thought.');

    const discard = await goBack();
    await act(async () => { fireEvent.click(within(discard).getByRole('button', { name: 'Discard changes' })); });
    expect(history.hash()).toBe('#/favorites?q=garden');
    expect(screen.queryByRole('dialog', { name: 'A closer look' })).toBeNull();
    await act(async () => { await archive.openItem(saved.id); });
    expect(screen.getByRole('textbox', { name: 'Your notes' })).toHaveValue('The saved note.');
    expect(fetchImpl).not.toHaveBeenCalled();
  } finally {
    archive.dispose();
  }
});
