// The edit form as plain data, and the one function that turns it into the body PUT accepts.
//
// The rules that matter, because PUT replaces the owner's whole version:
//  - a line the owner did not touch is sent back as it was, including its original wording (`text`), so a
//    quick edit to one ingredient does not rewrite the others;
//  - a line they did change is sent as its parts only; the server rebuilds the wording from them;
//  - a step's timer is read from its words unless the owner set it or cleared it; a step that was left alone
//    keeps the timer it had, even when that timer is none;
//  - ingredient_refs are never sent: the server matches ingredient names to steps itself, which also keeps
//    them right when ingredients are added, removed or reordered;
//  - only fields the contract accepts are sent. Provenance, confidence and the rest are the server's to say.
import type { IngredientEdit, Recipe, RecipeEdit, RecipeTime, StepEdit } from './api';

export const MAX_ROWS = 100;
const MAX_QUANTITY = 100_000;
const MAX_TIMER_SECONDS = 259_200;

let counter = 0;
const newKey = () => `row-${++counter}`;

export interface IngredientRow {
  key: string;
  quantity: string;
  unit: string;
  name: string;
  note: string;
  group: string;
  optional: boolean;
  /** What the row was loaded from. Null for a row the owner added. */
  origin: null | { text: string; quantity: number | null; quantityMax: number | null; quantityText: string; unit: string | null; snapshot: string };
}

export interface StepRow {
  key: string;
  text: string;
  /** Minutes (or m:ss) as typed. */
  timer: string;
  timerTouched: boolean;
  section: string;
  origin: null | { text: string; timerSeconds: number | null };
}

export interface RecipeForm {
  title: string;
  servings: string;
  totalMinutes: string;
  ingredients: IngredientRow[];
  steps: StepRow[];
  notes: string;
  origin: null | { servings: number | null; servingsText: string | null; time: RecipeTime };
}

/* Numbers a person types -------------------------------------------------------------------------------------- */

const DIGITS: Record<string, string> = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };
const VULGAR: Record<string, number> = { '¼': 0.25, '½': 0.5, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875, '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8, '⅙': 1 / 6, '⅚': 5 / 6 };

const plainDigits = (text: string) => text.replace(/[٠-٩۰-۹]/g, digit => DIGITS[digit] ?? digit);

/** One number: 2, 1.5, 1,5, 1/2, 1 1/2, ½, 1½. NaN when it is none of those. */
function parseNumber(raw: string): number {
  const text = plainDigits(raw).trim().replace(/^(\d+),(\d{1,2})$/, '$1.$2');
  let match = /^(\d+)\s+(\d+)\/(\d+)$/.exec(text);
  if (match) return Number(match[3]) ? Number(match[1]) + Number(match[2]) / Number(match[3]) : NaN;
  match = /^(\d+)\/(\d+)$/.exec(text);
  if (match) return Number(match[2]) ? Number(match[1]) / Number(match[2]) : NaN;
  match = /^(\d+)?\s*([¼½¾⅓⅔⅛⅜⅝⅞⅕⅖⅗⅘⅙⅚])$/.exec(text);
  if (match) return Number(match[1] ?? 0) + (VULGAR[match[2] ?? ''] ?? NaN);
  return /^(?:\d+\.?\d*|\.\d+)$/.test(text) ? Number(text) : NaN;
}

/** An amount as typed: empty (no amount), one number, or a range ("2-3", "2 to 3"). Null when it cannot be read. */
export function parseQuantity(text: string): { quantity: number | null; quantityMax: number | null } | null {
  const value = text.trim();
  if (!value) return { quantity: null, quantityMax: null };
  const parts = value.split(/\s*(?:[–—-]|\bto\b)\s*/);
  if (parts.length > 2) return null;
  const low = parseNumber(parts[0] ?? '');
  if (!Number.isFinite(low) || low > MAX_QUANTITY) return null;
  if (parts.length === 1) return { quantity: low, quantityMax: null };
  const high = parseNumber(parts[1] ?? '');
  if (!Number.isFinite(high) || high > MAX_QUANTITY) return null;
  return { quantity: low, quantityMax: high };
}

/** A number the way a cook writes it: 1 1/2, 2/3, 0.15. */
export function formatQuantity(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '';
  const whole = Math.floor(value + 1e-9);
  const fraction = value - whole;
  if (fraction < 0.005) return String(whole);
  for (const denominator of [2, 3, 4, 6, 8]) {
    const numerator = Math.round(fraction * denominator);
    if (numerator > 0 && numerator < denominator && Math.abs(fraction - numerator / denominator) < 0.005) return whole ? `${whole} ${numerator}/${denominator}` : `${numerator}/${denominator}`;
  }
  return String(Math.round(value * 100) / 100);
}

export const formatQuantityRange = (quantity: number | null, max: number | null) => (max === null ? formatQuantity(quantity) : `${formatQuantity(quantity)}-${formatQuantity(max)}`);

/** A timer as typed: 10, 10.5, 1:30, 90s, 1h, 2 min. Empty means none. Not ok when it cannot be read. */
export function parseTimer(text: string): { ok: true; seconds: number | null } | { ok: false } {
  const value = plainDigits(text).trim().toLowerCase();
  if (!value) return { ok: true, seconds: null };
  let seconds: number;
  let match = /^(\d+):(\d{2}):(\d{2})$/.exec(value);
  if (match) seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  else if ((match = /^(\d+):(\d{1,2})$/.exec(value))) seconds = Number(match[1]) * 60 + Number(match[2]);
  else if ((match = /^(\d+(?:\.\d+)?)\s*(s|secs?|seconds?)$/.exec(value))) seconds = Number(match[1]);
  else if ((match = /^(\d+(?:\.\d+)?)\s*(h|hrs?|hours?)$/.exec(value))) seconds = Number(match[1]) * 3600;
  else if ((match = /^(\d+(?:\.\d+)?)\s*(m|mins?|minutes?)?$/.exec(value))) seconds = Number(match[1]) * 60;
  else return { ok: false };
  seconds = Math.round(seconds);
  if (!Number.isFinite(seconds) || seconds > MAX_TIMER_SECONDS) return { ok: false };
  return { ok: true, seconds: seconds > 0 ? seconds : null };
}

/** A timer for its field: whole minutes as "10", anything else as "1:30". */
export function formatTimerField(seconds: number | null): string {
  if (seconds === null) return '';
  if (seconds % 60 === 0) return String(seconds / 60);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const minutesOf = (seconds: number | null) => (seconds === null ? '' : String(Math.round((seconds / 60) * 100) / 100));

/* Building the form ------------------------------------------------------------------------------------------ */

const snapshotOf = (row: Pick<IngredientRow, 'quantity' | 'unit' | 'name' | 'note' | 'group' | 'optional'>) => JSON.stringify([row.quantity, row.unit, row.name, row.note, row.group, row.optional]);

export function emptyIngredient(): IngredientRow {
  return { key: newKey(), quantity: '', unit: '', name: '', note: '', group: '', optional: false, origin: null };
}

export function emptyStep(section = ''): StepRow {
  return { key: newKey(), text: '', timer: '', timerTouched: false, section, origin: null };
}

export function formFromRecipe(recipe: Recipe | null, fallbackTitle = ''): RecipeForm {
  if (!recipe) return { title: fallbackTitle, servings: '', totalMinutes: '', ingredients: [emptyIngredient()], steps: [emptyStep()], notes: '', origin: null };
  const ingredients: IngredientRow[] = recipe.ingredients.map(ingredient => {
    const row = {
      quantity: ingredient.quantity === null ? '' : formatQuantityRange(ingredient.quantity, ingredient.quantity_max),
      unit: ingredient.unit_text ?? ingredient.unit ?? '',
      name: ingredient.name,
      note: ingredient.note ?? '',
      group: ingredient.group ?? '',
      optional: ingredient.optional,
    };
    return { key: newKey(), ...row, origin: { text: ingredient.text, quantity: ingredient.quantity, quantityMax: ingredient.quantity_max, quantityText: row.quantity, unit: ingredient.unit, snapshot: snapshotOf(row) } };
  });
  const steps: StepRow[] = recipe.steps.map(step => ({
    key: newKey(), text: step.text, timer: formatTimerField(step.timer_seconds), timerTouched: false, section: step.section ?? '', origin: { text: step.text, timerSeconds: step.timer_seconds },
  }));
  return {
    title: recipe.title || fallbackTitle,
    servings: recipe.servings === null ? '' : formatQuantity(recipe.servings),
    totalMinutes: minutesOf(recipe.time.total_seconds),
    ingredients: ingredients.length ? ingredients : [emptyIngredient()],
    steps: steps.length ? steps : [emptyStep()],
    notes: recipe.notes ?? '',
    origin: { servings: recipe.servings, servingsText: recipe.servings_text, time: recipe.time },
  };
}

/** What the form says, without the row keys: two forms with the same signature are the same recipe. */
export function formSignature(form: RecipeForm): string {
  return JSON.stringify([
    form.title, form.servings, form.totalMinutes, form.notes,
    form.ingredients.map(row => [row.quantity, row.unit, row.name, row.note, row.group, row.optional]),
    form.steps.map(row => [row.text, row.timer, row.section]),
  ]);
}

/** Moves one row up or down. Returns the same array when the move is not possible. */
export function moveRow<T>(rows: readonly T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (target < 0 || target >= rows.length) return [...rows];
  const next = [...rows];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved as T);
  return next;
}

/* The body ---------------------------------------------------------------------------------------------------- */

export interface FormErrors {
  title?: string;
  servings?: string;
  totalMinutes?: string;
  general?: string;
  ingredients: Record<string, { quantity?: string; name?: string }>;
  steps: Record<string, { text?: string; timer?: string }>;
}

export type BuiltEdit = { ok: true; body: RecipeEdit } | { ok: false; errors: FormErrors };

const hasErrors = (errors: FormErrors) => Boolean(errors.title || errors.servings || errors.totalMinutes || errors.general || Object.keys(errors.ingredients).length || Object.keys(errors.steps).length);

export function buildEdit(form: RecipeForm): BuiltEdit {
  const errors: FormErrors = { ingredients: {}, steps: {} };
  const title = form.title.trim();
  if (!title) errors.title = 'Give the recipe a title.';
  else if (title.length > 200) errors.title = 'A title can be up to 200 characters.';

  // Servings.
  let servings: number | null = null;
  const servingsText = form.servings.trim();
  if (servingsText) {
    const parsed = parseQuantity(servingsText);
    if (!parsed || parsed.quantity === null || parsed.quantityMax !== null || parsed.quantity <= 0 || parsed.quantity > 1000) errors.servings = 'Use a number above 0 and up to 1000.';
    else servings = parsed.quantity;
  }
  const servingsChanged = form.origin ? servingsText !== (form.origin.servings === null ? '' : formatQuantity(form.origin.servings)) : true;

  // Total time.
  let total: number | null | undefined;
  const totalText = plainDigits(form.totalMinutes).trim();
  if (totalText) {
    const minutes = Number(totalText.replace(',', '.'));
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 7 * 24 * 60) errors.totalMinutes = 'Use a number of minutes.';
    else total = Math.round(minutes * 60);
  }
  const totalChanged = form.origin ? totalText !== minutesOf(form.origin.time.total_seconds) : true;

  // Ingredients.
  const ingredients: IngredientEdit[] = [];
  for (const row of form.ingredients) {
    const name = row.name.trim();
    const blank = !name && !row.quantity.trim() && !row.unit.trim() && !row.note.trim() && !row.group.trim();
    if (blank) continue;
    const problems: { quantity?: string; name?: string } = {};
    if (!name) problems.name = 'Name this ingredient.';
    else if (name.length > 200) problems.name = 'A name can be up to 200 characters.';
    const parsed = parseQuantity(row.quantity);
    if (!parsed) problems.quantity = 'Use a number such as 2, 1 1/2 or 2-3.';
    else if (parsed.quantity !== null && parsed.quantityMax !== null && parsed.quantityMax < parsed.quantity) problems.quantity = 'The second number cannot be lower than the first.';
    if (Object.keys(problems).length) { errors.ingredients[row.key] = problems; continue; }
    const untouched = row.origin !== null && snapshotOf(row) === row.origin.snapshot;
    // An amount the owner did not retype keeps its exact stored value, not the rounded one shown in the field.
    const amount = row.origin && row.quantity === row.origin.quantityText ? { quantity: row.origin.quantity, quantityMax: row.origin.quantityMax } : parsed;
    const edit: IngredientEdit = {
      name,
      quantity: amount?.quantity ?? null,
      quantity_max: amount?.quantityMax ?? null,
      unit: untouched && row.origin ? row.origin.unit : row.unit.trim() || null,
      note: row.note.trim() || null,
      group: row.group.trim() || null,
      optional: row.optional,
    };
    if (untouched && row.origin) edit.text = row.origin.text;
    ingredients.push(edit);
  }

  // Steps.
  const steps: StepEdit[] = [];
  for (const row of form.steps) {
    const text = row.text.trim();
    if (!text) continue;
    if (text.length > 1000) { errors.steps[row.key] = { text: 'A step can be up to 1000 characters.' }; continue; }
    const timer = parseTimer(row.timer);
    if (!timer.ok) { errors.steps[row.key] = { timer: 'Use minutes (10), minutes and seconds (1:30) or seconds (45s).' }; continue; }
    const edit: StepEdit = { text, section: row.section.trim() || null };
    if (row.timerTouched) {
      if (timer.seconds === null) edit.no_timer = true;
      else edit.timer_seconds = timer.seconds;
    } else if (row.origin && row.origin.text === text) {
      // Left alone: keep the timer it had, even when that was none.
      if (row.origin.timerSeconds !== null) edit.timer_seconds = row.origin.timerSeconds;
      else edit.no_timer = true;
    }
    steps.push(edit);
  }

  if (form.ingredients.length > MAX_ROWS || form.steps.length > MAX_ROWS) errors.general = `A recipe can have up to ${MAX_ROWS} ingredients and ${MAX_ROWS} steps.`;
  else if (!ingredients.length && !steps.length && !hasErrors(errors)) errors.general = 'Add at least one ingredient or one step.';
  if (form.notes.length > 4000) errors.general = 'Notes can be up to 4000 characters.';
  if (hasErrors(errors)) return { ok: false, errors };

  const time: Partial<RecipeTime> = {};
  const origin = form.origin?.time;
  const keep = (key: keyof RecipeTime) => { const value = origin?.[key]; if (value !== null && value !== undefined) time[key] = value; };
  keep('active_seconds'); keep('prep_seconds'); keep('cook_seconds');
  if (totalChanged) { if (total !== undefined && total !== null) time.total_seconds = total; } else keep('total_seconds');

  const body: RecipeEdit = { is_recipe: true, title, ingredients, steps, notes: form.notes };
  if (servings !== null) {
    body.servings = servings;
    // The words the source used ("Serves 4") are kept only while they still say what the number says.
    if (!servingsChanged && form.origin?.servingsText) body.servings_text = form.origin.servingsText;
  }
  if (Object.keys(time).length) body.time = time;
  return { ok: true, body };
}
