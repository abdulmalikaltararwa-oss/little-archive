// The recipe routes, typed exactly as API_CONTRACT.md ("Recipes") writes them. Nothing here is invented: a
// field the contract does not name is not typed, and a body is built only from fields the contract accepts.
// Every call goes through the data layer's request function, so it reaches the right backend and carries the
// CSRF token or bearer token that backend needs.
import type { Archive } from '@/data/archive';

export type RecipeMethod = 'jsonld' | 'rules' | 'ai' | 'user';
export type Confidence = 'high' | 'medium' | 'low';
export type RecipeStatus = 'none' | 'extracted' | 'edited' | 'not_a_recipe';
export type RecipeReason = '' | 'not_a_recipe' | 'too_little_verifiable_content' | 'most_ingredients_unverified';
export type RecipePart = 'ingredients' | 'steps';

/** Where a line came from: jsonld, caption, transcript, title, notes, alt_text, page or user. Kept as text so a new source never breaks a screen. */
export type LineSource = string;

export interface RecipeTime {
  total_seconds: number | null;
  active_seconds: number | null;
  prep_seconds: number | null;
  cook_seconds: number | null;
}

export interface Ingredient {
  text: string;
  quantity: number | null;
  quantity_max: number | null;
  unit: string | null;
  unit_text: string | null;
  name: string;
  note: string | null;
  optional: boolean;
  scalable: boolean;
  group: string | null;
  source: LineSource;
}

export interface Step {
  text: string;
  timer_seconds: number | null;
  /** Indexes into the recipe's ingredients. */
  ingredient_refs: number[];
  source: LineSource;
  section: string | null;
  quote?: string;
}

export interface Provenance {
  method: RecipeMethod;
  evidence_level: string;
  evidence_sources: string[];
  evidence_note: string;
  provider: string;
  model: string;
  extracted_at?: string;
}

export interface RecipeEvidence {
  title: { source: string };
  servings: { source: string; quote: string } | null;
  time: { source: string } | null;
  ingredients: { sources: string[] };
  steps: { sources: string[] } | null;
}

export interface Recipe {
  schema: 1;
  is_recipe: boolean;
  confidence: Confidence;
  reason: RecipeReason;
  title: string;
  servings: number | null;
  servings_text: string | null;
  time: RecipeTime;
  ingredients: Ingredient[];
  steps: Step[];
  incomplete: RecipePart[];
  notes: string;
  evidence: RecipeEvidence;
  provenance: Provenance;
  dropped: { ingredients: number; steps: number };
}

export type ScaleWarning = 'rounded' | 'fractional_count';

export interface ScaledIngredient extends Ingredient {
  exact?: number | null;
  approximate?: boolean;
  scaled: boolean;
  /** The whole line as it should be read at this scale: amount, name and note. */
  display: string;
  warnings: ScaleWarning[];
}

export interface Scaled {
  factor: string;
  factor_float: number;
  base_servings: number | null;
  target_servings: number | null;
  ingredients: ScaledIngredient[];
  notes: string[];
}

export interface RecipeExtraction {
  method: 'jsonld' | 'rules' | 'ai';
  at: string;
  /** True when the save's text changed after this reading. */
  stale: boolean;
}

export interface RecipeResponse {
  item_id: string;
  status: RecipeStatus;
  edited: boolean;
  recipe: Recipe | null;
  extracted: Recipe | null;
  extraction: RecipeExtraction | null;
  edited_at: string | null;
  available: { jsonld: boolean; rules: boolean; ai: boolean };
  scaled?: Scaled;
}

export interface ExtractionResult {
  found: boolean;
  method?: 'jsonld' | 'rules' | 'ai';
  tried: string[];
  reason?: 'no_text' | 'ai_not_configured' | 'no_recipe_found';
  ai_available: boolean;
  is_recipe?: boolean;
}

export interface ExtractResponse extends RecipeResponse {
  extraction_result: ExtractionResult;
  /** The same text was already read; nothing was done again. */
  unchanged?: boolean;
}

export interface RecipeRow {
  item_id: string;
  title: string;
  item_title: string;
  url: string;
  thumbnail_url: string | null;
  servings: number | null;
  total_seconds: number | null;
  ingredient_count: number;
  step_count: number;
  confidence: Confidence;
  edited: boolean;
  method: RecipeMethod;
  updated_at: string;
}

export interface RecipeList {
  recipes: RecipeRow[];
  total: number;
  limit: number;
  offset: number;
}

/** What PUT accepts. The server decides provenance, confidence and every computed field. */
export interface IngredientEdit {
  /** Sent only for a line the owner did not touch, so a line they changed is rebuilt from its parts. */
  text?: string;
  name: string;
  quantity?: number | null;
  quantity_max?: number | null;
  unit?: string | null;
  note?: string | null;
  group?: string | null;
  optional?: boolean;
}

export interface StepEdit {
  text: string;
  /** Seconds, 1 or more. Left out, the server reads a timer from the step's own words. */
  timer_seconds?: number;
  /** Keeps a step without a timer even when its words contain a time. */
  no_timer?: boolean;
  section?: string | null;
}

export interface RecipeEdit {
  is_recipe?: boolean;
  title?: string;
  servings?: number;
  servings_text?: string;
  time?: Partial<RecipeTime>;
  ingredients?: IngredientEdit[];
  steps?: StepEdit[];
  notes?: string;
}

export interface ExtractBody {
  method?: 'auto' | 'jsonld' | 'rules' | 'ai';
  force?: boolean;
  fetch_page?: boolean;
}

/** How a recipe is shown: by a number of servings (needs the recipe to state its own) or by a factor. */
export type Scale = { kind: 'servings'; value: number } | { kind: 'factor'; value: number };

export const BASE_SCALE: Scale = { kind: 'factor', value: 1 };

export function scaleQuery(scale: Scale | null): string {
  if (!scale) return '';
  return scale.kind === 'servings' ? `?servings=${scale.value}` : `?factor=${scale.value}`;
}

const recipePath = (id: string) => `/items/${encodeURIComponent(id)}/recipe`;

/** The recipe of one save. With a scale, the response also carries `scaled`. */
export function getRecipe(archive: Archive, id: string, scale: Scale | null = null, signal?: AbortSignal) {
  return archive.api.request<RecipeResponse>(`${recipePath(id)}${scaleQuery(scale)}`, { signal });
}

/** Replaces the owner's version. The extraction stays beside it, untouched. */
export function putRecipe(archive: Archive, id: string, body: RecipeEdit) {
  return archive.api.request<RecipeResponse>(recipePath(id), { method: 'PUT', body });
}

/** Discards the owner's version; the extraction (if any) shows again. */
export function discardRecipeEdits(archive: Archive, id: string) {
  return archive.api.request<RecipeResponse>(`${recipePath(id)}/edits`, { method: 'DELETE' });
}

/** Reads the recipe from the save's own text. Never overwrites the owner's version. */
export function extractRecipe(archive: Archive, id: string, body: ExtractBody = {}) {
  return archive.api.request<ExtractResponse>(`${recipePath(id)}/extract`, { method: 'POST', body });
}

/** The saves whose recipe is a recipe, newest change first. */
export function listRecipes(archive: Archive, { limit = 24, offset = 0, includeArchived = false }: { limit?: number; offset?: number; includeArchived?: boolean } = {}, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (includeArchived) query.set('include_archived', 'true');
  return archive.api.request<RecipeList>(`/recipes?${query.toString()}`, { signal });
}
