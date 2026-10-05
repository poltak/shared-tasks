// Tooltips for a mouse. An element with a `data-tip` attribute shows its text after the pointer
// rests on it for 500 ms. One set of listeners on the document serves all elements, so a list
// with hundreds of buttons costs nothing. A finger never shows a tooltip.

const DELAY = 500;
const GAP = 6;
const EDGE = 8;

let tip: HTMLElement | null = null;
let target: Element | null = null;
let timer = 0;

function hide(): void {
  clearTimeout(timer);
  target = null;
  tip?.classList.remove('show');
}

function show(element: Element): void {
  const text = element.getAttribute('data-tip');
  // The element can be gone, or the page can have moved it away from the pointer.
  if (!text || !element.matches(':hover, :focus-visible')) return;
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'ui-tooltip';
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
  }
  tip.textContent = text;
  const box = element.getBoundingClientRect();
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  const x = Math.max(EDGE, Math.min(box.left + box.width / 2 - width / 2, window.innerWidth - width - EDGE));
  // Below the element, or above it if there is no room below.
  const y = box.bottom + GAP + height > window.innerHeight - EDGE ? box.top - GAP - height : box.bottom + GAP;
  tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  tip.classList.add('show');
}

/** Starts the wait again. The tooltip shows when the pointer or the focus rests on the element. */
function rest(element: Element): void {
  hide();
  target = element;
  timer = window.setTimeout(() => show(element), DELAY);
}

function onPointerOver(event: PointerEvent): void {
  if (event.pointerType !== 'mouse') return;
  const element = event.target instanceof Element ? event.target.closest('[data-tip]') : null;
  if (element === target) return;
  if (element) rest(element);
  else hide();
}

/** A person who moves with the Tab key gets the tooltip of the element with the focus. */
function onFocusIn(event: FocusEvent): void {
  const element = event.target;
  if (element instanceof Element && element.matches('[data-tip]:focus-visible')) rest(element);
}

/** A scroll moves the element, so the tooltip goes away. The wait starts again for the element below the pointer. */
function onScroll(): void {
  if (target) rest(target);
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerover', onPointerOver, { passive: true });
  document.addEventListener('pointerdown', hide, { capture: true, passive: true });
  document.addEventListener('keydown', hide, { capture: true, passive: true });
  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('focusout', hide);
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  document.documentElement.addEventListener('pointerleave', hide);
  window.addEventListener('blur', hide);
}

/**
 * Svelte action for an element that is not one of the UI parts: `use:tooltip={'Text'}`.
 * It only sets the attribute that the listeners above read.
 */
export function tooltip(node: HTMLElement, text: string | null | undefined): { update: (text: string | null | undefined) => void } {
  const set = (value: string | null | undefined): void => {
    if (value) node.setAttribute('data-tip', value);
    else node.removeAttribute('data-tip');
  };
  set(text);
  return { update: set };
}
