// Moving through a recipe in cook mode: which way a swipe or a key goes, and where the step counter can stop.
// Steps are 0 to the last step; one more position, `steps.length`, is the quiet "all done" page after the
// last step. Direction follows the reading direction: in a right-to-left language "next" is to the left.

export type Intent = 'next' | 'previous' | null;

export const SWIPE_DISTANCE = 56;
export const SWIPE_RATIO = 1.5;
export const SWIPE_MAX_MS = 900;

/** A flick across the step. Mostly sideways, long enough to mean it, quick enough not to be a text selection. */
export function swipeIntent(dx: number, dy: number, elapsedMs: number, rtl: boolean): Intent {
  if (elapsedMs > SWIPE_MAX_MS) return null;
  if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) < SWIPE_RATIO * Math.abs(dy)) return null;
  const forward = rtl ? dx > 0 : dx < 0;
  return forward ? 'next' : 'previous';
}

export function keyIntent(key: string, rtl: boolean): Intent {
  if (key === 'PageDown') return 'next';
  if (key === 'PageUp') return 'previous';
  if (key === 'ArrowRight') return rtl ? 'previous' : 'next';
  if (key === 'ArrowLeft') return rtl ? 'next' : 'previous';
  return null;
}

/** The position after a move, kept between the first step and the "all done" page. */
export function moveStep(index: number, total: number, intent: Intent): number {
  const clamp = (value: number) => Math.max(0, Math.min(total, value));
  if (intent === 'next') return clamp(index + 1);
  if (intent === 'previous') return clamp(index - 1);
  return clamp(index);
}

/** Text for the step counter. */
export function stepCounter(index: number, total: number): string {
  return index >= total ? 'all done' : `step ${index + 1} of ${total}`;
}

/** The size of a step's words: short steps are set large, long ones smaller so they still fit a phone without scrolling much. */
export function stepTextSize(text: string): 'large' | 'medium' | 'small' {
  const length = [...text].length;
  if (length <= 90) return 'large';
  if (length <= 200) return 'medium';
  return 'small';
}
