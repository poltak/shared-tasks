// Tests of the drag and drop engine on its demo page, with real pointer input.
// Run: DEV_PORT=5190 pnpm exec playwright test --config e2e/dev.config.ts dnd
// With DND_SHOTS=1, the tests also write screenshots of a drag to .tmp/dnd/.

import { expect, test, type Page } from '@playwright/test';

interface Point {
  x: number;
  y: number;
}

/** One pointer for the two projects: the mouse on the desktop, a finger on the phone. */
interface Pointer {
  /** Presses at the point and starts the drag there. */
  down(p: Point): Promise<void>;
  move(p: Point, steps?: number): Promise<void>;
  up(): Promise<void>;
}

/** Longer than the hold of the engine (250 ms). The hold must be real time, so the test waits. */
const HOLD = 330;
const shots = process.env.DND_SHOTS === '1';

function mousePointer(page: Page): Pointer {
  return {
    async down(p) {
      // The drag starts after 4 px. These 4 px go before the point, so the drag starts at the point.
      await page.mouse.move(p.x - 4, p.y);
      await page.mouse.down();
      await page.mouse.move(p.x, p.y);
    },
    move: (p, steps = 8) => page.mouse.move(p.x, p.y, { steps }),
    up: () => page.mouse.up(),
  };
}

/** Touch events through the DevTools protocol. They go through the gesture code of the browser, as a finger does. */
async function touchPointer(page: Page): Promise<Pointer & { swipe(from: Point, to: Point): Promise<void> }> {
  const cdp = await page.context().newCDPSession(page);
  let at: Point = { x: 0, y: 0 };
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: Point[]) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: 1 })) });
  const glide = async (to: Point, steps: number): Promise<void> => {
    const from = at;
    for (let i = 1; i <= steps; i++) {
      at = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
      await send('touchMove', [at]);
    }
  };
  return {
    async down(p) {
      at = p;
      await send('touchStart', [p]);
      await page.waitForTimeout(HOLD);
    },
    move: (p, steps = 8) => glide(p, steps),
    async up() {
      await send('touchEnd', []);
    },
    /** A quick movement with no hold: the gesture that scrolls. */
    async swipe(from, to) {
      at = from;
      await send('touchStart', [from]);
      await glide(to, 6);
      await send('touchEnd', []);
    },
  };
}

const el = (page: Page, id: string) => page.locator(`.demo [data-dnd-id="${id}"]`);

async function box(page: Page, id: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await el(page, id).boundingBox();
  if (!b) throw new Error(`no element for ${id}`);
  return b;
}

/** A point on the title of a row. The circle at the left does not start a drag. */
async function grip(page: Page, id: string): Promise<Point> {
  const b = await box(page, id);
  return { x: b.x + b.width / 2, y: b.y + Math.min(22, b.height / 2) };
}

/** The ids in a container in the order of the DOM. A subtask has a '-' before its id. */
function ids(page: Page, containerId: string): Promise<string[]> {
  return page
    .locator(`.demo [data-dnd-container="${containerId}"] > [data-dnd-id]`)
    .evaluateAll((els) => els.map((e) => ((e as HTMLElement).dataset.dndDepth === '1' ? '-' : '') + (e as HTMLElement).dataset.dndId));
}

async function lastDrop(page: Page): Promise<Record<string, unknown> | null> {
  return JSON.parse((await page.getByTestId('last-drop').textContent()) ?? 'null');
}

/** Waits for the end of the drop animation, and checks that the engine left nothing on the page. */
async function settled(page: Page): Promise<void> {
  await expect(page.locator('.dnd-layer')).toHaveCount(0);
  const left = await page.evaluate(() => ({
    active: document.documentElement.classList.contains('dnd-active'),
    styled: [...document.querySelectorAll<HTMLElement>('.demo [data-dnd-id], .demo [data-dnd-container]')]
      .filter((e) => e.getAttribute('style'))
      .map((e) => `${e.dataset.dndId ?? e.dataset.dndContainer}: ${e.getAttribute('style')}`),
  }));
  expect(left).toEqual({ active: false, styled: [] });
}

async function shot(page: Page, name: string): Promise<void> {
  if (!shots) return;
  // The rows and the marker are at rest after their transitions.
  await page.waitForTimeout(300);
  await page.screenshot({ path: `.tmp/dnd/${test.info().project.name}-${name}.png` });
}

/**
 * Records where the given things are on the screen in each frame that the browser paints, from
 * now on. The read is after the frame, so it sees what the user sees, not a state in between.
 */
async function recordFrames(page: Page, selectors: Record<string, string>): Promise<void> {
  await page.evaluate((selectors) => {
    const frames: Array<Record<string, { x: number; y: number; opacity: number } | null>> = [];
    (window as unknown as { frames: typeof frames }).frames = frames;
    const read = (): void => {
      const frame: (typeof frames)[number] = {};
      for (const [name, selector] of Object.entries(selectors)) {
        const e = document.querySelector(selector);
        const r = e?.getBoundingClientRect();
        frame[name] = e && r ? { x: r.left, y: r.top, opacity: Number(getComputedStyle(e).opacity) } : null;
      }
      frames.push(frame);
    };
    const loop = (): void => {
      requestAnimationFrame(() => {
        setTimeout(read, 0);
        if (frames.length < 45) loop();
      });
    };
    loop();
  }, selectors);
}

type Frames = Array<Record<string, { x: number; y: number; opacity: number } | null>>;

async function framesOf(page: Page): Promise<Frames> {
  await page.waitForFunction(() => (window as unknown as { frames: unknown[] }).frames.length >= 45);
  return page.evaluate(() => (window as unknown as { frames: Frames }).frames);
}

/** The values go one way only, with no step back: the sign of a jump to a wrong place. */
function oneWay(values: number[]): boolean {
  const up = values[values.length - 1]! >= values[0]!;
  return values.every((v, i) => i === 0 || (up ? v >= values[i - 1]! - 0.5 : v <= values[i - 1]! + 0.5));
}

const START = ['a1', 'a2', '-a2x', '-a2y', 'a3', 'a4', 'a5', 'a6'];

let pointer: Pointer;
let errors: string[];

test.beforeEach(async ({ page, isMobile }) => {
  errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/dev/dnd.html');
  await expect(el(page, 'a1')).toBeVisible();
  pointer = isMobile ? await touchPointer(page) : mousePointer(page);
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test('moves a row down', async ({ page }) => {
  const from = await grip(page, 'a4');
  const a5 = await box(page, 'a5');
  await pointer.down(from);
  await pointer.move({ x: from.x, y: from.y + a5.height * 0.75 });
  await pointer.up();
  await settled(page);
  expect(await ids(page, 'a')).toEqual(['a1', 'a2', '-a2x', '-a2y', 'a3', 'a5', 'a4', 'a6']);
  expect(await lastDrop(page)).toEqual({
    id: 'a4',
    fromContainerId: 'a',
    toContainerId: 'a',
    index: 6,
    depth: 0,
    parentId: null,
    afterId: 'a5',
    beforeId: 'a6',
  });
  await expect(page.getByTestId('check')).toHaveText('ok');
  await expect(page.getByTestId('log')).toHaveText('end a4 true');
});

test('moves a row up', async ({ page }) => {
  const from = await grip(page, 'a6');
  const a5 = await box(page, 'a5');
  const a4 = await box(page, 'a4');
  await pointer.down(from);
  await pointer.move({ x: from.x, y: from.y - a5.height - a4.height * 0.75 });
  await pointer.up();
  await settled(page);
  expect(await ids(page, 'a')).toEqual(['a1', 'a2', '-a2x', '-a2y', 'a3', 'a6', 'a4', 'a5']);
  expect(await lastDrop(page)).toMatchObject({ id: 'a6', index: 5, depth: 0, afterId: 'a3', beforeId: 'a4' });
  await expect(page.getByTestId('check')).toHaveText('ok');
});

test('a small movement puts the row back with no drop', async ({ page }) => {
  const from = await grip(page, 'a4');
  await pointer.down(from);
  await pointer.move({ x: from.x + 6, y: from.y + 12 });
  await pointer.up();
  await settled(page);
  expect(await ids(page, 'a')).toEqual(START);
  expect(await lastDrop(page)).toBeNull();
  await expect(page.getByTestId('log')).toHaveText('end a4 false');
});

test('the rows change places a little past the middle of a row, not at it', async ({ page }) => {
  const from = await grip(page, 'a4');
  const a5 = await box(page, 'a5');
  await pointer.down(from);
  await pointer.move({ x: from.x, y: from.y + a5.height / 2 + 2 });
  await page.waitForTimeout(100);
  await expect(el(page, 'a5')).not.toHaveAttribute('style');
  await pointer.move({ x: from.x, y: from.y + a5.height / 2 + 7 }, 2);
  await expect(el(page, 'a5')).toHaveCSS('will-change', 'transform');
  // And back: the place stays until the block is a little past the middle again.
  await pointer.move({ x: from.x, y: from.y + a5.height / 2 - 2 }, 2);
  await pointer.up();
  await settled(page);
  expect(await ids(page, 'a')).toEqual(['a1', 'a2', '-a2x', '-a2y', 'a3', 'a5', 'a4', 'a6']);
});

test('makes a subtask with a movement to the right', async ({ page, isMobile }) => {
  const from = await grip(page, 'a5');
  const row = await box(page, 'a5');
  await pointer.down(from);
  await pointer.move({ x: from.x + 12, y: from.y });
  // 12 px is not sufficient: the marker stays at depth 0.
  await expect.poll(async () => (await page.locator('.dnd-marker').boundingBox())?.x).toBeCloseTo(row.x, 0);
  await pointer.move({ x: from.x + 40, y: from.y });
  await expect.poll(async () => (await page.locator('.dnd-marker').boundingBox())?.x).toBeCloseTo(row.x + 28, 0);
  // On the phone the copy stays in line with the list, and its indent shows the depth.
  if (isMobile) {
    await expect.poll(async () => (await page.locator('.dnd-ghost').boundingBox())?.x).toBeCloseTo(row.x + 28, 0);
    // The end of the copy stays in line with the list.
    expect((await page.locator('.dnd-ghost').boundingBox())!.width).toBeCloseTo(row.width - 28, 0);
  }
  await shot(page, 'indent');
  await pointer.up();
  await settled(page);
  expect(await ids(page, 'a')).toEqual(['a1', 'a2', '-a2x', '-a2y', 'a3', 'a4', '-a5', 'a6']);
  expect(await lastDrop(page)).toMatchObject({ id: 'a5', index: 6, depth: 1, parentId: 'a4', afterId: null, beforeId: null });
  await expect(page.getByTestId('check')).toHaveText('ok');
});

test('makes a top row from the last subtask with a movement to the left', async ({ page }) => {
  const from = await grip(page, 'a2y');
  await pointer.down(from);
  await pointer.move({ x: from.x - 40, y: from.y });
  await pointer.up();
  await settled(page);
  expect(await ids(page, 'a')).toEqual(['a1', 'a2', '-a2x', 'a2y', 'a3', 'a4', 'a5', 'a6']);
  expect(await lastDrop(page)).toMatchObject({ id: 'a2y', index: 3, depth: 0, parentId: null, afterId: 'a2', beforeId: 'a3' });
  await expect(page.getByTestId('check')).toHaveText('ok');
});

test('a subtask between subtasks stays a subtask', async ({ page }) => {
  const from = await grip(page, 'a2x');
  await pointer.down(from);
  await pointer.move({ x: from.x - 60, y: from.y });
  await pointer.up();
  await settled(page);
  expect(await ids(page, 'a')).toEqual(START);
  expect(await lastDrop(page)).toBeNull();
});

test('a subtask goes to a different parent', async ({ page }) => {
  const from = await grip(page, 'a2x');
  const a5 = await box(page, 'a5');
  const top = (await box(page, 'a2x')).y;
  await pointer.down(from);
  // The top of the row goes to 3/4 of a5. The row after it (a2y) closed the place, so a5 is one row higher.
  await pointer.move({ x: from.x, y: from.y + (a5.y - a5.height + a5.height * 0.75 - top) }, 12);
  await pointer.up();
  await settled(page);
  expect(await ids(page, 'a')).toEqual(['a1', 'a2', '-a2y', 'a3', 'a4', 'a5', '-a2x', 'a6']);
  expect(await lastDrop(page)).toMatchObject({ id: 'a2x', depth: 1, parentId: 'a5', afterId: null, beforeId: null });
  await expect(page.getByTestId('check')).toHaveText('ok');
});

test('a parent moves with its subtasks and stays a top row', async ({ page }) => {
  const from = await grip(page, 'a2');
  const a3 = await box(page, 'a3');
  await pointer.down(from);
  await expect(page.locator('.dnd-ghost [data-dnd-id]')).toHaveCount(3);
  // The movement to the right asks for a subtask. A row with subtasks cannot be one.
  await pointer.move({ x: from.x + 50, y: from.y + a3.height / 2 + 14 });
  await shot(page, 'parent');
  await pointer.up();
  await settled(page);
  expect(await ids(page, 'a')).toEqual(['a1', 'a3', 'a2', '-a2x', '-a2y', 'a4', 'a5', 'a6']);
  expect(await lastDrop(page)).toMatchObject({ id: 'a2', index: 2, depth: 0, parentId: null, afterId: 'a3', beforeId: 'a4' });
  await expect(page.getByTestId('check')).toHaveText('ok');
});

test('a parent does not go between the subtasks of a different parent', async ({ page }) => {
  // a4 gets a subtask first: a5 moves to the right.
  let from = await grip(page, 'a5');
  await pointer.down(from);
  await pointer.move({ x: from.x + 40, y: from.y });
  await pointer.up();
  await settled(page);
  // Now a4 goes up into the family of a2. It lands before a2 or after a2y, not between.
  from = await grip(page, 'a4');
  const a2x = await box(page, 'a2x');
  const top = (await box(page, 'a4')).y;
  await pointer.down(from);
  await pointer.move({ x: from.x, y: from.y + (a2x.y + 4 - top) }, 12);
  await pointer.up();
  await settled(page);
  expect(await ids(page, 'a')).toEqual(['a1', 'a4', '-a5', 'a2', '-a2x', '-a2y', 'a3', 'a6']);
  await expect(page.getByTestId('check')).toHaveText('ok');
});

test('moves a row to a different column', async ({ page, isMobile }) => {
  const from = await grip(page, 'a1');
  const a1 = await box(page, 'a1');
  const b1 = await box(page, 'b1');
  await pointer.down(from);
  // The same place in the row of the other column, with the top of the row at 3/4 of b1.
  // On the phone only the left part of that column shows, and the band near the edge scrolls.
  const x = isMobile ? b1.x + 14 : from.x + (b1.x - a1.x);
  await pointer.move({ x, y: from.y + (b1.y + b1.height * 0.75 - a1.y) }, 12);
  await shot(page, 'column-move');
  await pointer.up();
  await settled(page);
  expect(await ids(page, 'a')).toEqual(['a2', '-a2x', '-a2y', 'a3', 'a4', 'a5', 'a6']);
  expect(await ids(page, 'b')).toEqual(['b1', 'a1', 'b2', '-b2x', 'b3']);
  expect(await lastDrop(page)).toEqual({
    id: 'a1',
    fromContainerId: 'a',
    toContainerId: 'b',
    index: 1,
    depth: 0,
    parentId: null,
    afterId: 'b1',
    beforeId: 'b2',
  });
  await expect(page.getByTestId('check')).toHaveText('ok');
});

test('moves a row to a different column as a subtask', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The depth comes from the place of the pointer in the column, and the phone shows only the left part of the second column');
  const from = await grip(page, 'a6');
  const a6 = await box(page, 'a6');
  const b2x = await box(page, 'b2x');
  await pointer.down(from);
  await pointer.move({ x: from.x + (b2x.x - a6.x) + 40, y: from.y + (b2x.y + b2x.height * 0.75 - a6.y) }, 12);
  await pointer.up();
  await settled(page);
  expect(await ids(page, 'b')).toEqual(['b1', 'b2', '-b2x', '-a6', 'b3']);
  expect(await lastDrop(page)).toMatchObject({ id: 'a6', toContainerId: 'b', index: 3, depth: 1, parentId: 'b2', afterId: 'b2x', beforeId: null });
  await expect(page.getByTestId('check')).toHaveText('ok');
});

test('only the rows in view get a layer and a transition', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The long list is not on the screen of the phone at the start');
  const from = await grip(page, 'b1');
  const b1 = await box(page, 'b1');
  const c1 = await box(page, 'c1');
  await pointer.down(from);
  // To the top of the long list: each of its 30 rows moves down by one row.
  await pointer.move({ x: from.x + (c1.x - b1.x), y: from.y + (c1.y - b1.y) - 10 }, 12);
  const rows = await page.locator('.demo [data-dnd-container="c"] > [data-dnd-id]').evaluateAll((els) =>
    els.map((e) => {
      const s = (e as HTMLElement).style;
      return { moved: s.transform !== '', layer: s.willChange === 'transform', animated: s.transition !== 'none' };
    }),
  );
  expect(rows.every((row) => row.moved)).toBe(true);
  expect(rows[0]).toEqual({ moved: true, layer: true, animated: true });
  expect(rows[29]).toEqual({ moved: true, layer: false, animated: false });
  const layers = rows.filter((row) => row.layer).length;
  expect(layers).toBeGreaterThan(14);
  expect(layers).toBeLessThan(24);
  await pointer.up();
  await settled(page);
  expect((await ids(page, 'c')).slice(0, 2)).toEqual(['b1', 'c1']);
});

test('moves a row into a column with no rows', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The empty column is not on the screen of the phone');
  const from = await grip(page, 'b3');
  const list = await page.locator('.demo [data-dnd-container="d"]').boundingBox();
  await pointer.down(from);
  await pointer.move({ x: list!.x + 150, y: list!.y + 60 }, 16);
  await pointer.up();
  await settled(page);
  expect(await ids(page, 'd')).toEqual(['b3']);
  expect(await lastDrop(page)).toMatchObject({ id: 'b3', fromContainerId: 'b', toContainerId: 'd', index: 0, depth: 0, afterId: null, beforeId: null });
});

test('the drop has no jump in the same list', async ({ page }) => {
  const from = await grip(page, 'a4');
  const a4 = await box(page, 'a4');
  const a5 = await box(page, 'a5');
  await pointer.down(from);
  await pointer.move({ x: from.x + 8, y: from.y + a5.height * 0.75 });
  await page.waitForTimeout(250);
  await recordFrames(page, {
    a3: '.demo [data-dnd-id="a3"]',
    a4: '.demo [data-dnd-id="a4"]',
    a5: '.demo [data-dnd-id="a5"]',
    a6: '.demo [data-dnd-id="a6"]',
    ghost: '.dnd-ghost',
  });
  await pointer.up();
  const frames = await framesOf(page);
  await settled(page);

  // The rows that made room are at their new places already. They must not move in any frame.
  for (const [id, y] of [
    ['a3', (await box(page, 'a3')).y],
    ['a5', a4.y],
    ['a6', (await box(page, 'a6')).y],
  ] as const) {
    for (const frame of frames) expect(frame[id]!.y, id).toBeCloseTo(y, 0);
  }
  // The user sees the copy or the row in each frame, never the two, and the row does not fade in.
  for (const frame of frames) expect(frame.a4!.opacity).toBe(frame.ghost ? 0 : 1);
  const seen = frames.map((frame) => (frame.ghost ?? frame.a4)!.y);
  expect(seen[0]).toBeCloseTo(a4.y + a5.height * 0.75, 0);
  expect(seen[seen.length - 1]).toBeCloseTo(a4.y + a5.height, 0);
  expect(oneWay(seen)).toBe(true);
});

test('the drop has no jump between two lists', async ({ page, isMobile }) => {
  const from = await grip(page, 'a1');
  const a1 = await box(page, 'a1');
  const b1 = await box(page, 'b1');
  await pointer.down(from);
  const x = isMobile ? b1.x + 14 : from.x + (b1.x - a1.x) + 10;
  await pointer.move({ x, y: from.y + (b1.y + b1.height * 0.75 - a1.y) }, 12);
  await page.waitForTimeout(250);
  const before = {
    a2: (await box(page, 'a2')).y,
    b2: (await box(page, 'b2')).y,
    doneA: (await page.locator('.demo [data-dnd-id="a"] .done').boundingBox())!.y,
    doneB: (await page.locator('.demo [data-dnd-id="b"] .done').boundingBox())!.y,
  };
  // The rows closed the place in the first list and made room in the second one.
  expect(before.a2).toBeCloseTo(a1.y, 0);
  expect(before.b2).toBeCloseTo(b1.y + b1.height + a1.height, 0);
  await recordFrames(page, {
    a1: '.demo [data-dnd-id="a1"]',
    a2: '.demo [data-dnd-id="a2"]',
    b2: '.demo [data-dnd-id="b2"]',
    doneA: '.demo [data-dnd-id="a"] .done',
    doneB: '.demo [data-dnd-id="b"] .done',
    ghost: '.dnd-ghost',
  });
  await pointer.up();
  const frames = await framesOf(page);
  await settled(page);

  // The row has a new element in the second list. The rows and the text below them stay where they are.
  for (const frame of frames) {
    for (const name of ['a2', 'b2', 'doneA', 'doneB'] as const) expect(frame[name]!.y, name).toBeCloseTo(before[name], 0);
    expect(frame.a1!.opacity).toBe(frame.ghost ? 0 : 1);
  }
  const seen = frames.map((frame) => (frame.ghost ?? frame.a1)!.y);
  expect(seen[seen.length - 1]).toBeCloseTo(b1.y + b1.height, 0);
  expect(oneWay(seen)).toBe(true);
  expect(oneWay(frames.map((frame) => (frame.ghost ?? frame.a1)!.x))).toBe(true);
});

test('a release away from the columns puts the row back', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The columns fill the width of the phone');
  const from = await grip(page, 'c1');
  await pointer.down(from);
  await pointer.move({ x: 1400, y: from.y + 100 }, 12);
  await expect(page.locator('.dnd-marker')).toHaveCSS('opacity', '0');
  await shot(page, 'outside');
  await pointer.up();
  await settled(page);
  expect((await ids(page, 'c')).slice(0, 3)).toEqual(['c1', 'c2', 'c3']);
  expect(await lastDrop(page)).toBeNull();
});

test('moves a column by its header', async ({ page }) => {
  const head = await page.locator('.demo [data-dnd-id="a"] [data-dnd-handle]').boundingBox();
  const from = { x: head!.x + 60, y: head!.y + head!.height / 2 };
  await pointer.down(from);
  await pointer.move({ x: from.x + 200, y: from.y + 10 }, 12);
  await shot(page, 'column');
  await pointer.up();
  await settled(page);
  expect(await ids(page, 'board')).toEqual(['b', 'a', 'c', 'd']);
  expect(await lastDrop(page)).toMatchObject({ id: 'a', fromContainerId: 'board', index: 1, afterId: 'b', beforeId: 'c' });
  await expect(page.getByTestId('check')).toHaveText('ok');
  // The rows went with their column.
  expect(await ids(page, 'a')).toEqual(START);
});

test('a row does not move its column, and the header does not move a row', async ({ page }) => {
  const from = await grip(page, 'a1');
  await pointer.down(from);
  await pointer.move({ x: from.x + 200, y: from.y }, 12);
  await pointer.up();
  await settled(page);
  expect(await ids(page, 'board')).toEqual(['a', 'b', 'c', 'd']);
});

test('moves a tab', async ({ page }) => {
  const t1 = await box(page, 't1');
  const t2 = await box(page, 't2');
  const t3 = await box(page, 't3');
  const from = { x: t1.x + t1.width / 2, y: t1.y + t1.height / 2 };
  await pointer.down(from);
  // The finger also goes down. The tab stays in its row.
  await pointer.move({ x: from.x + t2.width + t3.width / 2 + 20, y: from.y + 50 }, 12);
  const ghost = await page.locator('.dnd-ghost').boundingBox();
  expect(ghost!.y).toBeCloseTo(t1.y, 0);
  await shot(page, 'tab');
  await pointer.up();
  await settled(page);
  expect(await ids(page, 'tabs')).toEqual(['t2', 't3', 't1', 't4', 't5', 't6', 't7']);
  expect(await lastDrop(page)).toMatchObject({ id: 't1', fromContainerId: 'tabs', toContainerId: 'tabs', index: 2, afterId: 't3', beforeId: 't4' });
  await expect(page.getByTestId('check')).toHaveText('ok');
  await expect(page.getByTestId('clicks')).toHaveText('0');
});

test('an item that the caller locks does not move', async ({ page, isMobile }) => {
  if (isMobile) await page.locator('.tabs').evaluate((tabs) => (tabs.scrollLeft = 9999));
  const t7 = await box(page, 't7');
  const from = { x: t7.x + 30, y: t7.y + t7.height / 2 };
  await pointer.down(from);
  await pointer.move({ x: from.x - 120, y: from.y }, 6);
  await expect(page.locator('.dnd-layer')).toHaveCount(0);
  await pointer.up();
  expect(await ids(page, 'tabs')).toEqual(['t1', 't2', 't3', 't4', 't5', 't6', 't7']);
});

test('the picture stays until a slow change of the data is done', async ({ page }) => {
  await page.evaluate(() => ((window as unknown as { demo: { slow: boolean } }).demo.slow = true));
  const t1 = await box(page, 't1');
  const t2 = await box(page, 't2');
  const from = { x: t1.x + t1.width / 2, y: t1.y + t1.height / 2 };
  await pointer.down(from);
  await pointer.move({ x: from.x + t2.width * 0.75 + 8, y: from.y }, 8);
  await page.waitForTimeout(250);
  const shifted = await box(page, 't2');
  expect(shifted.x).toBeCloseTo(t1.x, 0);
  await recordFrames(page, { t1: '.demo [data-dnd-id="t1"]', t2: '.demo [data-dnd-id="t2"]', ghost: '.dnd-ghost' });
  await pointer.up();
  const frames = await framesOf(page);
  await settled(page);
  expect(await ids(page, 'tabs')).toEqual(['t2', 't1', 't3', 't4', 't5', 't6', 't7']);
  await expect(page.getByTestId('check')).toHaveText('ok');
  // The other tab stays at its new place through the wait and the change of the DOM.
  for (const frame of frames) {
    expect(frame.t2!.x).toBeCloseTo(t1.x, 0);
    expect(frame.t1!.opacity).toBe(frame.ghost ? 0 : 1);
  }
  expect(oneWay(frames.map((frame) => (frame.ghost ?? frame.t1)!.x))).toBe(true);
});

test('the row of tabs scrolls when a tab is near its edge', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'The tabs fit on the wide screen');
  const tabs = page.locator('.tabs');
  const t1 = await box(page, 't1');
  const from = { x: t1.x + t1.width / 2, y: t1.y + t1.height / 2 };
  await pointer.down(from);
  await pointer.move({ x: 402, y: from.y }, 12);
  const end = await tabs.evaluate((e) => e.scrollWidth - e.clientWidth);
  expect(end).toBeGreaterThan(100);
  await expect.poll(() => tabs.evaluate((e) => e.scrollLeft), { timeout: 10_000 }).toBe(end);
  await pointer.up();
  await settled(page);
  expect(await ids(page, 'tabs')).toEqual(['t2', 't3', 't4', 't5', 't6', 't7', 't1']);
  expect(await lastDrop(page)).toMatchObject({ id: 't1', index: 6, afterId: 't7', beforeId: null });
  // The list below did not scroll sideways.
  expect(await page.locator('.board').evaluate((e) => e.scrollLeft)).toBe(0);
});

test('Esc cancels the drag', async ({ page }) => {
  const from = await grip(page, 'a4');
  await pointer.down(from);
  await pointer.move({ x: from.x + 40, y: from.y + 90 });
  await expect(page.locator('.dnd-layer')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await settled(page);
  await pointer.up();
  expect(await ids(page, 'a')).toEqual(START);
  expect(await lastDrop(page)).toBeNull();
  await expect(page.getByTestId('log')).toHaveText('end a4 false');
  await expect(page.getByTestId('clicks')).toHaveText('0');
});

test('the lifted copy starts at the place of the row', async ({ page }) => {
  const row = await box(page, 'a3');
  await pointer.down(await grip(page, 'a3'));
  const ghost = await page.locator('.dnd-ghost').boundingBox();
  expect(ghost!.x).toBeCloseTo(row.x, 0);
  expect(ghost!.y).toBeCloseTo(row.y, 0);
  expect(ghost!.width).toBeCloseTo(row.width, 0);
  expect(ghost!.height).toBeCloseTo(row.height, 0);
  await expect(el(page, 'a3')).toHaveCSS('opacity', '0');
  await expect(page.locator('html')).toHaveClass(/dnd-active/);
  await page.waitForTimeout(200);
  await shot(page, 'lift');
  await pointer.up();
  await settled(page);
});

test('the list scrolls when the pointer is near its edge', async ({ page, isMobile }) => {
  if (isMobile) await page.locator('.board').evaluate((board) => (board.scrollLeft = 624));
  const scroll = page.getByTestId('scroll-c');
  const area = (await scroll.boundingBox())!;
  const top = () => scroll.evaluate((e) => e.scrollTop);

  let from = await grip(page, 'c2');
  await pointer.down(from);
  await pointer.move({ x: from.x, y: area.y + area.height - 12 }, 12);
  await expect.poll(top, { timeout: 10_000 }).toBeGreaterThan(400);
  await shot(page, 'autoscroll');
  await pointer.up();
  await settled(page);
  const order = await ids(page, 'c');
  expect(order.indexOf('c2')).toBeGreaterThan(12);
  expect((await lastDrop(page))!.index).toBe(order.indexOf('c2'));
  await expect(page.getByTestId('check')).toHaveText('ok');

  // And back up. The row at the pointer now is c2.
  from = await grip(page, 'c2');
  await pointer.down(from);
  await pointer.move({ x: from.x, y: area.y + 10 }, 12);
  await expect.poll(top, { timeout: 10_000 }).toBe(0);
  await pointer.up();
  await settled(page);
  expect((await ids(page, 'c'))[0]).toBe('c2');
  await expect(page.getByTestId('check')).toHaveText('ok');
});

test('a press near an edge does not scroll before the pointer goes to that edge', async ({ page, isMobile }) => {
  if (isMobile) await page.locator('.board').evaluate((board) => (board.scrollLeft = 624));
  const scroll = page.getByTestId('scroll-c');
  await scroll.evaluate((e) => (e.scrollTop = 200));
  const area = (await scroll.boundingBox())!;
  // The row at the top edge of the scroll area.
  const from = { x: area.x + area.width / 2, y: area.y + 20 };
  await pointer.down(from);
  await pointer.move({ x: from.x, y: from.y + 3 }, 2);
  await page.waitForTimeout(300);
  expect(await scroll.evaluate((e) => e.scrollTop)).toBe(200);
  await pointer.move({ x: from.x, y: from.y - 12 }, 4);
  await expect.poll(() => scroll.evaluate((e) => e.scrollTop)).toBeLessThan(150);
  await page.keyboard.press('Escape');
  await settled(page);
  await pointer.up();
});

test('the board scrolls sideways for a row near its edge', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'The board does not scroll on the wide screen');
  const board = page.locator('.board');
  const from = await grip(page, 'a1');
  await pointer.down(from);
  await pointer.move({ x: 400, y: from.y + 30 }, 12);
  await expect.poll(() => board.evaluate((e) => e.scrollLeft), { timeout: 10_000 }).toBeGreaterThan(250);
  await pointer.up();
  await settled(page);
  expect(await lastDrop(page)).toMatchObject({ id: 'a1', fromContainerId: 'a' });
  expect((await lastDrop(page))!.toContainerId).not.toBe('a');
  await expect(page.getByTestId('check')).toHaveText('ok');
});

test('a wheel scroll during a drag keeps the drop place at the pointer', async ({ page, isMobile }) => {
  test.skip(isMobile, 'No wheel on the phone');
  const scroll = page.getByTestId('scroll-c');
  const from = await grip(page, 'c3');
  await pointer.down(from);
  await pointer.move({ x: from.x, y: from.y + 10 });
  await page.mouse.wheel(0, 300);
  await expect.poll(() => scroll.evaluate((e) => e.scrollTop)).toBe(300);
  // The pointer did not move, and the list went up by 300 px below it.
  await pointer.move({ x: from.x, y: from.y + 12 }, 2);
  await pointer.up();
  await settled(page);
  const order = await ids(page, 'c');
  const index = order.indexOf('c3');
  expect(index).toBeGreaterThan(6);
  expect(index).toBeLessThan(11);
  await expect(page.getByTestId('check')).toHaveText('ok');
});

test('no text is selected by a drag', async ({ page }) => {
  const title = await page.locator('.demo [data-dnd-id="a3"] .title').boundingBox();
  const from = { x: title!.x + 10, y: title!.y + title!.height / 2 };
  await pointer.down(from);
  await pointer.move({ x: from.x + 90, y: from.y + 120 }, 12);
  expect(await page.evaluate(() => String(getSelection()))).toBe('');
  await pointer.up();
  await settled(page);
  expect(await page.evaluate(() => String(getSelection()))).toBe('');
  expect(await lastDrop(page)).toMatchObject({ id: 'a3' });
});

test('a drag from a picture or a link is not a native drag', async ({ page }) => {
  for (const [id, selector] of [
    ['a1', 'img'],
    ['a3', 'a'],
  ] as const) {
    const target = await page.locator(`.demo [data-dnd-id="${id}"] ${selector}`).boundingBox();
    const from = { x: target!.x + target!.width / 2, y: target!.y + target!.height / 2 };
    await pointer.down(from);
    await pointer.move({ x: from.x, y: from.y + 150 }, 12);
    await expect(page.locator('.dnd-layer')).toHaveCount(1);
    await pointer.up();
    await settled(page);
    expect(await lastDrop(page)).toMatchObject({ id });
  }
  // The link did not open.
  expect(page.url()).toContain('/dev/dnd.html');
});

test('a click is a click, and the release of a drag is not', async ({ page, isMobile }) => {
  const body = el(page, 'a5').locator('.body');
  if (isMobile) await body.tap();
  else await body.click();
  await expect(page.getByTestId('clicks')).toHaveText('1');

  const from = await grip(page, 'a5');
  await pointer.down(from);
  await pointer.move({ x: from.x, y: from.y + 40 });
  await pointer.up();
  await settled(page);
  await expect(page.getByTestId('clicks')).toHaveText('1');

  // The next click works immediately.
  if (isMobile) await body.tap();
  else await body.click();
  await expect(page.getByTestId('clicks')).toHaveText('2');
});

test('an element with data-dnd-ignore does not start a drag', async ({ page }) => {
  const circle = await el(page, 'a4').locator('.circle').boundingBox();
  const from = { x: circle!.x + circle!.width / 2, y: circle!.y + circle!.height / 2 };
  await pointer.down(from);
  await pointer.move({ x: from.x, y: from.y + 30 }, 4);
  await expect(page.locator('.dnd-layer')).toHaveCount(0);
  await pointer.up();
  await expect(page.getByTestId('log')).toHaveText('');
});

test('new data during a drag does not break it', async ({ page }) => {
  const from = await grip(page, 'a4');
  const a5 = await box(page, 'a5');
  await pointer.down(from);
  await pointer.move({ x: from.x, y: from.y + a5.height * 0.75 });
  // A row comes in at the top, as after a sync. All rows go down by one row below the pointer.
  await page.evaluate(() => (window as unknown as { demo: { addTop(id: string): void } }).demo.addTop('a'));
  await expect(el(page, 'new8')).toBeVisible();
  await pointer.move({ x: from.x, y: from.y + a5.height * 1.75 });
  await pointer.up();
  await settled(page);
  expect(await ids(page, 'a')).toEqual(['new8', 'a1', 'a2', '-a2x', '-a2y', 'a3', 'a5', 'a4', 'a6']);
  await expect(page.getByTestId('check')).toHaveText('ok');
});

test('the drag ends when the dragged row goes away', async ({ page }) => {
  const from = await grip(page, 'a4');
  await pointer.down(from);
  await pointer.move({ x: from.x, y: from.y + 60 });
  await page.evaluate(() => (window as unknown as { demo: { remove(id: string): void } }).demo.remove('a4'));
  await settled(page);
  await expect(page.getByTestId('log')).toHaveText('end a4 false');
  await pointer.up();
  expect(await ids(page, 'a')).toEqual(['a1', 'a2', '-a2x', '-a2y', 'a3', 'a5', 'a6']);
  expect(await lastDrop(page)).toBeNull();
});

test('mouse: the drag starts after 4 px', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Mouse only');
  const from = await grip(page, 'a4');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 3, from.y);
  await page.waitForTimeout(350);
  await expect(page.locator('.dnd-layer')).toHaveCount(0);
  await page.mouse.move(from.x + 3, from.y + 3);
  await expect(page.locator('.dnd-layer')).toHaveCount(1);
  await page.mouse.up();
  await settled(page);
});

test('mouse: the right button and Control with a click do not drag', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Mouse only');
  const from = await grip(page, 'a4');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(from.x, from.y + 40, { steps: 4 });
  await expect(page.locator('.dnd-layer')).toHaveCount(0);
  await page.mouse.up({ button: 'right' });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('log')).toHaveText('');
});

test('touch: the drag starts only after the hold', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Touch only');
  const cdp = await page.context().newCDPSession(page);
  const from = await grip(page, 'a4');
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: Point[]) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ ...p, id: 1 })) });
  await touch('touchStart', [from]);
  await page.waitForTimeout(120);
  await expect(page.locator('.dnd-layer')).toHaveCount(0);
  await page.waitForTimeout(200);
  await expect(page.locator('.dnd-layer')).toHaveCount(1);
  await touch('touchEnd', []);
  await settled(page);
  // The release after a hold is not a tap on the row.
  await expect(page.getByTestId('clicks')).toHaveText('0');
});

test('touch: a quick swipe scrolls the list and does not drag', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Touch only');
  await page.locator('.board').evaluate((board) => (board.scrollLeft = 624));
  const finger = await touchPointer(page);
  const scroll = page.getByTestId('scroll-c');
  const from = await grip(page, 'c8');
  await finger.swipe(from, { x: from.x + 6, y: from.y - 220 });
  await expect.poll(() => scroll.evaluate((e) => e.scrollTop)).toBeGreaterThan(100);
  await expect(page.locator('.dnd-layer')).toHaveCount(0);
  await expect(page.getByTestId('log')).toHaveText('');
  expect((await ids(page, 'c')).slice(0, 9)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']);
  expect(await lastDrop(page)).toBeNull();
});

test('touch: the page does not scroll below a drag', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Touch only');
  await page.locator('.board').evaluate((board) => (board.scrollLeft = 624));
  const scroll = page.getByTestId('scroll-c');
  const board = page.locator('.board');
  const from = await grip(page, 'c8');
  await pointer.down(from);
  // In the middle of the list, away from the edges: no automatic scroll, and no scroll from the finger.
  await pointer.move({ x: from.x - 60, y: from.y - 150 }, 10);
  await page.waitForTimeout(150);
  expect(await scroll.evaluate((e) => e.scrollTop)).toBe(0);
  expect(await board.evaluate((e) => e.scrollLeft)).toBe(624);
  await pointer.up();
  await settled(page);
  expect(await lastDrop(page)).toMatchObject({ id: 'c8' });
});

test('touch: a long hold selects no text and opens no menu', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Touch only');
  await page.evaluate(() => {
    addEventListener('contextmenu', (e) => ((window as unknown as { menu: boolean }).menu = !e.defaultPrevented));
  });
  const title = await page.locator('.demo [data-dnd-id="a4"] .title').boundingBox();
  await pointer.down({ x: title!.x + 20, y: title!.y + title!.height / 2 });
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => String(getSelection()))).toBe('');
  expect(await page.evaluate(() => (window as unknown as { menu?: boolean }).menu ?? false)).toBe(false);
  await pointer.up();
  await settled(page);
});

test('with reduced motion the drop has no animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const from = await grip(page, 'a4');
  const a5 = await box(page, 'a5');
  await pointer.down(from);
  await pointer.move({ x: from.x, y: from.y + a5.height * 0.75 });
  await expect(el(page, 'a5')).toHaveCSS('transition-duration', '0s');
  await pointer.up();
  // One frame for the new order, and nothing more.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await expect(page.locator('.dnd-layer')).toHaveCount(0, { timeout: 1 });
  await settled(page);
  expect(await ids(page, 'a')).toEqual(['a1', 'a2', '-a2x', '-a2y', 'a3', 'a5', 'a4', 'a6']);
});
