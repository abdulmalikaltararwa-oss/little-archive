// Every call the interface makes, named and typed against API_CONTRACT.md.
import { createQuery } from '@web/utils.js';
import type { Client } from './client';
import type {
  Account, AccountDeletion, AiJobList, Features, PurchaseResult, Purchases, StoreProof, AuthState, BulkAction, Collection, ExtensionToken, Filters, ImportResult, ImportRun, Item, ItemList, Settings, Stats, Tag,
} from './types';

export type Scope = Record<string, unknown>;

export function createApi(client: Client) {
  const { request } = client;
  const post = <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body });
  return {
    me: () => request<AuthState>('/auth/me'),
    login: (password: string) => post<AuthState>('/auth/login', { password }),
    logout: () => post<{ ok: boolean }>('/auth/logout'),

    stats: () => request<Stats>('/stats'),
    collections: () => request<{ collections: Collection[] }>('/collections'),
    tags: () => request<{ tags: Tag[] }>('/tags'),
    settings: () => request<Settings>('/settings'),
    patchSettings: (patch: Partial<Pick<Settings, 'remote_previews' | 'ai_sharing_allowed'>>) => request<Settings>('/settings', { method: 'PATCH', body: patch }),

    items: (filters: Partial<Filters> | Scope, offset = 0, limit = 60, signal?: AbortSignal) => request<ItemList>(`/items?${createQuery(filters, offset, limit)}`, { signal }),
    item: (id: string) => request<Item>(`/items/${encodeURIComponent(id)}`),
    createItem: (body: { url: string; title?: string; notes?: string; tags?: string[]; collection_ids?: string[] }) => post<Item>('/items', body),
    patchItem: (id: string, patch: Record<string, unknown>) => request<Item>(`/items/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
    deleteItem: (id: string) => request<{ ok: boolean }>(`/items/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    bulk: (body: { ids?: string[]; filters?: Scope; action: BulkAction; value?: string }) => post<{ updated: number }>('/items/bulk', body),
    uploadThumbnail: (id: string, file: Blob) => request<Item>(`/items/${encodeURIComponent(id)}/thumbnail`, { method: 'POST', body: file, raw: true, headers: { 'Content-Type': file.type || 'application/octet-stream' } }),
    deleteThumbnail: (id: string) => request<Item>(`/items/${encodeURIComponent(id)}/thumbnail`, { method: 'DELETE' }),

    acceptAi: (id: string) => post<Item>(`/items/${encodeURIComponent(id)}/ai/accept`),
    dismissAi: (id: string) => post<Item>(`/items/${encodeURIComponent(id)}/ai/dismiss`),
    deepRead: (id: string) => post<{ queued: number }>(`/items/${encodeURIComponent(id)}/deep-read`),
    queueAi: (body: { ids: string[] } | { filters: Scope }) => post<{ queued: number; matched: number; unchanged: number; skipped?: number; limit?: { scope?: string; resets_at?: string | null } }>('/ai/jobs', body),
    aiJobs: (limit = 25, offset = 0) => request<AiJobList>(`/ai/jobs?limit=${limit}&offset=${offset}`),
    cancelAi: () => post<{ cancelled: number }>('/ai/jobs/cancel'),
    retryAi: (id: string) => post<{ queued: number }>(`/ai/jobs/${encodeURIComponent(id)}/retry`),

    createCollection: (body: { name: string; color: string }) => post<Collection>('/collections', body),
    patchCollection: (id: string, body: { name?: string; color?: string }) => request<Collection>(`/collections/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    deleteCollection: (id: string) => request<{ ok: boolean }>(`/collections/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    importFile: (file: File) => request<ImportResult>(`/imports/file?filename=${encodeURIComponent(file.name)}`, { method: 'POST', body: file, raw: true, headers: { 'Content-Type': 'application/octet-stream' } }),
    imports: () => request<{ imports: ImportRun[] }>('/imports'),

    tokens: () => request<{ tokens: ExtensionToken[] }>('/extension/tokens'),
    createToken: (name: string) => post<{ id: string; name: string; token: string }>('/extension/tokens', { name }),
    revokeToken: (id: string) => request<{ ok: boolean }>(`/extension/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    addDemo: () => post<{ created: number }>('/demo'),
    account: () => request<Account>('/account'),
    deleteAccount: () => post<AccountDeletion>('/account/delete', { confirm: 'DELETE' }),

    purchases: () => request<Purchases>('/purchases'),
    /** Hands a store's proof to the server, which verifies it with the store. The body never says "unlocked". */
    submitPurchase: (proof: StoreProof) =>
      proof.provider === 'apple'
        ? post<PurchaseResult>('/purchases/apple', { signed_transaction: proof.signed_transaction })
        : post<PurchaseResult>('/purchases/google', { product_id: proof.product_id, purchase_token: proof.purchase_token }),

    features: () => request<Features>('/features'),

    download: client.download,
    /** For feature modules that keep their own typed calls beside their screens (src/features/<name>/api.ts). */
    request,
  };
}

export type Api = ReturnType<typeof createApi>;
