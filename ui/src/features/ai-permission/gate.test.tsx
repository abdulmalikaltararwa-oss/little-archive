import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { Archive } from '@/data/archive';
import type { Settings } from '@/data/types';
import { PRIVACY_URL } from '@/lib/site';
import { allowAi, askAiAgain, sharingApplies, useAiPermission, withdrawAi } from './gate';
import { AiPermissionHost } from './host';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null }),
  });
});
afterEach(() => {
  useAiPermission.getState().settle(false);
  cleanup();
});

const GEMINI: Settings = { remote_previews: false, ai_sharing_allowed: false, ai_enabled: true, ai_model: 'gemini-flash', ai_provider: 'gemini', ai_hosted: true, transcription_available: false };
const OLLAMA: Settings = { remote_previews: false, ai_sharing_allowed: false, ai_enabled: true, ai_model: 'gemma', ai_provider: 'ollama', ai_hosted: false, transcription_available: false };

interface Setup { settings: Settings; mode?: 'self-hosted' | 'hosted'; kind?: 'browser' | 'native' | 'demo'; patch?: (body: Partial<Settings>) => Promise<Settings>; status?: () => Promise<unknown> }

function rig({ settings, mode = 'hosted', kind = 'native', patch, status = async () => ({ analysis: { provider: settings.ai_provider, hosted: settings.ai_hosted, evidence_mode: 'public' }, transcription: { provider: null, auto: false } }) }: Setup) {
  const store = createStore(() => ({ settings, features: null }));
  const request = vi.fn(async (path: string) => { if (path === '/enrichment/status') return status(); throw new Error(`unexpected ${path}`); });
  const patchSettings = vi.fn(patch ?? (async (body: Partial<Settings>) => ({ ...store.getState().settings, ...body })));
  const archive = {
    backend: { kind, mode }, store, api: { request, patchSettings },
    setSettings: (next: Settings) => store.setState({ settings: next }),
  } as unknown as Archive;
  render(<AiPermissionHost />);
  return { archive, request, patchSettings, store };
}

describe('the permission step before an AI action', () => {
  it('goes straight ahead on a self-hosted server with a local model, and asks the server nothing', async () => {
    const { archive, request, patchSettings } = rig({ settings: OLLAMA, mode: 'self-hosted', kind: 'browser' });
    await expect(allowAi(archive, 'suggest')).resolves.toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(patchSettings).not.toHaveBeenCalled();
    expect(sharingApplies(archive)).toBe(false);
  });

  it('goes straight ahead in the demo, which has no server', async () => {
    const { archive, request } = rig({ settings: GEMINI, kind: 'demo' });
    await expect(allowAi(archive, 'suggest')).resolves.toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it('asks first, names the service, and on "Not now" allows nothing and keeps nothing', async () => {
    const { archive, patchSettings } = rig({ settings: GEMINI });
    const answer = allowAi(archive, 'suggest');
    const dialog = await screen.findByRole('dialog', { name: 'Allow sending saves to an AI service?' });
    expect(dialog).toHaveTextContent('Nothing is sent unless you allow it. One answer covers every action listed here.');
    expect(dialog).toHaveTextContent('what you just asked for');
    expect(dialog).toHaveTextContent('For each save you choose: its title, caption, creator name, image descriptions and any transcript.');
    expect(dialog).toHaveTextContent('This service sends the text to Google’s Gemini service.');
    expect(dialog).toHaveTextContent('Your own notes and the names of your collections are not sent.');
    expect(screen.getByRole('link', { name: /Privacy policy/ })).toHaveAttribute('href', PRIVACY_URL);
    expect(screen.getByRole('link', { name: /Privacy policy/ })).toHaveAttribute('target', '_blank');
    // The safe answer has focus, so Enter alone never sends anything.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Not now' })).toHaveFocus());
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await expect(answer).resolves.toBe(false);
    expect(patchSettings).not.toHaveBeenCalled();
    expect(archive.store.getState().settings.ai_sharing_allowed).toBe(false);
  });

  it('Escape means "Not now"', async () => {
    const { archive, patchSettings } = rig({ settings: GEMINI });
    const answer = allowAi(archive, 'ask');
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    await expect(answer).resolves.toBe(false);
    expect(patchSettings).not.toHaveBeenCalled();
  });

  it('on "Allow" keeps the answer with the account and does not ask again', async () => {
    const { archive, patchSettings, request } = rig({ settings: GEMINI });
    const answer = allowAi(archive, 'recipe');
    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    await expect(answer).resolves.toBe(true);
    expect(patchSettings).toHaveBeenCalledWith({ ai_sharing_allowed: true });
    expect(archive.store.getState().settings.ai_sharing_allowed).toBe(true);
    request.mockClear();
    await expect(allowAi(archive, 'closer-read')).resolves.toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(patchSettings).toHaveBeenCalledTimes(1);
  });

  it('asks again once the permission is withdrawn in Settings', async () => {
    const { archive, patchSettings } = rig({ settings: { ...GEMINI, ai_sharing_allowed: true } });
    await expect(allowAi(archive, 'suggest')).resolves.toBe(true);
    await withdrawAi(archive);
    expect(patchSettings).toHaveBeenCalledWith({ ai_sharing_allowed: false });
    const answer = allowAi(archive, 'suggest');
    await userEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    await expect(answer).resolves.toBe(false);
  });

  it('asks again when the server refuses although this page thought the permission was given', async () => {
    // Withdrawn on another device: this page's copy still says yes, so `allowAi` alone would not ask.
    const { archive, patchSettings } = rig({ settings: { ...GEMINI, ai_sharing_allowed: true } });
    const answer = askAiAgain(archive);
    await screen.findByRole('dialog', { name: 'Allow sending saves to an AI service?' });
    expect(archive.store.getState().settings.ai_sharing_allowed).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await expect(answer).resolves.toBe(true);
    expect(patchSettings).toHaveBeenCalledWith({ ai_sharing_allowed: true });

    await withdrawAi(archive);
    const declined = askAiAgain(archive);
    await userEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    await expect(declined).resolves.toBe(false);
    expect(archive.store.getState().settings.ai_sharing_allowed).toBe(false);
  });

  it('does not count a yes the server could not keep, since the server would refuse the request again', async () => {
    const { archive } = rig({ settings: GEMINI, patch: async () => { throw new Error('offline'); } });
    const answer = askAiAgain(archive);
    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    await expect(answer).resolves.toBe(false);
  });

  it('still asks, in general words, when the server’s status cannot be read', async () => {
    const { archive } = rig({ settings: { ...GEMINI, ai_provider: 'unheard-of' }, status: async () => { throw new Error('offline'); } });
    const answer = allowAi(archive, 'places');
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('This service sends the text to a hosted AI service.');
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await expect(answer).resolves.toBe(false);
  });

  it('a yes the server cannot keep holds until the page is closed', async () => {
    const { archive, patchSettings } = rig({ settings: GEMINI, patch: async () => { throw new Error('422'); } });
    const answer = allowAi(archive, 'suggest');
    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    await expect(answer).resolves.toBe(true);
    await expect(allowAi(archive, 'suggest')).resolves.toBe(true);
    expect(patchSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
  });

  it('a second question replaces the first, which counts as "Not now"', async () => {
    const { archive } = rig({ settings: GEMINI });
    const first = allowAi(archive, 'suggest');
    await screen.findByRole('dialog');
    const second = allowAi(archive, 'ask');
    await expect(first).resolves.toBe(false);
    await waitFor(() => expect(screen.getByRole('dialog').querySelector('li')).toHaveTextContent('Ask your archive'));
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await expect(second).resolves.toBe(false);
  });

  it('a yes given for a question has already named the transcription service a later closer read uses', async () => {
    const settings = { ...GEMINI, transcription_available: true };
    const { archive } = rig({ settings, status: async () => ({ analysis: { provider: 'gemini', hosted: true, evidence_mode: 'public' }, transcription: { provider: 'groq', auto: false } }) });
    const answer = allowAi(archive, 'ask');
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('A closer read');
    expect(dialog).toHaveTextContent('The post’s media file (sound and picture), to be written out as a transcript.');
    expect(dialog).toHaveTextContent('This service sends text to Google’s Gemini service and media files to Groq’s transcription service.');
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await expect(answer).resolves.toBe(true);
    await expect(allowAi(archive, 'closer-read')).resolves.toBe(true);
  });
});
