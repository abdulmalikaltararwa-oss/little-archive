// Reads tokens.css and checks every text/background pairing the interface uses against WCAG AA, in both
// themes. A new pairing belongs in PAIRS; a token that fails here is fixed in tokens.css, not excused.
import { describe, expect, it } from 'vitest';
import css from './tokens.css?raw';

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf('\n}', start));
  const tokens: Record<string, string> = {};
  for (const match of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) tokens[match[1]!] = match[2]!;
  return tokens;
}

const light = block(':root');
const dark = { ...light, ...block(":root[data-theme='dark']") };

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// [text, background]. Body text needs 4.5:1.
const PAIRS: [string, string][] = [
  ['ink', 'paper'], ['ink', 'paper-deep'], ['ink', 'card'], ['ink', 'card-2'], ['ink', 'card-3'], ['ink', 'sage-pale'], ['ink', 'petal-pale'], ['ink', 'butter-pale'],
  ['ink-soft', 'paper'], ['ink-soft', 'paper-deep'], ['ink-soft', 'card'], ['ink-soft', 'card-2'], ['ink-soft', 'sage-pale'],
  ['on-sage', 'sage'], ['on-sage', 'sage-deep'],
  ['petal-ink', 'petal-pale'], ['petal-ink', 'card'], ['petal-ink', 'paper'],
  ['butter-ink', 'butter-pale'], ['sky-ink', 'sky-pale'], ['lilac-ink', 'lilac-pale'], ['clay-ink', 'clay-pale'],
  ['danger', 'card'], ['danger', 'danger-pale'], ['danger', 'paper'],
  ['on-island', 'island'], ['on-island-soft', 'island'],
];

// Sage as text: `sage` in light, `sage-deep` in dark (components pair `text-sage` with `dark:text-sage-deep`).
const SAGE_GROUNDS = ['paper', 'card', 'card-2', 'sage-pale'];

describe.each([['light', light], ['dark', dark]] as const)('%s theme', (name, tokens) => {
  it('defines every colour token the other theme defines', () => {
    expect(Object.keys(tokens).sort()).toEqual(Object.keys(name === 'light' ? dark : light).sort());
  });

  it.each(PAIRS)('%s on %s is readable (4.5:1)', (text, ground) => {
    expect(tokens[text], `--${text}`).toBeDefined();
    expect(tokens[ground], `--${ground}`).toBeDefined();
    expect(contrast(tokens[text]!, tokens[ground]!)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SAGE_GROUNDS)('sage text on %s is readable (4.5:1)', ground => {
    const sage = name === 'light' ? tokens.sage! : tokens['sage-deep']!;
    expect(contrast(sage, tokens[ground]!)).toBeGreaterThanOrEqual(4.5);
  });

  it('draws field borders and focus rings that can be seen (3:1)', () => {
    expect(contrast(tokens.sage!, tokens.paper!)).toBeGreaterThanOrEqual(3);
    expect(contrast(tokens.sage!, tokens.card!)).toBeGreaterThanOrEqual(3);
  });
});
