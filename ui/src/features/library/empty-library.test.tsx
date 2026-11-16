import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveProvider } from '@/app/archive-context';
import { useDialogs } from '@/app/ui-state';
import type { Archive } from '@/data/archive';
import type { BackendKind } from '@/data/backend';
import { EmptyLibrary } from './empty-library';

afterEach(() => {
  cleanup();
  useDialogs.getState().closeAll();
});

function view(kind: BackendKind) {
  const archive = { backend: { kind } } as unknown as Archive;
  return render(<ArchiveProvider archive={archive}><EmptyLibrary /></ArchiveProvider>);
}

const kinds = () => useDialogs.getState().stack.map(dialog => dialog.kind);

describe('an empty library', () => {
  it('teaches the share sheet inside the phone app', () => {
    view('native');
    expect(screen.getByRole('heading', { level: 2, name: 'Save from any app with Share.' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('heading', { level: 3, name: 'Choose Little Archive' })).toBeInTheDocument();
    expect(screen.getByText(/Nothing is kept until you tap Save/)).toBeInTheDocument();
    expect(screen.queryByText(/extension/i)).toBeNull();
  });

  it('teaches pasting a link in a browser, with no word about a share sheet', () => {
    const { container } = view('browser');
    expect(screen.getByRole('heading', { level: 2, name: 'Every collection starts with one link.' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Choose Save a link and paste it' })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/share|row of apps/i);
    expect(screen.getByText(/companion extension for Chrome/)).toBeInTheDocument();
  });

  it('leaves the extension out of the demo, which has no server for it to reach', () => {
    view('demo');
    expect(screen.getByRole('heading', { level: 3, name: 'Copy the link' })).toBeInTheDocument();
    expect(screen.queryByText(/extension/i)).toBeNull();
  });

  it.each(['native', 'browser', 'demo'] as const)('keeps saving a link, importing and the demo saves in reach (%s)', async kind => {
    view(kind);
    expect(screen.getByRole('button', { name: 'Try demo saves' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save a link' }));
    await userEvent.click(screen.getByRole('button', { name: 'Import your saves' }));
    expect(kinds()).toEqual(['save-link', 'import']);
  });

  it('opens the connections part of Settings for the extension', async () => {
    view('browser');
    await userEvent.click(screen.getByRole('button', { name: 'Set it up in Settings' }));
    expect(useDialogs.getState().stack.at(-1)).toMatchObject({ kind: 'settings', section: 'connections' });
  });
});
