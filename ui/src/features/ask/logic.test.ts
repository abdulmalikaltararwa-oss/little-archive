import { describe, expect, it } from 'vitest';
import type { Collection, Features, Tag } from '@/data/types';
import type { AskFilters, AskReason, AskResponse } from './api';
import { aiTrouble, answered, citation, heldBack, nothingSaved, notShown, rankedOnly, source } from './fixtures';
import {
  aiNote, askCapability, authorLine, buildExamples, checkQuestion, collapseSources, contextLine, describeOutcome, EMPTY_SESSION, entryTag, evidenceLabel, fieldLabel, filterBody,
  highlight, HISTORY_LIMIT, isNarrowed, matchLabel, narrowingLabels, NO_FILTERS, platformOf, problemText, sessionReducer, sourceStatus, withheldText, type Entry, type Session,
} from './logic';

describe('the question', () => {
  it('needs 3 to 500 characters with a letter or a number in them', () => {
    expect(checkQuestion('').problem).toBe('empty');
    expect(checkQuestion('   \n ').problem).toBe('empty');
    expect(checkQuestion('hi').problem).toBe('short');
    expect(checkQuestion('???').problem).toBe('no_words');
    expect(checkQuestion('abc')).toMatchObject({ ok: true, count: 3, problem: '' });
    expect(checkQuestion('a'.repeat(500))).toMatchObject({ ok: true, count: 500, over: 0 });
    expect(checkQuestion('a'.repeat(501))).toMatchObject({ ok: false, problem: 'long', over: 1 });
  });

  it('sends the text without the spaces around it, and counts it the way the server does', () => {
    expect(checkQuestion('  what did I save?  \n').question).toBe('what did I save?');
    // An emoji is one character to the server (a code point), though JavaScript's length says two.
    expect(checkQuestion('🍋🍋🍋').count).toBe(3);
    expect(checkQuestion('a🍋'.repeat(250))).toMatchObject({ ok: true, count: 500 });
    expect(checkQuestion('a🍋'.repeat(251)).problem).toBe('long');
    // Emoji alone are not words, and the server refuses them (a 422), so they are not sent.
    expect(checkQuestion('🍋🍋🍋').problem).toBe('no_words');
    expect(checkQuestion('وين وصفة اللبنة؟').ok).toBe(true);
    expect(checkQuestion('2024').ok).toBe(true);
  });

  it('says in a sentence what is wrong, and nothing when nothing is', () => {
    expect(problemText(checkQuestion('hi'))).toMatch(/at least 3/);
    expect(problemText(checkQuestion('???'))).toMatch(/letter or number/);
    expect(problemText(checkQuestion('a'.repeat(503)))).toBe('3 characters over the limit of 500.');
    expect(problemText(checkQuestion('a'.repeat(501)))).toBe('1 character over the limit of 500.');
    expect(problemText(checkQuestion('lemon pasta'))).toBe('');
  });
});

describe('narrowing', () => {
  const collections = [{ id: 'c1', name: 'Food & recipes' }];
  it('sends only what is set', () => {
    expect(filterBody(NO_FILTERS)).toEqual({});
    expect(filterBody({ platform: 'tiktok', collection_id: '', tag: 'pasta' })).toEqual({ platform: 'tiktok', tag: 'pasta' });
    expect(isNarrowed(NO_FILTERS)).toBe(false);
    expect(isNarrowed({ ...NO_FILTERS, tag: 'x' })).toBe(true);
  });

  it('says it in words, naming a collection that has since gone rather than hiding it', () => {
    expect(narrowingLabels({ platform: 'web', collection_id: 'c1', tag: 'pasta' }, collections)).toEqual(['Web links', 'Food & recipes', 'topic: pasta']);
    expect(narrowingLabels({ ...NO_FILTERS, collection_id: 'gone' }, collections)).toEqual(['a collection that is no longer here']);
    expect(narrowingLabels(NO_FILTERS, collections)).toEqual([]);
  });
});

describe('example questions', () => {
  const tags: Tag[] = [{ name: 'pasta', count: 4 }, { name: 'ceramics', count: 9 }, { name: 'travel', count: 2 }];
  const collections: Pick<Collection, 'name' | 'count' | 'kind'>[] = [
    { name: 'Instagram saves', count: 40, kind: 'source' },
    { name: 'Weekend plans', count: 6, kind: 'local' },
    { name: 'Empty shelf', count: 0, kind: 'local' },
  ];

  it('are made only of the owner’s own topics and collection names', () => {
    const examples = buildExamples({ tags, collections });
    expect(examples).toHaveLength(4);
    const names = ['ceramics', 'pasta', 'travel', 'Weekend plans', 'Instagram saves'];
    for (const example of examples) expect(names.some(name => example.text.includes(name))).toBe(true);
    // The fullest topic first, then the owner's own collection before the one a platform made.
    expect(examples[0]!.text).toContain('ceramics');
    expect(examples[1]!.text).toContain('Weekend plans');
    expect(examples.some(example => example.text.includes('Empty shelf'))).toBe(false);
  });

  it('are fewer, or none, when the library has little to draw on', () => {
    expect(buildExamples({ tags: [], collections: [] })).toEqual([]);
    expect(buildExamples({ tags: [{ name: 'tea', count: 1 }], collections: [] })).toHaveLength(1);
    expect(buildExamples({ tags, collections, limit: 2 })).toHaveLength(2);
  });

  it('do not repeat a name that is both a topic and a collection, and skip names too short or too long to ask about', () => {
    const examples = buildExamples({ tags: [{ name: 'Recipes', count: 3 }, { name: 'x', count: 9 }, { name: 'q'.repeat(60), count: 8 }], collections: [{ name: 'recipes', count: 5, kind: 'local' }] });
    expect(examples).toHaveLength(1);
    expect(examples[0]!.text).toContain('Recipes');
  });

  it('give each example a stable id and a question the server will accept', () => {
    const examples = buildExamples({ tags, collections });
    expect(new Set(examples.map(example => example.id)).size).toBe(examples.length);
    for (const example of examples) expect(checkQuestion(example.text).ok).toBe(true);
  });
});

describe('what this server can do', () => {
  const features = (ask: Partial<Features['ask']>): Features => ({ mode: 'self-hosted', unlocked: true, ask: { available: true, locked: false, ...ask } } as Features);
  it('is read from the feature list first, then from the settings', () => {
    expect(askCapability(features({ answers: true }), { ai_enabled: false })).toBe('answers');
    expect(askCapability(features({ answers: false }), { ai_enabled: true })).toBe('ranked_only');
    expect(askCapability(features({ ai: true }), { ai_enabled: false })).toBe('answers');
    expect(askCapability(features({}), { ai_enabled: true })).toBe('answers');
    expect(askCapability(null, { ai_enabled: false })).toBe('ranked_only');
  });

  it('is said before anything is asked, including where the words go', () => {
    expect(aiNote('ranked_only', { ai_hosted: false })).toMatch(/No AI is set up/);
    expect(aiNote('answers', { ai_hosted: true })).toMatch(/hosted AI service/);
    expect(aiNote('answers', { ai_hosted: true })).toMatch(/notes are held back/);
    expect(aiNote('answers', { ai_hosted: false })).toMatch(/your own server/);
  });
});

describe('words for fields and evidence', () => {
  it('names the field a quote or a match came from', () => {
    expect(fieldLabel('caption')).toBe('the caption');
    expect(fieldLabel('transcript')).toBe('what is said');
    expect(fieldLabel('alt_text')).toBe('the image description');
    expect(fieldLabel('something_new')).toBe('something new');
    expect(matchLabel(['title', 'caption', 'alt_text'])).toBe('title, caption, image description');
    expect(matchLabel([])).toBe('');
  });

  it('labels what an answer rests on, and the unknown plainly', () => {
    expect(evidenceLabel('caption-based')).toBe('From captions');
    expect(evidenceLabel('transcript-based')).toBe('From what is said');
    expect(evidenceLabel('text-only')).toBe('From saved text only');
    expect(evidenceLabel('visual-based')).toBe('From visual based');
    expect(evidenceLabel(undefined)).toBe('From your saved text');
  });

  it('names who wrote an answer', () => {
    expect(authorLine({ provider: 'ollama', model: 'qwen3:8b' })).toBe('ollama · qwen3:8b');
    expect(authorLine({ provider: 'ollama', model: null })).toBe('ollama');
    expect(authorLine({ provider: null, model: null })).toBe('');
  });
});

describe('what each answer means', () => {
  it('answer: an answer with quotes, and the ranked saves as support', () => {
    expect(describeOutcome(answered())).toMatchObject({ key: 'answer', tone: 'answer', sources: 'support', retry: false });
    expect(describeOutcome(answered()).body).toMatch(/quotes below as the evidence/);
  });

  it('ranked_only / ai_not_configured: says there is no AI and pretends nothing', () => {
    const outcome = describeOutcome(rankedOnly());
    expect(outcome).toMatchObject({ key: 'no_ai', sources: 'lead', retry: false });
    expect(outcome.heading).toMatch(/no AI set up/);
    expect(outcome.body).toMatch(/none is pretended/);
    expect(outcome.notice).toMatch(/best-matching saves only/);
  });

  it('no_results: the server’s own sentence, no sources, and a way forward', () => {
    const outcome = describeOutcome(nothingSaved());
    expect(outcome).toMatchObject({ key: 'nothing_saved', heading: 'Nothing saved about that.', sources: 'none' });
    expect(outcome.body).toMatch(/Try other words/);
    expect(describeOutcome(nothingSaved(), { narrowed: true }).body).toMatch(/narrowed/);
    // A question of nothing but common words searches for nothing, and says so.
    expect(describeOutcome(nothingSaved({ terms: [], question: 'the and of' })).body).toMatch(/too common/);
    // Whatever the server's sentence is, it is the one shown.
    expect(describeOutcome(nothingSaved({ answer: 'Rien de sauvegardé.' })).heading).toBe('Rien de sauvegardé.');
  });

  it('answered:false / ai_failed: the AI was down; trying again may help', () => {
    const outcome = describeOutcome(aiTrouble('ai_failed'));
    expect(outcome).toMatchObject({ key: 'ai_failed', tone: 'warn', retry: true, sources: 'lead' });
    expect(outcome.heading).toMatch(/could not answer just now/);
  });

  it('answered:false / ai_invalid: the reply was unusable and nothing of it was kept', () => {
    const outcome = describeOutcome(aiTrouble('ai_invalid'));
    expect(outcome).toMatchObject({ key: 'ai_invalid', retry: true });
    expect(outcome.body).toMatch(/none of it was kept/);
  });

  it('answered:false / not_in_saves: the AI looked and found nothing, and did not guess', () => {
    const outcome = describeOutcome(notShown('not_in_saves'));
    expect(outcome).toMatchObject({ key: 'not_in_saves', tone: 'plain', retry: false, sources: 'lead' });
    expect(outcome.body).toMatch(/did not guess/);
  });

  it('answered:false / unverified: an answer exists but could not be checked, so it is not shown', () => {
    const outcome = describeOutcome(notShown('unverified'));
    expect(outcome).toMatchObject({ key: 'unverified', tone: 'warn', retry: true });
    expect(outcome.body).toMatch(/not shown/);
  });

  it('answered:false / contains_instructions: nothing was sent to the AI', () => {
    const outcome = describeOutcome(heldBack('contains_instructions'));
    expect(outcome).toMatchObject({ key: 'contains_instructions', tone: 'warn', retry: false });
    expect(outcome.heading).toBe('Nothing was sent to the AI');
    expect(outcome.notice).toMatch(/none were sent to the model/);
  });

  it('answered:false / no_shareable_text: the AI had nothing it may read', () => {
    const outcome = describeOutcome(heldBack('no_shareable_text'));
    expect(outcome).toMatchObject({ key: 'no_shareable_text', retry: false });
    expect(outcome.body).toMatch(/not sent to a hosted AI/);
  });

  it('a reason it has never heard of falls back to the ranked list, never to an answer', () => {
    const odd = { ...rankedOnly(), reason: 'something_new' as AskReason };
    expect(describeOutcome(odd)).toMatchObject({ key: 'unclear', sources: 'lead' });
    // An "answered" response that carries no answer text is not presented as one.
    expect(describeOutcome({ ...answered(), answer: null })).toMatchObject({ key: 'unclear' });
    expect(describeOutcome({ ...answered(), answer: '' }).key).toBe('unclear');
  });

  it('offers no sources section when there are no ranked saves to show', () => {
    expect(describeOutcome({ ...rankedOnly(), sources: [] }).sources).toBe('none');
  });

  it('every reason the contract lists has words of its own', () => {
    const reasons: AskReason[] = ['nothing_saved', 'ai_not_configured', 'ai_failed', 'ai_invalid', 'not_in_saves', 'unverified', 'contains_instructions', 'no_shareable_text'];
    const keys = reasons.map(reason => describeOutcome({ ...rankedOnly(), reason, mode: reason === 'nothing_saved' ? 'no_results' : 'ranked_only' }).key);
    expect(new Set(keys).size).toBe(reasons.length);
    expect(keys).not.toContain('unclear');
  });
});

describe('what became of a ranked save', () => {
  it('says why a save was kept from the AI, in plain words', () => {
    expect(withheldText('contains_instructions')).toMatch(/looks like instructions to an AI/);
    expect(withheldText('no_shareable_text')).toMatch(/no text in this save that can be sent/);
    expect(withheldText('context_full')).toMatch(/no room left/);
  });

  it('is cited, held back, read, or nothing, and says "read" only where the AI really looked', () => {
    const plain = source();
    expect(sourceStatus(source({ used_in_answer: true }), answered())).toEqual({ kind: 'cited' });
    expect(sourceStatus(source({ withheld_from_answer: 'context_full' }), answered())).toEqual({ kind: 'withheld', text: withheldText('context_full') });
    expect(sourceStatus(plain, answered())).toEqual({ kind: 'read' });
    expect(sourceStatus(plain, notShown('not_in_saves'))).toEqual({ kind: 'read' });
    expect(sourceStatus(plain, rankedOnly())).toEqual({ kind: 'none' });
    expect(sourceStatus(plain, aiTrouble('ai_failed'))).toEqual({ kind: 'none' });
  });

  it('mentions how much the AI was given only when it was given something', () => {
    expect(contextLine({ saves: 0, passages: 0, chars: 0, truncated: false })).toBe('');
    expect(contextLine({ saves: 1, passages: 1, chars: 40, truncated: false })).toBe('The AI read 1 short passage from 1 save.');
    expect(contextLine({ saves: 3, passages: 5, chars: 900, truncated: true })).toMatch(/5 short passages from 3 saves\. More saves matched than fit/);
  });

  it('keeps the first few ranked saves, plus any the answer cites, in ranked order', () => {
    const list = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => source({ item_id: id, used_in_answer: index === 5 }));
    const { shown, hidden } = collapseSources(list, 3);
    expect(shown.map(entry => entry.item_id)).toEqual(['a', 'b', 'c', 'f']);
    expect(hidden).toBe(2);
    expect(collapseSources(list, 10)).toMatchObject({ hidden: 0 });
  });

  it('finds the platform of a cited save, defaulting to the web', () => {
    expect(platformOf(citation(), [source({ platform: 'tiktok' })])).toBe('tiktok');
    expect(platformOf(citation({ item_id: 'unknown' }), [source()])).toBe('web');
  });
});

describe('showing why a save matched', () => {
  const joined = (pieces: { text: string; hit: boolean }[]) => pieces.map(piece => piece.text).join('');

  it('marks the words the terms matched and keeps every character', () => {
    const text = 'Spaghetti with lemon, garlic and parsley. Lemons too.';
    const pieces = highlight(text, ['lemon', 'pasta']);
    expect(joined(pieces)).toBe(text);
    expect(pieces.filter(piece => piece.hit).map(piece => piece.text)).toEqual(['lemon', 'Lemons']);
  });

  it('matches the start of a word for a term of three letters or more, and the whole word for a shorter one', () => {
    expect(highlight('restaurants and a rest', ['restaurant']).filter(piece => piece.hit).map(piece => piece.text)).toEqual(['restaurants']);
    expect(highlight('go to Goa, go', ['go']).filter(piece => piece.hit).map(piece => piece.text)).toEqual(['go', 'go']);
  });

  it('folds case and Arabic letter variants the way the server does', () => {
    expect(highlight('وصفة اللبنة بالزعتر', ['لبنة']).filter(piece => piece.hit).map(piece => piece.text)).toEqual(['اللبنة']);
    expect(highlight('أحمد', ['احمد']).some(piece => piece.hit)).toBe(true);
  });

  it('leaves text with nothing to mark whole, and never turns text into markup', () => {
    expect(highlight('nothing here', ['lemon'])).toEqual([{ text: 'nothing here', hit: false }]);
    expect(highlight('plain', [])).toEqual([{ text: 'plain', hit: false }]);
    expect(highlight('', ['lemon'])).toEqual([{ text: '', hit: false }]);
    const hostile = '<img src=x onerror=alert(1)> lemon </b>';
    const pieces = highlight(hostile, ['lemon']);
    expect(joined(pieces)).toBe(hostile);
    expect(pieces.find(piece => piece.hit)?.text).toBe('lemon');
  });
});

describe('the visit’s questions', () => {
  const entry = (id: string, question = `question ${id}`, filters: AskFilters = NO_FILTERS, state: Entry['state'] = { status: 'pending' }): Entry => ({ id, question, filters, state });
  const ask = (session: Session, id: string, question?: string, filters?: AskFilters) => sessionReducer(session, { type: 'asked', entry: entry(id, question, filters) });
  const done = (session: Session, id: string, response: AskResponse = answered()) => sessionReducer(session, { type: 'answered', id, response });

  it('shows the newest question first and makes it the one on show', () => {
    let session = done(ask(EMPTY_SESSION, 'a'), 'a');
    session = done(ask(session, 'b'), 'b');
    expect(session.entries.map(old => old.id)).toEqual(['b', 'a']);
    expect(session.activeId).toBe('b');
  });

  it('cancels a question still on its way when another is asked, and drops its late answer', () => {
    let session = ask(EMPTY_SESSION, 'a');
    session = ask(session, 'b');
    expect(session.entries.map(old => old.id)).toEqual(['b']);
    const late = done(session, 'a');
    expect(late).toBe(session);
    expect(late.entries[0]!.state.status).toBe('pending');
  });

  it('replaces an earlier entry when the same question is asked again with the same narrowing', () => {
    let session = done(ask(EMPTY_SESSION, 'a', 'lemon pasta'), 'a');
    session = done(ask(session, 'b', 'other'), 'b');
    session = done(ask(session, 'c', 'lemon pasta'), 'c');
    expect(session.entries.map(old => old.id)).toEqual(['c', 'b']);
    // With a different narrowing it is a different question.
    session = ask(session, 'd', 'other', { ...NO_FILTERS, tag: 'x' });
    expect(session.entries.map(old => old.id)).toEqual(['d', 'c', 'b']);
  });

  it('records an answer, an error, and a locked answer on the entry that asked', () => {
    expect(done(ask(EMPTY_SESSION, 'a'), 'a').entries[0]!.state).toMatchObject({ status: 'done' });
    expect(sessionReducer(ask(EMPTY_SESSION, 'a'), { type: 'failed', id: 'a', message: 'Could not reach your archive.', httpStatus: 0 }).entries[0]!.state).toEqual({ status: 'error', message: 'Could not reach your archive.', httpStatus: 0 });
    expect(sessionReducer(ask(EMPTY_SESSION, 'a'), { type: 'locked', id: 'a' }).entries[0]!.state).toEqual({ status: 'locked' });
  });

  it('ignores an answer for a question it does not have, or one that already has its answer', () => {
    const session = done(ask(EMPTY_SESSION, 'a'), 'a');
    expect(done(session, 'a', nothingSaved())).toBe(session);
    expect(done(session, 'zzz')).toBe(session);
  });

  it('tries a failed question again from the start', () => {
    let session = sessionReducer(ask(EMPTY_SESSION, 'a'), { type: 'failed', id: 'a', message: 'x', httpStatus: 503 });
    session = sessionReducer(session, { type: 'restarted', id: 'a' });
    expect(session.entries[0]!.state).toEqual({ status: 'pending' });
    expect(session.activeId).toBe('a');
    // A question that is waiting, or locked, is not restarted.
    expect(sessionReducer(session, { type: 'restarted', id: 'a' })).toBe(session);
    const locked = sessionReducer(ask(EMPTY_SESSION, 'b'), { type: 'locked', id: 'b' });
    expect(sessionReducer(locked, { type: 'restarted', id: 'b' })).toBe(locked);
  });

  it('removes a stopped question and falls back to the one before it', () => {
    let session = done(ask(EMPTY_SESSION, 'a'), 'a');
    session = ask(session, 'b');
    session = sessionReducer(session, { type: 'cancelled', id: 'b' });
    expect(session.entries.map(old => old.id)).toEqual(['a']);
    expect(session.activeId).toBe('a');
    session = sessionReducer(ask(EMPTY_SESSION, 'x'), { type: 'cancelled', id: 'x' });
    expect(session.entries).toEqual([]);
    expect(session.activeId).toBe('');
    // Only a waiting question can be stopped.
    const finished = done(ask(EMPTY_SESSION, 'y'), 'y');
    expect(sessionReducer(finished, { type: 'cancelled', id: 'y' })).toBe(finished);
  });

  it('reopening an earlier question shows its answer again and puts its question and narrowing back in the form', () => {
    const narrowing: AskFilters = { platform: 'instagram', collection_id: 'c1', tag: 'pasta' };
    let session = done(ask(EMPTY_SESSION, 'a', 'lemon pasta', narrowing), 'a');
    session = done(ask(session, 'b', 'roses'), 'b');
    session = sessionReducer(session, { type: 'drafted', text: 'half typed' });
    session = sessionReducer(session, { type: 'opened', id: 'a' });
    expect(session).toMatchObject({ activeId: 'a', draft: 'lemon pasta', filters: narrowing });
    expect(sessionReducer(session, { type: 'opened', id: 'zzz' })).toBe(session);
  });

  it('keeps what is typed and chosen, and changes nothing when nothing changed', () => {
    const typed = sessionReducer(EMPTY_SESSION, { type: 'drafted', text: 'lemon' });
    expect(typed.draft).toBe('lemon');
    expect(sessionReducer(typed, { type: 'drafted', text: 'lemon' })).toBe(typed);
    const narrowed = sessionReducer(typed, { type: 'narrowed', filters: { tag: 'pasta' } });
    expect(narrowed.filters).toEqual({ platform: '', collection_id: '', tag: 'pasta' });
    expect(sessionReducer(narrowed, { type: 'narrowed', filters: { tag: 'pasta' } })).toBe(narrowed);
  });

  it('forgets the oldest question past the limit', () => {
    let session = EMPTY_SESSION;
    for (let index = 0; index < HISTORY_LIMIT + 5; index += 1) session = done(ask(session, `q${index}`), `q${index}`);
    expect(session.entries).toHaveLength(HISTORY_LIMIT);
    expect(session.entries[0]!.id).toBe(`q${HISTORY_LIMIT + 4}`);
  });

  it('clears the list but not what is in the form', () => {
    let session = sessionReducer(done(ask(EMPTY_SESSION, 'a'), 'a'), { type: 'drafted', text: 'keep me' });
    session = sessionReducer(session, { type: 'cleared' });
    expect(session).toMatchObject({ entries: [], activeId: '', draft: 'keep me' });
  });
});

describe('a word for how each earlier question went', () => {
  const tag = (state: Entry['state']) => entryTag({ state });
  it('covers a waiting question, an error, a locked answer, and every outcome', () => {
    expect(tag({ status: 'pending' })).toBe('reading');
    expect(tag({ status: 'error', message: 'x', httpStatus: 500 })).toBe('did not go through');
    expect(tag({ status: 'locked' })).toBe('locked');
    expect(tag({ status: 'done', response: answered() })).toBe('answered');
    expect(tag({ status: 'done', response: rankedOnly() })).toBe('ranked only');
    expect(tag({ status: 'done', response: nothingSaved() })).toBe('nothing saved');
    expect(tag({ status: 'done', response: notShown('not_in_saves') })).toBe('not in your saves');
    expect(tag({ status: 'done', response: notShown('unverified') })).toBe('held back');
    expect(tag({ status: 'done', response: aiTrouble('ai_failed') })).toBe('no answer');
    expect(tag({ status: 'done', response: aiTrouble('ai_invalid') })).toBe('no answer');
    expect(tag({ status: 'done', response: heldBack('contains_instructions') })).toBe('held back');
    expect(tag({ status: 'done', response: heldBack('no_shareable_text') })).toBe('held back');
  });
});
