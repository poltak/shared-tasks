// The placement of the note cards (SPEC section 8, "Grid"). Pure functions: the grid measures
// the cards and the area, and gives the numbers here.

import type { LayoutMode } from '../ui/index.ts';

export interface Columns {
  count: number;
  /** The width of one column in px. */
  width: number;
  /** The space between two columns, and between two cards of a column, in px. */
  gap: number;
  /** The distance from the left edge of the area to the first column, in px. It centres the columns. */
  offset: number;
}

const PHONE_GAP = 8;
const WIDE_GAP = 16;
const WIDE_COLUMN = 240;

/**
 * The columns for an area of this width. A phone has two columns that share the width. A wide
 * screen has columns of 240 px, as many as fit, in the middle of the area.
 */
export function columnsFor({ width, mode }: { width: number; mode: LayoutMode }): Columns {
  const free = Math.max(0, width);
  if (mode === 'phone') return { count: 2, width: Math.max(0, (free - PHONE_GAP) / 2), gap: PHONE_GAP, offset: 0 };
  const count = Math.max(1, Math.floor((free + WIDE_GAP) / (WIDE_COLUMN + WIDE_GAP)));
  // An area that is narrower than one column gets one column of its own width.
  const column = Math.min(WIDE_COLUMN, free);
  const used = count * column + (count - 1) * WIDE_GAP;
  return { count, width: column, gap: WIDE_GAP, offset: Math.max(0, Math.floor((free - used) / 2)) };
}

export interface Placement {
  /** The top left corner of each card, in the order of the input, in px from the top left of the area. */
  positions: { x: number; y: number }[];
  /** The height of the highest column. */
  height: number;
}

/**
 * Puts each card, in order, into the column that is the shortest at that moment, or the left one
 * of the shortest. So the first cards are at the top, and a reader can follow the order from
 * left to right and down.
 */
export function placeCards({ heights, columns }: { heights: readonly number[]; columns: Columns }): Placement {
  const { width, gap, offset } = columns;
  const count = Math.max(1, Math.floor(columns.count));
  const bottoms: number[] = new Array<number>(count).fill(0);
  const positions = heights.map((height) => {
    let column = 0;
    for (let i = 1; i < count; i++) if (bottoms[i]! < bottoms[column]!) column = i;
    const y = bottoms[column]!;
    bottoms[column] = y + Math.max(0, height) + gap;
    return { x: offset + column * (width + gap), y };
  });
  const height = heights.length === 0 ? 0 : Math.max(...bottoms) - gap;
  return { positions, height: Math.max(0, height) };
}
