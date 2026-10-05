// Transitions for Svelte `transition:`, `in:`, and `out:`. Each one changes only `transform` and
// `opacity`, so the browser runs it with no layout and no paint.

import type { TransitionConfig } from 'svelte/transition';

const reduce = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

export function reducedMotion(): boolean {
  return reduce?.matches === true;
}

const time = (ms: number): number => (reducedMotion() ? 0 : ms);
const easeOut = (t: number): number => 1 - (1 - t) ** 3;

/** `to` is the opacity of the element at rest. */
export function fade(_node: Element, { duration = 150, to = 1 }: { duration?: number; to?: number } = {}): TransitionConfig {
  return { duration: time(duration), css: (t) => `opacity:${t * to}` };
}

/** A card that grows a little and comes into view. `y` is the distance that it moves up, in px. */
export function pop(
  _node: Element,
  { duration = 160, scale = 0.94, y = 0 }: { duration?: number; scale?: number; y?: number } = {},
): TransitionConfig {
  return {
    duration: time(duration),
    easing: easeOut,
    css: (t, u) => `opacity:${Math.min(1, t * 1.5)};transform:translateY(${u * y}px) scale(${1 - u * (1 - scale)})`,
  };
}

/** A sheet that comes up from the bottom edge. `from` is its offset in px when the transition starts (a drag). */
export function rise(_node: Element, { duration = 220, from = 0 }: { duration?: number; from?: number } = {}): TransitionConfig {
  return {
    duration: time(duration),
    easing: easeOut,
    css: (_t, u) => `transform:translateY(calc(${from}px + ${u} * (100% - ${from}px)))`,
  };
}

/** A screen that comes in from the right edge. */
export function slide(_node: Element, { duration = 220 }: { duration?: number } = {}): TransitionConfig {
  return {
    duration: time(duration),
    easing: easeOut,
    css: (t, u) => `opacity:${Math.min(1, t * 2)};transform:translateX(${u * 100}%)`,
  };
}
