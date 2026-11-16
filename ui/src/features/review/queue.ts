// The words and arithmetic of the review queue: what a suggestion would change, what it rests on, and how far
// through the queue the person is. Nothing here is invented: a row is shown only when the save's own data has it.
import type { AiSuggestion, Item } from '@/data/types';

// What an AI suggestion rests on, in plain words. The level comes from the server, computed from the input
// it was given, never from the model's answer.
const EVIDENCE_LABELS: Record<string, string> = {
  'text-only': 'From the title and link only',
  'caption-based': 'From the caption',
  'transcript-based': 'From what is said',
};

export function evidenceLabel(ai: AiSuggestion) {
  return EVIDENCE_LABELS[String(ai.evidence_level)] ?? `From ${String(ai.evidence_level || 'available text').replaceAll('-', ' ')}`;
}

/** The suggestion waiting on a save, if there is one. A suggestion that was answered no longer asks for review. */
export function pendingSuggestion(item: Pick<Item, 'ai' | 'needs_review'>): AiSuggestion | null {
  return item.ai && item.needs_review ? item.ai : null;
}

export interface SuggestionRows {
  /** How the suggestion reads the save. Accepting does not store this; it is shown so the rest can be judged. */
  kind: string;
  /** The collection the save would be filed in. */
  folder: string;
  /** Topics that would be added: the suggested ones the save does not already have. */
  topics: string[];
  /** A title or summary that differs from the save's. The server keeps one the owner wrote. */
  title: string;
  summary: string;
}

export function suggestionRows(item: Pick<Item, 'title' | 'summary' | 'tags'>, ai: AiSuggestion): SuggestionRows {
  const have = new Set((item.tags || []).map(tag => tag.toLowerCase()));
  const title = (ai.suggested_title || '').trim();
  const summary = (ai.summary || '').trim();
  return {
    kind: (ai.category && ai.category !== 'Other' ? ai.category : ai.content_type || '').trim(),
    folder: (ai.suggested_folder || '').trim(),
    topics: (ai.topics || []).filter(topic => topic && !have.has(topic.toLowerCase())),
    title: title && title !== (item.title || '').trim() ? title : '',
    summary: summary && summary !== (item.summary || '').trim() ? summary : '',
  };
}

const excerpt = (text: string, limit = 150) => {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1).trimEnd()}…` : clean;
};

/** The line a suggestion rests on: the save's own caption or transcript, quoted, when that is what was read. */
export function evidenceQuote(item: Pick<Item, 'caption' | 'evidence'>, ai: AiSuggestion): string {
  if (ai.evidence_level === 'transcript-based') {
    const spoken = (item.evidence || []).find(entry => entry.kind === 'transcript' && entry.text);
    if (spoken) return excerpt(spoken.text);
  }
  if (ai.evidence_level === 'caption-based' || ai.evidence_level === 'transcript-based') return item.caption ? excerpt(item.caption) : '';
  return '';
}

/** What the island says once an answer is given. */
export function answerWords(kind: 'accept' | 'keep', ai: AiSuggestion | null): string {
  if (!ai) return 'Marked as reviewed';
  if (kind === 'keep') return 'Kept as it was';
  return ai.suggested_folder ? `Filed in ${ai.suggested_folder}` : 'Suggestion accepted';
}

export interface Progress {
  /** Answers given in this visit. */
  done: number;
  /** Answers given plus saves still waiting. */
  total: number;
  /** The place of the save on show, counting from one. */
  position: number;
}

export function progress(answered: number, waiting: number): Progress {
  const done = Math.max(0, answered);
  const total = done + Math.max(0, waiting);
  return { done, total, position: Math.min(total, done + 1) };
}

/** Up to this many, the strip is one segment for each save; past it, one bar. */
export const MAX_SEGMENTS = 12;

/** What was decided in this visit, for the end of the queue. Empty when nothing was. */
export function tally(accepted: number, kept: number): string {
  const parts = [];
  if (accepted) parts.push(`${accepted} accepted`);
  if (kept) parts.push(`${kept} kept as ${kept === 1 ? 'it was' : 'they were'}`);
  return parts.length ? `${parts.join(', ')}.` : '';
}

/** How long ago a save was added, in whole days. Empty when the date cannot be read. */
export function addedAgo(created: string | null | undefined, now = Date.now()): string {
  const time = created ? Date.parse(created) : NaN;
  if (Number.isNaN(time)) return '';
  const days = Math.floor((now - time) / 86_400_000);
  if (days <= 0) return 'added today';
  if (days === 1) return 'added yesterday';
  if (days < 31) return `added ${days} days ago`;
  return `added ${new Date(time).toLocaleDateString('en', { month: 'short', year: 'numeric' })}`;
}
