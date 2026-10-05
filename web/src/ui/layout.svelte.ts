// The layout of the window, as a value that components can read in a template or an effect.

export type LayoutMode = 'wide' | 'phone';

/** SPEC section 8: the layout is wide from this window width. */
export const WIDE_MIN_WIDTH = 840;

const canMatch = typeof matchMedia === 'function';
const wideQuery = canMatch ? matchMedia(`(min-width: ${WIDE_MIN_WIDTH}px)`) : null;
const hoverQuery = canMatch ? matchMedia('(hover: hover) and (pointer: fine)') : null;

let wide = $state(wideQuery?.matches ?? true);
let hover = $state(hoverQuery?.matches ?? true);

wideQuery?.addEventListener('change', (event) => (wide = event.matches));
hoverQuery?.addEventListener('change', (event) => (hover = event.matches));

export const layout = {
  get mode(): LayoutMode {
    return wide ? 'wide' : 'phone';
  },
  get wide(): boolean {
    return wide;
  },
  get phone(): boolean {
    return !wide;
  },
  /** true if the main pointer is a mouse. A phone or a tablet with no mouse gives false. */
  get hover(): boolean {
    return hover;
  },
};
