// The motion of the rows below a row that leaves its column. The browser puts them at their
// new places at once. This module then lets them go there from their old places, with a
// transform only.
//
// Marks in the markup of a column:
//   data-flow-root   the element that scrolls the rows
//   data-flow        each element in it that can move: a row, a heading, the "Completed" button
//   data-flow-end    an empty element after the last one

import { flushSync } from 'svelte';
import type { ID } from '../../../shared/types.ts';
import { reducedMotion } from '../ui/motion.ts';

const MOVE_MS = 180;
const EASE = 'cubic-bezier(0.2, 0, 0, 1)';
/** More rows than a window shows. The rows after these are not in view. */
const MAX_MOVED = 48;

/** The element of the row of a task. A task has one row: only one view is on the screen. */
export function rowElement(id: ID): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`);
}

/**
 * Runs `change`, which takes `row` (and the rows of its subtasks) out of the column. All that is
 * below moves by the same distance, so the layout is read two times only: the place of the end
 * mark before the change and after it.
 */
export function flowAfter({ row, change }: { row: HTMLElement | null; change: () => void }): void {
  const root = row?.closest<HTMLElement>('[data-flow-root]');
  const end = root?.querySelector<HTMLElement>('[data-flow-end]');
  if (!row || !root || !end || reducedMotion()) return change();

  const all = [...root.querySelectorAll<HTMLElement>('[data-flow]')];
  const below = all.slice(all.indexOf(row) + 1, all.indexOf(row) + 1 + MAX_MOVED);
  const before = end.getBoundingClientRect().top;
  change();
  // The screen has the new rows now, and not at the next frame.
  flushSync();
  if (!end.isConnected) return;
  const distance = before - end.getBoundingClientRect().top;
  if (Math.abs(distance) < 1) return;
  const frames = [{ transform: `translateY(${distance}px)` }, { transform: 'none' }];
  for (const element of below) {
    if (element.isConnected) element.animate(frames, { duration: MOVE_MS, easing: EASE });
  }
}
