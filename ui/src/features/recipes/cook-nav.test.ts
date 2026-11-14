import { describe, expect, it } from 'vitest';
import { keyIntent, moveStep, stepCounter, stepTextSize, swipeIntent } from './cook-nav';

describe('swiping between steps', () => {
  it('goes to the next step on a flick toward the start and to the previous on a flick away', () => {
    expect(swipeIntent(-120, 8, 200, false)).toBe('next');
    expect(swipeIntent(120, -8, 200, false)).toBe('previous');
  });

  it('reads the other way in a right-to-left language', () => {
    expect(swipeIntent(-120, 8, 200, true)).toBe('previous');
    expect(swipeIntent(120, 8, 200, true)).toBe('next');
  });

  it('ignores a short move, a mostly vertical one (a scroll) and a slow drag (a selection)', () => {
    expect(swipeIntent(-40, 0, 100, false)).toBeNull();
    expect(swipeIntent(-100, 90, 150, false)).toBeNull();
    expect(swipeIntent(-100, 0, 1500, false)).toBeNull();
    expect(swipeIntent(0, 0, 50, false)).toBeNull();
  });
});

describe('keys', () => {
  it('maps the arrows to the reading direction', () => {
    expect(keyIntent('ArrowRight', false)).toBe('next');
    expect(keyIntent('ArrowLeft', false)).toBe('previous');
    expect(keyIntent('ArrowRight', true)).toBe('previous');
    expect(keyIntent('ArrowLeft', true)).toBe('next');
    expect(keyIntent('PageDown', true)).toBe('next');
    expect(keyIntent('PageUp', false)).toBe('previous');
    expect(keyIntent('Enter', false)).toBeNull();
  });
});

describe('the step counter', () => {
  it('stops at the first step and at the all done page', () => {
    expect(moveStep(0, 5, 'previous')).toBe(0);
    expect(moveStep(2, 5, 'next')).toBe(3);
    expect(moveStep(4, 5, 'next')).toBe(5);
    expect(moveStep(5, 5, 'next')).toBe(5);
    expect(moveStep(5, 5, 'previous')).toBe(4);
    expect(moveStep(9, 5, null)).toBe(5);
    expect(moveStep(2, 5, null)).toBe(2);
  });

  it('says where you are', () => {
    expect(stepCounter(0, 5)).toBe('step 1 of 5');
    expect(stepCounter(4, 5)).toBe('step 5 of 5');
    expect(stepCounter(5, 5)).toBe('all done');
  });

  it('sets short steps large and long ones smaller', () => {
    expect(stepTextSize('Stir well.')).toBe('large');
    expect(stepTextSize('x'.repeat(150))).toBe('medium');
    expect(stepTextSize('x'.repeat(260))).toBe('small');
    expect(stepTextSize('أضيفي الدجاج واتركيه ٢٠ دقيقة.')).toBe('large');
  });
});
