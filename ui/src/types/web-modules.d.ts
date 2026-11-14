// Types for the tested buildless modules in ../web, which this interface imports instead of rewriting.
// The modules stay plain JavaScript (the phone app and the public demo also load them); these declarations
// describe exactly what they export today. If one changes, its own tests in web/*.test.mjs are the authority.

declare module '@web/utils.js' {
  type Item = import('@/data/types').Item;
  type Filters = import('@/data/types').Filters;
  type SharedLink = import('@/data/types').SharedLink;
  type ShareFields = import('@/data/types').ShareFields;

  export const PLATFORM_NAMES: Record<string, string>;
  export const STATUS_NAMES: Record<string, string>;
  export const SHARE_PATH: string;
  export function safeURL(value: unknown, options?: { local?: boolean }): string | null;
  export function parseTags(value: string): string[];
  export function buildItemPatch(
    original: Pick<Item, 'title' | 'summary' | 'notes' | 'status' | 'needs_review' | 'tags' | 'collections'>,
    edits: Partial<{ title: string; summary: string; notes: string; status: string; needs_review: boolean; tags: string[]; collection_ids: string[] }>,
  ): Record<string, unknown>;
  export function itemChangeAffectsView(before: Item, after: Item, filters: Filters): boolean;
  export function formatDate(value: string | null | undefined, options?: Intl.DateTimeFormatOptions): string;
  export function hostLabel(value: string | null | undefined): string;
  export function countLabel(value: number | undefined, singular: string, plural?: string): string;
  export function createQuery(filters: Partial<Filters> | Record<string, unknown>, offset?: number, limit?: number): string;
  export function libraryScope(filters: Filters, scope?: 'all' | 'review' | 'view'): Record<string, unknown>;
  export function stableHue(text: string | null | undefined): number;
  export function errorMessage(error: unknown): string;
  export function parseSharedContent(fields?: ShareFields): SharedLink;
  export function readShareTarget(location: Pick<Location, 'pathname' | 'search'> | null | undefined): SharedLink | null;
  export function isTikTokShortLink(value: string): boolean;
}

declare module '@web/demo-store.js' {
  export function createDemoAPI(
    fixtures: readonly unknown[],
    options?: { clock?: () => string },
  ): (path: string, init?: RequestInit) => Promise<Response>;
}

declare module '@web/demo-data.js' {
  export const SYNTHETIC_RECORDS: readonly unknown[];
}

declare module '@web/transport.js' {
  export class TransportError extends Error {}
  export function cleanBaseUrl(value: unknown): string;
  export function apiUrl(baseUrl: string, path: string): string;
  export interface Transport {
    baseUrl: string;
    fetch(path: string, init?: RequestInit): Promise<Response>;
    localAsset(value: unknown): string | null;
    attachImage(image: HTMLImageElement, path: string): void;
    blobUrl(path: string): Promise<string>;
    dispose(): void;
  }
  export function createTransport(options: {
    baseUrl: string;
    http: (request: { url: string; method: string; headers: Record<string, string>; body?: string | Uint8Array }) => Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
    credential: { get: () => Promise<string | null>; refresh?: (failed: string) => Promise<string | null> };
    maxImages?: number;
    imageConcurrency?: number;
    observe?: (image: HTMLImageElement, show: () => void) => void;
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
  }): Transport;
}
