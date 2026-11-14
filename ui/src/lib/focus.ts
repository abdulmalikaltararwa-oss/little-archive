// Where focus goes when something closes. The rule the browser tests assert: back to what opened it; if that
// is gone or off screen, to a save that is on screen; failing that, to the view's heading. Never to <body>.

export const VIEW_TITLE_ID = 'view-title';

function usable(node: Element | null | undefined): node is HTMLElement {
  return node instanceof HTMLElement && node.isConnected && !node.closest('[inert], [aria-hidden="true"]') && node.getClientRects().length > 0;
}

function onScreen(node: Element): boolean {
  const box = node.getBoundingClientRect();
  return box.bottom > 0 && box.top < innerHeight;
}

/** The first card control that is in view. */
export function visibleCardControl(): HTMLElement | null {
  for (const node of document.querySelectorAll<HTMLElement>('[data-card-control="open"]')) if (usable(node) && onScreen(node)) return node;
  return null;
}

export interface FocusMemory {
  node: Element | null;
  itemId: string | null;
  control: string | null;
  navKey: string | null;
}

/**
 * Remembers a control in a way that survives it being re-rendered (a card is found again by its save). When nothing has
 * focus (the page itself does, <body>) there is no control to remember: a shortcut pressed then, or just after a dialog has
 * left, must not send focus back to the page when its own dialog closes.
 */
export function rememberFocus(node: Element | null = document.activeElement): FocusMemory {
  const element = node instanceof HTMLElement && node !== document.body ? node : null;
  return {
    node: element,
    itemId: element?.closest<HTMLElement>('[data-item-id]')?.dataset.itemId ?? null,
    control: element?.dataset.cardControl ?? null,
    navKey: element?.dataset.navKey ?? null,
  };
}

/**
 * Puts focus back where it was. With `strict`, nothing happens when that place is gone: used by a question
 * asked from inside another dialog, whose own closing decides where focus goes.
 */
export function restoreFocus(memory: FocusMemory | Element | null, { strict = false }: { strict?: boolean } = {}) {
  const remembered: FocusMemory = memory && 'node' in memory ? memory : rememberFocus(memory as Element | null);
  let target: Element | null = usable(remembered.node) ? remembered.node : null;
  if (strict && !target) return;
  if (!target && remembered.itemId && remembered.control) {
    target = document.querySelector(`[data-item-id="${CSS.escape(remembered.itemId)}"] [data-card-control="${CSS.escape(remembered.control)}"]`);
  }
  if (!target && remembered.navKey) target = document.querySelector(`[data-nav-key="${CSS.escape(remembered.navKey)}"]`);
  const fromCard = Boolean(remembered.itemId);
  if (fromCard && (!usable(target) || !onScreen(target))) target = visibleCardControl();
  if (!usable(target)) target = document.getElementById(VIEW_TITLE_ID);
  if (usable(target)) target.focus({ preventScroll: true });
}

/** After an action removed the focused control (a card left the view), put focus somewhere sensible. */
export function recoverFocus() {
  if (document.activeElement && document.activeElement !== document.body) return;
  if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return;
  const target = visibleCardControl() ?? document.getElementById(VIEW_TITLE_ID);
  if (usable(target)) target.focus({ preventScroll: true });
}
