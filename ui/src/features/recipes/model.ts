// What the recipe screens know without drawing anything: which address means what, how a duration or an
// amount is written, how ingredients and steps are grouped, and the plain words for every label and reason
// the server can send. Kept apart from the components so it can be tested on its own.
import type { Confidence, Ingredient, RecipeMethod, RecipePart, RecipeReason, ScaledIngredient, ScaleWarning, Scale, Step } from './api';

/* Addresses ------------------------------------------------------------------------------------------------ */

export type RecipeRoute =
  | { view: 'list' }
  | { view: 'card'; id: string }
  | { view: 'cook'; id: string }
  | { view: 'unknown' };

/** `rest` is the part of the address after #/recipes, already reduced to safe segments by the router. */
export function parseRest(rest: string): RecipeRoute {
  const parts = rest.split('/').filter(Boolean);
  if (!parts.length) return { view: 'list' };
  const [id = '', tail, ...more] = parts;
  if (more.length) return { view: 'unknown' };
  if (tail === undefined) return { view: 'card', id };
  if (tail === 'cook') return { view: 'cook', id };
  return { view: 'unknown' };
}

export const cardRest = (id: string) => id;
export const cookRest = (id: string) => `${id}/cook`;

/* Time ------------------------------------------------------------------------------------------------------ */

/** "45 sec", "9 min", "1 h 30 min", "1 day". For a person reading a card. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds} sec`;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (days) return [`${days} ${days === 1 ? 'day' : 'days'}`, hours ? `${hours} h` : ''].filter(Boolean).join(' ');
  if (hours) return [`${hours} h`, minutes ? `${minutes} min` : ''].filter(Boolean).join(' ');
  return rest ? `${minutes} min ${rest} sec` : `${minutes} min`;
}

/** The same, for a screen reader: whole words. */
export function spokenDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const unit = (value: number, word: string) => `${value} ${word}${value === 1 ? '' : 's'}`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const parts = [hours ? unit(hours, 'hour') : '', minutes ? unit(minutes, 'minute') : '', rest || !seconds ? unit(rest, 'second') : ''].filter(Boolean);
  return parts.join(' ');
}

/** A countdown's face: 09:05, or 1:30:00 past an hour. Rounds up, so a timer never shows 00:00 while it still runs. */
export function formatClock(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const two = (value: number) => String(value).padStart(2, '0');
  return hours ? `${hours}:${two(minutes)}:${two(rest)}` : `${two(minutes)}:${two(rest)}`;
}

/* Servings and scale ---------------------------------------------------------------------------------------- */

export function formatServings(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 100) / 100);
}

export const FACTORS = [0.5, 1, 2, 3] as const;
export const FACTOR_LABELS: Record<number, string> = { 0.5: '×½', 1: '×1', 2: '×2', 3: '×3' };

/** The smallest and largest number of servings the server accepts for a recipe of `base` servings (a factor of 1/100 to 100). */
export function servingsBounds(base: number): { min: number; max: number } {
  return { min: Math.max(0.01, base / 100), max: Math.min(1000, base * 100) };
}

/** One tap on the stepper: whole servings, so 2.5 goes to 3 or to 2 rather than to 3.5. Never below one, and never past the bounds. */
export function stepServings(value: number, direction: 1 | -1, base: number): number {
  const { max } = servingsBounds(base);
  if (direction > 0) return Math.min(max, Math.floor(value) + 1);
  return Math.max(Math.min(1, value), Math.ceil(value) - 1);
}

/** The scale the interface is showing, as a factor of the recipe's own amounts. */
export function scaleFactor(scale: Scale, base: number | null): number {
  if (scale.kind === 'factor') return scale.value;
  return base ? scale.value / base : 1;
}

export function sameScale(a: Scale, b: Scale): boolean {
  return a.kind === b.kind && a.value === b.value;
}

/* Ingredients ----------------------------------------------------------------------------------------------- */

const FRACTIONS = '¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞';
const NUMBER = `(?:[0-9٠-٩]+(?:[.,][0-9٠-٩]+)?(?:\\s?[0-9]+/[0-9]+)?[${FRACTIONS}]?|[${FRACTIONS}])`;
const AMOUNT = new RegExp(`^(${NUMBER}(?:\\s?[–-]\\s?${NUMBER})?)(?=\\s|$)`);

/** Splits "1½ tbsp olive oil" into its leading number and the rest, so the amount can be set a little heavier. */
export function splitAmount(line: string): [string, string] {
  const match = AMOUNT.exec(line);
  if (!match) return ['', line];
  const lead = match[1] ?? '';
  return [lead, line.slice(lead.length)];
}

/** The line to read for an ingredient: the server's scaled wording when there is one, else the line as written, else its parts. */
export function ingredientLine(ingredient: Ingredient | ScaledIngredient): string {
  if ('display' in ingredient && ingredient.display) return ingredient.display;
  if (ingredient.text) return ingredient.text;
  return ingredient.name;
}

/** Whether the line already says the ingredient is optional, so a second "optional" is not added. */
export function saysOptional(line: string): boolean {
  return /\boptional\b/i.test(line);
}

const WARNING_TEXT: Record<ScaleWarning, string> = {
  rounded: 'rounded to an amount you can measure',
  fractional_count: 'not a whole number',
};

export function warningText(warning: ScaleWarning): string {
  return WARNING_TEXT[warning] ?? warning;
}

export interface Grouped<T> {
  group: string | null;
  items: { index: number; value: T }[];
}

/** Keeps the recipe's own order and gathers lines under the group (or section) they name. Indexes stay the originals. */
export function groupBy<T>(values: readonly T[], key: (value: T) => string | null | undefined): Grouped<T>[] {
  const groups: Grouped<T>[] = [];
  values.forEach((value, index) => {
    const name = key(value)?.trim() || null;
    let group = groups.find(entry => entry.group === name);
    if (!group) {
      group = { group: name, items: [] };
      groups.push(group);
    }
    group.items.push({ index, value });
  });
  return groups;
}

export const groupIngredients = <T extends { group: string | null }>(ingredients: readonly T[]) => groupBy(ingredients, ingredient => ingredient.group);
export const groupSteps = (steps: readonly Step[]) => groupBy(steps, step => step.section);

/** The ingredients a step uses, in the recipe's order, skipping any index that does not exist. */
export function stepIngredients<T>(step: Pick<Step, 'ingredient_refs'>, ingredients: readonly T[]): { index: number; value: T }[] {
  const seen = new Set<number>();
  const found: { index: number; value: T }[] = [];
  for (const ref of [...step.ingredient_refs].sort((a, b) => a - b)) {
    const value = ingredients[ref];
    if (value === undefined || seen.has(ref)) continue;
    seen.add(ref);
    found.push({ index: ref, value });
  }
  return found;
}

/* Labels: the machine's voice ------------------------------------------------------------------------------ */

const METHOD_LABELS: Record<RecipeMethod, string> = { jsonld: 'page data', rules: 'text rules', ai: 'ai', user: 'yours' };

export const methodLabel = (method: RecipeMethod | string) => METHOD_LABELS[method as RecipeMethod] ?? String(method);

/** The mono label on a card: how it was read, and how sure the server is. */
export function readingLabel(method: RecipeMethod | string, confidence: Confidence | string): string {
  return `${methodLabel(method)} · ${confidence}`;
}

const LEVEL_LABELS: Record<string, string> = {
  'text-only': 'From the title and link only',
  'caption-based': 'From the caption',
  'transcript-based': 'From what is said',
  'structured-data': 'From the page’s own recipe data',
  'owner-edited': 'Written or corrected by you',
};

export function evidenceLabel(level: string): string {
  return LEVEL_LABELS[level] ?? `From ${String(level || 'available text').replaceAll('-', ' ')}`;
}

const SOURCE_LABELS: Record<string, string> = { jsonld: 'page data', caption: 'caption', transcript: 'transcript', title: 'title', notes: 'your notes', alt_text: 'alt text', page: 'page', user: 'you' };

export const sourceLabel = (source: string) => SOURCE_LABELS[source] ?? source.replaceAll('_', ' ');

const CONFIDENCE_SENTENCES: Record<Confidence, string> = {
  high: 'The server is fairly sure of this card: it comes from structured data or from your own words.',
  medium: 'The server found an ingredients list and a method, but a reading by rules can miss things. Check it against the save.',
  low: 'The server is not sure of this card. Check it against the save before you cook from it.',
};

export const confidenceSentence = (confidence: Confidence) => CONFIDENCE_SENTENCES[confidence] ?? '';

const REASON_SENTENCES: Record<Exclude<RecipeReason, ''>, string> = {
  not_a_recipe: 'The text of this save does not read like a recipe.',
  too_little_verifiable_content: 'There were too few ingredient lines that the text itself could back up, so no card was made.',
  most_ingredients_unverified: 'Most of the ingredient lines could not be matched to the text and were left out. The ones below are the ones the text supports.',
};

export function reasonSentence(reason: RecipeReason | string): string {
  return REASON_SENTENCES[reason as Exclude<RecipeReason, ''>] ?? '';
}

export function incompleteSentence(parts: readonly RecipePart[]): string {
  const has = (part: RecipePart) => parts.includes(part);
  if (has('ingredients') && has('steps')) return 'No ingredients and no steps were found in the text.';
  if (has('ingredients')) return 'The steps were found, but no ingredient list. Add one if you know it.';
  if (has('steps')) return 'The ingredients were found, but no method. You can write the steps yourself.';
  return '';
}

/** Why a look at the save's text found nothing, in the words an owner needs. */
export function noRecipeSentence(reason: string | undefined, aiAvailable: boolean): string {
  switch (reason) {
    case 'no_text': return 'This save has no caption, notes or page text to read a recipe from.';
    case 'ai_not_configured': return 'No recipe was found by the fixed text rules, and no AI is set up on this server to look any further.';
    case 'no_recipe_found': return aiAvailable ? 'Neither the text rules nor the AI found a recipe in this save’s text.' : 'Nothing in this save’s text reads like a recipe.';
    default: return 'No recipe was found in this save’s text.';
  }
}

export function droppedSentence(dropped: { ingredients: number; steps: number }): string {
  const parts = [
    dropped.ingredients ? `${dropped.ingredients} ingredient ${dropped.ingredients === 1 ? 'line' : 'lines'}` : '',
    dropped.steps ? `${dropped.steps} ${dropped.steps === 1 ? 'step' : 'steps'}` : '',
  ].filter(Boolean);
  if (!parts.length) return '';
  const one = dropped.ingredients + dropped.steps === 1;
  return `${parts.join(' and ')} the model suggested ${one ? 'was' : 'were'} left out, because the text did not back ${one ? 'it' : 'them'} up.`;
}

/** "8 ingredients", "1 step". */
export function countOf(count: number, singular: string, plural = `${singular}s`) {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}
