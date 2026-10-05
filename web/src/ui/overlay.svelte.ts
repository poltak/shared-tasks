// One stack for all that opens on top of the page: menus, dialogs, sheets, the detail screen of
// the phone. The stack gives each overlay the same rules:
// - Esc and the Back action of the browser close the top overlay.
// - The focus goes into the overlay, stays there, and goes back to the opener.
// - The page below does not scroll.
// - The overlay keeps clear of the on-screen keyboard (see .ui-layer in base.css).

export interface OverlayOptions {
  /** Esc and Back call this. The owner then closes the overlay and calls `remove` of the handle. */
  close: () => void;
  /** The element that gets the focus and keeps it. It must be able to get the focus (tabindex="-1"). */
  element?: () => HTMLElement | null | undefined;
  /** false: Esc does not close the overlay. Default true. */
  escape?: boolean;
  /** false: no history entry, so Back does not close this overlay by itself. Default true. */
  history?: boolean;
  /** false: Tab can leave the element. Default true. */
  trapFocus?: boolean;
  /** false: the page below can scroll. Default true. */
  lockScroll?: boolean;
  /** false: the focus does not go into the element and does not go back. Default true. */
  focus?: boolean;
}

export interface OverlayHandle {
  /** Takes the overlay off the stack. More than one call does no harm. */
  remove: () => void;
  isTop: () => boolean;
}

interface Entry {
  options: OverlayOptions;
  /** Where the focus goes after the close: the opener, then the openers of the overlays below. */
  openers: HTMLElement[];
}

/** The key in `history.state` with the number of overlay entries up to that entry. */
export const OVERLAY_STATE_KEY = 'stOverlay';

const stack: Entry[] = [];
let count = $state(0);
let root: HTMLElement | null = null;
let locked = false;
let keyboard = false;

export const overlays = {
  /** The number of open overlays. Reactive. */
  get count(): number {
    return count;
  },
};

/** true if the last input of the person was a key and not a pointer. */
export function keyboardUsed(): boolean {
  return keyboard;
}

/** The element that holds all overlays. It is the last child of <body>. */
export function overlayRoot(): HTMLElement {
  if (!root) {
    root = document.createElement('div');
    root.className = 'ui-overlays';
    document.body.appendChild(root);
  }
  return root;
}

/** Svelte action: moves the element into the overlay root, out of all scroll areas and clips. */
export function portal(node: HTMLElement): { destroy: () => void } {
  overlayRoot().appendChild(node);
  return { destroy: () => node.remove() };
}

export function pushOverlay(options: OverlayOptions): OverlayHandle {
  const entry: Entry = { options, openers: [] };
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) {
    entry.openers.push(active);
    // The opener can be in an overlay that closes at the same time (a menu item that opens a
    // dialog). Then the focus goes back to the opener of that overlay.
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i]!.options.element?.()?.contains(active)) {
        entry.openers.push(...stack[i]!.openers);
        break;
      }
    }
  }
  stack.push(entry);
  changed();
  if (options.focus !== false) focusInto(entry);

  return {
    remove() {
      const i = stack.indexOf(entry);
      if (i < 0) return;
      stack.splice(i, 1);
      changed();
      if (options.focus !== false) focusBack(entry);
    },
    isTop: () => stack[stack.length - 1] === entry,
  };
}

/** Closes the top overlay, as Esc does. Gives false if no overlay is open. */
export function closeTopOverlay(): boolean {
  const top = stack[stack.length - 1];
  top?.options.close();
  return top !== undefined;
}

export function closeAllOverlays(): void {
  for (const entry of [...stack].reverse()) entry.options.close();
}

function changed(): void {
  count = stack.length;
  const lock = stack.some((entry) => entry.options.lockScroll !== false);
  if (lock !== locked) {
    locked = lock;
    const page = document.documentElement;
    if (lock) page.style.setProperty('--ui-scroll-gap', `${window.innerWidth - page.clientWidth}px`);
    page.classList.toggle('ui-scroll-lock', lock);
  }
  if (stack.length) fitViewport();
  scheduleHistory();
}

// ---- Focus ----

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function focusable(element: HTMLElement): HTMLElement[] {
  return [...element.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (node) => node.getClientRects().length > 0 && !node.closest('[inert]'),
  );
}

function focusInto(entry: Entry): void {
  const element = entry.options.element?.();
  if (!element || element.contains(document.activeElement)) return;
  const target = element.querySelector<HTMLElement>('[data-autofocus]') ?? element;
  target.focus({ preventScroll: true });
  if (target instanceof HTMLInputElement && target.dataset.autofocus === 'select') target.select();
}

function focusBack(entry: Entry): void {
  const active = document.activeElement;
  const element = entry.options.element?.();
  // If the app put the focus in a different place, it stays there.
  if (active && active !== document.body && !element?.contains(active)) return;
  for (const opener of entry.openers) {
    if (opener.isConnected && !opener.closest('[inert]')) {
      opener.focus({ preventScroll: true });
      return;
    }
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key !== 'Shift') keyboard = true;
  const top = stack[stack.length - 1];
  if (!top || event.isComposing) return;

  if (event.key === 'Escape') {
    // A part in the overlay that used Esc for itself (an open list of a field) prevents the default.
    if (event.defaultPrevented || top.options.escape === false) return;
    event.preventDefault();
    top.options.close();
    return;
  }

  if (event.key !== 'Tab' || top.options.trapFocus === false) return;
  const element = top.options.element?.();
  if (!element) return;
  const items = focusable(element);
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  let target: HTMLElement | undefined;
  if (!first) target = element;
  else if (!element.contains(active)) target = event.shiftKey ? last : first;
  else if (event.shiftKey && (active === first || active === element)) target = last;
  else if (!event.shiftKey && active === last) target = first;
  if (target) {
    event.preventDefault();
    target.focus();
  }
}

/** The focus went out of the top overlay by a way that the Tab rule above does not see. */
function onFocusIn(event: FocusEvent): void {
  const top = stack[stack.length - 1];
  if (!top || top.options.trapFocus === false || top.options.focus === false) return;
  const element = top.options.element?.();
  if (!element || !(event.target instanceof Node) || element.contains(event.target)) return;
  (focusable(element)[0] ?? element).focus({ preventScroll: true });
}

// ---- History ----
//
// Each overlay with `history` has one history entry. `history.state[OVERLAY_STATE_KEY]` of an
// entry is the number of overlay entries up to it. The stack and the history change at different
// times, so one function compares the two and repairs the difference. It runs in a new task:
// a menu that closes and a dialog that opens in the same click then need no history change.

let historyTimer = 0;
/** A `history.go` that this module started has not arrived yet. */
let waiting = false;
let waitTimer = 0;

function depthOf(state: unknown): number {
  const depth = typeof state === 'object' && state !== null ? (state as Record<string, unknown>)[OVERLAY_STATE_KEY] : 0;
  return typeof depth === 'number' ? depth : 0;
}

function wantedDepth(): number {
  let depth = 0;
  for (const entry of stack) if (entry.options.history !== false) depth++;
  return depth;
}

function withDepth(depth: number): Record<string, unknown> {
  return { ...(history.state as Record<string, unknown> | null), [OVERLAY_STATE_KEY]: depth };
}

function scheduleHistory(): void {
  if (!historyTimer) historyTimer = window.setTimeout(syncHistory, 0);
}

function syncHistory(): void {
  historyTimer = 0;
  if (waiting) return;
  const have = depthOf(history.state);
  const want = wantedDepth();
  if (want > have) {
    for (let depth = have + 1; depth <= want; depth++) history.pushState(withDepth(depth), '');
  } else if (want < have) {
    waiting = true;
    history.go(want - have);
    // If the entries are not there (a copy of the tab), no event comes. Then the state gets the
    // true number, so the next change starts from a correct value.
    waitTimer = window.setTimeout(() => {
      waiting = false;
      history.replaceState(withDepth(wantedDepth()), '');
    }, 600);
  }
}

function onPopState(event: PopStateEvent): void {
  const have = depthOf(event.state);
  if (waiting) {
    waiting = false;
    clearTimeout(waitTimer);
    // The code of the app must not see a navigation that only removed overlay entries.
    event.stopImmediatePropagation();
    scheduleHistory();
    return;
  }
  let extra = wantedDepth() - have;
  if (extra === 0) return;
  event.stopImmediatePropagation();
  // Back: close from the top. A Forward to an old overlay entry has `extra` below 0, and the
  // repair goes back from that entry.
  for (let i = stack.length - 1; i >= 0 && extra > 0; i--) {
    const entry = stack[i]!;
    if (entry.options.history !== false) extra--;
    entry.options.close();
  }
  scheduleHistory();
}

// ---- Visual viewport ----

/** Keeps the box of the overlays equal to the part of the window that the keyboard leaves free. */
function fitViewport(): void {
  const view = window.visualViewport;
  if (!view) return;
  const style = overlayRoot().style;
  // With pinch zoom, the visual viewport is a part of the page and not the window.
  if (Math.abs(view.scale - 1) > 0.01) {
    style.removeProperty('--vvt');
    style.removeProperty('--vvh');
    return;
  }
  style.setProperty('--vvt', `${view.offsetTop}px`);
  style.setProperty('--vvh', `${view.height}px`);
}

function onViewport(): void {
  if (stack.length) fitViewport();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => (keyboard = false), true);
  window.addEventListener('keydown', onKeydown);
  // Capture: this listener runs before the listeners of the app, and can hide the event from them.
  window.addEventListener('popstate', onPopState, true);
  document.addEventListener('focusin', onFocusIn);
  window.visualViewport?.addEventListener('resize', onViewport);
  window.visualViewport?.addEventListener('scroll', onViewport);
  // After a reload with an open overlay, the entries of the overlays are still in the history.
  if (depthOf(history.state) > 0) scheduleHistory();
}
