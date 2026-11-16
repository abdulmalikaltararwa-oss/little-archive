import { describe, expect, it } from 'vitest';
import type { AiSuggestion, Item } from '@/data/types';
import { addedAgo, answerWords, evidenceLabel, evidenceQuote, pendingSuggestion, progress, suggestionRows, tally } from './queue';

const AI: AiSuggestion = { suggested_title: 'Machboos at home', summary: 'Chicken and rice.', topics: ['chicken', 'Rice', 'kuwaiti'], category: 'Recipes', content_type: 'video', suggested_folder: 'Weeknight dinners', evidence_level: 'caption-based' };
const ITEM = { title: 'Machboos deyay', summary: '', tags: ['rice'], caption: '  2 cups basmati,\n1 whole chicken ', evidence: [], ai: AI, needs_review: true } as unknown as Item;

describe('what a suggestion would change', () => {
  it('lists the kind, the collection, the topics the save does not have yet, and a different title or summary', () => {
    expect(suggestionRows(ITEM, AI)).toEqual({ kind: 'Recipes', folder: 'Weeknight dinners', topics: ['chicken', 'kuwaiti'], title: 'Machboos at home', summary: 'Chicken and rice.' });
  });

  it('shows no row for something the suggestion does not have or would not change', () => {
    expect(suggestionRows({ title: 'Machboos at home', summary: 'Chicken and rice.', tags: ['chicken', 'rice', 'kuwaiti'] }, { ...AI, category: 'Other', content_type: '', suggested_folder: '' }))
      .toEqual({ kind: '', folder: '', topics: [], title: '', summary: '' });
    expect(suggestionRows(ITEM, {})).toEqual({ kind: '', folder: '', topics: [], title: '', summary: '' });
  });

  it('falls back to the kind of thing saved when the category says nothing', () => {
    expect(suggestionRows(ITEM, { category: 'Other', content_type: 'video' }).kind).toBe('video');
  });

  it('is only waiting while the save still needs review', () => {
    expect(pendingSuggestion(ITEM)).toBe(AI);
    expect(pendingSuggestion({ ai: AI, needs_review: false })).toBeNull();
    expect(pendingSuggestion({ ai: null, needs_review: true })).toBeNull();
  });
});

describe('what a suggestion rests on', () => {
  it('names the level the server computed', () => {
    expect(evidenceLabel({ evidence_level: 'caption-based' })).toBe('From the caption');
    expect(evidenceLabel({ evidence_level: 'text-only' })).toBe('From the title and link only');
    expect(evidenceLabel({ evidence_level: 'page-text' })).toBe('From page text');
    expect(evidenceLabel({})).toBe('From available text');
  });

  it('quotes the caption or the transcript only when that is what was read', () => {
    expect(evidenceQuote(ITEM, AI)).toBe('2 cups basmati, 1 whole chicken');
    expect(evidenceQuote(ITEM, { evidence_level: 'text-only' })).toBe('');
    expect(evidenceQuote({ caption: 'A caption', evidence: [{ kind: 'transcript', text: 'What is said' }] }, { evidence_level: 'transcript-based' })).toBe('What is said');
    expect(evidenceQuote({ caption: '', evidence: [] }, AI)).toBe('');
    expect(evidenceQuote({ caption: 'x'.repeat(400), evidence: [] }, AI)).toHaveLength(150);
  });
});

describe('the queue\'s words and counts', () => {
  it('says what an answer did', () => {
    expect(answerWords('accept', AI)).toBe('Filed in Weeknight dinners');
    expect(answerWords('accept', { topics: ['x'] })).toBe('Suggestion accepted');
    expect(answerWords('keep', AI)).toBe('Kept as it was');
    expect(answerWords('keep', null)).toBe('Marked as reviewed');
  });

  it('counts the answers given against the saves still waiting', () => {
    expect(progress(2, 5)).toEqual({ done: 2, total: 7, position: 3 });
    expect(progress(0, 1)).toEqual({ done: 0, total: 1, position: 1 });
    expect(progress(7, 0)).toEqual({ done: 7, total: 7, position: 7 });
    expect(progress(0, 0)).toEqual({ done: 0, total: 0, position: 0 });
  });

  it('sums up a visit, and says nothing when nothing was decided', () => {
    expect(tally(5, 2)).toBe('5 accepted, 2 kept as they were.');
    expect(tally(0, 1)).toBe('1 kept as it was.');
    expect(tally(3, 0)).toBe('3 accepted.');
    expect(tally(0, 0)).toBe('');
  });

  it('says how long ago a save was added, in whole days', () => {
    const now = Date.parse('2026-11-16T12:00:00Z');
    expect(addedAgo('2026-11-16T08:00:00Z', now)).toBe('added today');
    expect(addedAgo('2026-11-15T10:00:00Z', now)).toBe('added yesterday');
    expect(addedAgo('2026-11-11T10:00:00Z', now)).toBe('added 5 days ago');
    expect(addedAgo('2026-03-02T10:00:00Z', now)).toBe('added Mar 2026');
    expect(addedAgo('', now)).toBe('');
    expect(addedAgo('not a date', now)).toBe('');
  });
});
