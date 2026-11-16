// The arithmetic of swiping a row. Offsets are along the line, not left and right: a positive offset moves the row
// towards the end of the line and uncovers what is under its start (Done, File); a negative one uncovers what is
// under its end (Delete). Right-to-left the same numbers apply and only the drawing flips.

export type Side = '' | 'start' | 'end';

/** How wide the uncovered actions are, under each edge of the row. */
export const REVEAL = { start: 152, end: 76 } as const;
/** How far a finger travels before the move counts as a swipe or as a scroll. */
export const SLOP = 8;

/** Where the row rests when a side is open. */
export function restOffset(side: Side): number {
  return side === 'start' ? REVEAL.start : side === 'end' ? -REVEAL.end : 0;
}

/** What a move is, once it is long enough to tell: sideways is a swipe, anything else is the page being scrolled. */
export function intent(dx: number, dy: number): 'swipe' | 'scroll' | null {
  if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return null;
  return Math.abs(dx) > Math.abs(dy) ? 'swipe' : 'scroll';
}

/** The row follows the finger as far as its actions are wide, and then only a fifth as fast. */
export function dragOffset(offset: number): number {
  if (offset > REVEAL.start) return REVEAL.start + (offset - REVEAL.start) / 5;
  if (offset < -REVEAL.end) return -REVEAL.end + (offset + REVEAL.end) / 5;
  return offset;
}

/** Which side stays open when the finger lifts: the one whose actions are more than half uncovered. */
export function settleSide(offset: number): Side {
  if (offset > REVEAL.start / 2) return 'start';
  if (offset < -REVEAL.end / 2) return 'end';
  return '';
}

/** The sign that turns an offset along the line into one across the screen. */
export function lineSign(direction: string): 1 | -1 {
  return direction === 'rtl' ? -1 : 1;
}
