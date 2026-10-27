import { describe, expect, it } from 'vitest';
import { columnsFor, placeCards, type Columns } from './masonry.ts';

const three: Columns = { count: 3, width: 100, gap: 10, offset: 0 };

describe('placeCards', () => {
  it('puts each card into the shortest column, and the left one on a tie', () => {
    const { positions, height } = placeCards({ heights: [50, 80, 30, 20, 40], columns: three });
    expect(positions).toEqual([
      // A tie of three empty columns: left to right.
      { x: 0, y: 0 },
      { x: 110, y: 0 },
      { x: 220, y: 0 },
      // The third column (30) is the shortest.
      { x: 220, y: 40 },
      // The first column (50) and the third (30 + 10 + 20 = 60): the first.
      { x: 0, y: 60 },
    ]);
    // The first column: 50 + 10 + 40. The second: 80. The third: 30 + 10 + 20.
    expect(height).toBe(100);
  });

  it('keeps the order of the input, so the first cards are at the top', () => {
    const { positions } = placeCards({ heights: [10, 10, 10, 10, 10, 10, 10], columns: three });
    expect(positions.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [110, 0],
      [220, 0],
      [0, 20],
      [110, 20],
      [220, 20],
      [0, 40],
    ]);
  });

  it('adds the offset that centres the columns', () => {
    const { positions } = placeCards({ heights: [10, 10], columns: { ...three, offset: 25 } });
    expect(positions.map((p) => p.x)).toEqual([25, 135]);
  });

  it('gives no height for no cards, and no gap below the last card', () => {
    expect(placeCards({ heights: [], columns: three })).toEqual({ positions: [], height: 0 });
    expect(placeCards({ heights: [42], columns: three }).height).toBe(42);
  });

  it('treats a card that is not measured yet as a card with no height', () => {
    const { positions } = placeCards({ heights: [0, 30, 0], columns: { count: 2, width: 100, gap: 8, offset: 0 } });
    expect(positions).toEqual([
      { x: 0, y: 0 },
      { x: 108, y: 0 },
      { x: 0, y: 8 },
    ]);
  });

  it('uses one column when the count is not valid', () => {
    const { positions } = placeCards({ heights: [10, 10], columns: { count: 0, width: 100, gap: 8, offset: 0 } });
    expect(positions).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 18 },
    ]);
  });
});

describe('columnsFor', () => {
  it('gives a phone two columns with an 8 px gap that share the width', () => {
    expect(columnsFor({ width: 388, mode: 'phone' })).toEqual({ count: 2, width: 190, gap: 8, offset: 0 });
  });

  it('gives a wide screen as many 240 px columns as fit, in the middle', () => {
    // 4 columns: 4 x 240 + 3 x 16 = 1008 px.
    expect(columnsFor({ width: 1100, mode: 'wide' })).toEqual({ count: 4, width: 240, gap: 16, offset: 46 });
    // Exactly 3 columns.
    expect(columnsFor({ width: 752, mode: 'wide' })).toEqual({ count: 3, width: 240, gap: 16, offset: 0 });
    // One pixel less: 2 columns.
    expect(columnsFor({ width: 751, mode: 'wide' })).toEqual({ count: 2, width: 240, gap: 16, offset: 127 });
  });

  it('gives a narrow wide area one column of its own width', () => {
    expect(columnsFor({ width: 200, mode: 'wide' })).toEqual({ count: 1, width: 200, gap: 16, offset: 0 });
    expect(columnsFor({ width: 0, mode: 'wide' })).toEqual({ count: 1, width: 0, gap: 16, offset: 0 });
    expect(columnsFor({ width: -5, mode: 'phone' })).toEqual({ count: 2, width: 0, gap: 8, offset: 0 });
  });
});
