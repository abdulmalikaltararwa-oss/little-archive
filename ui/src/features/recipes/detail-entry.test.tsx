import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { ArchiveProvider } from '@/app/archive-context';
import type { Archive } from '@/data/archive';
import { ApiError } from '@/data/client';
import type { Features, Item } from '@/data/types';
import type { Recipe, RecipeResponse } from './api';
import { RecipeEntry } from './detail-entry';

// The motion library and the ASCII spinner ask whether motion is reduced; jsdom has no matchMedia.
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null }),
  });
});
afterEach(cleanup);

const ITEM = { id: 'item-1', title: 'Lemon spaghetti', url: 'https://example.com/a' } as Item;

const features = (recipes: Partial<Features['recipes']> | null): Features => ({
  mode: 'self-hosted', unlocked: true,
  recipes: recipes === null ? (undefined as never) : { available: true, locked: false, ...recipes },
  places: { available: true, locked: false }, ask: { available: true, locked: false }, guided_import: { available: true, locked: false },
});

function recipe(changes: Partial<Recipe> = {}): Recipe {
  return {
    schema: 1, is_recipe: true, confidence: 'medium', reason: '', title: 'Lemon spaghetti', servings: 4, servings_text: null,
    time: { total_seconds: null, active_seconds: null, prep_seconds: null, cook_seconds: null },
    ingredients: [{ text: '400 g spaghetti', quantity: 400, quantity_max: null, unit: 'g', unit_text: 'g', name: 'spaghetti', note: null, optional: false, scalable: true, group: null, source: 'caption' }],
    steps: [{ text: 'Boil it.', timer_seconds: 540, ingredient_refs: [0], source: 'caption', section: null }],
    incomplete: [], notes: '',
    evidence: { title: { source: 'title' }, servings: null, time: null, ingredients: { sources: ['caption'] }, steps: { sources: ['caption'] } },
    provenance: { method: 'rules', evidence_level: 'caption-based', evidence_sources: ['caption'], evidence_note: '', provider: '', model: '' },
    dropped: { ingredients: 0, steps: 0 },
    ...changes,
  };
}

const answer = (status: RecipeResponse['status'], card: Recipe | null): RecipeResponse => ({
  item_id: 'item-1', status, edited: false, recipe: card, extracted: card, extraction: card ? { method: 'rules', at: '2026-11-14T10:00:00+00:00', stale: false } : null, edited_at: null, available: { jsonld: false, rules: true, ai: false },
});

interface Setup { features: Features | null; known?: boolean; get?: () => Promise<unknown>; post?: () => Promise<unknown>; leave?: boolean }

function view({ features: flags, known = true, get = async () => answer('none', null), post, leave = true }: Setup) {
  const request = vi.fn(async (_path: string, options?: { method?: string }) => {
    if (options?.method === 'POST') return post ? post() : answer('none', null);
    return get();
  });
  const closeItem = vi.fn(async () => leave);
  const goScreen = vi.fn();
  const archive = { store: createStore(() => ({ features: flags, featuresKnown: known })), api: { request }, closeItem, goScreen } as unknown as Archive;
  const result = render(<ArchiveProvider archive={archive}><RecipeEntry item={ITEM} /></ArchiveProvider>);
  return { ...result, request, closeItem, goScreen };
}

describe('a save’s recipe section', () => {
  it('shows nothing while the recipes feature is not on this server, and asks nothing', () => {
    const { container, request } = view({ features: features({ available: false }) });
    expect(container).toBeEmptyDOMElement();
    expect(request).not.toHaveBeenCalled();
  });

  it('shows nothing while the server’s feature list is not known yet', () => {
    const { container, request } = view({ features: null, known: false });
    expect(container).toBeEmptyDOMElement();
    expect(request).not.toHaveBeenCalled();
  });

  it('says it is locked, without asking, when the account has not unlocked recipes', async () => {
    const { request, goScreen, closeItem } = view({ features: features({ locked: true }) });
    expect(screen.getByText(/part of the one-time unlock/)).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'About the unlock' }));
    await waitFor(() => expect(goScreen).toHaveBeenCalledWith('unlock', ''));
    expect(closeItem).toHaveBeenCalled();
  });

  it('shows the same quiet line when a call answers 402', async () => {
    view({ features: features({}), get: async () => { throw new ApiError('This comes with the full unlock.', 402, 'unlock_required'); } });
    expect(await screen.findByText(/part of the one-time unlock/)).toBeInTheDocument();
  });

  it('offers to look for a recipe when there is none, and reports the honest reason when nothing is found', async () => {
    const post = async () => ({ ...answer('none', null), extraction_result: { found: false, tried: ['rules'], reason: 'ai_not_configured', ai_available: false } });
    const { request } = view({ features: features({}), post });
    const button = await screen.findByRole('button', { name: 'Look for a recipe' });
    await userEvent.click(button);
    expect(await screen.findByRole('status')).toHaveTextContent(/no AI is set up on this server/);
    expect(request).toHaveBeenCalledWith('/items/item-1/recipe/extract', { method: 'POST', body: { method: 'auto' } });
  });

  it('explains a save with no text at all', async () => {
    const post = async () => ({ ...answer('none', null), extraction_result: { found: false, tried: [], reason: 'no_text', ai_available: false } });
    view({ features: features({}), post });
    await userEvent.click(await screen.findByRole('button', { name: 'Look for a recipe' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/no caption, notes or page text/);
  });

  it('shows the card once one is found', async () => {
    const post = async () => ({ ...answer('extracted', recipe()), extraction_result: { found: true, method: 'rules', tried: ['rules'], ai_available: false, is_recipe: true } });
    view({ features: features({}), post });
    await userEvent.click(await screen.findByRole('button', { name: 'Look for a recipe' }));
    expect(await screen.findByRole('button', { name: 'Open recipe card' })).toBeInTheDocument();
    expect(screen.getByText(/text rules · medium/)).toBeInTheDocument();
  });

  it('offers the card and cook mode for a save that has a recipe, and says how it was read', async () => {
    view({ features: features({}), get: async () => answer('extracted', recipe()) });
    expect(await screen.findByRole('button', { name: 'Open recipe card' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cook' })).toBeEnabled();
    expect(screen.getByText(/1 ingredient · 1 step/)).toBeInTheDocument();
  });

  it('does not offer cook mode for a card with no steps', async () => {
    view({ features: features({}), get: async () => answer('extracted', recipe({ steps: [], incomplete: ['steps'] })) });
    expect(await screen.findByRole('button', { name: 'Cook' })).toBeDisabled();
  });

  it('closes the save (which asks about unsaved edits) before opening the recipe, and stays put if the answer is no', async () => {
    const opened = view({ features: features({}), get: async () => answer('extracted', recipe()) });
    await userEvent.click(await screen.findByRole('button', { name: 'Open recipe card' }));
    await waitFor(() => expect(opened.goScreen).toHaveBeenCalledWith('recipes', 'item-1'));
    cleanup();

    const refused = view({ features: features({}), get: async () => answer('extracted', recipe()), leave: false });
    await userEvent.click(await screen.findByRole('button', { name: 'Cook' }));
    await waitFor(() => expect(refused.closeItem).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(refused.goScreen).not.toHaveBeenCalled();
  });

  it('opens cook mode at its own address', async () => {
    const { goScreen } = view({ features: features({}), get: async () => answer('extracted', recipe()) });
    await userEvent.click(await screen.findByRole('button', { name: 'Cook' }));
    await waitFor(() => expect(goScreen).toHaveBeenCalledWith('recipes', 'item-1/cook'));
  });

  it('says so, without a card, when the save was marked as not a recipe', async () => {
    view({ features: features({}), get: async () => ({ ...answer('not_a_recipe', recipe({ is_recipe: false, reason: 'not_a_recipe' })), edited: true }) });
    expect(await screen.findByText(/You marked this save as not a recipe/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cook' })).toBeNull();
  });

  it('shows a failure in words and lets the owner try again', async () => {
    const get = vi.fn().mockRejectedValueOnce(new ApiError('Could not reach your archive.', 0)).mockResolvedValue(answer('none', null));
    view({ features: features({}), get });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach your archive.');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Look for a recipe' })).toBeInTheDocument();
  });
});
