// When the server says "not now". A hosted server can refuse a request for a reason that is nobody's fault:
// the feature is part of the unlock, today's allowance is used, the service is busy, the storage is full.
// Each of those has a stable `code` (API_CONTRACT.md, "Refusals and codes"). This module turns a code into
// what a person needs to know: what happened, when it changes, and what they can do. Pure, so it is tested.
import { ApiError } from '@/data/client';

export type RefusalKind = 'unlock' | 'allowance' | 'busy' | 'storage' | 'purchase';

export interface Refusal {
  code: string;
  kind: RefusalKind;
  title: string;
  body: string;
  /** When it starts working again, if the server said. */
  resetsAt: Date | null;
  /** Seconds to wait, if that is what the server said instead. */
  retryAfter: number | null;
  /** Usage behind an allowance refusal, when the server sent it. */
  usage: { used: number; limit: number } | null;
  /** 'unlock' offers the unlock screen; 'wait' and 'none' only explain. */
  action: 'unlock' | 'wait' | 'none';
}

interface Limit {
  scope?: string;
  period?: string;
  used?: number;
  limit?: number | null;
  remaining?: number | null;
  resets_at?: string | null;
}

const UNLOCK_FEATURES: Record<string, string> = {
  recipes: 'Recipe cards and cook mode open',
  places: 'Places and the map open',
  ask: 'Asking your archive opens',
  suggestions: 'More AI suggestions open',
  deep_reads: 'Closer reads open',
};

function date(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The first moment of the month after a 'YYYY-MM' period, in UTC: when a monthly allowance starts again. */
export function monthEnd(period: unknown): Date | null {
  const match = typeof period === 'string' ? /^(\d{4})-(\d{2})$/.exec(period) : null;
  return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]), 1)) : null;
}

const WHAT: Record<string, { day: string; month: string; tries: string; spent: string }> = {
  suggestions: { day: 'Today’s suggestions are used', month: 'This month’s suggestions are used', tries: 'That is enough tries for today', spent: 'Nothing new was queued.' },
  feature_calls: { day: 'Today’s recipe, place and ask requests are used', month: 'This month’s recipe, place and ask requests are used', tries: 'That is enough tries for today', spent: 'What you already have stays as it is; reading and editing cost nothing.' },
};

/** Explains a refusal, or returns null for an ordinary error (which is shown as itself). */
export function describeRefusal(error: unknown): Refusal | null {
  if (!(error instanceof ApiError) || !error.code) return null;
  const { code, status, extra } = error;
  const limit = (extra.limit && typeof extra.limit === 'object' ? extra.limit : {}) as Limit;
  const resetsAt = date(limit.resets_at);
  const retryAfter = typeof extra.retry_after === 'number' && extra.retry_after > 0 ? Math.ceil(extra.retry_after) : null;
  const usage = typeof limit.used === 'number' && typeof limit.limit === 'number' ? { used: limit.used, limit: limit.limit } : null;
  const base = { code, resetsAt, retryAfter, usage };

  if (status === 402 && code === 'unlock_required') {
    const what = UNLOCK_FEATURES[String(extra.feature)] ?? 'This opens';
    return { ...base, kind: 'unlock', action: 'unlock', title: 'Part of the one-time unlock', body: `${what} with a single payment, once. Saving, searching, importing and exporting stay free.` };
  }
  if (code === 'deep_reads_exhausted') {
    return { ...base, resetsAt: resetsAt ?? monthEnd(limit.period), kind: 'allowance', action: 'wait', title: 'This month’s closer reads are used', body: 'Nothing was queued and nothing was charged. Suggestions from captions still work.' };
  }
  const family = code.startsWith('suggestions_') ? WHAT.suggestions : code.startsWith('feature_calls_') ? WHAT.feature_calls : null;
  if (family && status === 429) {
    const title = code.endsWith('_daily_limit') ? family.day : code.endsWith('_monthly_limit') ? family.month : family.tries;
    const body = code.endsWith('_attempts_limit') ? 'Tries that failed count too, so a stuck request cannot run away. It opens again tomorrow.' : family.spent;
    return { ...base, kind: 'allowance', action: 'wait', title, body };
  }
  if (code === 'storage_full') {
    return { ...base, kind: 'storage', action: 'none', title: 'Your storage is full', body: 'This would not fit in your account’s storage. Removing saves or previews you no longer need makes room. Reading, exporting and backing up still work.' };
  }
  if (code === 'rate_limited') {
    return { ...base, kind: 'busy', action: 'wait', title: 'A little too fast', body: 'That was a lot of requests in a short time. Nothing is wrong and nothing was lost.' };
  }
  if (code === 'too_many_concurrent') {
    return { ...base, kind: 'busy', action: 'wait', title: 'One at a time', body: 'One of these is already running for your account. When it finishes, this one can start.' };
  }
  if (code === 'auth_rate_limited') {
    return { ...base, kind: 'busy', action: 'wait', title: 'Too many sign-in attempts', body: 'Sign-in is paused for this connection for a moment, to keep guessing out.' };
  }
  if (code === 'server_busy') {
    return { ...base, kind: 'busy', action: 'wait', title: 'The service is busy', body: 'It is handling a lot of these right now. Your library is fine; this one request has to wait.' };
  }
  if (code === 'purchases_unavailable') {
    return { ...base, kind: 'purchase', action: 'wait', title: 'The store could not be reached', body: 'The purchase could not be checked just now. You have not been charged twice; try again in a moment.' };
  }
  if (['purchase_invalid', 'purchase_wrong_app', 'purchase_wrong_product', 'purchase_wrong_environment'].includes(code)) {
    return { ...base, kind: 'purchase', action: 'none', title: 'That purchase could not be confirmed', body: 'The store’s receipt is not one for Little Archive’s unlock, so nothing was unlocked. If you were charged, restoring the purchase from the device that bought it usually settles it.' };
  }
  if (code === 'purchase_bound_elsewhere') {
    return { ...base, kind: 'purchase', action: 'none', title: 'This purchase belongs to another account', body: 'It already unlocked a different Little Archive account. Sign in to that account to use it; one purchase unlocks one account.' };
  }
  if (code === 'purchase_revoked') {
    return { ...base, kind: 'purchase', action: 'none', title: 'The store took this purchase back', body: 'It was refunded or cancelled, so it no longer unlocks anything. Your library and everything free stay as they are.' };
  }
  return null;
}

/** Why some saves were not queued, when a hosted allowance cut a request short (a 200 with `skipped`). */
export function skippedWhy(scope?: string): string {
  return scope === 'daily' ? 'today’s allowance is used' : scope === 'monthly' ? 'this month’s allowance is used' : scope === 'attempts' ? 'too many tries today' : 'not included in this account';
}

export const isRefusal = (error: unknown): error is ApiError => describeRefusal(error) !== null;

function span(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} seconds`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${Math.round(minutes)} minutes`;
  const hours = minutes / 60;
  if (hours < 36) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}

/** "Opens again in 3 hours, at 02:00." The clock time is the reader's own; `now` is passed in so this is testable. */
export function whenText(refusal: Pick<Refusal, 'resetsAt' | 'retryAfter'>, now: number = Date.now(), locale?: string): string {
  if (refusal.resetsAt) {
    const seconds = (refusal.resetsAt.getTime() - now) / 1000;
    if (seconds <= 0) return 'It should be open again now.';
    const sameDay = new Date(now).toDateString() === refusal.resetsAt.toDateString();
    const clock = sameDay
      ? refusal.resetsAt.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
      : refusal.resetsAt.toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    return `Opens again in ${span(seconds)}, ${sameDay ? 'at' : 'on'} ${clock}.`;
  }
  if (refusal.retryAfter) return `Try again in ${span(refusal.retryAfter)}.`;
  return '';
}
