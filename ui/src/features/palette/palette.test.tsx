import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { ArchiveProvider } from '@/app/archive-context';
import type { OpenDialog } from '@/app/ui-state';
import type { Archive, ArchiveState } from '@/data/archive';
import { HOME } from '@/data/location';
import type { Item, ItemList } from '@/data/types';
import { CommandPalette } from './palette';
import { addRecent, clearRecent, readRecent } from './recent';

// cmdk measures and scrolls its list; jsdom has neither.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});

afterEach(() => {
  cleanup();
  clearRecent(true);
});

const save = (id: string, changes: Partial<Item>): Item => ({
  id, platform: 'tiktok', url: `https://www.tiktok.com/@a/video/${id}`, title: '', creator: '', caption: '', summary: '', notes: '', content_type: 'video', preview_url: null, thumbnail_url: null,
  tags: [], collections: [], favorite: false, status: 'inbox', needs_review: false, saved_at: null, created_at: '', updated_at: '', last_seen_at: '', ...changes,
});

const CHAI: Item[] = [
  save('1', { title: 'Karak chai at home, properly strong', creator: '@chaiwithdana', match_in: ['title'] }),
  save('2', { title: 'Where to drink tea in Souq Al-Mubarakiya', platform: 'instagram', caption: 'We found the chai haleeb stall by the gate', match_in: ['caption'] }),
  save('3', { title: 'Enamel mugs, small batch', platform: 'web', url: 'https://example.com/mugs', notes: 'for chai on the balcony', match_in: ['notes'] }),
];

function setup(answers: Record<string, { items: Item[]; total: number }> = {}) {
  const state = {
    stats: { total: 1284, favorites: 96, to_revisit: 41, needs_review: 7, archived: 0, collections: 1, platforms: { instagram: 700, tiktok: 500, web: 84 } },
    tags: [{ name: 'dessert', count: 19 }, { name: 'coffee', count: 8 }],
    collections: [{ id: 'c1', name: 'Weeknight dinners', kind: 'local', count: 58 }],
  } as unknown as ArchiveState;
  const items = vi.fn(async (filters: { q?: string }): Promise<ItemList> => {
    const answer = answers[filters.q ?? ''] ?? { items: [], total: 0 };
    return { ...answer, limit: 6, offset: 0 };
  });
  const archive = { backend: { remembers: true }, store: createStore(() => state), api: { items }, navigate: vi.fn(), openItem: vi.fn(async () => true), goView: vi.fn(), goScreen: vi.fn() } as unknown as Archive;
  const close = vi.fn();
  const spec = { kind: 'palette', id: 1, opener: null, open: true } as OpenDialog;
  render(<ArchiveProvider archive={archive}><CommandPalette spec={spec} close={close} /></ArchiveProvider>);
  return { archive, items, close };
}

const type = (value: string) => fireEvent.change(screen.getByRole('combobox'), { target: { value } });
const option = (name: string | RegExp) => screen.getByRole('option', { name });

describe('search before anything is typed', () => {
  it('offers the recent searches with how many saves each finds now, and searches built from the library', async () => {
    addRecent(true, 'kyoto');
    addRecent(true, 'machboos');
    setup({ machboos: { items: [], total: 3 }, kyoto: { items: [], total: 12 } });
    expect(screen.getByRole('status')).toHaveTextContent('search · 1,284 saves');
    await waitFor(() => expect(option(/^machboos/)).toHaveTextContent('3 saves'));
    expect(option(/^kyoto/)).toHaveTextContent('12 saves');
    expect(option(/^dessert/)).toHaveTextContent('19');
    expect(option(/^In Weeknight dinners/)).toHaveTextContent('58');
    expect(option(/^From Instagram/)).toHaveTextContent('700');
    expect(option('To revisit, oldest first')).toBeInTheDocument();
    // The views and actions the palette always offered are still under them.
    expect(option('All saves')).toBeInTheDocument();
    expect(option('Save a link')).toBeInTheDocument();
  });

  it('shows no Recent section until a search has been made', () => {
    setup();
    expect(screen.queryByText('recent')).toBeNull();
    expect(screen.getByText('from your library')).toBeInTheDocument();
  });

  it('runs a recent search as a finished search and moves it to the front', async () => {
    addRecent(true, 'kyoto');
    addRecent(true, 'machboos');
    const { archive, close } = setup();
    fireEvent.click(option(/^kyoto/));
    expect(archive.navigate).toHaveBeenCalledWith({ ...HOME, q: 'kyoto' });
    expect(close).toHaveBeenCalled();
    expect(readRecent(true)).toEqual(['kyoto', 'machboos']);
  });

  it('runs a suggestion as a finished search', () => {
    const { archive } = setup();
    fireEvent.click(option('To revisit, oldest first'));
    expect(archive.navigate).toHaveBeenLastCalledWith({ ...HOME, view: 'revisit', sort: 'oldest' });
    fireEvent.click(option(/^dessert/));
    expect(archive.navigate).toHaveBeenLastCalledWith({ ...HOME, tag: 'dessert' });
    // A suggestion is not something the person typed, so it is not kept as a recent search.
    expect(readRecent(true)).toEqual([]);
  });

  it('forgets the recent searches on Clear and keeps the keyboard in the field', () => {
    addRecent(true, 'kyoto');
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Clear recent searches' }));
    expect(screen.queryByRole('option', { name: /^kyoto/ })).toBeNull();
    expect(readRecent(true)).toEqual([]);
    expect(screen.getByRole('combobox')).toHaveFocus();
  });

  it('has a Cancel beside the field for the phone layout', () => {
    const { close } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(close).toHaveBeenCalled();
  });
});

describe('search while typing', () => {
  it('says how many were found, marks the words, and says where they were found', async () => {
    setup({ chai: { items: CHAI, total: 3 } });
    type('chai');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('search · 3 of 1,284'));
    const inTitle = option(/^Karak chai at home/);
    expect(within(inTitle).getByText('chai').tagName).toBe('MARK');
    expect(inTitle).toHaveTextContent('TikTok · @chaiwithdana');
    const inCaption = option(/^Where to drink tea/);
    expect(inCaption).toHaveTextContent('In the caption: “We found the chai haleeb stall by the gate”');
    expect(within(inCaption).getByText('chai').tagName).toBe('MARK');
    expect(option(/^Enamel mugs/)).toHaveTextContent('In your note: “for chai on the balcony”');
    // Every result is in hand and they come from three sources, so each source narrows the search in one tap.
    expect(option(/^Only TikTok/)).toHaveTextContent('1');
    expect(option(/^Only Instagram/)).toHaveTextContent('1');
  });

  it('remembers a search that was carried out, whether by opening a result or by searching the library', async () => {
    const { archive } = setup({ chai: { items: CHAI, total: 3 } });
    type('chai');
    await waitFor(() => expect(option(/^Enamel mugs/)).toBeInTheDocument());
    fireEvent.click(option(/^Enamel mugs/));
    expect(archive.openItem).toHaveBeenCalledWith('3');
    expect(readRecent(true)).toEqual(['chai']);
    type('karak chai');
    fireEvent.click(option(/^Search the library for “karak chai”/));
    expect(archive.navigate).toHaveBeenLastCalledWith({ ...HOME, q: 'karak chai' });
    expect(readRecent(true)).toEqual(['karak chai', 'chai']);
  });

  it('narrows to one source', async () => {
    const { archive } = setup({ chai: { items: CHAI, total: 3 } });
    type('chai');
    await waitFor(() => expect(option(/^Only Instagram/)).toBeInTheDocument());
    fireEvent.click(option(/^Only Instagram/));
    expect(archive.navigate).toHaveBeenLastCalledWith({ ...HOME, q: 'chai', platform: 'instagram' });
  });

  it('does not offer to narrow when more was found than is shown', async () => {
    setup({ chai: { items: CHAI, total: 40 } });
    type('chai');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('search · 40 of 1,284'));
    expect(screen.queryByRole('option', { name: /^Only/ })).toBeNull();
  });
});

describe('a search that finds nothing', () => {
  it('says so, says what search looks at, and offers the most used topics', async () => {
    const { archive } = setup();
    type('tiramisu');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Nothing for “tiramisu”.' })).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('search · 0 of 1,284');
    expect(screen.getByText(/Search looks at titles, captions, topics, your notes and transcripts/)).toBeInTheDocument();
    // An empty library is not offered as a result.
    expect(screen.queryByRole('option', { name: /^Search the library/ })).toBeNull();
    // Nothing in the list is chosen for Enter: the topics are buttons to tap, not the answer to what was typed.
    expect(screen.queryAllByRole('option')).toEqual([]);
    expect(screen.getByRole('button', { name: /^Try “dessert”/ })).toHaveTextContent('19');
    fireEvent.click(screen.getByRole('button', { name: /^Try “coffee”/ }));
    expect(archive.navigate).toHaveBeenLastCalledWith({ ...HOME, tag: 'coffee' });
  });

  it('still offers a view or an action the words name', async () => {
    setup();
    type('settings');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
    expect(screen.queryByRole('heading', { name: /^Nothing for/ })).toBeNull();
    expect(option('Settings & connections')).toBeInTheDocument();
    expect(option(/^Search the library for “settings”/)).toBeInTheDocument();
  });
});
