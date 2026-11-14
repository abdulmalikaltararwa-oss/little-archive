// What the ask screen decides without drawing anything: whether a question may be sent, which example
// questions to offer, what each answer the server can give means in a person's words, and how the list of
// questions asked on this visit changes. Pure functions, so every mode and reason in the contract is tested
// (logic.test.ts) without a browser.
//
// Nothing here makes up facts. Example questions use only the owner's own topics and collections; every
// sentence about an outcome is about what the server said happened, never about what a model "thinks".
import type { Collection, Features, Settings, Tag } from '@/data/types';
import { QUESTION_MAX, QUESTION_MIN, type AskCitation, type AskContext, type AskFilters, type AskResponse, type AskSource, type Withheld } from './api';

/* The question ------------------------------------------------------------------------------------------ */

/** The question field's id, so "change the question" and "ask something else" can put the cursor back in it. */
export const COMPOSER_ID = 'ask-question';

export type QuestionProblem = '' | 'empty' | 'short' | 'no_words' | 'long';

export interface QuestionCheck {
  ok: boolean;
  /** What would be sent: the text without the spaces around it. */
  question: string;
  /** Characters as the server counts them (code points), so an emoji is one, not two. */
  count: number;
  problem: QuestionProblem;
  /** How many characters past the limit, or 0. */
  over: number;
}

/** The server accepts 3 to 500 characters with at least one letter or digit among them (a 422 otherwise). */
export function checkQuestion(text: string): QuestionCheck {
  const question = text.trim();
  const count = [...question].length;
  let problem: QuestionProblem = '';
  if (!count) problem = 'empty';
  else if (count > QUESTION_MAX) problem = 'long';
  else if (count < QUESTION_MIN) problem = 'short';
  else if (!/[\p{L}\p{N}]/u.test(question)) problem = 'no_words';
  return { ok: !problem, question, count, problem, over: Math.max(0, count - QUESTION_MAX) };
}

/** A sentence for a question that cannot be sent yet. Empty when there is nothing to say. */
export function problemText(check: QuestionCheck): string {
  switch (check.problem) {
    case 'empty': return 'Type a question first.';
    case 'short': return `Use at least ${QUESTION_MIN} characters.`;
    case 'no_words': return 'Ask it in words: a question needs at least one letter or number.';
    case 'long': return `${check.over.toLocaleString()} ${check.over === 1 ? 'character' : 'characters'} over the limit of ${QUESTION_MAX}.`;
    default: return '';
  }
}

/* Narrowing --------------------------------------------------------------------------------------------- */

export const NO_FILTERS: AskFilters = { platform: '', collection_id: '', tag: '' };

export const SOURCE_NAMES = { instagram: 'Instagram', tiktok: 'TikTok', web: 'Web links' } as const;

export const isNarrowed = (filters: AskFilters) => Boolean(filters.platform || filters.collection_id || filters.tag);

/** The body's narrowing: only what is set, so the request carries nothing it does not need. */
export function filterBody(filters: AskFilters): Partial<AskFilters> {
  const body: Partial<AskFilters> = {};
  if (filters.platform) body.platform = filters.platform;
  if (filters.collection_id) body.collection_id = filters.collection_id;
  if (filters.tag) body.tag = filters.tag;
  return body;
}

/** The narrowing in words, for the line above an answer. A collection that is gone is named plainly, not hidden. */
export function narrowingLabels(filters: AskFilters, collections: readonly Pick<Collection, 'id' | 'name'>[]): string[] {
  const labels: string[] = [];
  if (filters.platform) labels.push(SOURCE_NAMES[filters.platform] ?? filters.platform);
  if (filters.collection_id) labels.push(collections.find(collection => collection.id === filters.collection_id)?.name ?? 'a collection that is no longer here');
  if (filters.tag) labels.push(`topic: ${filters.tag}`);
  return labels;
}

/* Example questions ------------------------------------------------------------------------------------- */

export interface Example {
  id: string;
  text: string;
}

const TEMPLATES: readonly ((name: string) => string)[] = [
  name => `What did I save about ${name}?`,
  name => `Which saves mention ${name}?`,
  name => `Remind me what I kept about ${name}.`,
];

/**
 * A few questions to start from, made of the owner's own topics and collection names and nothing else: the
 * commonest topics and the fullest collections, taken in turn. A library with neither has no examples.
 */
export function buildExamples({ tags, collections, limit = 4 }: { tags: readonly Tag[]; collections: readonly Pick<Collection, 'name' | 'count' | 'kind'>[]; limit?: number }): Example[] {
  const byCount = <T extends { count?: number }>(list: readonly T[]) => [...list].sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  const usable = (name: string) => name.trim().length >= 2 && [...name.trim()].length <= 48;
  const topics = byCount(tags).map(tag => tag.name.trim()).filter(usable);
  // Collections the owner made come before the ones imported from a platform; an empty one has nothing to ask about.
  const places = byCount(collections.filter(collection => collection.count !== 0))
    .sort((a, b) => Number(a.kind === 'source') - Number(b.kind === 'source'))
    .map(collection => collection.name.trim())
    .filter(usable);

  const names: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; names.length < limit && (index < topics.length || index < places.length); index += 1) {
    for (const name of [topics[index], places[index]]) {
      if (!name || names.length >= limit || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      names.push(name);
    }
  }
  return names.map((name, index) => ({ id: `${index}:${name.toLowerCase()}`, text: TEMPLATES[index % TEMPLATES.length]!(name) }));
}

/* What this server can do ------------------------------------------------------------------------------- */

export type AskCapability = 'answers' | 'ranked_only';

/** Whether this server will write answers or only rank saves, from what GET /api/features and /api/settings say. */
export function askCapability(features: Features | null, settings: Pick<Settings, 'ai_enabled'>): AskCapability {
  const flag = features?.ask;
  if (typeof flag?.answers === 'boolean') return flag.answers ? 'answers' : 'ranked_only';
  if (typeof flag?.ai === 'boolean') return flag.ai ? 'answers' : 'ranked_only';
  return settings.ai_enabled ? 'answers' : 'ranked_only';
}

/** One honest sentence, shown before anything is asked, about where the words of a question go. */
export function aiNote(capability: AskCapability, settings: Pick<Settings, 'ai_hosted'>): string {
  if (capability === 'ranked_only') return 'No AI is set up on this server, so you will get the best-matching saves, ranked, and no written answer.';
  if (settings.ai_hosted) return 'This server uses a hosted AI service. It reads short passages from the saves that match your question; your own notes are held back unless the server’s operator allows them.';
  return 'The AI on your own server reads short passages from the saves that match your question, and nothing else from your library.';
}

/* Words for each field a quote or a match can come from ------------------------------------------------- */

const FIELDS: Record<string, string> = {
  title: 'the title',
  creator: 'the creator’s name',
  caption: 'the caption',
  alt_text: 'the image description',
  notes: 'your notes',
  transcript: 'what is said',
  summary: 'the summary',
  tags: 'the topics',
};

/** A field name as a person would say it: "the caption", "what is said". */
export function fieldLabel(field: string): string {
  return FIELDS[field] ?? field.replaceAll('_', ' ');
}

/** The fields a ranked save matched in, as a short list in words. Empty when the server named none. */
export function matchLabel(matchIn: readonly string[]): string {
  return matchIn.map(field => fieldLabel(field).replace(/^the /, '')).join(', ');
}

const EVIDENCE_LABELS: Record<string, string> = {
  'text-only': 'From saved text only',
  'caption-based': 'From captions',
  'transcript-based': 'From what is said',
};

/** What an answer rests on, in words. The level is computed by the server from the passages it used. */
export function evidenceLabel(level: string | undefined): string {
  if (!level) return 'From your saved text';
  return EVIDENCE_LABELS[level] ?? `From ${level.replaceAll('-', ' ')}`;
}

/** The provider and model that wrote an answer, for the mono line beneath it. */
export function authorLine(ai: Pick<AskResponse['ai'], 'provider' | 'model'>): string {
  return [ai.provider, ai.model].filter(Boolean).join(' · ');
}

/* What the server said happened ------------------------------------------------------------------------- */

export type OutcomeKey =
  | 'answer'
  | 'no_ai'
  | 'nothing_saved'
  | 'ai_failed'
  | 'ai_invalid'
  | 'not_in_saves'
  | 'unverified'
  | 'contains_instructions'
  | 'no_shareable_text'
  | 'unclear';

export interface Outcome {
  key: OutcomeKey;
  /** A short line a person understands. For nothing saved it is the server's own sentence. */
  heading: string;
  /** What happened, and what was and was not done about it. */
  body: string;
  /** The server's own notice, when it sent one. It is shown as the server's, beside the explanation. */
  notice: string | null;
  tone: 'answer' | 'plain' | 'warn';
  /** Whether asking again can plausibly help: the AI was down, or its answer could not be checked. */
  retry: boolean;
  /** How the ranked saves are used: as the result itself, as the support for an answer, or not at all. */
  sources: 'lead' | 'support' | 'none';
}

const SAYS: Record<Exclude<OutcomeKey, 'answer' | 'nothing_saved'>, Pick<Outcome, 'heading' | 'body' | 'tone' | 'retry'>> = {
  no_ai: {
    heading: 'This server has no AI set up',
    body: 'So no answer is written, and none is pretended. These are the saves that match your words best, ranked, with the lines that matched.',
    tone: 'plain',
    retry: false,
  },
  ai_failed: {
    heading: 'The AI could not answer just now',
    body: 'Nothing was written. Your saves were still searched, and the best matches are below. Trying again may work.',
    tone: 'warn',
    retry: true,
  },
  ai_invalid: {
    heading: 'The AI’s reply could not be used',
    body: 'It came back in a form that could not be read, so none of it was kept. The best matches are below. Trying again may work.',
    tone: 'warn',
    retry: true,
  },
  not_in_saves: {
    heading: 'Your saves do not seem to say',
    body: 'The AI read the closest saves and did not find the answer in them, so it did not guess. These are the closest ones; a different wording may find more.',
    tone: 'plain',
    retry: false,
  },
  unverified: {
    heading: 'An answer was held back',
    body: 'The AI wrote an answer, but its quotes could not be checked against your saves word for word, so it is not shown. These are the closest saves. Trying again may give one that checks out.',
    tone: 'warn',
    retry: true,
  },
  contains_instructions: {
    heading: 'Nothing was sent to the AI',
    body: 'The matching saves contain text that looks like instructions to an AI, so Little Archive kept them away from it. They are still yours: here they are, ranked.',
    tone: 'warn',
    retry: false,
  },
  no_shareable_text: {
    heading: 'The AI had nothing it may read',
    body: 'None of the matching saves has text that can be sent to the AI. Notes you wrote yourself are not sent to a hosted AI. Here are the saves that match.',
    tone: 'plain',
    retry: false,
  },
  unclear: {
    heading: 'No written answer this time',
    body: 'Here are the saves that matched your question best.',
    tone: 'plain',
    retry: false,
  },
};

const NOTHING_SAVED = 'Nothing saved about that.';

/**
 * What a response means, as words and as a decision about what to show. Every mode and reason the contract
 * lists has its own entry; one the screen has never heard of falls back to the plain ranked list, never to a
 * made-up answer.
 */
export function describeOutcome(response: AskResponse, { narrowed = false }: { narrowed?: boolean } = {}): Outcome {
  const notice = response.notice?.trim() || null;
  if (response.mode === 'no_results' || response.reason === 'nothing_saved') {
    const hint = response.terms.length ? 'Nothing matched the words searched for.' : 'Those words were too common to search on. Try naming the thing itself.';
    return {
      key: 'nothing_saved',
      heading: response.answer?.trim() || NOTHING_SAVED,
      body: `${hint}${narrowed ? ' You narrowed the question, so try it without that.' : ' Try other words, or fewer of them.'}`,
      notice,
      tone: 'plain',
      retry: false,
      sources: 'none',
    };
  }
  if (response.mode === 'answer' && response.answered && response.answer) {
    return { key: 'answer', heading: 'From your saves', body: 'Treat the answer as a convenience and the quotes below as the evidence.', notice, tone: 'answer', retry: false, sources: 'support' };
  }
  const key: Exclude<OutcomeKey, 'answer' | 'nothing_saved'> = response.reason === 'ai_not_configured' ? 'no_ai'
    : response.reason === 'ai_failed' || response.reason === 'ai_invalid' || response.reason === 'not_in_saves' || response.reason === 'unverified'
      || response.reason === 'contains_instructions' || response.reason === 'no_shareable_text' ? response.reason
      : 'unclear';
  return { key, ...SAYS[key], notice, sources: response.sources.length ? 'lead' : 'none' };
}

/** Why a save was kept away from the AI, in a sentence. */
export function withheldText(reason: Withheld): string {
  switch (reason) {
    case 'contains_instructions': return 'Held back: its text looks like instructions to an AI, so it was not sent to one.';
    case 'no_shareable_text': return 'Not read by the AI: there was no text in this save that can be sent to it.';
    case 'context_full': return 'Not read by the AI: there was no room left for it.';
    default: return 'Not read by the AI.';
  }
}

export type SourceStatus = { kind: 'cited' } | { kind: 'withheld'; text: string } | { kind: 'read' } | { kind: 'none' };

/**
 * What became of one ranked save. "Read" is only said where the AI really did answer or refuse the answer
 * (mode "answer"): after an outage or with no AI there is nothing true to say about it.
 */
export function sourceStatus(source: Pick<AskSource, 'used_in_answer' | 'withheld_from_answer'>, response: Pick<AskResponse, 'mode'>): SourceStatus {
  if (source.used_in_answer) return { kind: 'cited' };
  if (source.withheld_from_answer) return { kind: 'withheld', text: withheldText(source.withheld_from_answer) };
  return response.mode === 'answer' ? { kind: 'read' } : { kind: 'none' };
}

/** A quiet line about how much the AI was given, or nothing when it was given nothing. */
export function contextLine(context: AskContext): string {
  if (!context.saves) return '';
  const passages = `${context.passages} short ${context.passages === 1 ? 'passage' : 'passages'}`;
  const saves = `${context.saves} ${context.saves === 1 ? 'save' : 'saves'}`;
  return `The AI read ${passages} from ${saves}.${context.truncated ? ' More saves matched than fit, so the lowest-ranked were left out.' : ''}`;
}

/** The first few ranked saves, always including any that the answer cites, in their ranked order. */
export function collapseSources(sources: readonly AskSource[], keep: number): { shown: AskSource[]; hidden: number } {
  const shown = sources.filter((source, index) => index < keep || source.used_in_answer);
  return { shown, hidden: sources.length - shown.length };
}

/** The save a citation points at, for the platform mark on its card. */
export function platformOf(citation: Pick<AskCitation, 'item_id'>, sources: readonly Pick<AskSource, 'item_id' | 'platform'>[]): string {
  return sources.find(source => source.item_id === citation.item_id)?.platform ?? 'web';
}

/* Showing why a save matched ---------------------------------------------------------------------------- */

export interface Piece {
  text: string;
  hit: boolean;
}

// The server folds case, compatibility forms, combining marks and Arabic letter variants before it matches
// (server/storage.py normalize_search); this does the same to a word so that what it marks is what matched.
const fold = (word: string) => word.normalize('NFKC').toLowerCase().replaceAll('ـ', '').replace(/\p{M}/gu, '').replace(/[أإآ]/gu, 'ا');

const isHit = (word: string, terms: readonly string[]) => {
  const folded = fold(word);
  const bare = folded.length > 4 && folded.startsWith('ال') ? folded.slice(2) : folded;
  // The server's own rule: a term of three or more letters matches the start of a word; a shorter one, the whole word.
  return terms.some(term => (term.length >= 3 ? folded.startsWith(term) || bare.startsWith(term) : folded === term || bare === term));
};

/**
 * Splits text into runs, marking the words the question's terms matched. The pieces are plain strings to be
 * rendered as text, never markup, so a snippet that contains angle brackets stays angle brackets.
 */
export function highlight(text: string, terms: readonly string[]): Piece[] {
  const wanted = terms.map(term => term.trim()).filter(Boolean);
  if (!text || !wanted.length) return [{ text, hit: false }];
  const pieces: Piece[] = [];
  let last = 0;
  for (const match of text.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    if (!isHit(match[0], wanted)) continue;
    if (match.index > last) pieces.push({ text: text.slice(last, match.index), hit: false });
    pieces.push({ text: match[0], hit: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) pieces.push({ text: text.slice(last), hit: false });
  return pieces.length ? pieces : [{ text, hit: false }];
}

/* The visit's questions --------------------------------------------------------------------------------- */

export type EntryState =
  | { status: 'pending' }
  | { status: 'done'; response: AskResponse }
  | { status: 'error'; message: string; httpStatus: number }
  | { status: 'locked' };

export interface Entry {
  id: string;
  question: string;
  filters: AskFilters;
  state: EntryState;
}

export interface Session {
  /** Newest first. */
  entries: Entry[];
  /** The entry on show, or '' for none. */
  activeId: string;
  /** What is in the question field. */
  draft: string;
  /** What the narrowing menus are set to. */
  filters: AskFilters;
}

export const EMPTY_SESSION: Session = { entries: [], activeId: '', draft: '', filters: NO_FILTERS };

/** More than this and the oldest question is forgotten: the list is a convenience, held in memory. */
export const HISTORY_LIMIT = 20;

export type SessionAction =
  /** A question was sent. Any question still waiting is cancelled, and the same question asked again replaces its earlier entry. */
  | { type: 'asked'; entry: Entry }
  | { type: 'answered'; id: string; response: AskResponse }
  | { type: 'failed'; id: string; message: string; httpStatus: number }
  | { type: 'locked'; id: string }
  /** Try the same question again from where it failed. */
  | { type: 'restarted'; id: string }
  /** The person stopped a waiting question. */
  | { type: 'cancelled'; id: string }
  /** An earlier question was reopened: its answer is shown again and its question and narrowing go back in the form. */
  | { type: 'opened'; id: string }
  | { type: 'drafted'; text: string }
  | { type: 'narrowed'; filters: Partial<AskFilters> }
  | { type: 'cleared' };

const sameFilters = (a: AskFilters, b: AskFilters) => a.platform === b.platform && a.collection_id === b.collection_id && a.tag === b.tag;

function settle(session: Session, id: string, state: EntryState): Session {
  // An answer that arrives for a question that was cancelled or replaced is dropped.
  const waiting = session.entries.find(entry => entry.id === id && entry.state.status === 'pending');
  if (!waiting) return session;
  return { ...session, entries: session.entries.map(entry => (entry.id === id ? { ...entry, state } : entry)) };
}

export function sessionReducer(session: Session, action: SessionAction): Session {
  switch (action.type) {
    case 'asked': {
      const { entry } = action;
      const kept = session.entries.filter(old => old.state.status !== 'pending' && !(old.question === entry.question && sameFilters(old.filters, entry.filters)));
      return { ...session, entries: [entry, ...kept].slice(0, HISTORY_LIMIT), activeId: entry.id };
    }
    case 'answered': return settle(session, action.id, { status: 'done', response: action.response });
    case 'failed': return settle(session, action.id, { status: 'error', message: action.message, httpStatus: action.httpStatus });
    case 'locked': return settle(session, action.id, { status: 'locked' });
    case 'restarted': {
      const entry = session.entries.find(old => old.id === action.id);
      if (!entry || entry.state.status === 'pending' || entry.state.status === 'locked') return session;
      const entries = session.entries.map(old => (old.id === action.id ? { ...old, state: { status: 'pending' } as const } : old));
      return { ...session, entries, activeId: action.id };
    }
    case 'cancelled': {
      const entries = session.entries.filter(entry => !(entry.id === action.id && entry.state.status === 'pending'));
      if (entries.length === session.entries.length) return session;
      return { ...session, entries, activeId: session.activeId === action.id ? (entries[0]?.id ?? '') : session.activeId };
    }
    case 'opened': {
      const entry = session.entries.find(old => old.id === action.id);
      if (!entry) return session;
      return { ...session, activeId: entry.id, draft: entry.question, filters: entry.filters };
    }
    case 'drafted': return action.text === session.draft ? session : { ...session, draft: action.text };
    case 'narrowed': {
      const filters = { ...session.filters, ...action.filters };
      return sameFilters(filters, session.filters) ? session : { ...session, filters };
    }
    case 'cleared': return { ...session, entries: [], activeId: '' };
  }
}

/** A word or two, in the mono voice, for how an earlier question went. */
export function entryTag(entry: Pick<Entry, 'state'>): string {
  const { state } = entry;
  if (state.status === 'pending') return 'reading';
  if (state.status === 'error') return 'did not go through';
  if (state.status === 'locked') return 'locked';
  switch (describeOutcome(state.response).key) {
    case 'answer': return 'answered';
    case 'no_ai': return 'ranked only';
    case 'nothing_saved': return 'nothing saved';
    case 'not_in_saves': return 'not in your saves';
    case 'ai_failed':
    case 'ai_invalid': return 'no answer';
    case 'unverified':
    case 'contains_instructions':
    case 'no_shareable_text': return 'held back';
    default: return 'ranked only';
  }
}
