// When the data of a page changes, its rows and cards do not jump: each one moves from the place
// where it was on the screen to its new place. Only the elements in view are read and animated,
// so a list with 500 rows costs the same as a list with 20. All motion is transform and opacity.
//
// Marks in the markup:
//
//   data-flip-list    A list. Its children are the rows, in the order of the screen. The list must
//                     be positioned (`position: relative`), so `offsetTop` of a row counts from it.
//   data-flip="row"   A row. A row that goes away fades out at its old place.
//   data-flip-block   A box that moves as one thing: a card, an empty state. With the value "card",
//                     the bottom edge of the box follows its rows when the height of the box
//                     changes. Such a box must be positioned and must have `isolation: isolate`,
//                     and the page around it must have the color `--bg`.
//
// The root must be positioned too: the copy of a row that goes away is put into it.

import { reducedMotion } from '../ui/motion.ts';

const EASE = 'cubic-bezier(0.2, 0, 0, 1)';
const MOVE_MS = 200;
const IN_MS = 180;
const OUT_MS = 140;
/** Rows this far out of the visible part of the page move too, so a row that comes into view does not jump. */
const MARGIN = 80;
/** More elements than this is not a change of some rows. Then nothing moves. */
const MAX_ELEMENTS = 90;

export interface FlipOptions {
  /** The element around the lists and the boxes. */
  root: () => HTMLElement | null | undefined;
  /** The element that scrolls the root. */
  scroller: () => HTMLElement | null | undefined;
  /** false: the next change shows with no motion. */
  enabled: () => boolean;
}

export interface Flip {
  /** Call before the DOM gets the change (`$effect.pre`). */
  capture: () => void;
  /** Call after the DOM got the change (`$effect`). */
  play: () => void;
  /** The changes of this task of the browser show with no motion. For a change that has its own motion. */
  pause: () => void;
}

interface Snapshot {
  rects: Map<HTMLElement, DOMRect>;
  /** Each row that was there, also out of view. */
  known: Set<Element>;
}

interface Delta {
  x: number;
  y: number;
}

const ZERO: Delta = { x: 0, y: 0 };
const px = (n: number): string => `${Math.round(n * 100) / 100}px`;

/** The children of a list that are between two lines of the window. A binary search finds the first one. */
function rowsInView({ list, top, bottom }: { list: HTMLElement; top: number; bottom: number }): HTMLElement[] {
  const rows = list.children;
  const count = rows.length;
  if (count === 0) return [];
  const start = list.getBoundingClientRect().top;
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const row = rows[mid] as HTMLElement;
    if (start + row.offsetTop + row.offsetHeight < top) lo = mid + 1;
    else hi = mid;
  }
  const found: HTMLElement[] = [];
  for (let i = lo; i < count; i++) {
    const row = rows[i] as HTMLElement;
    if (start + row.offsetTop > bottom) break;
    found.push(row);
  }
  return found;
}

function read({ root, scroller }: { root: HTMLElement; scroller: HTMLElement }): Map<HTMLElement, DOMRect> {
  const rects = new Map<HTMLElement, DOMRect>();
  const view = scroller.getBoundingClientRect();
  // Document order: a box is in the map before the boxes and the rows in it.
  for (const block of root.querySelectorAll<HTMLElement>('[data-flip-block]')) rects.set(block, block.getBoundingClientRect());
  for (const list of root.querySelectorAll<HTMLElement>('[data-flip-list]')) {
    for (const row of rowsInView({ list, top: view.top - MARGIN, bottom: view.bottom + MARGIN })) {
      rects.set(row, row.getBoundingClientRect());
    }
  }
  return rects;
}

export function createFlip(options: FlipOptions): Flip {
  let before: Snapshot | null = null;
  let paused = false;
  /** The moves that are on their way. A new change starts from where they are. */
  const running = new Set<Animation>();

  function run({ el, frames, duration }: { el: HTMLElement; frames: Keyframe[]; duration: number }): void {
    const animation = el.animate(frames, { duration, easing: EASE });
    running.add(animation);
    animation.onfinish = animation.oncancel = () => running.delete(animation);
  }

  /** An element that is only there for one animation. */
  function runAndRemove({ el, frames, duration }: { el: HTMLElement; frames: Keyframe[]; duration: number }): void {
    const animation = el.animate(frames, { duration, easing: EASE, fill: 'forwards' });
    animation.onfinish = animation.oncancel = () => el.remove();
  }

  function move(el: HTMLElement, { x, y }: Delta): void {
    if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) return;
    run({ el, frames: [{ transform: `translate(${px(x)},${px(y)})` }, { transform: 'none' }], duration: MOVE_MS });
  }

  /**
   * The box became shorter at once, but its rows are still on their way up. A piece with the
   * background of the box covers the part that the box lost, and goes up with the rows.
   */
  function skirt(card: HTMLElement, lost: number): void {
    const radius = parseFloat(getComputedStyle(card).borderBottomLeftRadius) || 0;
    const el = document.createElement('div');
    el.setAttribute('aria-hidden', 'true');
    Object.assign(el.style, {
      position: 'absolute',
      left: '0',
      right: '0',
      top: `calc(100% - ${px(radius)})`,
      height: px(lost + radius),
      borderRadius: `0 0 ${px(radius)} ${px(radius)}`,
      background: 'inherit',
      boxShadow: 'inherit',
      // Above the background of the box, below its rows.
      zIndex: '-1',
      pointerEvents: 'none',
    });
    card.append(el);
    runAndRemove({ el, frames: [{ transform: 'none' }, { transform: `translateY(${px(-lost)})` }], duration: MOVE_MS });
  }

  /**
   * The box became higher at once, but its rows are still on their way down. A piece in the color
   * of the page covers the part that the box gained. Its top edge has the form of the bottom
   * edge of the box, and goes down with the rows.
   */
  function unroll(card: HTMLElement, gained: number): void {
    const radius = parseFloat(getComputedStyle(card).borderBottomLeftRadius) || 0;
    // A little wider and lower than the box, for its shadow.
    const margin = 6;
    const cover = document.createElement('div');
    cover.setAttribute('aria-hidden', 'true');
    Object.assign(cover.style, {
      position: 'absolute',
      left: px(-margin),
      right: px(-margin),
      bottom: px(-margin),
      height: px(gained + radius + margin),
      overflow: 'hidden',
      zIndex: '1',
      pointerEvents: 'none',
    });
    // The window is empty, so the box shows through it. Its shadow has no blur and fills the
    // cover below it. The window starts above the cover and ends with its top at the top of the
    // cover, so the shadow never shows above it.
    const edge = document.createElement('div');
    Object.assign(edge.style, {
      position: 'absolute',
      left: px(margin),
      right: px(margin),
      top: px(-gained),
      height: px(gained + radius),
      borderRadius: `0 0 ${px(radius)} ${px(radius)}`,
      boxShadow: `0 0 0 ${px(gained + radius + 4 * margin)} var(--bg)`,
    });
    cover.append(edge);
    card.append(cover);
    const animation = edge.animate([{ transform: 'none' }, { transform: `translateY(${px(gained)})` }], { duration: MOVE_MS, easing: EASE, fill: 'forwards' });
    animation.onfinish = animation.oncancel = () => cover.remove();
  }

  /** A copy of a row that went away, at the place where the row was. */
  function ghost({ row, rect, root, frame }: { row: HTMLElement; rect: DOMRect; root: HTMLElement; frame: DOMRect }): void {
    const copy = row.cloneNode(true) as HTMLElement;
    // The copy is a picture. It must not count as a row for the drag engine, a test, or a reader.
    for (const name of ['data-flip', 'data-dnd-id', 'data-testid']) copy.removeAttribute(name);
    copy.setAttribute('aria-hidden', 'true');
    copy.inert = true;
    Object.assign(copy.style, {
      position: 'absolute',
      left: px(rect.left - frame.left),
      top: px(rect.top - frame.top),
      width: px(rect.width),
      height: px(rect.height),
      margin: '0',
      pointerEvents: 'none',
    });
    root.append(copy);
    runAndRemove({
      el: copy,
      frames: [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: 'scale(0.97)' },
      ],
      duration: OUT_MS,
    });
  }

  function capture(): void {
    before = null;
    if (paused || reducedMotion() || !options.enabled()) return;
    const root = options.root();
    const scroller = options.scroller();
    if (!root || !scroller) return;
    const known = new Set<Element>();
    for (const list of root.querySelectorAll('[data-flip-list]')) for (const row of list.children) known.add(row);
    before = { rects: read({ root, scroller }), known };
  }

  function play(): void {
    const snapshot = before;
    before = null;
    const root = options.root();
    const scroller = options.scroller();
    if (!snapshot || !root?.isConnected || !scroller) return;

    // The snapshot has the places of the moves that were on their way. The new places must be
    // the places of the layout, with no transform.
    for (const animation of [...running]) animation.cancel();

    const now = read({ root, scroller });
    // A row that went out of view (a new sort order) goes to its new place too.
    for (const el of snapshot.rects.keys()) if (el.isConnected && !now.has(el)) now.set(el, el.getBoundingClientRect());
    if (now.size > MAX_ELEMENTS) return;
    // All reads of the layout are before the first write.
    const view = scroller.getBoundingClientRect();
    const frame = root.getBoundingClientRect();
    const seen = (y: number): boolean => y > view.top - MARGIN && y < view.bottom + MARGIN;

    /** How far each box is from its old place. What is in the box moves with it. */
    const blocks = new Map<HTMLElement, Delta>();
    /** For each list: how far the last row with a known old place is from that place. */
    const lastRow = new Map<Element, Delta>();

    for (const [el, rect] of now) {
      const old = snapshot.rects.get(el);
      const isBlock = el.hasAttribute('data-flip-block');
      const around = (isBlock ? el.parentElement : el)?.closest<HTMLElement>('[data-flip-block]');
      const base = (around && blocks.get(around)) || ZERO;

      if (isBlock) {
        if (!old) {
          run({ el, frames: [{ opacity: 0 }, { opacity: 1 }], duration: IN_MS });
          continue;
        }
        // A box moves only if its top edge is in view. A long card with its top above the
        // window must not become one moving layer with all its rows: its rows in view move
        // by themselves. (After a change above the window, the browser keeps the rows in view
        // in their places, and only the hidden top of the card goes up or down.)
        const delta = seen(old.top) || seen(rect.top) ? { x: old.left - rect.left, y: old.top - rect.top } : ZERO;
        blocks.set(el, delta);
        move(el, { x: delta.x - base.x, y: delta.y - base.y });
        if (el.dataset.flipBlock === 'card' && (seen(old.bottom) || seen(rect.bottom))) {
          // How far the bottom edge is from its old place on the screen, after the move of the box.
          const lost = old.bottom - rect.bottom - delta.y;
          // An edge that goes farther than the window is high is out of view at once. The
          // piece for it would be a very large layer for nothing.
          if (Math.abs(lost) > view.height) continue;
          if (lost > 0.5) skirt(el, lost);
          else if (lost < -0.5) unroll(el, -lost);
        }
        continue;
      }

      const list = el.parentElement;
      if (!list) continue;
      if (old) {
        const delta = { x: old.left - rect.left - base.x, y: old.top - rect.top - base.y };
        lastRow.set(list, delta);
        move(el, delta);
      } else if (snapshot.known.has(el)) {
        // The row was out of view. It comes in with the rows next to it.
        move(el, lastRow.get(list) ?? ZERO);
      } else {
        run({
          el,
          frames: [
            { opacity: 0, transform: 'translateY(-8px)' },
            { opacity: 1, transform: 'none' },
          ],
          duration: IN_MS,
        });
      }
    }

    for (const [el, rect] of snapshot.rects) {
      if (el.isConnected || el.dataset.flip !== 'row' || rect.bottom < view.top || rect.top > view.bottom) continue;
      ghost({ row: el, rect, root, frame });
    }
  }

  function pause(): void {
    paused = true;
    before = null;
    setTimeout(() => (paused = false), 0);
  }

  return { capture, play, pause };
}
