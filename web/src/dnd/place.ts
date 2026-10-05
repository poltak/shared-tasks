// The math of a drop place. No DOM, so the tests run in Node.js.
//
// The rows of a container are given without the dragged block, in the order of the screen,
// with `start` and `size` along the axis as if the block was not in the layout.

import type { DndPlace } from './index.ts';

export interface PlaceRow {
  id: string;
  depth: number;
  start: number;
  size: number;
}

interface Container {
  rows: PlaceRow[];
  /** Space between two rows. */
  gap: number;
  /** Start of the first row of a container that has no rows. */
  emptyStart: number;
}

/**
 * The index where the block goes when its leading edge is at `lead`.
 * A row changes sides when the edge of the block passes the middle of the row. With this rule
 * the block must move by half of a row to pass it, in the two directions, for each row size.
 */
export function indexAt({ rows, gap, lead }: { rows: PlaceRow[]; gap: number; lead: number }): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const row = rows[mid]!;
    if (lead > row.start + (row.size + gap) / 2) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Where the block starts when it is at `index`. */
export function slotStart({ rows, gap, emptyStart, index }: Container & { index: number }): number {
  const at = rows[index];
  if (at) return at.start;
  const last = rows[rows.length - 1];
  return last ? last.start + last.size + gap : emptyStart;
}

type DepthRule = (place: DndPlace) => number;

interface PlaceQuery extends Container {
  id: string;
  containerId: string;
  maxDepthAt: DepthRule;
}

/** The depths that are permitted at an index. null if the block cannot go there. */
export function depthRange({
  rows,
  index,
  id,
  containerId,
  maxDepthAt,
}: Pick<PlaceQuery, 'rows' | 'id' | 'containerId' | 'maxDepthAt'> & { index: number }): { min: number; max: number } | null {
  const prev = rows[index - 1] ?? null;
  const next = rows[index] ?? null;
  // A smaller depth than the next row would take that row away from its parent.
  const min = next ? next.depth : 0;
  const allowed = maxDepthAt({
    id,
    containerId,
    index,
    prev: prev && { id: prev.id, depth: prev.depth },
    next: next && { id: next.id, depth: next.depth },
  });
  const max = Math.min(allowed, prev ? prev.depth + 1 : 0);
  return max >= min ? { min, max } : null;
}

/**
 * The place for a block with its leading edge at `lead` and the wanted depth `pref`.
 * If the nearest index is not permitted, the result is the permitted index with the nearest slot.
 */
export function resolvePlace(query: PlaceQuery & { lead: number; pref: number }): { index: number; depth: number } | null {
  const { rows, lead, pref } = query;
  const raw = indexAt(query);
  let best: { index: number; depth: number } | null = null;
  let bestDistance = Infinity;
  const consider = (index: number): boolean => {
    const range = depthRange({ ...query, index });
    if (!range) return false;
    const distance = Math.abs(slotStart({ ...query, index }) - lead);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { index, depth: Math.min(range.max, Math.max(range.min, pref)) };
    }
    return true;
  };
  if (consider(raw)) return best;
  for (let i = raw - 1; i >= 0 && !consider(i); i--);
  for (let i = raw + 1; i <= rows.length && !consider(i); i++);
  return best;
}

/** The parent and the neighbors with the same parent, for a block at `index` with `depth`. */
export function family({ rows, index, depth }: { rows: PlaceRow[]; index: number; depth: number }): {
  parentId: string | null;
  beforeId: string | null;
  afterId: string | null;
} {
  let parentId: string | null = null;
  let afterId: string | null = null;
  for (let i = index - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.depth < depth) {
      parentId = row.id;
      break;
    }
    if (row.depth === depth && afterId === null) {
      afterId = row.id;
      if (depth === 0) break;
    }
  }
  const next = rows[index];
  return { parentId, afterId, beforeId: next && next.depth === depth ? next.id : null };
}

/**
 * The wanted depth for a sideways position. `raw` is the start depth plus the sideways movement
 * in depth steps. The depth changes at 3/4 of a step and goes back at 1/4, so a small movement
 * of the hand near the limit does not flip it.
 */
export function stepDepth({ pref, raw }: { pref: number; raw: number }): number {
  if (raw - pref >= 0.75) return Math.floor(raw + 0.25);
  // The sum with 0 makes a negative zero positive.
  if (pref - raw >= 0.75) return Math.ceil(raw - 0.25) + 0;
  return pref;
}
