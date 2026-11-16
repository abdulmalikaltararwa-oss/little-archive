import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { ArchiveProvider } from '@/app/archive-context';
import type { Archive, ArchiveState } from '@/data/archive';
import type { Item } from '@/data/types';
import { WallEnd } from './wall-end';

afterEach(cleanup);

const saves = (dates: (string | null)[]) => dates.map((saved_at, index) => ({ id: `item-${index}`, saved_at }) as Item);
const DATED = saves(['2024-06-15T12:00:00+00:00', '2023-03-15T12:00:00+00:00', '2025-01-15T12:00:00+00:00']);

function view(changes: Partial<ArchiveState> = {}, kind = 'browser') {
  const state = {
    list: 'ready', items: DATED, total: 3, loadingMore: false,
    filters: { sort: 'recent' }, loc: { view: 'all', q: '', tag: '', platform: '' }, stats: { total: 3, archived: 0 },
    ...changes,
  } as unknown as ArchiveState;
  const archive = { store: createStore(() => state), backend: { kind } } as unknown as Archive;
  return render(<ArchiveProvider archive={archive}><WallEnd /></ArchiveProvider>);
}

describe('the end of the wall', () => {
  it('says that was everything, in real text, with the garden under it as decoration', () => {
    const { container } = view();
    expect(screen.getByText('that is all 3 · your first save was in March 2023')).toBeInTheDocument();
    const garden = container.querySelector('[data-garden="wall"]')!;
    expect(garden).toHaveAttribute('aria-hidden', 'true');
    expect(garden.querySelectorAll('pre').length).toBeGreaterThan(5);
    for (const plant of garden.querySelectorAll('pre')) expect(plant).toHaveAttribute('dir', 'ltr');
    // Nothing in the garden can be reached or pressed.
    expect(garden.querySelector('button, a, [tabindex]')).toBeNull();
  });

  it('is not drawn while the wall is loading', () => {
    const { container } = view({ list: 'loading', items: [], total: 0 });
    expect(container).toBeEmptyDOMElement();
  });

  it('is not drawn mid-list, while there are more saves to load', () => {
    const { container } = view({ total: 240, stats: { total: 240, archived: 0 } as ArchiveState['stats'] });
    expect(container).toBeEmptyDOMElement();
  });

  it('is not drawn while the next page is on its way', () => {
    const { container } = view({ loadingMore: true });
    expect(container).toBeEmptyDOMElement();
  });

  it('is not drawn under an empty view, after an error, or under a shuffled sample', () => {
    expect(view({ items: [], total: 0 }).container).toBeEmptyDOMElement();
    cleanup();
    expect(view({ list: 'error' }).container).toBeEmptyDOMElement();
    cleanup();
    expect(view({ filters: { sort: 'random' } as ArchiveState['filters'] }).container).toBeEmptyDOMElement();
  });

  it('gives only the count when the wall is one view of the library, not all of it', () => {
    view({ loc: { view: 'favorites', q: '', tag: '', platform: '' } as ArchiveState['loc'] });
    expect(screen.getByText('that is all 3')).toBeInTheDocument();
    cleanup();
    view({ loc: { view: 'all', q: 'lemon', tag: '', platform: '' } as ArchiveState['loc'] });
    expect(screen.getByText('that is all 3')).toBeInTheDocument();
  });

  it('gives only the count when an archived save could be the first one', () => {
    view({ stats: { total: 3, archived: 2 } as ArchiveState['stats'] });
    expect(screen.getByText('that is all 3')).toBeInTheDocument();
  });

  it('gives only the count in the demo, whose saves are nobody’s', () => {
    view({}, 'demo');
    expect(screen.getByText('that is all 3')).toBeInTheDocument();
  });

  it('gives only the count when a save has no date of its own', () => {
    view({ items: saves(['2024-06-15T12:00:00+00:00', null, '2025-01-15T12:00:00+00:00']) });
    expect(screen.getByText('that is all 3')).toBeInTheDocument();
  });
});
