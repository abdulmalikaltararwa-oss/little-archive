import { describe, expect, it } from 'vitest';
import type { Step } from './api';
import {
  countOf, droppedSentence, evidenceLabel, formatClock, formatDuration, formatServings, groupIngredients, groupSteps, incompleteSentence, ingredientLine, noRecipeSentence,
  parseRest, reasonSentence, readingLabel, saysOptional, scaleFactor, servingsBounds, spokenDuration, splitAmount, stepIngredients, stepServings,
} from './model';

describe('addresses', () => {
  it('reads the part of the address after #/recipes', () => {
    expect(parseRest('')).toEqual({ view: 'list' });
    expect(parseRest('5a2742e4-5755')).toEqual({ view: 'card', id: '5a2742e4-5755' });
    expect(parseRest('5a2742e4-5755/cook')).toEqual({ view: 'cook', id: '5a2742e4-5755' });
  });

  it('does not guess at anything else', () => {
    expect(parseRest('abc/edit')).toEqual({ view: 'unknown' });
    expect(parseRest('abc/cook/extra')).toEqual({ view: 'unknown' });
  });
});

describe('time', () => {
  it('writes a duration for a card', () => {
    expect(formatDuration(0)).toBe('0 sec');
    expect(formatDuration(45)).toBe('45 sec');
    expect(formatDuration(540)).toBe('9 min');
    expect(formatDuration(90)).toBe('1 min 30 sec');
    expect(formatDuration(5400)).toBe('1 h 30 min');
    expect(formatDuration(7200)).toBe('2 h');
    expect(formatDuration(86400)).toBe('1 day');
    expect(formatDuration(86400 + 7200)).toBe('1 day 2 h');
  });

  it('says a duration in whole words for a screen reader', () => {
    expect(spokenDuration(60)).toBe('1 minute');
    expect(spokenDuration(90)).toBe('1 minute 30 seconds');
    expect(spokenDuration(5400)).toBe('1 hour 30 minutes');
    expect(spokenDuration(0)).toBe('0 seconds');
  });

  it('rounds a countdown up so it never reads 00:00 while it still runs', () => {
    expect(formatClock(540_000)).toBe('09:00');
    expect(formatClock(539_100)).toBe('09:00');
    expect(formatClock(1)).toBe('00:01');
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(5_400_000)).toBe('1:30:00');
    expect(formatClock(86_400_000)).toBe('24:00:00');
    expect(formatClock(-5)).toBe('00:00');
  });
});

describe('servings and scale', () => {
  it('shows servings without needless decimals', () => {
    expect(formatServings(4)).toBe('4');
    expect(formatServings(2.5)).toBe('2.5');
    expect(formatServings(1 / 3)).toBe('0.33');
  });

  it('keeps a scale inside what the server accepts', () => {
    expect(servingsBounds(4)).toEqual({ min: 0.04, max: 400 });
    expect(servingsBounds(24).max).toBe(1000);
  });

  it('steps by whole servings and stops at one', () => {
    expect(stepServings(4, 1, 4)).toBe(5);
    expect(stepServings(4, -1, 4)).toBe(3);
    expect(stepServings(2.5, 1, 4)).toBe(3);
    expect(stepServings(2.5, -1, 4)).toBe(2);
    expect(stepServings(1, -1, 4)).toBe(1);
    expect(stepServings(0.5, -1, 1)).toBe(0.5);
    expect(stepServings(400, 1, 4)).toBe(400);
  });

  it('turns a scale into a factor', () => {
    expect(scaleFactor({ kind: 'servings', value: 6 }, 4)).toBe(1.5);
    expect(scaleFactor({ kind: 'factor', value: 2 }, null)).toBe(2);
    expect(scaleFactor({ kind: 'servings', value: 6 }, null)).toBe(1);
  });
});

describe('ingredient lines', () => {
  it('splits the leading amount from the rest', () => {
    expect(splitAmount('600 g spaghetti')).toEqual(['600', ' g spaghetti']);
    expect(splitAmount('4½ tbsp olive oil')).toEqual(['4½', ' tbsp olive oil']);
    expect(splitAmount('1 1/2 cups milk')).toEqual(['1 1/2', ' cups milk']);
    expect(splitAmount('4–6 cloves garlic')).toEqual(['4–6', ' cloves garlic']);
    expect(splitAmount('⅓ cup sugar')).toEqual(['⅓', ' cup sugar']);
    expect(splitAmount('٢ كوب طحين')).toEqual(['٢', ' كوب طحين']);
  });

  it('leaves a line with no amount alone', () => {
    expect(splitAmount('salt and black pepper, to taste')).toEqual(['', 'salt and black pepper, to taste']);
    expect(splitAmount('a handful of parsley')).toEqual(['', 'a handful of parsley']);
    expect(splitAmount('2x4 plank')).toEqual(['', '2x4 plank']);
  });

  it('prefers the server’s scaled wording, then the line as written, then the name', () => {
    const base = { text: '', name: 'salt' } as never;
    expect(ingredientLine({ text: '2 cups flour', name: 'flour', display: '3 cups flour' } as never)).toBe('3 cups flour');
    expect(ingredientLine({ text: '2 cups flour', name: 'flour' } as never)).toBe('2 cups flour');
    expect(ingredientLine(base)).toBe('salt');
  });

  it('knows when a line already says optional', () => {
    expect(saysOptional('1 tsp chilli flakes (optional)')).toBe(true);
    expect(saysOptional('1½ tsp chilli flakes')).toBe(false);
  });

  it('groups in the recipe’s own order and keeps the original indexes', () => {
    const groups = groupIngredients([{ group: null }, { group: 'Sauce' }, { group: null }, { group: ' Sauce ' }, { group: 'Topping' }]);
    expect(groups.map(entry => [entry.group, entry.items.map(item => item.index)])).toEqual([[null, [0, 2]], ['Sauce', [1, 3]], ['Topping', [4]]]);
  });

  it('groups steps by their section', () => {
    const steps = [{ section: 'Batter' }, { section: 'Batter' }, { section: 'Cook' }] as Step[];
    expect(groupSteps(steps).map(entry => [entry.group, entry.items.length])).toEqual([['Batter', 2], ['Cook', 1]]);
  });

  it('finds the ingredients a step uses, ignoring references that do not exist', () => {
    const found = stepIngredients({ ingredient_refs: [2, 0, 2, 9] }, ['a', 'b', 'c']);
    expect(found).toEqual([{ index: 0, value: 'a' }, { index: 2, value: 'c' }]);
  });
});

describe('words for what the server says', () => {
  it('labels how a recipe was read', () => {
    expect(readingLabel('rules', 'medium')).toBe('text rules · medium');
    expect(readingLabel('jsonld', 'high')).toBe('page data · high');
    expect(readingLabel('user', 'high')).toBe('yours · high');
    expect(readingLabel('ai', 'low')).toBe('ai · low');
  });

  it('says what a recipe rests on, including levels it has not seen before', () => {
    expect(evidenceLabel('caption-based')).toBe('From the caption');
    expect(evidenceLabel('structured-data')).toBe('From the page’s own recipe data');
    expect(evidenceLabel('owner-edited')).toBe('Written or corrected by you');
    expect(evidenceLabel('page-text')).toBe('From page text');
  });

  it('explains every reason a card can be doubtful', () => {
    expect(reasonSentence('not_a_recipe')).not.toBe('');
    expect(reasonSentence('too_little_verifiable_content')).not.toBe('');
    expect(reasonSentence('most_ingredients_unverified')).not.toBe('');
    expect(reasonSentence('')).toBe('');
  });

  it('says what is missing from an incomplete card', () => {
    expect(incompleteSentence(['steps'])).toMatch(/no method/);
    expect(incompleteSentence(['ingredients'])).toMatch(/no ingredient list/);
    expect(incompleteSentence(['ingredients', 'steps'])).toMatch(/No ingredients and no steps/);
    expect(incompleteSentence([])).toBe('');
  });

  it('explains why a look at the text found nothing', () => {
    expect(noRecipeSentence('no_text', false)).toMatch(/no caption/);
    expect(noRecipeSentence('ai_not_configured', false)).toMatch(/no AI is set up/);
    expect(noRecipeSentence('no_recipe_found', true)).toMatch(/AI found/);
    expect(noRecipeSentence('no_recipe_found', false)).toMatch(/Nothing in this save/);
  });

  it('counts what a model offered that the text did not back', () => {
    expect(droppedSentence({ ingredients: 0, steps: 0 })).toBe('');
    expect(droppedSentence({ ingredients: 1, steps: 0 })).toBe('1 ingredient line the model suggested was left out, because the text did not back it up.');
    expect(droppedSentence({ ingredients: 2, steps: 1 })).toBe('2 ingredient lines and 1 step the model suggested were left out, because the text did not back them up.');
  });

  it('counts things', () => {
    expect(countOf(1, 'step')).toBe('1 step');
    expect(countOf(8, 'ingredient')).toBe('8 ingredients');
  });
});
