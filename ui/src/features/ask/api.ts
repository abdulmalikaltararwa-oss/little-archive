// The one call this screen makes: POST /api/ask, typed exactly as API_CONTRACT.md writes it (section "Recipes,
// places, ask and guided import" > Ask). Nothing here is invented. A field the contract does not name is not
// typed, and the reasons and modes are the contract's own words, because the screen switches on them.
import type { Api } from '@/data/api';
import type { Platform } from '@/data/types';

/** What the person may narrow by. An empty string means "no narrowing", which is how the server reads it too. */
export interface AskFilters {
  platform: '' | Platform;
  collection_id: string;
  tag: string;
}

/** The request body. `limit` is 1 to 12 (default 8). Unknown fields are a 422, so nothing else is ever sent. */
export interface AskRequest extends Partial<AskFilters> {
  question: string;
  limit?: number;
}

export type AskMode = 'answer' | 'ranked_only' | 'no_results';

export type AskReason =
  | ''
  | 'nothing_saved'
  | 'ai_not_configured'
  | 'ai_failed'
  | 'ai_invalid'
  | 'not_in_saves'
  | 'unverified'
  | 'contains_instructions'
  | 'no_shareable_text';

/** Why a ranked save was kept away from the model, when it was. */
export type Withheld = 'contains_instructions' | 'no_shareable_text' | 'context_full';

/** A quote that the server checked, word for word, against the save it names. The only thing shown as evidence. */
export interface AskCitation {
  item_id: string;
  title: string;
  url: string;
  quote: string;
  /** Where in the save the quote sits: title, creator, caption, alt_text, notes, transcript or summary. */
  field: string;
}

export interface AskSource {
  item_id: string;
  title: string;
  url: string;
  platform: string;
  score: number;
  match_in: string[];
  snippet: string;
  used_in_answer: boolean;
  withheld_from_answer: Withheld | null;
}

export interface AskContext {
  saves: number;
  passages: number;
  chars: number;
  truncated: boolean;
}

export interface AskAi {
  available: boolean;
  provider: string | null;
  model: string | null;
  /** The provider's own message when it failed. Untrusted text: it is shown as text. */
  error?: string;
}

/** What an answer rests on, computed by the server from the passages it used, never from the model. */
export interface AskEvidence {
  level: string;
  sources: string[];
  note: string;
}

export interface AskResponse {
  question: string;
  terms: string[];
  mode: AskMode;
  answered: boolean;
  /** Plain text only: the server guarantees no markup and no links. Render it as a text node. */
  answer: string | null;
  reason: AskReason;
  notice: string | null;
  citations: AskCitation[];
  sources: AskSource[];
  context: AskContext;
  ai: AskAi;
  evidence?: AskEvidence;
}

export const QUESTION_MIN = 3;
export const QUESTION_MAX = 500;

/**
 * Asks the archive. Pass an AbortSignal to cancel: a newer question replaces an older one. A provider that
 * is down is not an error here (it comes back as `answered: false` with a reason); a real HTTP error is
 * thrown as an ApiError, and a 402 `unlock_required` is the locked answer (see isLocked in data/client).
 */
export function askArchive(api: Pick<Api, 'request'>, body: AskRequest, signal?: AbortSignal): Promise<AskResponse> {
  return api.request<AskResponse>('/ask', { method: 'POST', body, signal });
}
