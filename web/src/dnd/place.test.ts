import { describe, expect, it } from 'vitest';
import type { DndPlace } from './index.ts';
import { depthRange, family, indexAt, resolvePlace, slotStart, stepDepth, type PlaceRow } from './place.ts';

/** Rows of 40 px with no space between them. The text gives the depths: 'A', 'A1' is a subtask. */
function rowsOf(...ids: string[]): PlaceRow[] {
  return ids.map((id, i) => ({ id, depth: id.length > 1 ? 1 : 0, start: i * 40, size: 40 }));
}

const base = { id: 'X', containerId: 'list', gap: 0, emptyStart: 0 };
const subtasksOk = (): number => 1;
const flat = (): number => 0;

describe('indexAt', () => {
  const rows = rowsOf('A', 'B', 'C');

  it('changes at the middle of a row', () => {
    expect(indexAt({ rows, gap: 0, lead: -100 })).toBe(0);
    expect(indexAt({ rows, gap: 0, lead: 20 })).toBe(0);
    expect(indexAt({ rows, gap: 0, lead: 21 })).toBe(1);
    expect(indexAt({ rows, gap: 0, lead: 61 })).toBe(2);
    expect(indexAt({ rows, gap: 0, lead: 500 })).toBe(3);
  });

  it('puts the limit in the middle of the space between rows', () => {
    const spaced = rows.map((row, i) => ({ ...row, start: i * 50 }));
    expect(indexAt({ rows: spaced, gap: 10, lead: 25 })).toBe(0);
    expect(indexAt({ rows: spaced, gap: 10, lead: 26 })).toBe(1);
  });

  it('gives 0 for a container with no rows', () => {
    expect(indexAt({ rows: [], gap: 0, lead: 30 })).toBe(0);
  });
});

describe('slotStart', () => {
  it('is the start of the row at the index, or the end of the last row', () => {
    const rows = rowsOf('A', 'B');
    expect(slotStart({ rows, gap: 8, emptyStart: 5, index: 1 })).toBe(40);
    expect(slotStart({ rows, gap: 8, emptyStart: 5, index: 2 })).toBe(88);
    expect(slotStart({ rows: [], gap: 8, emptyStart: 5, index: 0 })).toBe(5);
  });
});

describe('depthRange', () => {
  const rows = rowsOf('A', 'A1', 'A2', 'B');
  const range = (index: number, maxDepthAt = subtasksOk) => depthRange({ ...base, rows, index, maxDepthAt });

  it('permits only depth 0 at the start', () => {
    expect(range(0)).toEqual({ min: 0, max: 0 });
  });

  it('needs depth 1 between a parent and its subtask', () => {
    expect(range(1)).toEqual({ min: 1, max: 1 });
    expect(range(2)).toEqual({ min: 1, max: 1 });
  });

  it('permits the two depths after the last subtask and after a top row', () => {
    expect(range(3)).toEqual({ min: 0, max: 1 });
    expect(range(4)).toEqual({ min: 0, max: 1 });
  });

  it('has no place between subtasks for a block that must stay at depth 0', () => {
    expect(range(1, flat)).toBeNull();
    expect(range(3, flat)).toEqual({ min: 0, max: 0 });
  });

  it('gives the neighbors to the rule of the caller', () => {
    const seen: DndPlace[] = [];
    depthRange({
      ...base,
      rows,
      index: 1,
      maxDepthAt: (place) => {
        seen.push(place);
        return 1;
      },
    });
    expect(seen).toEqual([
      { id: 'X', containerId: 'list', index: 1, prev: { id: 'A', depth: 0 }, next: { id: 'A1', depth: 1 } },
    ]);
  });

  it('has no place where the rule gives a negative number', () => {
    expect(range(0, () => -1)).toBeNull();
  });
});

describe('resolvePlace', () => {
  const rows = rowsOf('A', 'A1', 'A2', 'B');
  const place = (lead: number, pref: number, maxDepthAt = subtasksOk) =>
    resolvePlace({ ...base, rows, lead, pref, maxDepthAt });

  it('keeps the wanted depth where it is permitted', () => {
    expect(place(130, 0)).toEqual({ index: 3, depth: 0 });
    expect(place(130, 1)).toEqual({ index: 3, depth: 1 });
  });

  it('moves the depth into the permitted range', () => {
    expect(place(50, 0)).toEqual({ index: 1, depth: 1 });
    expect(place(0, 1)).toEqual({ index: 0, depth: 0 });
    expect(place(130, 5)).toEqual({ index: 3, depth: 1 });
  });

  it('goes to the nearest permitted slot around a family', () => {
    // Slots for a block that stays at depth 0: before A (0), after A2 (120), after B (160).
    expect(place(50, 0, flat)).toEqual({ index: 0, depth: 0 });
    expect(place(70, 0, flat)).toEqual({ index: 3, depth: 0 });
  });

  it('gives null where no slot is permitted', () => {
    expect(place(50, 0, () => -1)).toBeNull();
  });

  it('works for a container with no rows', () => {
    expect(resolvePlace({ ...base, rows: [], lead: 300, pref: 1, maxDepthAt: subtasksOk })).toEqual({ index: 0, depth: 0 });
  });
});

describe('family', () => {
  const rows = rowsOf('A', 'A1', 'A2', 'B', 'C');

  it('finds the neighbors at depth 0 across the subtasks', () => {
    expect(family({ rows, index: 3, depth: 0 })).toEqual({ parentId: null, afterId: 'A', beforeId: 'B' });
    expect(family({ rows, index: 0, depth: 0 })).toEqual({ parentId: null, afterId: null, beforeId: 'A' });
    expect(family({ rows, index: 5, depth: 0 })).toEqual({ parentId: null, afterId: 'C', beforeId: null });
  });

  it('finds the parent and the neighbors of a subtask', () => {
    expect(family({ rows, index: 1, depth: 1 })).toEqual({ parentId: 'A', afterId: null, beforeId: 'A1' });
    expect(family({ rows, index: 2, depth: 1 })).toEqual({ parentId: 'A', afterId: 'A1', beforeId: 'A2' });
    expect(family({ rows, index: 3, depth: 1 })).toEqual({ parentId: 'A', afterId: 'A2', beforeId: null });
    expect(family({ rows, index: 4, depth: 1 })).toEqual({ parentId: 'B', afterId: null, beforeId: null });
  });
});

describe('stepDepth', () => {
  it('changes at 3/4 of a step and goes back at 1/4', () => {
    expect(stepDepth({ pref: 0, raw: 0.7 })).toBe(0);
    expect(stepDepth({ pref: 0, raw: 0.75 })).toBe(1);
    expect(stepDepth({ pref: 1, raw: 0.3 })).toBe(1);
    expect(stepDepth({ pref: 1, raw: 0.25 })).toBe(0);
    expect(stepDepth({ pref: 0, raw: -0.75 })).toBe(-1);
  });

  it('follows a large movement', () => {
    expect(stepDepth({ pref: 0, raw: 2.9 })).toBe(3);
    expect(stepDepth({ pref: 3, raw: 0.1 })).toBe(0);
  });
});
