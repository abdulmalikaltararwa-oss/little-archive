import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ingredient, ScaledIngredient, Step } from './api';
import { BASE_SCALE } from './api';
import { IngredientList, ScaleControl, StepList } from './card-parts';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null }),
  });
});
afterEach(cleanup);

const HOSTILE = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script> [x](javascript:alert(1)) **bold**';

const ingredient = (changes: Partial<ScaledIngredient> = {}): ScaledIngredient => ({
  text: '400 g spaghetti', quantity: 400, quantity_max: null, unit: 'g', unit_text: 'g', name: 'spaghetti', note: null, optional: false, scalable: true, group: null, source: 'caption',
  scaled: true, display: '600 g spaghetti', warnings: [], ...changes,
});

describe('untrusted text on a card', () => {
  it('draws an ingredient, a group, a step, a section and a quote as the characters they are', () => {
    render(
      <>
        <IngredientList ingredients={[ingredient({ display: HOSTILE, group: HOSTILE })]} showSources />
        <StepList steps={[{ text: HOSTILE, timer_seconds: null, ingredient_refs: [], source: 'caption', section: HOSTILE, quote: HOSTILE } as Step]} ingredients={[ingredient({ name: HOSTILE }) as Ingredient]} showSources />
      </>,
    );
    expect(document.querySelector('img, script, iframe, style, a[href]')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    for (const node of screen.getAllByText((_, element) => Boolean(element?.textContent?.includes('onerror')) && element?.children.length === 0)) {
      expect(node.closest('[dir="auto"]')).not.toBeNull();
    }
  });
});

describe('ingredient lines', () => {
  it('sets the amount apart, marks optional ones, and says what was rounded', () => {
    render(<IngredientList ingredients={[ingredient({ optional: true, approximate: true, exact: 62.5, warnings: ['rounded'], display: '63 g sugar' })]} showSources={false} />);
    const line = screen.getByRole('listitem');
    expect(within(line).getByText('63')).toHaveClass('font-semibold');
    expect(within(line).getByText('optional')).toBeInTheDocument();
    expect(line).toHaveTextContent('about');
    expect(line).toHaveTextContent('rounded to an amount you can measure');
    expect(line).toHaveTextContent('exactly 62.5 g');
  });

  it('does not say optional twice', () => {
    render(<IngredientList ingredients={[ingredient({ optional: true, display: '1 tsp chilli flakes (optional)' })]} showSources={false} />);
    expect(screen.getAllByText(/optional/)).toHaveLength(1);
  });

  it('shows where each line came from only when asked', () => {
    const { rerender } = render(<IngredientList ingredients={[ingredient()]} showSources={false} />);
    expect(screen.queryByText('caption')).toBeNull();
    rerender(<IngredientList ingredients={[ingredient()]} showSources />);
    expect(screen.getByText('caption')).toBeInTheDocument();
  });

  it('groups lines under the group they name', () => {
    render(<IngredientList ingredients={[ingredient({ group: null, display: '1 egg' }), ingredient({ group: 'Sauce', display: '2 tbsp oil' })]} showSources={false} />);
    expect(screen.getByRole('heading', { name: 'Sauce' })).toBeInTheDocument();
  });
});

describe('the servings control', () => {
  it('steps by one serving and asks for the new scale', async () => {
    const onScale = vi.fn();
    render(<ScaleControl base={4} scale={BASE_SCALE} onScale={onScale} />);
    expect(screen.getByRole('status')).toHaveTextContent('4 servings');
    await userEvent.click(screen.getByRole('button', { name: 'One serving more' }));
    expect(onScale).toHaveBeenLastCalledWith({ kind: 'servings', value: 5 });
    await userEvent.click(screen.getByRole('button', { name: 'One serving fewer' }));
    expect(onScale).toHaveBeenLastCalledWith({ kind: 'servings', value: 3 });
  });

  it('goes back to the recipe’s own amounts when the number returns to the original', async () => {
    const onScale = vi.fn();
    render(<ScaleControl base={4} scale={{ kind: 'servings', value: 5 }} onScale={onScale} />);
    expect(screen.getByText(/Scaled from 4/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'One serving fewer' }));
    expect(onScale).toHaveBeenLastCalledWith(BASE_SCALE);
    await userEvent.click(screen.getByRole('button', { name: /Back to 4/ }));
    expect(onScale).toHaveBeenLastCalledWith(BASE_SCALE);
  });

  it('does not go below one serving', () => {
    render(<ScaleControl base={4} scale={{ kind: 'servings', value: 1 }} onScale={() => {}} />);
    expect(screen.getByRole('button', { name: 'One serving fewer' })).toBeDisabled();
  });

  it('offers a factor, and only a factor, to a recipe that does not say how many it serves', async () => {
    const onScale = vi.fn();
    render(<ScaleControl base={null} scale={BASE_SCALE} onScale={onScale} />);
    expect(screen.queryByRole('button', { name: 'One serving more' })).toBeNull();
    expect(screen.getByText(/does not say how many it serves/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: '×2' }));
    expect(onScale).toHaveBeenLastCalledWith({ kind: 'factor', value: 2 });
  });
});
