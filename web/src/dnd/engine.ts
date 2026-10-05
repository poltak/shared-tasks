// The drag and drop engine. `index.ts` is the public door and has the rules for callers.
//
// How a drag works:
//
// 1. Press. A mouse must move 4 px, a finger must stay for 250 ms. Then the drag starts.
// 2. Start. The engine reads each rectangle one time. It hides the dragged block and shows a
//    clone of it in a fixed layer, at the same place.
// 3. Move. Pointer handlers only store the position. One requestAnimationFrame loop finds the
//    drop place from the stored rectangles and writes transforms. It reads nothing from the
//    layout, but for the scroll positions after a scroll.
// 4. Release. The engine stores where each item is on the screen, calls `onDrop`, and waits for
//    the next frame. Then it removes its transforms, reads the new layout, and moves each item
//    from the stored place to the new place (FLIP).

import type { DndController, DndDrop, DndOptions, DndPlace } from './index.ts';
import { family, resolvePlace, slotStart, stepDepth, type PlaceRow } from './place.ts';
import './dnd.css';

const MOUSE_SLOP = 4;
const TOUCH_SLOP = 8;
const HOLD_MS = 250;
const SHIFT_MS = 160;
const SETTLE_MS = 200;
const EASE = 'cubic-bezier(0.2, 0, 0, 1)';
/** Width of the band at an edge of a scroll area where the automatic scroll runs. */
const EDGE = 56;
/** Speed of the automatic scroll at the edge, in px for each second. */
const SCROLL_SPEED = 1100;
/** The pointer can be this far to the side of a container and the drop still goes into it. */
const REACH = 40;
/** The block must go this far past the middle of a row to change places with it. */
const STICK = 4;
/** A row this far out of the visible part of its list still counts as in view. */
const VIEW_MARGIN = 150;
const IGNORE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-dnd-ignore]';
const ITEM = '[data-dnd-id]';
const ZONE = '[data-dnd-container]';
/** Text properties that the clone gets from the elements above an item, and loses in the layer. */
const TEXT_STYLES = [
  'color',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'direction',
] as const;
const LOOK_VARS = ['--dnd-accent', '--dnd-lift-radius', '--dnd-lift-shadow', '--dnd-lift-scale'];

interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}

/** An element that scrolls or clips its content. */
interface Scroller {
  el: Element;
  /** Its rectangle at measure time. */
  box: Box;
  /** The scrollers around it. */
  outer: Scroller[];
  canX: boolean;
  canY: boolean;
  /** Scroll position at measure time, and now. */
  x0: number;
  y0: number;
  x: number;
  y: number;
}

interface Row extends PlaceRow {
  el: HTMLElement;
  /** Rectangle at measure time. */
  box: Box;
  /** Start along the axis at measure time, on the screen. `start` is the same with the block removed. */
  base: number;
  /** The row is after the dragged block in the same container. */
  after: boolean;
  /** The transform that the row has now. */
  shift: number;
  styled: boolean;
  /** The row has `will-change`. */
  hinted: boolean;
}

/** A container. */
interface Zone {
  el: HTMLElement;
  id: string;
  /** The rows without the dragged block. */
  rows: Row[];
  gap: number;
  emptyStart: number;
  box: Box;
  /** Where the rows start and end across the axis. */
  lo: number;
  hi: number;
  /** The scrollers that move the rows, and those that move the container. */
  inner: Scroller[];
  outer: Scroller[];
  /** How far the scrollers moved the rows since the measure: along and across the axis. */
  o: number;
  oc: number;
  /** The same for the box of the container. */
  bo: number;
  bc: number;
  /** The part of the screen where the rows can show. */
  clip: Box;
  /** Padding and margin at the end, from the style sheet. */
  pad: number;
  margin: number;
  canGrow: boolean;
  grown: number;
  /** The engine wrote styles on the container. */
  sized: boolean;
}

interface Layout {
  zones: Zone[];
  scrollers: Scroller[];
  src: Zone;
  /** The dragged item and its subtasks. */
  els: HTMLElement[];
  ids: string[];
  /** Rectangle around the block at measure time. */
  box: Box;
  /** Size of the block along the axis. */
  size: number;
  originIndex: number;
  originDepth: number;
}

interface Target {
  zone: Zone;
  index: number;
  depth: number;
}

interface Press {
  el: HTMLElement;
  id: string;
  pointerId: number;
  touch: boolean;
  x: number;
  y: number;
  sx: number;
  sy: number;
  timer: number;
}

interface Drag extends Layout {
  id: string;
  pointerId: number;
  /** Pointer now, and at the start. */
  x: number;
  y: number;
  sx: number;
  sy: number;
  /** From the corner of the block to the pointer. */
  grabX: number;
  grabY: number;
  /** From the side of the rows to the pointer at the start. The depth comes from the change of this distance. */
  side: number;
  pref: number;
  target: Target | null;
  layer: HTMLElement;
  ghost: HTMLElement;
  /** Where the copy is on the screen. */
  gx: number;
  gy: number;
  /** How far the copy is moved to the side to show the depth, with `lockAxis`. */
  lean: number;
  marker: HTMLElement;
  marked: boolean;
  /** Work for the next frame. */
  moved: boolean;
  scrolled: boolean;
  stale: boolean;
  /** The next writes must not animate, because they put back a state after a new measure. */
  instant: boolean;
  /** The pointer went this way at some time. The automatic scroll waits for that, so a press near an edge does not scroll immediately. */
  went: { up: boolean; down: boolean; left: boolean; right: boolean };
  frame: number;
  time: number;
  observer: MutationObserver;
  /** Items with a transform from the last animation. */
  flipped: HTMLElement[];
  /** Elements after `strip` that wait for `free`. */
  loose: HTMLElement[];
}

// Two engines can have the same root. One press starts one drag.
const taken = new WeakSet<Event>();

let active = 0;
function setActive(on: boolean): void {
  active += on ? 1 : -1;
  document.documentElement.classList.toggle('dnd-active', active > 0);
}

const toBox = (r: DOMRect): Box => ({ l: r.left, t: r.top, r: r.right, b: r.bottom });
const cut = (a: Box, b: Box): Box => ({
  l: Math.max(a.l, b.l),
  t: Math.max(a.t, b.t),
  r: Math.min(a.r, b.r),
  b: Math.min(a.b, b.b),
});
const around = (boxes: Box[]): Box =>
  boxes.reduce((a, b) => ({ l: Math.min(a.l, b.l), t: Math.min(a.t, b.t), r: Math.max(a.r, b.r), b: Math.max(a.b, b.b) }));
const px = (n: number): string => `${Math.round(n * 100) / 100}px`;
/** For the copy and the marker, which have a layer of their own for the full drag. */
const moveTo = (x: number, y: number): string => `translate3d(${px(x)},${px(y)},0)`;
/** For rows. A 3D transform gives each row a layer for all the time, and a long list has many rows. */
const slideTo = (x: number, y: number): string => `translate(${px(x)},${px(y)})`;
const depthOf = (el: HTMLElement): number => Number(el.dataset.dndDepth) || 0;

/** How far a chain of scrollers moved its content since the measure. */
function scrolledBy(chain: Scroller[]): [number, number] {
  let x = 0;
  let y = 0;
  for (const s of chain) {
    x += s.x - s.x0;
    y += s.y - s.y0;
  }
  return [x, y];
}

/** The rectangle of a scroller on the screen now. */
function seen(s: Scroller): Box {
  const [x, y] = scrolledBy(s.outer);
  return { l: s.box.l - x, t: s.box.t - y, r: s.box.r - x, b: s.box.b - y };
}

/** A row often has no background of its own. The lifted copy needs one, or the rows below show through. */
function solidBackground(el: Element | null): string {
  for (; el; el = el.parentElement) {
    const color = getComputedStyle(el).backgroundColor;
    // The computed value has an alpha part only if the color is not opaque.
    if (color && color !== 'transparent' && !color.startsWith('rgba') && !color.includes('/')) return color;
  }
  return '';
}

function hide(el: HTMLElement): void {
  // Opacity, not visibility: a text field in the row keeps the focus.
  el.style.transition = 'none';
  el.style.opacity = '0';
}

/**
 * Takes the styles of the engine off an element. The transition stays off: if the CSS of the
 * page has a transition for the transform or the opacity of the element, it must not animate
 * this change. `free` puts the transition back after the browser took the new styles.
 */
function strip(el: HTMLElement): void {
  const s = el.style;
  s.transition = 'none';
  s.transform = '';
  s.willChange = '';
  s.opacity = '';
}

function free(el: HTMLElement): void {
  el.style.transition = '';
}

function makeGhost(els: HTMLElement[], boxes: Box[]): HTMLElement {
  const all = around(boxes);
  const ghost = document.createElement('div');
  ghost.className = 'dnd-ghost';
  ghost.style.width = px(all.r - all.l);
  ghost.style.height = px(all.b - all.t);
  const lift = document.createElement('div');
  lift.className = 'dnd-lift';
  const shadow = document.createElement('div');
  shadow.className = 'dnd-shadow';
  const plate = document.createElement('div');
  plate.className = 'dnd-plate';
  lift.append(shadow, plate);
  els.forEach((el, i) => {
    const box = boxes[i]!;
    const clone = el.cloneNode(true) as HTMLElement;
    const s = clone.style;
    s.position = 'absolute';
    s.left = px(box.l - all.l);
    s.top = px(box.t - all.t);
    // Not a fixed width: the copy becomes narrower when it shows an indent.
    s.width = `calc(100% - ${px(all.r - all.l - (box.r - box.l))})`;
    s.height = px(box.b - box.t);
    s.boxSizing = 'border-box';
    s.margin = '0';
    s.transform = 'none';
    s.transition = 'none';
    s.opacity = '';
    lift.append(clone);
  });
  ghost.append(lift);
  return ghost;
}

export function startEngine(root: HTMLElement, options: DndOptions): DndController {
  const vertical = options.axis !== 'x';
  const group = options.group ?? '';
  const indent = options.indent ?? 28;
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  const maxDepthAt = (place: DndPlace): number => options.maxDepthAt?.(place) ?? 0;

  const along = (b: Box): number => (vertical ? b.t : b.l);
  const alongEnd = (b: Box): number => (vertical ? b.b : b.r);
  const across = (b: Box): number => (vertical ? b.l : b.t);
  const acrossEnd = (b: Box): number => (vertical ? b.r : b.b);
  const shiftTo = (n: number): string => (vertical ? slideTo(0, n) : slideTo(n, 0));
  const shiftMotion = (): string => (calm.matches ? 'none' : `transform ${SHIFT_MS}ms ${EASE}`);
  const padEnd = vertical ? 'paddingBottom' : 'paddingRight';
  const marginEnd = vertical ? 'marginBottom' : 'marginRight';

  let phase: 'idle' | 'pending' | 'dragging' | 'settling' = 'idle';
  let press: Press | null = null;
  let drag: Drag | null = null;
  let settleTimer = 0;

  // Finding the elements

  function zoneOf(el: Element): HTMLElement | null {
    const zone = el.parentElement?.closest<HTMLElement>(ZONE);
    return zone && root.contains(zone) && (zone.dataset.dndGroup ?? '') === group ? zone : null;
  }

  /** The item of this engine at an element. An item of a different group can be between the two. */
  function itemAt(target: Element): HTMLElement | null {
    let el = target.closest<HTMLElement>(ITEM);
    while (el && !zoneOf(el)) el = el.parentElement?.closest<HTMLElement>(ITEM) ?? null;
    return el;
  }

  function scan(): Array<{ zone: HTMLElement; items: HTMLElement[] }> {
    const zones = [...root.querySelectorAll<HTMLElement>(ZONE)];
    if (root.matches(ZONE)) zones.unshift(root);
    return zones
      .filter((zone) => (zone.dataset.dndGroup ?? '') === group)
      .map((zone) => ({
        zone,
        items: [...zone.querySelectorAll<HTMLElement>(ITEM)].filter((el) => zoneOf(el) === zone),
      }));
  }

  // Measure

  /** Reads all rectangles. `first` is the dragged item, if the element is known. */
  function measure(first: HTMLElement | undefined, id: string): Layout | null {
    const found = scan();
    const lead =
      first?.isConnected && zoneOf(first)
        ? first
        : found.flatMap((f) => f.items).find((el) => el.dataset.dndId === id);
    if (!lead) return null;
    const srcEl = zoneOf(lead)!;

    const page: Scroller = {
      el: document.scrollingElement ?? document.documentElement,
      box: { l: 0, t: 0, r: innerWidth, b: innerHeight },
      outer: [],
      canX: true,
      canY: true,
      x0: scrollX,
      y0: scrollY,
      x: scrollX,
      y: scrollY,
    };
    const scrollers: Scroller[] = [page];
    const chains = new Map<Element, Scroller[]>();
    // The scrollers from an element up to the page, the nearest first.
    const chainOf = (el: Element | null): Scroller[] => {
      if (!el || el === document.documentElement) return [page];
      let chain = chains.get(el);
      if (chain) return chain;
      const outer = chainOf(el.parentElement);
      const style = getComputedStyle(el);
      chain = outer;
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
        const scrolls = /auto|scroll|overlay/;
        const s: Scroller = {
          el,
          box: toBox(el.getBoundingClientRect()),
          outer,
          canX: scrolls.test(style.overflowX),
          canY: scrolls.test(style.overflowY),
          x0: el.scrollLeft,
          y0: el.scrollTop,
          x: el.scrollLeft,
          y: el.scrollTop,
        };
        scrollers.push(s);
        chain = [s, ...outer];
      }
      chains.set(el, chain);
      return chain;
    };

    const layout = { scrollers, els: [lead], ids: [id], size: 0, originIndex: 0, originDepth: depthOf(lead) } as Layout;
    layout.zones = found.map(({ zone: el, items }) => {
      const boxes = items.map((item) => toBox(item.getBoundingClientRect()));
      const box = toBox(el.getBoundingClientRect());
      const style = getComputedStyle(el);
      const inner = chainOf(el);

      let from = -1;
      let count = 0;
      if (el === srcEl) {
        from = items.indexOf(lead);
        count = 1;
        while (from + count < items.length && depthOf(items[from + count]!) > layout.originDepth) count++;
        const blockBoxes = boxes.slice(from, from + count);
        layout.els = items.slice(from, from + count);
        layout.ids = layout.els.map((item) => item.dataset.dndId!);
        layout.box = around(blockBoxes);
        layout.size = alongEnd(blockBoxes[count - 1]!) - along(blockBoxes[0]!);
        layout.originIndex = from;
      }

      // The smallest space between two rows. A larger space has something between the rows, such as a heading.
      let gap = Infinity;
      for (let i = 1; i < boxes.length; i++) gap = Math.min(gap, along(boxes[i]!) - alongEnd(boxes[i - 1]!));
      if (!(gap >= 0 && gap < Infinity)) gap = 0;

      const rows: Row[] = [];
      items.forEach((item, i) => {
        if (i >= from && i < from + count) return;
        const base = along(boxes[i]!);
        const after = from >= 0 && i > from;
        rows.push({
          el: item,
          id: item.dataset.dndId!,
          depth: depthOf(item),
          box: boxes[i]!,
          base,
          start: after ? base - layout.size - gap : base,
          size: alongEnd(boxes[i]!) - base,
          after,
          shift: 0,
          styled: false,
          hinted: false,
        });
      });

      const zone: Zone = {
        el,
        id: el.dataset.dndContainer ?? '',
        rows,
        gap,
        // With no other rows, the place of the block in its own container is where it is now.
        emptyStart: from >= 0 ? along(layout.box) : along(box) + parseFloat(vertical ? style.paddingTop : style.paddingLeft),
        box,
        lo: boxes.length ? Math.min(...boxes.map(across)) : across(box) + parseFloat(vertical ? style.paddingLeft : style.paddingTop),
        hi: boxes.length ? Math.max(...boxes.map(acrossEnd)) : acrossEnd(box) - parseFloat(vertical ? style.paddingRight : style.paddingBottom),
        inner,
        outer: chainOf(el.parentElement),
        o: 0,
        oc: 0,
        bo: 0,
        bc: 0,
        clip: box,
        pad: parseFloat(style[padEnd]),
        margin: parseFloat(style[marginEnd]),
        // A container that scrolls keeps its size: the rows that move make its content larger.
        canGrow: inner[0]!.el !== el,
        grown: 0,
        sized: false,
      };
      if (el === srcEl) layout.src = zone;
      return zone;
    });
    return layout;
  }

  /** Brings the stored rectangles up to date after a scroll. `read` is false when the positions are known. */
  function sync(d: Drag, read: boolean): void {
    if (read) {
      for (const s of d.scrollers) {
        s.x = s.el.scrollLeft;
        s.y = s.el.scrollTop;
      }
    }
    for (const z of d.zones) {
      const [ix, iy] = scrolledBy(z.inner);
      const [bx, by] = scrolledBy(z.outer);
      z.o = vertical ? iy : ix;
      z.oc = vertical ? ix : iy;
      z.bo = vertical ? by : bx;
      z.bc = vertical ? bx : by;
      z.clip = z.inner.reduce((clip, s) => cut(clip, seen(s)), { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity });
    }
  }

  // The drop place

  /** Where the copy must be for the pointer position. */
  function ghostAt(d: Drag): [number, number] {
    let x = d.x - d.grabX;
    let y = d.y - d.grabY;
    if (options.lockAxis) {
      // The copy stays in line with the rows of the container, and its indent shows the depth.
      const t = d.target;
      const z = t?.zone ?? d.src;
      const side = z.lo - z.oc + across(d.box) - d.src.lo + (t ? (t.depth - d.originDepth) * indent : 0);
      if (vertical) x = side;
      else y = side;
    }
    return [x, y];
  }

  function locate(d: Drag): Target | null {
    const p = vertical ? d.x : d.y;
    const q = vertical ? d.y : d.x;
    let zone: Zone | null = null;
    let bestSide = options.lockAxis ? Infinity : REACH;
    let bestAlong = Infinity;
    for (const z of d.zones) {
      const lo = Math.max(across(z.box) - z.bc, across(z.clip));
      const hi = Math.min(acrossEnd(z.box) - z.bc, acrossEnd(z.clip));
      // A container that a scroll area hides fully, such as the list on the next page of a pager.
      if (hi - lo < 1) continue;
      const side = p < lo ? lo - p : p > hi ? p - hi : 0;
      // Along the axis there is no limit: a pointer above or below a list is at its start or end.
      const start = along(z.box) - z.bo;
      const end = alongEnd(z.box) - z.bo;
      const far = q < start ? start - q : q > end ? q - end : 0;
      if (side < bestSide || (side === bestSide && far < bestAlong)) {
        zone = z;
        bestSide = side;
        bestAlong = far;
      }
    }
    if (!zone) return null;
    if (vertical) {
      const raw = d.originDepth + (d.x - (zone.lo - zone.oc) - d.side) / indent;
      d.pref = stepDepth({ pref: d.pref, raw });
    }
    const [x, y] = ghostAt(d);
    const lead = (vertical ? y : x) + zone.o;
    const at = (edge: number): { index: number; depth: number } | null =>
      resolvePlace({
        rows: zone.rows,
        gap: zone.gap,
        emptyStart: zone.emptyStart,
        id: d.id,
        containerId: zone.id,
        maxDepthAt,
        lead: edge,
        pref: d.pref,
      });
    let place = at(lead);
    const old = d.target;
    if (place && old && old.zone === zone && place.index !== old.index) {
      // The block must go a little past the limit between two places. If not, a hand that
      // rests on the limit makes the rows go back and forth.
      const held = at(lead + (place.index > old.index ? -STICK : STICK));
      if (held?.index === old.index) place = held;
    }
    return place && { zone, ...place };
  }

  /** Tells if a row with a shift is in the visible part of its container, or near it. */
  function inView({ z, row, shift }: { z: Zone; row: Row; shift: number }): boolean {
    const at = row.base - z.o + shift;
    return at + row.size > along(z.clip) - VIEW_MARGIN && at < alongEnd(z.clip) + VIEW_MARGIN;
  }

  function setShift({ d, z, row, shift }: { d: Drag; z: Zone; row: Row; shift: number }): void {
    if (row.shift === shift) return;
    // Only the rows that the user can see animate and get a layer. A row in a transition has
    // a layer, and a long list out of view would make hundreds of them.
    const seen = inView({ z, row, shift: row.shift }) || inView({ z, row, shift });
    row.shift = shift;
    row.styled = true;
    const s = row.el.style;
    if (seen && !row.hinted) {
      row.hinted = true;
      s.willChange = 'transform';
    }
    s.transition = seen && !d.instant ? shiftMotion() : 'none';
    s.transform = shiftTo(shift);
  }

  /** Content after a container must follow when the block goes to a different container. */
  function resize({ d, z, amount }: { d: Drag; z: Zone; amount: number }): void {
    if (z.grown === amount || !z.canGrow) return;
    z.grown = amount;
    z.sized = true;
    const s = z.el.style;
    const motion = `${SHIFT_MS}ms ${EASE}`;
    s.transition = d.instant || calm.matches ? 'none' : `padding ${motion}, margin ${motion}`;
    // Padding makes the container itself larger, with its background. Only a margin can be negative.
    s[padEnd] = amount > 0 ? px(z.pad + amount) : '';
    s[marginEnd] = amount < 0 ? px(z.margin + amount) : '';
  }

  function unsize(z: Zone): void {
    if (!z.sized) return;
    z.sized = false;
    z.grown = 0;
    const s = z.el.style;
    s.transition = '';
    s[padEnd] = '';
    s[marginEnd] = '';
  }

  /** Moves the rows of a container apart for the target, and closes the place that the block left. */
  function arrange(d: Drag, z: Zone): void {
    const t = d.target;
    const here = t?.zone === z;
    const left = d.size + d.src.gap;
    const span = d.size + z.gap;
    z.rows.forEach((row, i) => {
      setShift({ d, z, row, shift: t ? (here && i >= t.index ? span : 0) - (row.after ? left : 0) : 0 });
    });
    resize({ d, z, amount: t ? (here ? span : 0) - (z === d.src ? left : 0) : 0 });
  }

  /** Shows the drop marker at the target. `jump` is true after a scroll: the marker must stay on its rows. */
  function mark(d: Drag, jump: boolean): void {
    const t = d.target;
    const s = d.marker.style;
    let box: Box | null = null;
    if (t) {
      const z = t.zone;
      const start = slotStart({ rows: z.rows, gap: z.gap, emptyStart: z.emptyStart, index: t.index }) - z.o;
      const side = z.lo - z.oc;
      box = cut(
        vertical
          ? { l: side + t.depth * indent, r: z.hi - z.oc, t: start, b: start + d.size }
          : { l: start, r: start + d.size, t: side, b: side + d.box.b - d.box.t },
        z.clip,
      );
      if (box.r - box.l < 1 || box.b - box.t < 1) box = null;
    }
    if (!box) {
      s.transition = '';
      s.opacity = '0';
      d.marked = false;
      return;
    }
    // A marker that comes into view must not fly in from its last place.
    s.transition = d.marked && !jump && !d.instant ? '' : 'opacity 120ms linear';
    s.transform = moveTo(box.l, box.t);
    s.width = px(box.r - box.l);
    s.height = px(box.b - box.t);
    s.opacity = '1';
    d.marked = true;
  }

  function retarget(d: Drag, jump: boolean): void {
    const t = locate(d);
    const old = d.target;
    const same = t === old || (!!t && !!old && t.zone === old.zone && t.index === old.index && t.depth === old.depth);
    if (!same) {
      d.target = t;
      for (const z of new Set([d.src, old?.zone, t?.zone])) if (z) arrange(d, z);
    }
    if (!same || jump) mark(d, jump);
  }

  // The frame loop

  function autoScroll(d: Drag, dt: number): boolean {
    const mode = options.autoScroll ?? 'axis';
    if (mode === 'none') return false;
    const zone = d.target?.zone ?? d.src;
    let pushed = false;
    for (const down of [true, false]) {
      if (mode === 'axis' && down !== vertical) continue;
      const p = down ? d.y : d.x;
      for (const s of zone.inner) {
        if (!(down ? s.canY : s.canX)) continue;
        const box = seen(s);
        const lo = down ? box.t : box.l;
        const hi = down ? box.b : box.r;
        const edge = Math.min(EDGE, (hi - lo) / 3);
        // How far the pointer is into the band: 0 at its start, 1 at the edge. Negative at the start edge.
        let into = 0;
        if (p < lo + edge && (down ? d.went.up : d.went.left)) into = (p - lo - edge) / edge;
        else if (p > hi - edge && (down ? d.went.down : d.went.right)) into = (p - hi + edge) / edge;
        if (!into) continue;
        // Slow at the start of the band for exact work, fast at the edge and past it.
        const force = Math.min(1, Math.abs(into));
        const step = Math.sign(into) * (0.08 + 0.92 * force * force) * SCROLL_SPEED * dt;
        const was = down ? s.y : s.x;
        if (down) {
          s.el.scrollTop = was + step;
          s.y = s.el.scrollTop;
        } else {
          s.el.scrollLeft = was + step;
          s.x = s.el.scrollLeft;
        }
        // At its limit, a scroller gives the turn to the scroller around it.
        if ((down ? s.y : s.x) !== was) {
          pushed = true;
          break;
        }
      }
    }
    return pushed;
  }

  /** Puts the rows, the block, and the containers back to the layout of the page, with no animation. */
  function stripAll(d: Drag): void {
    for (const z of d.zones) {
      for (const row of z.rows) {
        if (!row.styled) continue;
        strip(row.el);
        d.loose.push(row.el);
      }
      unsize(z);
    }
    for (const el of [...d.flipped, ...d.els]) {
      strip(el);
      d.loose.push(el);
    }
  }

  /** Call it after the browser took the styles (after a layout read). `keep` have new styles of the engine. */
  function freeAll(d: Drag, keep: HTMLElement[]): void {
    for (const el of d.loose) if (!keep.includes(el)) free(el);
    d.loose = [];
  }

  /** The layout changed below the drag (a resize, or new data). Reads it again and puts the picture back. */
  function remeasure(d: Drag): boolean {
    d.stale = false;
    stripAll(d);
    const layout = measure(d.els[0], d.id);
    if (!layout) {
      stopInput(d);
      clear(d);
      options.onDragEnd?.({ id: d.id, dropped: false });
      return false;
    }
    Object.assign(d, layout);
    d.els.forEach(hide);
    d.target = null;
    d.instant = true;
    sync(d, false);
    return true;
  }

  function frame(time: number): void {
    const d = drag;
    if (!d || phase !== 'dragging') return;
    d.frame = requestAnimationFrame(frame);
    const dt = Math.min(Math.max(time - d.time, 0), 50) / 1000;
    d.time = time;
    if (d.stale && !remeasure(d)) return;

    if (d.y < d.sy - 6) d.went.up = true;
    if (d.y > d.sy + 6) d.went.down = true;
    if (d.x < d.sx - 6) d.went.left = true;
    if (d.x > d.sx + 6) d.went.right = true;

    const pushed = autoScroll(d, dt);
    const scrolled = pushed || d.scrolled;
    if (scrolled) sync(d, d.scrolled);
    d.scrolled = false;
    if (!scrolled && !d.moved && !d.instant) return;
    d.moved = false;

    retarget(d, scrolled);
    const [x, y] = ghostAt(d);
    if (options.lockAxis) {
      // A change of the depth or of the container moves the copy to the side. It goes there in
      // some frames, not in one jump. The loop must run until it is there.
      const ease = calm.matches || d.instant ? 1 : 1 - Math.exp(-dt * 22);
      const near = (now: number, to: number): number => (Math.abs(to - now) < 0.5 ? to : now + (to - now) * ease);
      const lean = near(d.lean, d.target ? (d.target.depth - d.originDepth) * indent : 0);
      if (lean !== d.lean) {
        d.lean = lean;
        // The end of the row stays in line with the list, as it will be after the drop.
        d.ghost.style.width = px(d.box.r - d.box.l - Math.max(0, lean));
      }
      d.gx = vertical ? near(d.gx, x) : x;
      d.gy = vertical ? y : near(d.gy, y);
      if (d.gx !== x || d.gy !== y) d.moved = true;
    } else {
      d.gx = x;
      d.gy = y;
    }
    d.ghost.style.transform = moveTo(d.gx, d.gy);

    if (d.instant) {
      d.instant = false;
      // The browser must take the styles with no transition before the transitions come back.
      void root.offsetWidth;
      freeAll(d, d.els);
      for (const z of d.zones) for (const row of z.rows) if (row.styled) row.el.style.transition = shiftMotion();
    }
  }

  // Start and end

  function begin(): void {
    const p = press;
    if (!p) return;
    clearTimeout(p.timer);
    press = null;
    const layout = measure(p.el, p.id);
    if (!layout) {
      phase = 'idle';
      listen(false);
      return;
    }

    // The looks come from the item, because the layer is not below the elements that set them.
    const first = layout.els[0]!;
    const style = getComputedStyle(first);
    const text = getComputedStyle(first.parentElement!);
    const look = new Map(LOOK_VARS.map((name) => [name, style.getPropertyValue(name).trim()]));
    look.set('--dnd-lift-bg', style.getPropertyValue('--dnd-lift-bg').trim() || solidBackground(first));
    if (!look.get('--dnd-lift-radius') && parseFloat(style.borderTopLeftRadius)) {
      look.set('--dnd-lift-radius', style.borderTopLeftRadius);
    }
    if (!look.get('--dnd-lift-scale')) {
      // The same number of px for a small tab and for a tall column.
      const { box } = layout;
      look.set('--dnd-lift-scale', String(1 + Math.min(0.06, 8 / Math.max(box.r - box.l, box.b - box.t, 1))));
    }
    const selection = getSelection();

    const layer = document.createElement('div');
    layer.className = 'dnd-layer';
    layer.setAttribute('aria-hidden', 'true');
    for (const key of TEXT_STYLES) layer.style[key] = text[key];
    for (const [name, value] of look) if (value) layer.style.setProperty(name, value);
    layer.style.setProperty('--dnd-ox', px(p.x - layout.box.l));
    layer.style.setProperty('--dnd-oy', px(p.y - layout.box.t));
    const marker = document.createElement('div');
    marker.className = vertical ? 'dnd-marker dnd-rows' : 'dnd-marker';
    const ghost = makeGhost(
      layout.els,
      layout.els.map((el) => toBox(el.getBoundingClientRect())),
    );
    ghost.style.transform = moveTo(layout.box.l, layout.box.t);
    layer.append(marker, ghost);

    const d: Drag = {
      ...layout,
      id: p.id,
      pointerId: p.pointerId,
      x: p.x,
      y: p.y,
      sx: p.x,
      sy: p.y,
      grabX: p.x - layout.box.l,
      grabY: p.y - layout.box.t,
      side: p.x - layout.src.lo,
      pref: layout.originDepth,
      target: null,
      layer,
      ghost,
      gx: layout.box.l,
      gy: layout.box.t,
      lean: 0,
      marker,
      marked: false,
      moved: true,
      scrolled: false,
      stale: false,
      instant: false,
      went: { up: false, down: false, left: false, right: false },
      frame: 0,
      time: performance.now(),
      observer: new MutationObserver(() => {
        d.stale = true;
      }),
      flipped: [],
      loose: [],
    };
    sync(d, false);

    // From here, only writes.
    (options.overlayParent ?? document.body).append(layer);
    d.els.forEach(hide);
    if (selection && !selection.isCollapsed) selection.removeAllRanges();
    setActive(true);
    // The scale and the shadow start from the look of the row at rest, so the start has no jump.
    void ghost.offsetWidth;
    ghost.classList.add('dnd-up');
    try {
      // Capture on the root: a row can go away during the drag, and its events with it.
      root.setPointerCapture(p.pointerId);
    } catch {
      // The pointer is gone. The pointerup or pointercancel event ends the drag.
    }
    if (p.touch) {
      try {
        navigator.vibrate?.(10);
      } catch {
        // No vibration on this device.
      }
    }
    d.observer.observe(root, { childList: true, subtree: true });
    drag = d;
    phase = 'dragging';
    d.frame = requestAnimationFrame(frame);
    options.onDragStart?.({ id: d.id, containerId: d.src.id });
  }

  function abort(): void {
    if (!press) return;
    clearTimeout(press.timer);
    press = null;
    phase = 'idle';
    listen(false);
  }

  function stopInput(d: Drag): void {
    cancelAnimationFrame(d.frame);
    d.observer.disconnect();
    listen(false);
    try {
      root.releasePointerCapture(d.pointerId);
    } catch {
      // The capture is gone already.
    }
  }

  /** Removes each thing that the drag put on the page. */
  function clear(d: Drag): void {
    clearTimeout(settleTimer);
    d.layer.remove();
    stripAll(d);
    void root.offsetWidth;
    freeAll(d, []);
    setActive(false);
    drag = null;
    phase = 'idle';
  }

  function settle(d: Drag): void {
    settleTimer = window.setTimeout(() => {
      if (drag === d) clear(d);
    }, SETTLE_MS + 40);
  }

  /** No drop: the rows close, and the copy goes back to the place of the block. */
  function goBack(d: Drag): void {
    d.target = null;
    for (const z of d.zones) arrange(d, z);
    mark(d, false);
    if (calm.matches) return clear(d);
    const s = d.ghost.style;
    s.width = px(d.box.r - d.box.l);
    s.transition = `transform ${SETTLE_MS}ms ${EASE}`;
    s.transform = vertical ? moveTo(d.box.l - d.src.oc, d.box.t - d.src.o) : moveTo(d.box.l - d.src.o, d.box.t - d.src.oc);
    d.ghost.classList.replace('dnd-up', 'dnd-down');
    settle(d);
  }

  function release(commit: boolean): void {
    const d = drag!;
    stopInput(d);
    phase = 'settling';
    if (commit) retarget(d, false);
    const t = commit ? d.target : null;
    if (!t || (t.zone === d.src && t.index === d.originIndex && t.depth === d.originDepth)) {
      goBack(d);
      options.onDragEnd?.({ id: d.id, dropped: false });
      return;
    }

    const drop: DndDrop = {
      id: d.id,
      fromContainerId: d.src.id,
      toContainerId: t.zone.id,
      index: t.index,
      depth: t.depth,
      ...family({ rows: t.zone.rows, index: t.index, depth: t.depth }),
    };
    d.marker.style.transition = '';
    d.marker.style.opacity = '0';

    // Where each item is on the screen now. A row in the middle of a transition stops there,
    // so the next animation starts from the place that the user sees.
    const first = new Map<string, Box>();
    const frozen: Array<[Row, number]> = [];
    for (const z of d.zones) {
      const x = vertical ? z.oc : z.o;
      const y = vertical ? z.o : z.oc;
      for (const row of z.rows) {
        if (!inView({ z, row, shift: row.shift })) {
          // Out of view, a row has no transition. The stored rectangle tells where it is.
          const sx = vertical ? 0 : row.shift;
          const sy = vertical ? row.shift : 0;
          first.set(row.id, { l: row.box.l - x + sx, t: row.box.t - y + sy, r: row.box.r - x + sx, b: row.box.b - y + sy });
          continue;
        }
        const box = toBox(row.el.getBoundingClientRect());
        first.set(row.id, box);
        const shift = along(box) - (row.base - z.o);
        if (row.styled && Math.abs(shift - row.shift) > 0.5) frozen.push([row, shift]);
      }
    }
    for (const [row, shift] of frozen) {
      row.el.style.transition = 'none';
      row.el.style.transform = shiftTo(shift);
    }
    const from: [number, number] = [d.gx, d.gy];

    const next = (): void => {
      requestAnimationFrame(() => handOver({ d, first, from }));
    };
    let wait: void | Promise<void> = undefined;
    try {
      wait = options.onDrop(drop);
      options.onDragEnd?.({ id: d.id, dropped: true });
    } finally {
      // The data has the new order, and the framework wrote it to the DOM before the next frame.
      if (wait instanceof Promise) wait.then(next, next);
      else next();
    }
  }

  /** The DOM has the new order. Moves each item from its old place on the screen to its new place. */
  function handOver({ d, first, from }: { d: Drag; first: Map<string, Box>; from: [number, number] }): void {
    if (drag !== d) return;
    stripAll(d);
    if (calm.matches) return clear(d);

    const now = scan()
      .flatMap((f) => f.items)
      .map((el) => ({ el, id: el.dataset.dndId!, box: toBox(el.getBoundingClientRect()) }));
    const off = (b: Box): boolean => b.b < 0 || b.t > innerHeight || b.r < 0 || b.l > innerWidth;

    for (const item of now) {
      const old = first.get(item.id);
      if (!old) continue;
      const dx = old.l - item.box.l;
      const dy = old.t - item.box.t;
      if ((Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) || (off(old) && off(item.box))) continue;
      item.el.style.transition = 'none';
      item.el.style.transform = slideTo(dx, dy);
      d.flipped.push(item.el);
    }

    // The block can have new elements and a new look (an indent). A new copy of it lands, so
    // the change from the copy to the true rows shows nothing.
    const block = now.filter((item) => d.ids.includes(item.id));
    const old = d.ghost;
    if (block.some((item) => item.id === d.id)) {
      const boxes = block.map((item) => item.box);
      const ghost = makeGhost(
        block.map((item) => item.el),
        boxes,
      );
      ghost.classList.add('dnd-up');
      ghost.style.transform = moveTo(...from);
      old.replaceWith(ghost);
      d.ghost = ghost;
      d.els = block.map((item) => item.el);
      d.els.forEach(hide);
      void ghost.offsetWidth;
      const to = around(boxes);
      ghost.style.transition = `transform ${SETTLE_MS}ms ${EASE}`;
      ghost.style.transform = moveTo(to.l, to.t);
      ghost.classList.replace('dnd-up', 'dnd-down');
    } else {
      // The item is not in a container of this engine any more.
      d.els = [];
      void old.offsetWidth;
      old.style.transition = `opacity ${SETTLE_MS}ms linear`;
      old.style.opacity = '0';
    }
    freeAll(d, d.els);
    for (const el of d.flipped) {
      el.style.transition = `transform ${SETTLE_MS}ms ${EASE}`;
      el.style.transform = slideTo(0, 0);
    }
    settle(d);
  }

  // Input

  /** The click that the browser makes after a drag must not open the row. */
  function swallowClick(): void {
    const eat = (e: Event): void => {
      e.stopPropagation();
      e.preventDefault();
      off();
    };
    const off = (): void => {
      window.removeEventListener('click', eat, true);
      window.removeEventListener('pointerdown', off, true);
      clearTimeout(timer);
    };
    window.addEventListener('click', eat, true);
    // A new press is a new gesture, and its click is a true click.
    window.addEventListener('pointerdown', off, true);
    const timer = window.setTimeout(off, 400);
  }

  function onDown(e: PointerEvent): void {
    if (!e.isPrimary || e.button !== 0 || taken.has(e) || options.disabled) return;
    // Control and a click opens the context menu on a Mac.
    if (e.pointerType === 'mouse' && e.ctrlKey) return;
    if (!(e.target instanceof Element)) return;
    if (phase === 'settling' && drag) clear(drag);
    if (phase !== 'idle') return;
    const el = itemAt(e.target);
    if (!el) return;
    // A press on a row in a column is for the engine of the rows. The column moves by its handle.
    if (!options.handle && e.target.closest(ITEM) !== el) return;
    const stop = e.target.closest(options.ignore ?? IGNORE);
    if (stop && el.contains(stop)) return;
    if (options.handle) {
      const handle = e.target.closest(options.handle);
      if (!handle || itemAt(handle) !== el) return;
    }
    const id = el.dataset.dndId!;
    if (options.canDrag && !options.canDrag(id)) return;
    taken.add(e);
    const touch = e.pointerType !== 'mouse';
    press = {
      el,
      id,
      pointerId: e.pointerId,
      touch,
      x: e.clientX,
      y: e.clientY,
      sx: e.clientX,
      sy: e.clientY,
      timer: touch ? window.setTimeout(begin, HOLD_MS) : 0,
    };
    phase = 'pending';
    listen(true);
  }

  function onMove(e: PointerEvent): void {
    if (press && e.pointerId === press.pointerId) {
      press.x = e.clientX;
      press.y = e.clientY;
      const far = Math.hypot(press.x - press.sx, press.y - press.sy);
      // A finger that moves before the hold ends wants to scroll.
      if (press.touch) {
        if (far >= TOUCH_SLOP) abort();
      } else if (far >= MOUSE_SLOP) begin();
    } else if (drag && phase === 'dragging' && e.pointerId === drag.pointerId) {
      drag.x = e.clientX;
      drag.y = e.clientY;
      drag.moved = true;
    }
  }

  function onUp(e: PointerEvent): void {
    if (press && e.pointerId === press.pointerId) abort();
    else if (drag && phase === 'dragging' && e.pointerId === drag.pointerId) {
      drag.x = e.clientX;
      drag.y = e.clientY;
      swallowClick();
      release(e.type === 'pointerup');
    }
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    if (phase === 'dragging') {
      // The key is for the drag only. A dialog below must stay open.
      e.preventDefault();
      e.stopPropagation();
      release(false);
    } else abort();
  }

  function leave(): void {
    if (phase === 'dragging') release(false);
    else abort();
  }

  function onBlur(e: Event): void {
    // The capture phase also gives the blur events of elements. Only the window counts.
    if (e.target === window) leave();
  }

  function onHidden(): void {
    if (document.hidden) leave();
  }

  function onContextMenu(e: Event): void {
    // A hold with a finger opens the context menu on Android.
    if (phase === 'dragging' || press?.touch) e.preventDefault();
  }

  function block(e: Event): void {
    e.preventDefault();
  }

  function onScroll(): void {
    if (drag) drag.scrolled = true;
  }

  function onResize(): void {
    if (drag) drag.stale = true;
  }

  function onTouchMove(e: TouchEvent): void {
    // Pointer capture does not stop the scroll on iOS. Only this does.
    if (phase === 'dragging' && e.cancelable) e.preventDefault();
  }

  const wires: Array<[target: Window | Document, type: string, fn: (e: never) => void, passive?: boolean]> = [
    [window, 'pointermove', onMove],
    [window, 'pointerup', onUp],
    [window, 'pointercancel', onUp],
    [window, 'keydown', onKey],
    [window, 'contextmenu', onContextMenu],
    [window, 'selectstart', block],
    [window, 'dragstart', block],
    [window, 'blur', onBlur],
    [document, 'visibilitychange', onHidden],
    [window, 'scroll', onScroll, true],
    [window, 'resize', onResize, true],
  ];

  /** Listeners for the time from the press to the release. */
  function listen(on: boolean): void {
    for (const [target, type, fn, passive] of wires) {
      if (on) target.addEventListener(type, fn as EventListener, { capture: true, passive: !!passive });
      else target.removeEventListener(type, fn as EventListener, true);
    }
  }

  root.addEventListener('pointerdown', onDown);
  // This listener must be there before the touch starts, and it must not be passive.
  // If not, the browser does not wait for it, and the page scrolls below the drag.
  root.addEventListener('touchmove', onTouchMove, { passive: false });

  return {
    get dragging() {
      return phase === 'dragging';
    },
    cancel() {
      if (phase === 'dragging') release(false);
    },
    destroy() {
      abort();
      if (drag) {
        if (phase === 'dragging') stopInput(drag);
        clear(drag);
      }
      root.removeEventListener('pointerdown', onDown);
      root.removeEventListener('touchmove', onTouchMove);
    },
  };
}
