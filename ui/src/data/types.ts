// The shapes the server sends, as written in API_CONTRACT.md. Nothing here is invented: a field that the
// contract does not name is not typed.

export type Platform = 'instagram' | 'tiktok' | 'web';
export type Status = 'inbox' | 'to_revisit' | 'done' | 'archived';
export type ContentType = 'post' | 'video' | 'article' | 'image' | 'link';
export type Sort = 'recent' | 'oldest' | 'title' | 'random';

export interface CollectionRef {
  id: string;
  name: string;
  kind: 'source' | 'local';
  platform?: Platform;
}

export interface Collection extends CollectionRef {
  source_account?: string;
  color?: string | null;
  count?: number;
}

export interface Evidence {
  kind: 'caption' | 'thumbnail_alt' | 'user_text' | 'transcript' | (string & {});
  text: string;
}

export type EvidenceLevel = 'text-only' | 'caption-based' | 'transcript-based' | (string & {});

export interface AiSuggestion {
  suggested_title?: string;
  summary?: string;
  topics?: string[];
  content_type?: string;
  category?: string;
  suggested_folder?: string;
  evidence_level?: EvidenceLevel;
  evidence_sources?: string[];
  evidence_note?: string;
  needs_review?: boolean;
  provider?: string;
  model?: string;
  created_at?: string;
}

export interface DeepRead {
  available: boolean;
  reason: string;
  state: '' | 'queued' | 'running' | 'failed';
  error: string;
}

export interface Enrichment {
  page: null | Record<string, unknown>;
  transcript: null | Record<string, unknown>;
  transcript_needed?: boolean;
  transcript_reason?: string;
  deep_read?: DeepRead;
}

export interface Item {
  id: string;
  platform: Platform;
  source_account?: string;
  source_key?: string;
  url: string;
  title: string;
  creator: string;
  caption: string;
  summary: string;
  notes: string;
  content_type: ContentType;
  preview_url: string | null;
  thumbnail_url: string | null;
  tags: string[];
  collections: CollectionRef[];
  favorite: boolean;
  status: Status;
  needs_review: boolean;
  saved_at: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  evidence?: Evidence[];
  ai?: AiSuggestion | null;
  enrichment?: Enrichment;
  match_in?: string[];
}

export interface ItemList {
  items: Item[];
  total: number;
  limit: number;
  offset: number;
}

export interface Stats {
  total: number;
  favorites: number;
  to_revisit: number;
  needs_review: number;
  archived: number;
  collections: number;
  platforms: Partial<Record<Platform, number>>;
}

export interface Tag {
  name: string;
  count: number;
}

export interface Settings {
  remote_previews: boolean;
  /** The owner's yes to sending saved content to an AI service. Absent on a server that does not keep it. */
  ai_sharing_allowed?: boolean;
  ai_enabled: boolean;
  ai_model: string;
  ai_available?: boolean;
  ai_provider?: string;
  ai_hosted?: boolean;
  page_fetch_enabled?: boolean;
  transcription_available?: boolean;
  shared_cache_enabled?: boolean;
}

export interface Filters {
  q: string;
  platform: '' | Platform;
  collection_id: string;
  tag: string;
  status: '' | Status;
  favorite: boolean;
  needs_review: boolean;
  sort: Sort;
}

export type BulkAction = 'favorite' | 'unfavorite' | 'tag' | 'collection' | 'archive' | 'restore';

export interface ImportResult {
  run_id: string;
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
  coverage: 'partial' | 'enumeration_exhausted';
}

export interface ImportRun {
  id: string;
  source: string;
  source_account?: string;
  status: string;
  coverage?: string;
  created?: number;
  updated?: number;
  skipped?: number;
  error?: string;
  started_at?: string;
  finished_at?: string;
  created_at?: string;
}

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface AiJob {
  id: string;
  item_id?: string;
  title?: string;
  status: JobStatus;
  error?: string;
  created_at?: string;
  updated_at?: string;
  started_at?: string;
}

export interface AiJobList {
  jobs: AiJob[];
  total: number;
  counts: Record<JobStatus, number>;
  limit: number;
  offset: number;
}

export interface ExtensionToken {
  id: string;
  name: string;
  created_at?: string;
  last_used_at?: string | null;
}

export interface AuthState {
  authenticated: boolean;
  csrf_token?: string;
  version?: string;
}

/** One allowance window: how much of a day's or month's allowance is used. `limit: null` means no limit. */
export interface AllowanceWindow {
  period: string;
  used: number;
  limit: number | null;
  remaining: number | null;
  resets_at?: string | null;
}

/** GET /api/account. */
export interface Account {
  mode: 'self-hosted' | 'hosted';
  user_id: string | null;
  storage: { used_bytes: number; quota_bytes: number | null };
  entitlements: {
    unlocked: boolean;
    unlocked_via?: null | 'apple' | 'google' | 'tap' | 'manual' | 'owner';
    deep_reads: AllowanceWindow;
    suggestions?: { daily: AllowanceWindow; monthly: AllowanceWindow };
    feature_calls?: { daily: AllowanceWindow; monthly: AllowanceWindow };
  };
}

/** POST /api/account/delete. The library is always gone; what happened to the sign-in varies. */
export interface AccountDeletion {
  deleted: boolean;
  auth_user_deleted?: boolean;
  auth_deletion?: 'pending' | 'not_configured';
  detail?: string;
}

/** GET /api/purchases (hosted only). */
export interface Purchases {
  unlocked: boolean;
  unlocked_via: null | 'apple' | 'google' | 'tap' | 'manual' | 'owner';
  purchases: { provider: 'apple' | 'google' | 'tap'; product_id: string; status: 'active' | 'revoked'; environment?: string }[];
}

/** What a store hands the app after a purchase; the server verifies it and nothing else can unlock an account. */
export type StoreProof =
  | { provider: 'apple'; signed_transaction: string }
  | { provider: 'google'; product_id: string; purchase_token: string };

/** The answer to POST /api/purchases/apple or /google. `status: 'pending'` (Google only) means the payment is not complete yet. */
export interface PurchaseResult {
  unlocked: boolean;
  provider: 'apple' | 'google';
  product_id: string;
  status: 'active' | 'pending';
  restored: boolean;
  environment?: string;
  acknowledged?: boolean;
}

/** GET /api/features: what this server offers and what this account may use. Not gated. */
export interface FeatureFlag {
  available: boolean;
  locked: boolean;
  ai?: boolean;
}

export interface Features {
  mode: 'self-hosted' | 'hosted';
  unlocked: boolean;
  recipes: FeatureFlag & { methods?: string[] };
  places: FeatureFlag & { geocoding?: { enabled: boolean; attribution?: string | null } };
  ask: FeatureFlag & { answers?: boolean };
  guided_import: FeatureFlag & { platforms?: string[]; max_archive_bytes?: number; chunk_bytes?: number; max_active_imports?: number; batch_size?: number };
}

export type FeatureName = 'recipes' | 'places' | 'ask' | 'guided_import';

/** What the phone's share sheet hands over, already reduced to plain strings by parseSharedContent. */
export interface SharedLink {
  shared: boolean;
  url: string;
  title: string;
  notes: string;
}

export interface ShareFields {
  title?: string;
  text?: string;
  url?: string;
}

export const EMPTY_FILTERS: Filters = {
  q: '', platform: '', collection_id: '', tag: '', status: '', favorite: false, needs_review: false, sort: 'recent',
};

export const EMPTY_STATS: Stats = {
  total: 0, favorites: 0, to_revisit: 0, needs_review: 0, archived: 0, collections: 0, platforms: {},
};

export const EMPTY_SETTINGS: Settings = { remote_previews: false, ai_enabled: false, ai_model: '' };
