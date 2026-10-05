// Drag and drop for rows, columns, and tabs. This file is the public API.
//
// Markup that the engine reads:
//
//   data-dnd-container="ID"   A list of items. Its id is the containerId in the results.
//   data-dnd-group="NAME"     On a container. An engine uses only the containers of its group.
//                             No attribute is the group ''.
//   data-dnd-id="ID"          An item. It belongs to the nearest container above it.
//   data-dnd-depth="0|1"      The depth of an item. No attribute is depth 0.
//   data-dnd-ignore           On an element in an item. A press there does not start a drag.
//
// The engine does not change the data and does not move DOM nodes. It reports the drop, and
// the caller changes its data. The engine then animates each item from the place where it was
// on the screen to its new place. It finds the items again by their id, so the caller can make
// new elements for moved items (for example in a different column).
//
// Rules for the caller:
//
// - Render the items in a keyed block, with the same id as in data-dnd-id.
// - Do not use `animate:` or `transition:` directives on the items. The engine does the motion.
// - The engine writes the inline styles transform, transition, will-change, and opacity on the
//   items, and transition, padding, and margin on a container, during a drag. It removes them
//   at the end. Do not set these inline.
// - The lifted copy is a clone in a layer in <body> (or `overlayParent`). It gets the font and
//   the text color of the place where the item is. CSS selectors that need an element above
//   the item do not match the clone. Custom properties that the CSS of the item uses must come
//   from the item itself, or from an element above the layer (such as <html>).
// - Align the containers of one group at their start (the top for the axis 'y'). The engine
//   changes the size of a container when the block goes to a different container.
// - The engine stops a touch scroll after the hold with a `touchmove` listener, so the items
//   need no `touch-action` value. Do not set `touch-action: none` on them: the page must
//   scroll before the hold ends.
// - `dnd.css` (loaded by this module) sets `user-select: none` on each item, but not on the
//   text fields in it.
// - An element that is an item of one engine can contain the items of a second engine (a
//   column with rows). Then the outer engine must have a `handle`.
// - A drag ends with a click event in some browsers. The engine stops that click.
//
// Cost: the engine reads rectangles at the start of a drag (one for each item of the group),
// at the release (the items in view), and after a resize or a change of the DOM below the
// root. During the drag it writes transforms only, in one requestAnimationFrame loop. Rows out
// of view move with no transition and no layer.
//
// Looks: set these custom properties on the items, or on an element above them. The engine
// reads them from the dragged item at the start of a drag.
//
//   --dnd-accent        Color of the drop marker. Default #1a73e8.
//   --dnd-lift-bg       Background of the lifted copy. Default: the background color of the
//                       item, or of the nearest element above it, that is fully opaque.
//   --dnd-lift-radius   Corner radius of the lifted copy and of the marker. Default: the radius
//                       of the item, or 10px.
//   --dnd-lift-shadow   Shadow of the lifted copy.
//   --dnd-lift-scale    Scale of the lifted copy. Default: 8 px more on the long side, at most 1.06.

import type { Attachment } from 'svelte/attachments';
import { startEngine } from './engine.ts';

/** A row next to a drop place. */
export interface DndNeighbor {
  id: string;
  depth: number;
}

/** A place where the dragged block can go. The engine asks the caller about it. */
export interface DndPlace {
  /** The dragged item. */
  id: string;
  /** The container of the place. */
  containerId: string;
  /** Position in the container, counted without the dragged block. 0 is before the first item. */
  index: number;
  /** The item directly before the place, at any depth. null at the start of the container. */
  prev: DndNeighbor | null;
  /** The item directly after the place, at any depth. null at the end of the container. */
  next: DndNeighbor | null;
}

/** The result of a drop. */
export interface DndDrop {
  /** The dragged item. Its subtasks (the items directly after it with a larger depth) moved with it. */
  id: string;
  fromContainerId: string;
  toContainerId: string;
  /** Position in the target container, counted without the dragged block. */
  index: number;
  /**
   * The next item with the same parent: the dragged item goes directly before it.
   * null if the dragged item is the last one of its parent (or of the container, at depth 0).
   */
  beforeId: string | null;
  /**
   * The previous item with the same parent: the dragged item goes directly after it.
   * null if the dragged item is the first one of its parent (or of the container, at depth 0).
   */
  afterId: string | null;
  /** The new depth of the dragged item. */
  depth: number;
  /** The item that becomes the parent. null when depth is 0. */
  parentId: string | null;
}

export interface DndOptions {
  /** Direction of the items in a container. 'y' is top to bottom, 'x' is left to right. Default 'y'. */
  axis?: 'x' | 'y';
  /** The value of data-dnd-group on the containers of this engine. Default ''. */
  group?: string;
  /** CSS selector. If set, a drag starts only from a matching element in the item. */
  handle?: string;
  /**
   * CSS selector of elements in an item that do not start a drag.
   * Default: 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-dnd-ignore]'.
   */
  ignore?: string;
  /**
   * Width of one depth step in px. Default 28. The depth of the drop goes up when the pointer
   * moves 3/4 of this value to the right from where it was at the start, and down for a
   * movement to the left. The drop marker starts `indent` px more to the right for depth 1.
   */
  indent?: number;
  /**
   * true: the lifted copy moves only along the axis and stays in line with the items of the
   * container below the pointer. In a list with depths, the copy moves to the side by one
   * `indent` for each depth step, so the copy itself shows the depth of the drop.
   * Use it for tabs, and for a list on a phone. Default false: the copy follows the pointer.
   */
  lockAxis?: boolean;
  /**
   * Automatic scroll near the edges of the scroll areas around the containers.
   * 'axis' scrolls only in the direction of the axis, 'both' in the two directions. Default 'axis'.
   */
  autoScroll?: 'axis' | 'both' | 'none';
  /** The layer of the lifted copy goes into this element. Default: document.body. */
  overlayParent?: HTMLElement;
  /** true: a press does not start a drag. Read at each press, so a getter can give the current value. */
  disabled?: boolean;
  /** Tells if the item can be dragged. Default: each item can. */
  canDrag?: (id: string) => boolean;
  /**
   * Gives the largest depth that is permitted at a place. Return a negative number if the block
   * cannot go to that place at all. Default: 0 at each place.
   *
   * The engine adds two rules of its own: the depth is at most `prev.depth + 1` (0 at the start
   * of a container), and at least `next.depth` (so the item after the place keeps its parent).
   */
  maxDepthAt?: (place: DndPlace) => number;
  /** A drag started. */
  onDragStart?: (info: { id: string; containerId: string }) => void;
  /**
   * The user dropped the block at a new place. Change the data now. If the change is not
   * synchronous, return a promise: the engine keeps the picture until the promise settles.
   * Not called when the block comes back to its old place and depth.
   */
  onDrop: (drop: DndDrop) => void | Promise<void>;
  /** The drag ended. `dropped` is true if onDrop was called. */
  onDragEnd?: (info: { id: string; dropped: boolean }) => void;
}

export interface DndController {
  /** true from the start of a drag to the release. */
  readonly dragging: boolean;
  /** Ends the current drag and puts the block back. Does nothing if there is no drag. */
  cancel(): void;
  /** Removes all listeners. Cancels the current drag with no animation. */
  destroy(): void;
}

/**
 * Starts an engine on `root`. The root must contain the containers of the group (it can be the
 * container itself) and must not be removed during a drag.
 *
 * Gestures: a mouse drag starts after 4 px of movement. A touch or pen drag starts after a hold
 * of 250 ms with less than 8 px of movement. Esc, a release away from all containers, or a
 * release at the old place puts the block back.
 */
export function createDnd(root: HTMLElement, options: DndOptions): DndController {
  return startEngine(root, options);
}

/**
 * Svelte attachment for `createDnd`: `<div {@attach dnd({ onDrop })}>`.
 *
 * The engine reads the options at each press and calls the callbacks at drag time, so callbacks
 * that read `$state` always see the current data. Make the options object one time (in the
 * script), not in the template, so a change of state does not start the engine again.
 */
export function dnd(options: DndOptions): Attachment<HTMLElement> {
  return (root) => startEngine(root, options).destroy;
}

/** Attributes of a container, to spread on its element: `<ul {...dndContainer({ id, group: 'tasks' })}>`. */
export function dndContainer({ id, group = '' }: { id: string; group?: string }): {
  'data-dnd-container': string;
  'data-dnd-group': string;
} {
  return { 'data-dnd-container': id, 'data-dnd-group': group };
}

/** Attributes of an item, to spread on its element: `<li {...dndItem({ id, depth })}>`. */
export function dndItem({ id, depth = 0 }: { id: string; depth?: number }): {
  'data-dnd-id': string;
  'data-dnd-depth': number;
} {
  return { 'data-dnd-id': id, 'data-dnd-depth': depth };
}
