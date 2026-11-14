// Responses shaped exactly like POST /api/ask answers in tests/test_feature_ask.py, for the unit tests and
// for the screenshot script's mocked server. Only the values are made up; no field is.
import type { AskCitation, AskResponse, AskSource } from './api';

export const source = (changes: Partial<AskSource> = {}): AskSource => ({
  item_id: 'item-pasta',
  title: 'Lemon pasta with garlic',
  url: 'https://example.com/lemon-pasta',
  platform: 'instagram',
  score: 0.91,
  match_in: ['title', 'caption'],
  snippet: 'Spaghetti with lemon, garlic and parsley. A quick pasta dinner for two.',
  used_in_answer: false,
  withheld_from_answer: null,
  ...changes,
});

export const citation = (changes: Partial<AskCitation> = {}): AskCitation => ({
  item_id: 'item-pasta',
  title: 'Lemon pasta with garlic',
  url: 'https://example.com/lemon-pasta',
  quote: 'Spaghetti with lemon, garlic and parsley',
  field: 'caption',
  ...changes,
});

const base: Pick<AskResponse, 'question' | 'terms' | 'notice' | 'citations' | 'sources' | 'context' | 'ai'> = {
  question: 'What was that lemon pasta recipe I saved?',
  terms: ['lemon', 'pasta', 'recipe'],
  notice: null,
  citations: [],
  sources: [],
  context: { saves: 0, passages: 0, chars: 0, truncated: false },
  ai: { available: false, provider: null, model: null },
};

/** An answer with one citation. */
export const answered = (changes: Partial<AskResponse> = {}): AskResponse => ({
  ...base,
  mode: 'answer',
  answered: true,
  answer: 'You saved a lemon pasta with garlic and parsley.',
  reason: '',
  citations: [citation()],
  sources: [source({ used_in_answer: true }), source({ item_id: 'item-squash', title: 'Lemon squash', platform: 'tiktok', score: 0.4, match_in: ['title'], snippet: 'Lemon lemon lemon squash cordial.' }), source({ item_id: 'item-tomato', title: 'Tomato pasta bake', platform: 'web', score: 0.38, match_in: ['title', 'caption'], snippet: 'A pasta bake with tomato and mozzarella.' })],
  context: { saves: 3, passages: 3, chars: 190, truncated: false },
  ai: { available: true, provider: 'stub', model: 'stub-model-1' },
  evidence: { level: 'caption-based', sources: ['caption'], note: 'Based on captions from up to 3 of your saves. The pictures and videos themselves were not seen. Only the saves cited are the source.' },
  ...changes,
});

/** No provider: the ranked saves, flagged as such. */
export const rankedOnly = (changes: Partial<AskResponse> = {}): AskResponse => ({
  ...base,
  mode: 'ranked_only',
  answered: false,
  answer: null,
  reason: 'ai_not_configured',
  notice: 'No AI provider is configured on this server, so these are the best-matching saves only. Nothing was summarised.',
  sources: [source(), source({ item_id: 'item-squash', title: 'Lemon squash', platform: 'tiktok', score: 0.4, match_in: ['title'], snippet: 'Lemon lemon lemon squash cordial.' })],
  ...changes,
});

/** Nothing retrieved: no model was asked. */
export const nothingSaved = (changes: Partial<AskResponse> = {}): AskResponse => ({
  ...base,
  question: 'What did I save about submarines?',
  terms: ['submarine'],
  mode: 'no_results',
  answered: false,
  answer: 'Nothing saved about that.',
  reason: 'nothing_saved',
  ...changes,
});

/** The model answered but the answer was not shown (`not_in_saves` or `unverified`): still mode "answer". */
export const notShown = (reason: 'not_in_saves' | 'unverified', changes: Partial<AskResponse> = {}): AskResponse => ({
  ...answered(),
  answered: false,
  answer: null,
  reason,
  notice: reason === 'not_in_saves' ? 'Your saves don’t seem to say. Here are the closest ones.' : 'The model’s answer could not be checked against your saves, so it is not shown. Here are the closest ones.',
  citations: [],
  sources: [source(), source({ item_id: 'item-tomato', title: 'Tomato pasta bake', platform: 'web', score: 0.38, snippet: 'A pasta bake with tomato and mozzarella.' })],
  ...changes,
});

/** A provider outage or an unusable reply (`ai_failed`, `ai_invalid`): ranked saves, mode "ranked_only". */
export const aiTrouble = (reason: 'ai_failed' | 'ai_invalid', changes: Partial<AskResponse> = {}): AskResponse => ({
  ...rankedOnly(),
  reason,
  notice: 'The AI provider could not answer just now, so these are the best-matching saves only.',
  ai: { available: true, provider: 'stub', model: 'stub-model-1', error: 'The local model service could not be reached.' },
  context: { saves: 2, passages: 2, chars: 120, truncated: false },
  ...changes,
});

/** Every match kept away from the model (`contains_instructions`, `no_shareable_text`). */
export const heldBack = (reason: 'contains_instructions' | 'no_shareable_text', changes: Partial<AskResponse> = {}): AskResponse => ({
  ...rankedOnly(),
  reason,
  notice: reason === 'contains_instructions'
    ? 'The matching saves contain text that looks like instructions to an AI, so none were sent to the model. Here they are.'
    : 'The matching text is in your private notes, which this service does not send to its hosted model. Here they are.',
  ai: { available: true, provider: 'stub', model: 'stub-model-1' },
  sources: [source({ withheld_from_answer: reason, title: 'Submarine guide 0', match_in: ['caption'] }), source({ item_id: 'item-sub1', withheld_from_answer: reason, title: 'Submarine guide 1', match_in: ['caption'], platform: 'web' })],
  ...changes,
});
