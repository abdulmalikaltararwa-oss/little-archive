import { describe, expect, it } from 'vitest';
import { layoutList, ROW_HEIGHT, windowRange } from './masonry';
import { dragOffset, intent, lineSign, restOffset, REVEAL, settleSide } from './swipe';

describe('swiping a row', () => {
  it('tells a swipe from a scroll only once the finger has moved far enough', () => {
    expect(intent(3, 4)).toBeNull();
    expect(intent(12, 3)).toBe('swipe');
    expect(intent(-12, 3)).toBe('swipe');
    expect(intent(3, 12)).toBe('scroll');
    expect(intent(9, 9)).toBe('scroll');
  });

  it('rests where the open side\'s actions are fully uncovered', () => {
    expect(restOffset('')).toBe(0);
    expect(restOffset('start')).toBe(REVEAL.start);
    expect(restOffset('end')).toBe(-REVEAL.end);
  });

  it('follows the finger up to the width of the actions and resists past it', () => {
    expect(dragOffset(40)).toBe(40);
    expect(dragOffset(-40)).toBe(-40);
    expect(dragOffset(REVEAL.start + 50)).toBe(REVEAL.start + 10);
    expect(dragOffset(-REVEAL.end - 50)).toBe(-REVEAL.end - 10);
  });

  it('stays open on the side that is more than half uncovered, and closes otherwise', () => {
    expect(settleSide(REVEAL.start / 2 + 1)).toBe('start');
    expect(settleSide(REVEAL.start / 2)).toBe('');
    expect(settleSide(-REVEAL.end / 2 - 1)).toBe('end');
    expect(settleSide(-10)).toBe('');
    // Dragging an open row back past half closes it.
    expect(settleSide(restOffset('start') - 100)).toBe('');
  });

  it('mirrors on a right-to-left line', () => {
    expect(lineSign('ltr')).toBe(1);
    expect(lineSign('rtl')).toBe(-1);
  });
});

describe('the list layout', () => {
  it('puts one save on each line, all the same height, as wide as the list', () => {
    const list = layoutList([{}, {}, {}], 358);
    expect(list.tiles).toEqual([
      { x: 0, y: 0, width: 358, height: ROW_HEIGHT },
      { x: 0, y: ROW_HEIGHT, width: 358, height: ROW_HEIGHT },
      { x: 0, y: ROW_HEIGHT * 2, width: 358, height: ROW_HEIGHT },
    ]);
    expect(list.height).toBe(ROW_HEIGHT * 3);
    expect(list.columns).toBe(1);
    expect(layoutList([], 358).height).toBe(0);
  });

  it('is drawn through the same window as the wall', () => {
    const list = layoutList(new Array(1000).fill(null), 358);
    expect(windowRange(list.tiles, ROW_HEIGHT * 10, ROW_HEIGHT * 20)).toEqual([9, 20]);
  });
});
