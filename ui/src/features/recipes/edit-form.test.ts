import { describe, expect, it } from 'vitest';
import type { Recipe } from './api';
import { buildEdit, emptyIngredient, emptyStep, formatQuantity, formatTimerField, formFromRecipe, formSignature, moveRow, parseQuantity, parseTimer, type RecipeForm } from './edit-form';

function recipe(changes: Partial<Recipe> = {}): Recipe {
  return {
    schema: 1, is_recipe: true, confidence: 'medium', reason: '', title: 'Garlic butter noodles', servings: 2, servings_text: 'Serves 2',
    time: { total_seconds: null, active_seconds: null, prep_seconds: null, cook_seconds: 240 },
    ingredients: [
      { text: '200 g spaghetti', quantity: 200, quantity_max: null, unit: 'g', unit_text: 'g', name: 'spaghetti', note: null, optional: false, scalable: true, group: null, source: 'caption' },
      { text: '3 cloves garlic, minced', quantity: 3, quantity_max: null, unit: 'clove', unit_text: 'cloves', name: 'garlic', note: 'minced', optional: false, scalable: true, group: null, source: 'caption' },
      { text: '1/3 cup milk', quantity: 0.3333333, quantity_max: null, unit: 'cup', unit_text: 'cup', name: 'milk', note: null, optional: false, scalable: true, group: 'Sauce', source: 'caption' },
      { text: 'Parmesan, to serve', quantity: null, quantity_max: null, unit: null, unit_text: null, name: 'Parmesan', note: 'to serve', optional: false, scalable: false, group: null, source: 'caption' },
    ],
    steps: [
      { text: 'Boil the spaghetti for 9 minutes.', timer_seconds: 540, ingredient_refs: [0], source: 'caption', section: null },
      { text: 'Toss with the butter.', timer_seconds: null, ingredient_refs: [], source: 'caption', section: 'Finish' },
    ],
    incomplete: [], notes: 'Good cold, too.',
    evidence: { title: { source: 'title' }, servings: null, time: null, ingredients: { sources: ['caption'] }, steps: { sources: ['caption'] } },
    provenance: { method: 'rules', evidence_level: 'caption-based', evidence_sources: ['caption'], evidence_note: '', provider: '', model: '' },
    dropped: { ingredients: 0, steps: 0 },
    ...changes,
  };
}

const built = (form: RecipeForm) => {
  const result = buildEdit(form);
  if (!result.ok) throw new Error(`Expected a body, got ${JSON.stringify(result.errors)}`);
  return result.body;
};

describe('numbers a person types', () => {
  it('reads amounts the way a cook writes them', () => {
    expect(parseQuantity('2')).toEqual({ quantity: 2, quantityMax: null });
    expect(parseQuantity('1.5')).toEqual({ quantity: 1.5, quantityMax: null });
    expect(parseQuantity('1,5')).toEqual({ quantity: 1.5, quantityMax: null });
    expect(parseQuantity('1/2')).toEqual({ quantity: 0.5, quantityMax: null });
    expect(parseQuantity('1 1/2')).toEqual({ quantity: 1.5, quantityMax: null });
    expect(parseQuantity('½')).toEqual({ quantity: 0.5, quantityMax: null });
    expect(parseQuantity('1½')).toEqual({ quantity: 1.5, quantityMax: null });
    expect(parseQuantity('٢')).toEqual({ quantity: 2, quantityMax: null });
    expect(parseQuantity(' 2-3 ')).toEqual({ quantity: 2, quantityMax: 3 });
    expect(parseQuantity('2 to 3')).toEqual({ quantity: 2, quantityMax: 3 });
    expect(parseQuantity('2–3')).toEqual({ quantity: 2, quantityMax: 3 });
    expect(parseQuantity('')).toEqual({ quantity: null, quantityMax: null });
  });

  it('refuses what is not an amount', () => {
    for (const bad of ['two', '1/0', '-1', '1-2-3', '2 cups', '1e3', '999999999']) expect(parseQuantity(bad)).toBeNull();
  });

  it('writes an amount for a field', () => {
    expect(formatQuantity(2)).toBe('2');
    expect(formatQuantity(1.5)).toBe('1 1/2');
    expect(formatQuantity(0.3333333)).toBe('1/3');
    expect(formatQuantity(0.75)).toBe('3/4');
    expect(formatQuantity(2.125)).toBe('2 1/8');
    expect(formatQuantity(0.15)).toBe('0.15');
    expect(formatQuantity(null)).toBe('');
  });

  it('reads a timer as minutes, minutes and seconds, or seconds', () => {
    expect(parseTimer('10')).toEqual({ ok: true, seconds: 600 });
    expect(parseTimer('10.5')).toEqual({ ok: true, seconds: 630 });
    expect(parseTimer('1:30')).toEqual({ ok: true, seconds: 90 });
    expect(parseTimer('1:00:00')).toEqual({ ok: true, seconds: 3600 });
    expect(parseTimer('90s')).toEqual({ ok: true, seconds: 90 });
    expect(parseTimer('2 min')).toEqual({ ok: true, seconds: 120 });
    expect(parseTimer('1h')).toEqual({ ok: true, seconds: 3600 });
    expect(parseTimer('٥')).toEqual({ ok: true, seconds: 300 });
    expect(parseTimer('')).toEqual({ ok: true, seconds: null });
    expect(parseTimer('0')).toEqual({ ok: true, seconds: null });
  });

  it('refuses a timer it cannot read or one that is far too long', () => {
    for (const bad of ['soon', '1:75x', '-5', '9999 h', '1.2.3']) expect(parseTimer(bad)).toEqual({ ok: false });
  });

  it('writes a timer for a field', () => {
    expect(formatTimerField(540)).toBe('9');
    expect(formatTimerField(90)).toBe('1:30');
    expect(formatTimerField(45)).toBe('0:45');
    expect(formatTimerField(null)).toBe('');
  });
});

describe('the form from a recipe', () => {
  it('shows each part the way it is written', () => {
    const form = formFromRecipe(recipe());
    expect(form.title).toBe('Garlic butter noodles');
    expect(form.servings).toBe('2');
    expect(form.totalMinutes).toBe('');
    expect(form.ingredients.map(row => [row.quantity, row.unit, row.name, row.note, row.group])).toEqual([
      ['200', 'g', 'spaghetti', '', ''], ['3', 'cloves', 'garlic', 'minced', ''], ['1/3', 'cup', 'milk', '', 'Sauce'], ['', '', 'Parmesan', 'to serve', ''],
    ]);
    expect(form.steps.map(row => [row.text, row.timer, row.section])).toEqual([['Boil the spaghetti for 9 minutes.', '9', ''], ['Toss with the butter.', '', 'Finish']]);
    expect(form.notes).toBe('Good cold, too.');
  });

  it('starts a hand-written recipe with one empty row of each', () => {
    const form = formFromRecipe(null, 'Toast');
    expect(form.title).toBe('Toast');
    expect(form.ingredients).toHaveLength(1);
    expect(form.steps).toHaveLength(1);
  });

  it('gives every row its own key', () => {
    const form = formFromRecipe(recipe());
    const keys = [...form.ingredients, ...form.steps].map(row => row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('the body PUT accepts', () => {
  it('sends an untouched recipe back as it was, wording and all', () => {
    const body = built(formFromRecipe(recipe()));
    expect(body.title).toBe('Garlic butter noodles');
    expect(body.is_recipe).toBe(true);
    expect(body.servings).toBe(2);
    expect(body.servings_text).toBe('Serves 2');
    expect(body.time).toEqual({ cook_seconds: 240 });
    expect(body.notes).toBe('Good cold, too.');
    expect(body.ingredients?.[1]).toEqual({ text: '3 cloves garlic, minced', name: 'garlic', quantity: 3, quantity_max: null, unit: 'clove', note: 'minced', group: null, optional: false });
    // The amount the owner never retyped keeps its exact stored value, not the rounded one in the field.
    expect(body.ingredients?.[2]?.quantity).toBe(0.3333333);
    expect(body.steps).toEqual([
      { text: 'Boil the spaghetti for 9 minutes.', section: null, timer_seconds: 540 },
      { text: 'Toss with the butter.', section: 'Finish', no_timer: true },
    ]);
  });

  it('never sends fields the contract does not accept', () => {
    const body = built(formFromRecipe(recipe()));
    const allowed = new Set(['is_recipe', 'title', 'servings', 'servings_text', 'time', 'ingredients', 'steps', 'notes']);
    expect(Object.keys(body).every(key => allowed.has(key))).toBe(true);
    for (const ingredient of body.ingredients ?? []) expect(Object.keys(ingredient).every(key => ['text', 'name', 'quantity', 'quantity_max', 'unit', 'note', 'group', 'optional'].includes(key))).toBe(true);
    for (const step of body.steps ?? []) expect(Object.keys(step).every(key => ['text', 'timer_seconds', 'no_timer', 'section'].includes(key))).toBe(true);
    // The server matches ingredients to steps by name, so these are never sent.
    expect(JSON.stringify(body)).not.toContain('ingredient_refs');
  });

  it('rebuilds the wording of a line the owner changed, and only that one', () => {
    const form = formFromRecipe(recipe());
    form.ingredients[0] = { ...form.ingredients[0]!, quantity: '250' };
    const body = built(form);
    expect(body.ingredients?.[0]).toEqual({ name: 'spaghetti', quantity: 250, quantity_max: null, unit: 'g', note: null, group: null, optional: false });
    expect(body.ingredients?.[0]).not.toHaveProperty('text');
    expect(body.ingredients?.[1]?.text).toBe('3 cloves garlic, minced');
  });

  it('reads a range and an optional flag', () => {
    const form = formFromRecipe(recipe());
    form.ingredients.push({ ...emptyIngredient(), quantity: '2-3', unit: 'tbsp', name: 'capers', optional: true });
    const added = built(form).ingredients?.[4];
    expect(added).toEqual({ name: 'capers', quantity: 2, quantity_max: 3, unit: 'tbsp', note: null, group: null, optional: true });
  });

  it('lets the server read a timer from the words of a step the owner changed', () => {
    const form = formFromRecipe(recipe());
    form.steps[0] = { ...form.steps[0]!, text: 'Boil the spaghetti for 12 minutes.' };
    const first = built(form).steps?.[0];
    expect(first).toEqual({ text: 'Boil the spaghetti for 12 minutes.', section: null });
  });

  it('keeps a timer the owner set, clears one they emptied, and reads minutes', () => {
    const form = formFromRecipe(recipe());
    form.steps[0] = { ...form.steps[0]!, timer: '1:30', timerTouched: true };
    form.steps[1] = { ...form.steps[1]!, timer: '10', timerTouched: true };
    expect(built(form).steps?.map(step => [step.timer_seconds, step.no_timer])).toEqual([[90, undefined], [600, undefined]]);
    form.steps[0] = { ...form.steps[0]!, timer: '', timerTouched: true };
    expect(built(form).steps?.[0]).toEqual({ text: 'Boil the spaghetti for 9 minutes.', section: null, no_timer: true });
  });

  it('drops the source’s words for servings when the number changes', () => {
    const form = formFromRecipe(recipe());
    form.servings = '4';
    const body = built(form);
    expect(body.servings).toBe(4);
    expect(body).not.toHaveProperty('servings_text');
  });

  it('sends no servings when the owner clears them', () => {
    const form = formFromRecipe(recipe());
    form.servings = '';
    const body = built(form);
    expect(body).not.toHaveProperty('servings');
    expect(body).not.toHaveProperty('servings_text');
  });

  it('keeps the other times and takes a new total in minutes', () => {
    const form = formFromRecipe(recipe());
    form.totalMinutes = '25';
    expect(built(form).time).toEqual({ cook_seconds: 240, total_seconds: 1500 });
  });

  it('leaves out empty rows, and a recipe written by hand needs no stored original', () => {
    const form = formFromRecipe(null, 'Toast');
    form.ingredients = [{ ...emptyIngredient(), quantity: '2', unit: 'slice', name: 'bread' }, emptyIngredient()];
    form.steps = [{ ...emptyStep(), text: 'Toast it.' }, emptyStep()];
    const body = built(form);
    expect(body.ingredients).toEqual([{ name: 'bread', quantity: 2, quantity_max: null, unit: 'slice', note: null, group: null, optional: false }]);
    expect(body.steps).toEqual([{ text: 'Toast it.', section: null }]);
    expect(body).not.toHaveProperty('servings');
    expect(body).not.toHaveProperty('time');
  });

  it('says what is wrong instead of sending it', () => {
    const form = formFromRecipe(recipe());
    form.title = '  ';
    form.servings = '0';
    form.totalMinutes = 'long';
    form.ingredients[0] = { ...form.ingredients[0]!, quantity: 'two' };
    form.ingredients[1] = { ...form.ingredients[1]!, name: '' };
    form.ingredients[2] = { ...form.ingredients[2]!, quantity: '3-2' };
    form.steps[0] = { ...form.steps[0]!, timer: 'soon', timerTouched: true };
    const result = buildEdit(form);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.title).toBeTruthy();
    expect(result.errors.servings).toBeTruthy();
    expect(result.errors.totalMinutes).toBeTruthy();
    expect(result.errors.ingredients[form.ingredients[0]!.key]?.quantity).toBeTruthy();
    expect(result.errors.ingredients[form.ingredients[1]!.key]?.name).toBeTruthy();
    expect(result.errors.ingredients[form.ingredients[2]!.key]?.quantity).toMatch(/cannot be lower/);
    expect(result.errors.steps[form.steps[0]!.key]?.timer).toBeTruthy();
  });

  it('wants at least one ingredient or step', () => {
    const form = formFromRecipe(null, 'Toast');
    const result = buildEdit(form);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.general).toMatch(/at least one/);
  });
});

describe('knowing what changed', () => {
  it('gives two forms with the same words the same signature', () => {
    expect(formSignature(formFromRecipe(recipe()))).toBe(formSignature(formFromRecipe(recipe())));
  });

  it('notices any edit, and a reorder', () => {
    const base = formFromRecipe(recipe());
    const edited = { ...base, title: 'Other' };
    expect(formSignature(edited)).not.toBe(formSignature(base));
    const reordered = { ...base, ingredients: moveRow(base.ingredients, 0, 1) };
    expect(formSignature(reordered)).not.toBe(formSignature(base));
  });

  it('moves a row, and stays put at the ends', () => {
    expect(moveRow(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveRow(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moveRow(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveRow(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });
});
