import { describe, expect, it } from 'vitest';
import { clusterElement, pinElement } from './markers';

describe('pinElement', () => {
  it('is a flower on a stem for a place, anchored where the stem meets the ground', () => {
    const drawn = pinElement({ selected: false, area: false });
    expect(drawn.element.className).toBe('la-pin');
    expect(drawn.element.querySelectorAll('.petal')).toHaveLength(5);
    expect(drawn.element.querySelector('.stem')).not.toBeNull();
    expect(drawn.anchor[1]).toBeGreaterThan(drawn.size[1] / 2);
  });

  it('is marked when selected', () => {
    expect(pinElement({ selected: true, area: false }).element.classList.contains('is-selected')).toBe(true);
  });

  it('is a flower in a dashed ring, centred and without a stem, when the position is only an area', () => {
    const drawn = pinElement({ selected: false, area: true });
    expect(drawn.element.classList.contains('is-area')).toBe(true);
    expect(drawn.element.querySelector('.ring')).not.toBeNull();
    expect(drawn.element.querySelector('.stem')).toBeNull();
    expect(drawn.anchor).toEqual([drawn.size[0] / 2, drawn.size[1] / 2]);
  });

  it('is hidden from assistive technology: the list carries the words', () => {
    expect(pinElement({ selected: false, area: false }).element.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('clusterElement', () => {
  it('shows the count as text, never as markup', () => {
    const drawn = clusterElement(12);
    expect(drawn.element.textContent).toBe('12');
    expect(drawn.element.children).toHaveLength(1);
    expect(drawn.element.querySelector('*')?.tagName).toBe('SPAN');
  });

  it('grows with the count and caps what it prints', () => {
    expect(clusterElement(3).size[0]).toBeLessThan(clusterElement(30).size[0]);
    expect(clusterElement(30).size[0]).toBeLessThan(clusterElement(300).size[0]);
    expect(clusterElement(5000).element.textContent).toBe('999+');
  });
});
