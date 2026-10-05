// Tests of the UI base on its gallery page.
// Run: DEV_PORT=5191 pnpm exec playwright test --config e2e/dev.config.ts gallery

import { expect, test, type Locator, type Page } from '@playwright/test';

// A fixed day and a fixed language, so the texts and the month grid are the same on each run.
// 6 October 2026 is a Tuesday. In en-GB the week starts on Monday and the clock has 24 hours.
const TODAY = '2026-10-06';
const URL = `/dev/gallery.html?today=${TODAY}&locale=en-GB`;

test.beforeEach(async ({ page }) => {
  await page.goto(URL);
  await expect(page.getByTestId('section-pickers')).toBeVisible();
});

const isPhone = (page: Page): boolean => page.viewportSize()!.width < 840;
const overlayCount = (page: Page): Locator => page.getByTestId('overlay-count');
/** The number of overlay entries in the history, as the stack wrote it into the state. */
const historyDepth = (page: Page): Promise<number> =>
  page.evaluate(() => (history.state as { stOverlay?: number } | null)?.stOverlay ?? 0);
const focusedText = (page: Page): Promise<string> =>
  page.evaluate(() => (document.activeElement?.textContent ?? '').replace(/\s+/g, ' ').trim());
const focusedTestId = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
const day = (scope: Page | Locator, date: string): Locator => scope.locator(`[data-date="${date}"]`);

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await locator.boundingBox();
  if (!b) throw new Error('the element has no box');
  return b;
}

/** Chooses an option of a Select: a menu on the desktop, a bottom sheet on the phone. */
async function choose(page: Page, { select, option }: { select: RegExp; option: string }): Promise<void> {
  await page.getByRole('button', { name: select }).click();
  await page.getByRole('menuitemradio', { name: option, exact: true }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
}

test.describe('menu', () => {
  test('the keys move the focus, select, and close', async ({ page }) => {
    test.skip(isPhone(page), 'A phone shows the menu as a bottom sheet');
    const opener = page.getByTestId('open-list-menu');
    await opener.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    // A menu that the keyboard opened puts the focus on the checked item.
    await expect.poll(() => focusedText(page)).toBe('My order');

    await page.keyboard.press('ArrowDown');
    expect(await focusedText(page)).toBe('Date');
    await page.keyboard.press('End');
    expect(await focusedText(page)).toBe('Delete all completed tasks');
    await page.keyboard.press('ArrowDown');
    expect(await focusedText(page)).toBe('My order');
    await page.keyboard.press('ArrowUp');
    expect(await focusedText(page)).toBe('Delete all completed tasks');
    await page.keyboard.press('Home');
    expect(await focusedText(page)).toBe('My order');

    // Typed letters: "s" finds the next item with that letter, "sh" the item that starts with the two.
    await page.keyboard.press('s');
    expect(await focusedText(page)).toBe('Starred recently');
    await page.keyboard.press('h');
    expect(await focusedText(page)).toBe('Share with Minh');
    await page.waitForTimeout(700);
    await page.keyboard.press('t');
    expect(await focusedText(page)).toBe('Title');

    // A disabled item gets the focus, with its reason, but Enter does nothing.
    await page.keyboard.press('d');
    await page.waitForTimeout(700);
    await page.keyboard.press('d');
    expect(await focusedText(page)).toBe("Delete list The default list can't be deleted");
    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible();
    await expect(page.getByTestId('menu-result')).toHaveText('none');

    // Tab does not leave the menu.
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.closest('[role="menu"]') !== null)).toBe(true);

    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId('menu-result')).toHaveText('sort-date');
    await expect(page.getByTestId('menu-closes')).toHaveText('1');
    expect(await focusedTestId(page)).toBe('open-list-menu');

    await page.keyboard.press('Space');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId('menu-closes')).toHaveText('2');
    await expect(page.getByTestId('menu-result')).toHaveText('sort-date');
    expect(await focusedTestId(page)).toBe('open-list-menu');
  });

  test('the popover is at its anchor and inside the window', async ({ page }) => {
    test.skip(isPhone(page), 'A phone shows the menu as a bottom sheet');
    const view = page.viewportSize()!;
    const menu = page.getByRole('menu');
    const inside = async (): Promise<void> => {
      const m = await box(menu);
      expect(m.x).toBeGreaterThanOrEqual(8);
      expect(m.y).toBeGreaterThanOrEqual(8);
      expect(m.x + m.width).toBeLessThanOrEqual(view.width - 8);
      expect(m.y + m.height).toBeLessThanOrEqual(view.height - 8);
    };

    // Below the button, with the same left edge.
    const opener = page.getByTestId('open-task-menu');
    // The button is near the top of the window, so the menu has room below it.
    await opener.evaluate((element) => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 120));
    await opener.click();
    await expect(menu).toBeVisible();
    // The size is final when the open animation ends.
    await page.waitForTimeout(250);
    let anchor = await box(opener);
    let m = await box(menu);
    expect(Math.abs(m.x - anchor.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.y - (anchor.y + anchor.height + 4))).toBeLessThanOrEqual(1);
    await inside();
    // A press outside closes the menu and selects nothing.
    await page.mouse.click(5, 5);
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId('menu-result')).toHaveText('none');

    // align="end": the right edges are the same.
    const end = page.getByTestId('open-end-menu');
    await end.click();
    await page.waitForTimeout(250);
    anchor = await box(end);
    m = await box(menu);
    expect(Math.abs(m.x + m.width - (anchor.x + anchor.width))).toBeLessThanOrEqual(1);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // A button at the corner of the window: the menu moves to the inside.
    await page.getByTestId('open-corner-menu').click();
    await expect(menu).toBeVisible();
    await page.waitForTimeout(250);
    await inside();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // A right click opens the menu at the pointer.
    const area = await box(page.getByTestId('context-area'));
    const point = { x: Math.round(area.x + 40), y: Math.round(area.y + 20) };
    await page.mouse.click(point.x, point.y, { button: 'right' });
    await expect(menu).toBeVisible();
    await page.waitForTimeout(250);
    m = await box(menu);
    expect(Math.abs(m.x - point.x)).toBeLessThanOrEqual(1);
    await inside();
    await menu.getByRole('menuitem', { name: 'Move to top' }).click();
    await expect(page.getByTestId('menu-result')).toHaveText('top');

    // A menu that is higher than the window scrolls inside.
    await page.setViewportSize({ width: 1440, height: 320 });
    await page.getByTestId('open-corner-menu').click();
    await expect(menu).toBeVisible();
    await page.waitForTimeout(250);
    m = await box(menu);
    expect(m.y).toBeGreaterThanOrEqual(8);
    expect(m.y + m.height).toBeLessThanOrEqual(320 - 8);
    expect(await menu.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  });

  test('a phone shows the menu as a bottom sheet', async ({ page }) => {
    test.skip(!isPhone(page), 'The desktop shows a popover');
    await page.getByTestId('open-list-menu').click();
    const sheet = page.getByRole('dialog', { name: 'List options' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('menuitemradio', { name: 'My order' })).toHaveAttribute('aria-checked', 'true');
    await page.waitForTimeout(300);
    const view = page.viewportSize()!;
    const s = await box(sheet);
    expect(s.x).toBe(0);
    expect(s.width).toBe(view.width);
    expect(Math.abs(s.y + s.height - view.height)).toBeLessThanOrEqual(1);

    // A press on the disabled item does nothing. The press is forced, because the test tool does not press a disabled control.
    await sheet.getByText('Delete list').click({ force: true });
    await page.waitForTimeout(200);
    await expect(sheet).toBeVisible();
    await expect(page.getByTestId('menu-result')).toHaveText('none');
    await sheet.getByRole('menuitemradio', { name: 'Date' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByTestId('menu-result')).toHaveText('sort-date');
    await expect(page.getByTestId('menu-closes')).toHaveText('1');

    // A narrow window on a computer has a keyboard: the keys work in the sheet too.
    await page.getByTestId('open-list-menu').focus();
    await page.keyboard.press('Enter');
    await expect(sheet).toBeVisible();
    await expect.poll(() => focusedText(page)).toBe('My order');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    expect(await focusedText(page)).toBe('Deadline');
    await page.keyboard.press('Enter');
    await expect(sheet).toHaveCount(0);
    await expect(page.getByTestId('menu-result')).toHaveText('sort-deadline');
    await expect.poll(() => focusedTestId(page)).toBe('open-list-menu');
  });

  test('a long menu starts with the chosen option in view', async ({ page }) => {
    await page.getByTestId('open-repeat').click();
    await choose(page, { select: /^Unit/, option: 'month' });
    await choose(page, { select: /^Day:/, option: 'Day 28' });
    await page.getByRole('button', { name: 'Day: Day 28' }).click();
    const item = page.getByRole('menuitemradio', { name: 'Day 28', exact: true });
    await expect(item).toHaveAttribute('aria-checked', 'true');
    await expect(item).toBeInViewport({ ratio: 1 });
  });

  test('Back closes a menu', async ({ page }) => {
    await page.getByTestId('open-task-menu').click();
    await expect(page.getByRole('menu')).toBeVisible();
    await expect.poll(() => historyDepth(page)).toBe(1);
    await page.goBack();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByTestId('menu-closes')).toHaveText('1');
    await expect(page.getByTestId('menu-result')).toHaveText('none');
  });
});

test.describe('overlay stack', () => {
  test('Esc and Back close only the top overlay', async ({ page }) => {
    await page.getByTestId('open-nested').click();
    const outer = page.getByRole('dialog', { name: 'Create a task' });
    const inner = page.getByRole('dialog', { name: 'Discard the task?' });
    await expect(outer).toBeVisible();
    await expect(overlayCount(page)).toHaveText('1');
    await expect.poll(() => historyDepth(page)).toBe(1);

    await page.getByTestId('open-inner-confirm').click();
    await expect(inner).toBeVisible();
    await expect(overlayCount(page)).toHaveText('2');
    await expect.poll(() => historyDepth(page)).toBe(2);

    await page.keyboard.press('Escape');
    await expect(inner).toHaveCount(0);
    await expect(outer).toBeVisible();
    await expect(page.getByTestId('overlay-result')).toHaveText('kept');
    await expect(overlayCount(page)).toHaveText('1');
    await expect.poll(() => historyDepth(page)).toBe(1);
    // The focus is again on the button that opened the inner dialog.
    expect(await focusedTestId(page)).toBe('open-inner-confirm');

    await page.getByTestId('open-inner-confirm').click();
    await expect(inner).toBeVisible();
    await expect.poll(() => historyDepth(page)).toBe(2);
    await page.goBack();
    await expect(inner).toHaveCount(0);
    await expect(outer).toBeVisible();
    await expect(overlayCount(page)).toHaveText('1');

    await page.goBack();
    await expect(outer).toHaveCount(0);
    await expect(overlayCount(page)).toHaveText('0');
    await expect(page.getByTestId('overlay-result')).toHaveText('nested closed');
    expect(await historyDepth(page)).toBe(0);
    await expect(page).toHaveURL(new RegExp('/dev/gallery\\.html'));

    // Forward goes to the old entry of the overlay. The stack goes back from it and opens nothing.
    await page.goForward();
    await expect.poll(() => historyDepth(page)).toBe(0);
    await expect(overlayCount(page)).toHaveText('0');
    await expect(outer).toHaveCount(0);
  });

  test('a close by code removes the history entry', async ({ page }) => {
    await page.evaluate(() => history.pushState({ marker: 1 }, '', '#marker'));
    await page.getByTestId('open-dialog').click();
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    await expect.poll(() => historyDepth(page)).toBe(1);
    // The state of the app stays in the entry of the overlay.
    expect(await page.evaluate(() => (history.state as { marker?: number }).marker)).toBe(1);

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => historyDepth(page)).toBe(0);
    expect(await page.evaluate(() => location.hash)).toBe('#marker');

    // One Back now leaves the entry of the app. An entry of the overlay would take this step.
    await page.goBack();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
    await expect(page.getByTestId('section-pickers')).toBeVisible();
    await expect(overlayCount(page)).toHaveText('0');
  });

  test('many fast opens and closes leave one spare history entry and no open overlay', async ({ page }) => {
    const length = await page.evaluate(() => history.length);
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    for (let i = 0; i < 6; i++) {
      await page.getByTestId('open-dialog').click();
      // No wait for the history: the close comes before the entry of the open is there, or after it.
      if (i % 2) await expect.poll(() => historyDepth(page)).toBe(1);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }
    await expect.poll(() => historyDepth(page)).toBe(0);
    await expect(overlayCount(page)).toHaveText('0');
    // Each open after a close writes over the forward entry of the open before it.
    expect(await page.evaluate(() => history.length)).toBe(length + 1);
  });

  test('a reload with an open overlay removes the entry of the overlay', async ({ page }) => {
    await page.getByTestId('open-dialog').click();
    await expect.poll(() => historyDepth(page)).toBe(1);
    await page.reload();
    await expect(page.getByTestId('section-pickers')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => historyDepth(page)).toBe(0);
  });

  test('with reduced motion an overlay shows with no animation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByTestId('open-sheet').click();
    const sheet = page.getByRole('dialog', { name: 'Move to list' });
    await expect(sheet).toBeVisible();
    const view = page.viewportSize()!;
    // No wait: the sheet is at its place in the first frame.
    const s = await box(sheet);
    expect(Math.abs(s.y + s.height - view.height)).toBeLessThanOrEqual(1);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  });

  test('a menu item opens a dialog, and the focus goes back to the button of the menu', async ({ page }) => {
    await page.getByTestId('open-list-menu').click();
    await page.getByRole('menuitem', { name: 'Rename list' }).click();
    const dialog = page.getByRole('dialog', { name: 'Rename list' });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(overlayCount(page)).toHaveText('1');
    await expect.poll(() => historyDepth(page)).toBe(1);
    await expect(dialog.getByRole('textbox')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => historyDepth(page)).toBe(0);
    await expect.poll(() => focusedTestId(page)).toBe('open-list-menu');
  });

  test('the page below does not scroll while an overlay is open', async ({ page }) => {
    await page.getByTestId('open-dialog').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe('hidden');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe('hidden');
  });

  test('a press outside closes a dialog', async ({ page }) => {
    await page.getByTestId('open-confirm').click();
    const dialog = page.getByRole('dialog', { name: 'Delete this list?' });
    await expect(dialog).toBeVisible();
    await page.mouse.click(6, 6);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('overlay-result')).toHaveText('cancelled');

    await page.getByTestId('open-confirm').click();
    await dialog.getByRole('button', { name: 'Delete' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('overlay-result')).toHaveText('confirmed');
  });

  test('a full screen dialog on a phone has a Back button', async ({ page }) => {
    await page.getByTestId('open-full').click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(300);
    const view = page.viewportSize()!;
    const d = await box(dialog);
    if (isPhone(page)) {
      expect(d).toEqual({ x: 0, y: 0, width: view.width, height: view.height });
      await dialog.getByRole('button', { name: 'Back' }).click();
    } else {
      expect(d.width).toBe(480);
      await page.keyboard.press('Escape');
    }
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('overlay-result')).toHaveText('full closed');
  });
});

test('overlays keep clear of the on-screen keyboard', async ({ page }) => {
  // The test browser has no on-screen keyboard. The test gives the visual viewport the values
  // that a keyboard makes: a smaller height, and an offset from the top of the page.
  const keyboard = (height: number | null, offsetTop = 0): Promise<void> =>
    page.evaluate(
      ([h, top]) => {
        const view = window.visualViewport!;
        if (h === null) {
          delete (view as unknown as Record<string, unknown>).height;
          delete (view as unknown as Record<string, unknown>).offsetTop;
        } else {
          Object.defineProperty(view, 'height', { configurable: true, get: () => h });
          Object.defineProperty(view, 'offsetTop', { configurable: true, get: () => top });
        }
        view.dispatchEvent(new Event('resize'));
      },
      [height, offsetTop] as const,
    );
  const view = page.viewportSize()!;

  await page.getByTestId('open-add').click();
  const sheet = page.getByRole('dialog', { name: 'New task' });
  await expect(sheet).toBeVisible();
  await page.waitForTimeout(300);
  let s = await box(sheet);
  expect(Math.abs(s.y + s.height - view.height)).toBeLessThanOrEqual(1);
  await keyboard(420, 30);
  s = await box(sheet);
  expect(Math.abs(s.y + s.height - 450)).toBeLessThanOrEqual(1);
  await keyboard(null);
  s = await box(sheet);
  expect(Math.abs(s.y + s.height - view.height)).toBeLessThanOrEqual(1);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  // A dialog is in the centre of the free part, and not higher than it.
  await page.getByTestId('open-prompt').click();
  const dialog = page.getByRole('dialog', { name: 'Create new list' });
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(300);
  await keyboard(300, 0);
  let d = await box(dialog);
  expect(Math.abs(d.y + d.height / 2 - 150)).toBeLessThanOrEqual(1);
  // A phone on its side: the dialog gets smaller and its content scrolls.
  await keyboard(180, 0);
  d = await box(dialog);
  expect(d.y).toBeGreaterThanOrEqual(16);
  expect(d.y + d.height).toBeLessThanOrEqual(180 - 16 + 1);
  await keyboard(null);
});

test('the focus stays in a dialog', async ({ page }) => {
  const opener = page.getByTestId('open-dialog');
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeFocused();

  const first = dialog.getByPlaceholder('First field');
  const second = dialog.getByPlaceholder('Second field');
  const cancel = dialog.getByRole('button', { name: 'Cancel' });
  const ok = dialog.getByRole('button', { name: 'OK' });
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(second).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(ok).toBeFocused();
  // After the last control comes the first one, and the other way.
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(ok).toBeFocused();

  // Code of the page cannot put the focus outside.
  await opener.evaluate((element: HTMLElement) => element.focus());
  await expect(first).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test.describe('date picker', () => {
  test('a day, a different month, and a typed time', async ({ page }) => {
    await page.getByTestId('open-date').click();
    const picker = page.getByRole('dialog', { name: 'Date and time' });
    await expect(picker).toBeVisible();
    await expect(picker.getByText('October 2026')).toBeVisible();
    await expect(day(picker, TODAY)).toHaveAttribute('aria-current', 'date');
    // The week starts on Monday in this language: the first cell is Monday 28 September.
    await expect(picker.locator('[data-date]').first()).toHaveAttribute('data-date', '2026-09-28');
    const done = picker.getByRole('button', { name: 'Done' });
    await expect(done).toBeDisabled();

    await picker.getByRole('button', { name: 'Previous month' }).click();
    await expect(picker.getByText('September 2026')).toBeVisible();
    await picker.getByRole('button', { name: 'Next month' }).click();
    await picker.getByRole('button', { name: 'Next month' }).click();
    await expect(picker.getByText('November 2026')).toBeVisible();
    await day(picker, '2026-11-15').click();
    await expect(day(picker, '2026-11-15')).toHaveClass(/chosen/);
    await expect(done).toBeEnabled();

    // The list has each half hour. A press on an option sets the time.
    const time = picker.getByRole('combobox', { name: 'Time' });
    await time.click();
    const list = page.getByRole('listbox');
    await expect(list).toBeVisible();
    await expect(list.getByRole('option')).toHaveCount(48);
    await list.getByRole('option', { name: '09:30' }).click();
    await expect(time).toHaveValue('09:30');
    await expect(list).toHaveCount(0);

    // Typed text in more than one form.
    for (const [typed, shown] of [
      ['3pm', '15:00'],
      ['9', '09:00'],
      ['9:15', '09:15'],
      ['0930', '09:30'],
      ['14.30', '14:30'],
    ] as const) {
      await time.fill(typed);
      await page.keyboard.press('Enter');
      await expect(time).toHaveValue(shown);
    }
    // Text that is not a time brings the old time back.
    await time.fill('soon');
    await page.keyboard.press('Enter');
    await expect(time).toHaveValue('14:30');

    await done.click();
    await expect(picker).toHaveCount(0);
    await expect(page.getByTestId('date-result')).toHaveText(JSON.stringify({ date: '2026-11-15', time: '14:30', repeat: null }));

    // The next open shows the value.
    await page.getByTestId('open-date').click();
    await expect(picker.getByText('November 2026')).toBeVisible();
    await expect(day(picker, '2026-11-15')).toHaveClass(/chosen/);
    await expect(picker.getByRole('combobox', { name: 'Time' })).toHaveValue('14:30');
    // Esc cancels, and the value stays.
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect(page.getByTestId('date-result')).toHaveText('cancelled');
  });

  test('the arrow keys move in the grid', async ({ page }) => {
    await page.getByTestId('open-date').click();
    const picker = page.getByRole('dialog', { name: 'Date and time' });
    await day(picker, TODAY).focus();
    await page.keyboard.press('ArrowRight');
    await expect(day(picker, '2026-10-07')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(day(picker, '2026-10-14')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowUp');
    await expect(day(picker, TODAY)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(day(picker, '2026-10-05')).toBeFocused();
    await page.keyboard.press('End');
    await expect(day(picker, '2026-10-11')).toBeFocused();
    // A step out of the month shows the next month.
    await page.keyboard.press('PageDown');
    await expect(picker.getByText('November 2026')).toBeVisible();
    await expect(day(picker, '2026-11-11')).toBeFocused();
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
    await expect(picker.getByText('December 2026')).toBeVisible();
    await expect(day(picker, '2026-12-02')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(day(picker, '2026-12-02')).toHaveClass(/chosen/);
    await picker.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('date-result')).toHaveText(JSON.stringify({ date: '2026-12-02', time: null, repeat: null }));
  });

  test('a time with no day gives today, and Esc in the time list keeps the picker open', async ({ page }) => {
    await page.getByTestId('open-date').click();
    const picker = page.getByRole('dialog', { name: 'Date and time' });
    const time = picker.getByRole('combobox', { name: 'Time' });
    await time.click();
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(picker).toBeVisible();

    // The arrow keys choose an option of the list.
    await time.fill('7');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(time).toHaveValue('08:00');
    await expect(day(picker, TODAY)).toHaveClass(/chosen/);
    await picker.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('date-result')).toHaveText(JSON.stringify({ date: TODAY, time: '08:00', repeat: null }));

    // The X removes the time.
    await page.getByTestId('open-date').click();
    await picker.getByRole('button', { name: 'Remove time' }).click();
    await expect(picker.getByRole('combobox', { name: 'Time' })).toHaveValue('');
    await picker.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('date-result')).toHaveText(JSON.stringify({ date: TODAY, time: null, repeat: null }));
  });

  test('"Repeat" opens the repeat dialog and shows the rule', async ({ page }) => {
    await page.getByTestId('open-date').click();
    const picker = page.getByRole('dialog', { name: 'Date and time' });
    await day(picker, '2026-10-09').click();
    await picker.getByRole('button', { name: 'Repeat' }).click();
    const repeat = page.getByRole('dialog', { name: 'Repeat' });
    await expect(repeat).toBeVisible();
    await expect(overlayCount(page)).toHaveText('2');
    // The rule starts at the chosen day, a Friday.
    await expect(repeat.getByRole('button', { name: 'Friday' })).toHaveAttribute('aria-pressed', 'true');
    await repeat.getByRole('button', { name: 'Done' }).click();
    await expect(repeat).toHaveCount(0);
    await expect(picker.getByText('Weekly on Friday')).toBeVisible();

    // While a rule is set, a day before today cannot be chosen, and a new day moves the start.
    await expect(day(picker, '2026-10-05')).toHaveAttribute('aria-disabled', 'true');
    await day(picker, '2026-10-12').click();
    await expect(day(picker, '2026-10-16')).toHaveClass(/chosen/);
    await picker.getByRole('button', { name: 'Done' }).click();
    const rule = { every: 1, unit: 'week', start: '2026-10-12', end: { type: 'never' }, weekdays: [5] };
    expect(JSON.parse(await page.getByTestId('date-result').innerText())).toEqual({ date: '2026-10-16', time: null, repeat: rule });

    // "Stop repeating" removes the rule and keeps the day.
    await page.getByTestId('open-date').click();
    await picker.getByRole('button', { name: 'Stop repeating' }).click();
    await expect(picker.getByRole('button', { name: 'Repeat' })).toBeVisible();
    await picker.getByRole('button', { name: 'Done' }).click();
    expect(JSON.parse(await page.getByTestId('date-result').innerText())).toEqual({ date: '2026-10-16', time: null, repeat: null });
  });

  test('a picker with no time and no repeat, and a first day', async ({ page }) => {
    await page.getByTestId('open-plain-date').click();
    const picker = page.getByRole('dialog', { name: 'Start date' });
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('combobox')).toHaveCount(0);
    await expect(picker.getByRole('button', { name: 'Repeat' })).toHaveCount(0);
    await expect(day(picker, '2026-10-08')).toHaveClass(/chosen/);
    // A press on a day before the first day does nothing. The press is forced, because the test
    // tool does not press a disabled control. It then also does not wait for the open animation.
    await page.waitForTimeout(350);
    await day(picker, '2026-10-05').click({ force: true });
    await expect(day(picker, '2026-10-08')).toHaveClass(/chosen/);
    await day(picker, TODAY).click();
    await picker.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('date-result')).toHaveText(JSON.stringify({ date: TODAY, time: null, repeat: null }));
  });

  test('the deadline picker', async ({ page }) => {
    await page.getByTestId('open-deadline').click();
    const picker = page.getByRole('dialog', { name: 'Deadline' });
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('button', { name: 'Done' })).toBeDisabled();
    // A day of the next month that shows in this month.
    await day(picker, '2026-11-03').click();
    await expect(picker.getByText('November 2026')).toBeVisible();
    await picker.getByRole('button', { name: 'Done' }).click();
    await expect(picker).toHaveCount(0);
    await expect(page.getByTestId('deadline-result')).toHaveText('2026-11-03');

    await page.getByTestId('open-deadline').click();
    await expect(day(picker, '2026-11-03')).toHaveClass(/chosen/);
    await picker.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('deadline-result')).toHaveText('cancelled');
  });
});

test.describe('repeat dialog', () => {
  const never = { type: 'never' };

  async function open(page: Page): Promise<Locator> {
    await page.getByTestId('open-repeat').click();
    const dialog = page.getByRole('dialog', { name: 'Repeat' });
    await expect(dialog).toBeVisible();
    return dialog;
  }

  async function result(page: Page, dialog: Locator): Promise<unknown> {
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);
    return JSON.parse(await page.getByTestId('repeat-result').innerText());
  }

  test('the default is each week on the weekday of today', async ({ page }) => {
    const dialog = await open(page);
    await expect(dialog.getByRole('spinbutton', { name: 'Interval' })).toHaveValue('1');
    await expect(dialog.getByRole('button', { name: 'Tuesday' })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByRole('button', { name: 'Monday' })).toHaveAttribute('aria-pressed', 'false');
    await expect(dialog.getByRole('radio', { name: 'Never' })).toBeChecked();
    await expect(dialog.getByRole('spinbutton', { name: 'Number of occurrences' })).toHaveValue('30');
    expect(await result(page, dialog)).toEqual({ rule: { every: 1, unit: 'week', weekdays: [2], start: TODAY, end: never }, time: null });
  });

  test('day: each 3 days, 5 times', async ({ page }) => {
    const dialog = await open(page);
    await dialog.getByRole('spinbutton', { name: 'Interval' }).fill('3');
    await choose(page, { select: /^Unit/, option: 'days' });
    await expect(dialog.getByRole('button', { name: 'Tuesday' })).toHaveCount(0);
    await dialog.getByRole('spinbutton', { name: 'Number of occurrences' }).fill('5');
    await expect(dialog.getByRole('radio', { name: 'After' })).toBeChecked();
    expect(await result(page, dialog)).toEqual({ rule: { every: 3, unit: 'day', start: TODAY, end: { type: 'after', count: 5 } }, time: null });
  });

  test('week: each 2 weeks on Monday and Friday, with a time', async ({ page }) => {
    const dialog = await open(page);
    await dialog.getByRole('spinbutton', { name: 'Interval' }).fill('2');
    const done = dialog.getByRole('button', { name: 'Done' });
    await dialog.getByRole('button', { name: 'Tuesday' }).click();
    // A week rule needs one weekday or more.
    await expect(done).toBeDisabled();
    await dialog.getByRole('button', { name: 'Friday' }).click();
    await dialog.getByRole('button', { name: 'Monday' }).click();
    await expect(done).toBeEnabled();
    const time = dialog.getByRole('combobox', { name: 'Time' });
    await time.fill('7:15');
    await page.keyboard.press('Enter');
    await expect(time).toHaveValue('07:15');
    expect(await result(page, dialog)).toEqual({ rule: { every: 2, unit: 'week', weekdays: [1, 5], start: TODAY, end: never }, time: '07:15' });

    // The dialog opens again with the rule.
    const again = await open(page);
    await expect(again.getByRole('spinbutton', { name: 'Interval' })).toHaveValue('2');
    await expect(again.getByRole('button', { name: /^Unit: weeks/ })).toBeVisible();
    await expect(again.getByRole('button', { name: 'Friday' })).toHaveAttribute('aria-pressed', 'true');
    await expect(again.getByRole('button', { name: 'Tuesday' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('month: on a day, and on the last day', async ({ page }) => {
    let dialog = await open(page);
    await choose(page, { select: /^Unit/, option: 'month' });
    await expect(dialog.getByRole('radio', { name: 'On a day of the month' })).toBeChecked();
    await expect(dialog.getByRole('button', { name: 'Day: Day 6' })).toBeVisible();
    expect(await result(page, dialog)).toEqual({ rule: { every: 1, unit: 'month', monthMode: 'day', monthDay: 6, start: TODAY, end: never }, time: null });

    dialog = await open(page);
    await choose(page, { select: /^Day:/, option: 'Last day' });
    expect(await result(page, dialog)).toEqual({ rule: { every: 1, unit: 'month', monthMode: 'day', monthDay: -1, start: TODAY, end: never }, time: null });
  });

  test('month: on a weekday of the month', async ({ page }) => {
    const dialog = await open(page);
    await choose(page, { select: /^Unit/, option: 'month' });
    // 6 October 2026 is the first Tuesday of the month.
    await expect(dialog.getByRole('button', { name: 'Week: First' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Weekday: Tuesday' })).toBeVisible();
    await dialog.getByRole('radio', { name: 'On a weekday of the month' }).check();
    expect(await result(page, dialog)).toEqual({
      rule: { every: 1, unit: 'month', monthMode: 'weekday', ordinal: 1, weekday: 2, start: TODAY, end: never },
      time: null,
    });

    const again = await open(page);
    await choose(page, { select: /^Week:/, option: 'Last' });
    await choose(page, { select: /^Weekday:/, option: 'Friday' });
    expect(await result(page, again)).toEqual({
      rule: { every: 1, unit: 'month', monthMode: 'weekday', ordinal: -1, weekday: 5, start: TODAY, end: never },
      time: null,
    });
  });

  test('year, with an end date', async ({ page }) => {
    const dialog = await open(page);
    await choose(page, { select: /^Unit/, option: 'year' });
    // The button of the end date sets "On" and opens a month grid.
    await dialog.getByRole('button', { name: 'Fri 6 Nov' }).click();
    const end = page.getByRole('dialog', { name: 'End date' });
    await expect(end).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'On', exact: true })).toBeChecked();
    await day(end, '2026-11-20').click();
    await end.getByRole('button', { name: 'Done' }).click();
    await expect(end).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Fri 20 Nov' })).toBeVisible();
    expect(await result(page, dialog)).toEqual({ rule: { every: 1, unit: 'year', start: TODAY, end: { type: 'on', date: '2026-11-20' } }, time: null });
  });

  test('the start date is not in the past, and the weekday goes with it', async ({ page }) => {
    const dialog = await open(page);
    await dialog.getByRole('button', { name: 'Tue 6 Oct' }).click();
    const start = page.getByRole('dialog', { name: 'Start date' });
    await expect(start).toBeVisible();
    await expect(day(start, '2026-10-05')).toHaveAttribute('aria-disabled', 'true');
    await page.waitForTimeout(350);
    await day(start, '2026-10-05').click({ force: true });
    await expect(day(start, TODAY)).toHaveClass(/chosen/);
    await day(start, '2026-10-09').click();
    await start.getByRole('button', { name: 'Done' }).click();
    await expect(dialog.getByRole('button', { name: 'Fri 9 Oct' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Friday' })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByRole('button', { name: 'Tuesday' })).toHaveAttribute('aria-pressed', 'false');
    expect(await result(page, dialog)).toEqual({ rule: { every: 1, unit: 'week', weekdays: [5], start: '2026-10-09', end: never }, time: null });
  });

  test('a rule that is not valid cannot be saved, and Cancel changes nothing', async ({ page }) => {
    const dialog = await open(page);
    const done = dialog.getByRole('button', { name: 'Done' });
    const every = dialog.getByRole('spinbutton', { name: 'Interval' });
    await every.fill('0');
    await expect(done).toBeDisabled();
    await every.fill('1001');
    await expect(done).toBeDisabled();
    await every.fill('');
    await expect(done).toBeDisabled();
    await every.fill('1000');
    await expect(done).toBeEnabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('repeat-result')).toHaveText('cancelled');
  });
});

test('the text prompt', async ({ page }) => {
  await page.getByTestId('open-prompt').click();
  const dialog = page.getByRole('dialog', { name: 'Create new list' });
  await expect(dialog).toBeVisible();
  const field = dialog.getByPlaceholder('Enter name');
  const done = dialog.getByRole('button', { name: 'Done' });
  await expect(field).toBeFocused();
  await expect(done).toBeDisabled();
  // Enter with no text does nothing. Spaces are not text.
  await page.keyboard.press('Enter');
  await field.fill('   ');
  await expect(done).toBeDisabled();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();

  await field.fill('  Books to read ');
  await expect(done).toBeEnabled();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('prompt-result')).toHaveText('Books to read');

  // The next open starts with an empty field.
  await page.getByTestId('open-prompt').click();
  await expect(field).toHaveValue('');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('prompt-result')).toHaveText('cancelled');

  // "Rename list" starts with the name, selected, so that typing replaces it.
  await page.getByTestId('open-rename').click();
  const rename = page.getByRole('dialog', { name: 'Rename list' });
  const name = rename.getByRole('textbox');
  await expect(name).toHaveValue('Groceries');
  await expect(name).toBeFocused();
  expect(await name.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([0, 9]);
  await page.keyboard.type('Food');
  await rename.getByRole('button', { name: 'Done' }).click();
  await expect(rename).toHaveCount(0);
  await expect(page.getByTestId('list-name')).toHaveText('Food');
});

test.describe('bottom sheet', () => {
  /** A finger through the DevTools protocol, so the gesture code of the browser runs as on a phone. */
  interface Point {
    x: number;
    y: number;
  }
  /** `pause` is the time between two steps of the movement, in ms. */
  interface Swipe {
    from: Point;
    to: Point;
    pause?: number;
  }

  async function finger(page: Page): Promise<(swipe: Swipe) => Promise<void>> {
    const cdp = await page.context().newCDPSession(page);
    const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: Point[]) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: 1 })) });
    return async ({ from, to, pause = 16 }) => {
      await send('touchStart', [from]);
      for (let i = 1; i <= 10; i++) {
        await send('touchMove', [{ x: from.x + ((to.x - from.x) * i) / 10, y: from.y + ((to.y - from.y) * i) / 10 }]);
        await page.waitForTimeout(pause);
      }
      await send('touchEnd', []);
    };
  }

  test('a drag down closes the sheet, and a short drag does not', async ({ page }) => {
    await page.getByTestId('open-sheet').click();
    const sheet = page.getByRole('dialog', { name: 'Move to list' });
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(300);
    const view = page.viewportSize()!;
    const s = await box(sheet);
    expect(Math.abs(s.y + s.height - view.height)).toBeLessThanOrEqual(1);
    // The sheet is not higher than the window, and its list scrolls.
    expect(s.y).toBeGreaterThanOrEqual(24);
    const grab = { x: s.x + s.width / 2, y: s.y + 10 };

    if (isPhone(page)) {
      const drag = await finger(page);
      // Slow and short: the sheet goes back.
      await drag({ from: grab, to: { x: grab.x, y: grab.y + 40 }, pause: 60 });
      await page.waitForTimeout(300);
      await expect(sheet).toBeVisible();
      expect(Math.abs((await box(sheet)).y - s.y)).toBeLessThanOrEqual(1);

      // A drag up in the list scrolls the list. Then a drag down scrolls it back and the sheet stays.
      const content = page.getByTestId('sheet-content').locator('..');
      const middle = { x: s.x + s.width / 2, y: s.y + s.height / 2 };
      await drag({ from: middle, to: { x: middle.x, y: middle.y - 200 } });
      await expect.poll(() => content.evaluate((el) => el.scrollTop)).toBeGreaterThan(50);
      await drag({ from: middle, to: { x: middle.x, y: middle.y + 100 } });
      await page.waitForTimeout(300);
      await expect(sheet).toBeVisible();
      expect(Math.abs((await box(sheet)).y - s.y)).toBeLessThanOrEqual(1);
      await content.evaluate((el) => (el.scrollTop = 0));

      // With the list at its top, a drag down in the list moves the sheet and closes it.
      await drag({ from: middle, to: { x: middle.x, y: middle.y + 320 } });
    } else {
      await page.mouse.move(grab.x, grab.y);
      await page.mouse.down();
      await page.mouse.move(grab.x, grab.y + 40, { steps: 4 });
      // The sheet follows the pointer.
      expect(Math.abs((await box(sheet)).y - (s.y + 40))).toBeLessThanOrEqual(2);
      await page.waitForTimeout(200);
      await page.mouse.up();
      await page.waitForTimeout(300);
      await expect(sheet).toBeVisible();
      expect(Math.abs((await box(sheet)).y - s.y)).toBeLessThanOrEqual(1);

      await page.mouse.move(grab.x, grab.y);
      await page.mouse.down();
      await page.mouse.move(grab.x, grab.y + 320, { steps: 8 });
      await page.mouse.up();
    }
    await expect(sheet).toHaveCount(0);
    await expect(page.getByTestId('overlay-result')).toHaveText('sheet closed');
    await expect(overlayCount(page)).toHaveText('0');
    await expect.poll(() => historyDepth(page)).toBe(0);
  });

  test('a press outside, Back, and a row close the sheet', async ({ page }) => {
    const sheet = page.getByRole('dialog', { name: 'Move to list' });
    await page.getByTestId('open-sheet').click();
    await expect(sheet).toBeVisible();
    await page.mouse.click(8, 8);
    await expect(sheet).toHaveCount(0);
    await expect(page.getByTestId('overlay-result')).toHaveText('sheet closed');

    await page.getByTestId('open-sheet').click();
    await expect(sheet).toBeVisible();
    await expect.poll(() => historyDepth(page)).toBe(1);
    await page.goBack();
    await expect(sheet).toHaveCount(0);

    await page.getByTestId('open-sheet').click();
    await sheet.getByRole('button', { name: 'List number 3', exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByTestId('overlay-result')).toHaveText('row 3');
  });

  test('the add sheet puts the focus in its field', async ({ page }) => {
    await page.getByTestId('open-add').click();
    const sheet = page.getByRole('dialog', { name: 'New task' });
    await expect(sheet).toBeVisible();
    const title = sheet.getByPlaceholder('New task');
    await expect(title).toBeFocused();
    const save = sheet.getByRole('button', { name: 'Save' });
    await expect(save).toBeDisabled();
    await title.fill('Buy bread');
    await expect(save).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(page.getByTestId('open-add')).toBeFocused();
  });
});

test.describe('small parts', () => {
  test('a tooltip shows for a mouse after a delay', async ({ page }) => {
    test.skip(isPhone(page), 'A finger gets no tooltip');
    const tip = page.locator('.ui-tooltip.show');
    // In the middle of the window, the tooltip has room below the button.
    await page.getByTestId('tip-button').evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await page.getByTestId('tip-button').hover();
    await page.waitForTimeout(250);
    await expect(tip).toHaveCount(0);
    await expect(tip).toHaveText('Main menu');
    const button = await box(page.getByTestId('tip-button'));
    const t = await box(tip);
    expect(t.y).toBeGreaterThan(button.y + button.height);
    expect(Math.abs(t.x + t.width / 2 - (button.x + button.width / 2))).toBeLessThanOrEqual(1);
    await page.mouse.move(600, 5);
    await expect(tip).toHaveCount(0);
  });

  test('the task circle, the star, and the controls', async ({ page }) => {
    const row = page.getByTestId('task-t1');
    const circle = row.getByRole('checkbox', { name: 'Mark completed' });
    await circle.click();
    await expect(row.getByRole('checkbox', { name: 'Mark uncompleted' })).toHaveAttribute('aria-checked', 'true');
    await expect(row).toHaveClass(/done/);

    const star = row.getByRole('button', { name: 'Add to Starred' });
    await star.click();
    await expect(row.getByRole('button', { name: 'Remove from Starred' })).toHaveAttribute('aria-pressed', 'true');

    // A date before today is in the danger color.
    const danger = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--danger').trim());
    const late = page.getByTestId('task-t2').getByRole('button', { name: '3 days ago' });
    const toRgb = (hex: string): string => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
    expect(await late.evaluate((el) => getComputedStyle(el).color)).toBe(toRgb(danger));

    // A Select sets its value from a menu.
    await page.getByTestId('section-fields').getByRole('button', { name: /^List:/ }).click();
    await page.getByRole('menuitemradio', { name: 'Work' }).click();
    await expect(page.getByTestId('select-value')).toHaveText('work');

    // The segmented control moves with the arrow keys.
    const sort = page.getByRole('radiogroup', { name: 'Sort' });
    await sort.getByRole('radio', { name: 'My order' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(sort.getByRole('radio', { name: 'Date' })).toHaveAttribute('aria-checked', 'true');
    await expect(sort.getByRole('radio', { name: 'Date' })).toBeFocused();
  });

  test('the theme switch sets the colors', async ({ page }) => {
    const background = (): Promise<string> => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const theme = page.getByRole('radiogroup', { name: 'Theme' });
    await theme.getByRole('radio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await background()).toBe('rgb(17, 19, 24)');
    await theme.getByRole('radio', { name: 'Light' }).click();
    expect(await background()).toBe('rgb(246, 248, 252)');
    // With no forced theme, the setting of the system applies.
    await theme.getByRole('radio', { name: 'System' }).click();
    await expect(page.locator('html')).not.toHaveAttribute('data-theme');
    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await background()).toBe('rgb(17, 19, 24)');
    await page.emulateMedia({ colorScheme: 'light' });
    expect(await background()).toBe('rgb(246, 248, 252)');
  });

  test('the snackbar is at the bottom of the window', async ({ page }) => {
    await page.getByTestId('show-snackbar').click();
    const bar = page.getByRole('status').filter({ hasText: 'Task deleted (1)' });
    await expect(bar).toBeVisible();
    await page.waitForTimeout(250);
    const view = page.viewportSize()!;
    const b = await box(bar);
    if (isPhone(page)) {
      expect(b.x).toBe(12);
      expect(b.width).toBe(view.width - 24);
      // Above the place of the add button.
      expect(view.height - (b.y + b.height)).toBe(88);
    } else {
      expect(b.x).toBe(24);
      expect(view.height - (b.y + b.height)).toBe(24);
    }
    // A new message replaces the old one.
    await page.getByTestId('show-snackbar').click();
    await expect(page.getByRole('status').filter({ hasText: 'Task deleted (2)' })).toBeVisible();
    await expect(bar).toHaveCount(0);
    await page.getByRole('status').filter({ hasText: 'Task deleted (2)' }).getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Task deleted' })).toHaveCount(0);
  });
});
