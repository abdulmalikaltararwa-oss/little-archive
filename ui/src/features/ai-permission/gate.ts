// The permission step before saved content is sent to an AI service. Every action that can send it calls
// `allowAi` first and stops when the answer is false; nothing is requested from the server's AI routes before
// the person has said yes. The answer is kept with the library (PATCH /api/settings `ai_sharing_allowed`), which
// on a hosted service means with the account. The server checks the same answer before it sends anything, and
// refuses with `ai_permission_required` when it is missing; `askAiAgain` turns that refusal back into the question.
import { create } from 'zustand';
import { toast } from '@/app/ui-state';
import type { Archive } from '@/data/archive';
import { describeSharing, type AiAction, type Disclosure, type EnrichmentStatus, type SharingContext } from './disclosure';

interface PermissionState {
  request: { disclosure: Disclosure; resolve: (allowed: boolean) => void; opener: Element | null } | null;
  ask(disclosure: Disclosure): Promise<boolean>;
  settle(allowed: boolean): void;
}

export const useAiPermission = create<PermissionState>((set, get) => ({
  request: null,
  ask(disclosure) {
    // One question at a time: a second one takes the place of the first, which counts as "Not now".
    get().request?.resolve(false);
    return new Promise<boolean>(resolve => {
      set({ request: { disclosure, resolve, opener: typeof document === 'undefined' ? null : document.activeElement } });
    });
  },
  settle(allowed) {
    const pending = get().request;
    if (!pending) return;
    set({ request: null });
    pending.resolve(allowed);
  },
}));

// A yes that the server could not keep (an older server without the setting, a dropped connection) still holds
// until the page is closed, so the person is not asked again for every action.
const allowedForNow = new WeakSet<object>();

function context(archive: Archive, status: EnrichmentStatus | null): SharingContext {
  const state = archive.store.getState();
  return {
    settings: state.settings ?? {},
    features: state.features ?? null,
    hostedAccount: archive.backend?.mode === 'hosted' || state.features?.mode === 'hosted',
    status,
  };
}

/** What the switch in Settings needs: whether this server would send anything anywhere, without asking it again. */
export function sharingApplies(archive: Archive): boolean {
  return archive.backend?.kind !== 'demo' && describeSharing('settings', context(archive, null)) !== null;
}

/**
 * Resolves true when the action may go ahead: nothing would leave the person's own server, or they have allowed
 * it (before, or just now in the dialog). Resolves false on "Not now", and then the caller sends nothing.
 */
export async function allowAi(archive: Archive, action: AiAction): Promise<boolean> {
  // The demo has no server and no model: nothing can be sent.
  if (archive.backend?.kind === 'demo') return true;
  if (archive.store.getState().settings?.ai_sharing_allowed || allowedForNow.has(archive)) return true;
  // From the settings alone first, so a server with no hosted service is never asked for its status.
  if (!describeSharing(action, context(archive, null))) return true;
  const status = await archive.api.request<EnrichmentStatus>('/enrichment/status').catch(() => null);
  const disclosure = describeSharing(action, context(archive, status));
  if (!disclosure) return true;
  if (!(await useAiPermission.getState().ask(disclosure))) return false;
  try {
    archive.setSettings(await archive.api.patchSettings({ ai_sharing_allowed: true }));
    if (!archive.store.getState().settings?.ai_sharing_allowed) throw new Error('not kept');
  } catch {
    allowedForNow.add(archive);
    toast('Allowed for now. This server could not keep your answer, so it will ask again next time.');
  }
  return true;
}

/**
 * The server said the permission is missing although this page thought it was given (it was withdrawn somewhere
 * else, or the server could not keep it). What this page remembered is dropped and the question is asked again.
 */
export async function askAiAgain(archive: Archive): Promise<boolean> {
  allowedForNow.delete(archive);
  const settings = archive.store.getState().settings;
  if (settings?.ai_sharing_allowed) archive.setSettings({ ...settings, ai_sharing_allowed: false });
  if (!(await allowAi(archive, 'settings'))) return false;
  // Only an answer the server kept lets the request through; "allowed for now" would be refused again.
  return Boolean(archive.store.getState().settings?.ai_sharing_allowed);
}

/** Withdraws the permission. The next AI action asks again, and the server holds work already queued until it is given again. */
export async function withdrawAi(archive: Archive): Promise<void> {
  allowedForNow.delete(archive);
  archive.setSettings(await archive.api.patchSettings({ ai_sharing_allowed: false }));
}
