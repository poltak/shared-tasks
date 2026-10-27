// Tests of the phone layout in the full app: the built client, the real server, touch input.
// Run: E2E_PORT=5122 E2E_WEB_DIR=<build folder> pnpm exec playwright test --config e2e/playwright.config.ts --project phone app.phone
//
// The seed data (server/seed.ts) for the first account:
//   My Tasks:  Plan the weekend trip (details), Call the dentist (today 16:30), Pay the electricity bill (3 days ago),
//              Send the tax documents (deadline in 5 days), Buy a birthday present (star),
//              Pack for the trip (subtasks: Passport, Phone charger)
//   Home:      Water the plants (today, daily), and 3 completed tasks
//   Groceries: Milk, Bread, Eggs, Coffee, Apples. Shared with the second account.

import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

interface Account {
  name: string;
  password: string;
}
const { users } = JSON.parse(readFileSync(new URL('../fixtures/users.json', import.meta.url), 'utf8')) as { users: Account[] };
const alex = users[0]!;

interface Point {
  x: number;
  y: number;
}

/** Longer than the hold of the drag engine (250 ms). The hold is real time. */
const HOLD_MS = 330;
/** The row stays for 300 ms after a press on its circle. */
const LEAVE_MS = 300;

// ---- Parts of the screen ----

const tabs = (page: Page): Locator => page.getByRole('tablist', { name: 'Lists' });
const tab = (page: Page, name: string): Locator => tabs(page).getByRole('tab', { name });
/** The page of one list. The pages next to the active one are in the DOM too, so each test names its page. */
const panel = (page: Page, name: string): Locator => page.getByRole('tabpanel', { name, exact: true });
const rows = (scope: Locator): Locator => scope.getByTestId('task-row');
const row = (scope: Locator, title: string): Locator => rows(scope).filter({ hasText: title });
const titles = (scope: Locator): Locator => rows(scope).locator('.title');
const completedRows = (scope: Locator): Locator => scope.getByTestId('completed-row');
const circle = (taskRow: Locator): Locator => taskRow.getByRole('checkbox');
const addButton = (page: Page): Locator => page.getByRole('button', { name: 'Add a task' });
const addSheet = (page: Page): Locator => page.getByRole('dialog', { name: 'New task' });
const addField = (page: Page): Locator => page.getByPlaceholder('New task');
const detail = (page: Page): Locator => page.getByRole('dialog', { name: 'Task details' });
const snackbar = (page: Page): Locator => page.locator('.snackbar');
/** An entry of the open menu, by its label. An entry is a `menuitem`, or a `menuitemradio` if it can have a check mark. */
const menuItem = (page: Page, name: string): Locator =>
  page.getByRole('menu').locator('[role^="menuitem"]', { has: page.locator('.label', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
const tabNames = (page: Page): Locator => tabs(page).locator('[role="tab"] .label');

async function signIn(page: Page, account: Account = alex): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Name', { exact: true }).fill(account.name);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(tab(page, 'My Tasks')).toBeVisible();
  await expect(rows(panel(page, 'My Tasks')).first()).toBeVisible();
}

/** Shows the page of a list, and waits until the pager is at rest. */
async function goToTab(page: Page, name: string): Promise<Locator> {
  await tab(page, name).click();
  await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
  const list = panel(page, name);
  await expect(list.getByRole('heading', { name, exact: true })).toBeInViewport({ ratio: 1 });
  return list;
}

async function openTask(scope: Locator, title: string): Promise<Locator> {
  await scope.getByRole('button', { name: title }).first().click();
  const screen = detail(scope.page());
  await expect(screen).toBeVisible();
  // The screen comes in from the right. A click during that time can miss.
  await scope.page().waitForTimeout(260);
  return screen;
}

async function closeDetail(page: Page): Promise<void> {
  await detail(page).getByRole('button', { name: 'Back' }).click();
  await expect(detail(page)).toHaveCount(0);
}

async function addTask(page: Page, title: string): Promise<void> {
  if ((await addSheet(page).count()) === 0) await addButton(page).click();
  await addField(page).fill(title);
  await addField(page).press('Enter');
}

/** Closes the add sheet with a tap on the page above it. */
async function closeAddSheet(page: Page): Promise<void> {
  await page.mouse.click(200, 80);
  await expect(addSheet(page)).toHaveCount(0);
}

/** The date of the browser, moved by a number of days, as the month grid names it. */
function dayOf(page: Page, offset: number): Promise<string> {
  return page.evaluate((days) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    const two = (n: number): string => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  }, offset);
}

/** Touch events through the DevTools protocol. They go through the gesture code of the browser, as a finger does. */
async function finger(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  let at: Point = { x: 0, y: 0 };
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: Point[]) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: 1 })) });
  const glide = async (to: Point, steps: number): Promise<void> => {
    const from = at;
    for (let i = 1; i <= steps; i++) {
      at = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
      await send('touchMove', [at]);
      await page.waitForTimeout(16);
    }
  };
  return {
    /** Touch and hold: the start of a drag. */
    async hold(p: Point): Promise<void> {
      at = p;
      await send('touchStart', [p]);
      await page.waitForTimeout(HOLD_MS);
    },
    move: (p: Point, steps = 8) => glide(p, steps),
    up: () => send('touchEnd', []),
    /** A quick movement with no hold: the gesture that scrolls. */
    async swipe(from: Point, to: Point): Promise<void> {
      at = from;
      await send('touchStart', [from]);
      await glide(to, 6);
      await send('touchEnd', []);
    },
  };
}

async function middle(locator: Locator): Promise<Point> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('The element is not on the screen');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** The Back action of the browser. The history entry of an overlay is made in the task after the overlay opens. */
async function goBack(page: Page): Promise<void> {
  await page.waitForTimeout(100);
  await page.goBack();
}

/** The engine removes its layer when the motion of a drop is over. */
async function dragSettled(page: Page): Promise<void> {
  await expect(page.locator('.dnd-layer')).toHaveCount(0);
}

/** A second phone with no local data: it shows what the server has for the account. */
async function freshDevice({ browser, baseURL, account = alex }: { browser: Browser; baseURL: string | undefined; account?: Account }): Promise<Page> {
  const context = await browser.newContext({ baseURL, viewport: { width: 412, height: 839 }, hasTouch: true, isMobile: true, locale: 'en-GB' });
  const page = await context.newPage();
  await signIn(page, account);
  return page;
}

test.beforeEach(async ({ request, page }) => {
  // Each test starts from the seed data.
  const reply = await request.post('/api/test/reset', { data: {} });
  expect(reply.ok()).toBe(true);
  await signIn(page);
});

test.describe('tabs and pages', () => {
  test('shows the bar, the tabs with their counts, and the first list', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Account and settings' })).toHaveText('A');
    await expect(tabNames(page)).toHaveText(['My Tasks', 'Home', 'Groceries']);
    await expect(tab(page, 'Starred')).toBeVisible();

    // The active tab has no count. The others show their open tasks, with the subtasks.
    await expect(tab(page, 'My Tasks')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(page, 'My Tasks').locator('.count')).toHaveCount(0);
    await expect(tab(page, 'Home').locator('.count')).toHaveText('1');
    await expect(tab(page, 'Groceries').locator('.count')).toHaveText('5');

    const list = panel(page, 'My Tasks');
    await expect(titles(list)).toHaveText([
      'Plan the weekend trip',
      'Call the dentist',
      'Pay the electricity bill',
      'Send the tax documents',
      'Buy a birthday present',
      'Pack for the trip',
      'Passport',
      'Phone charger',
    ]);
    await expect(row(list, 'Passport')).toHaveAttribute('data-dnd-depth', '1');
    await expect(row(list, 'Call the dentist')).toContainText('Today, 16:30');
    await expect(row(list, 'Pay the electricity bill')).toContainText('3 days ago');
    await expect(row(list, 'Send the tax documents')).toContainText('Due ');
    await expect(row(list, 'Plan the weekend trip')).toContainText('Check the train times');
  });

  test('a tap on a tab shows its page', async ({ page }) => {
    const home = await goToTab(page, 'Home');
    await expect(titles(home)).toHaveText(['Water the plants']);
    await expect(tab(page, 'Home').locator('.count')).toHaveCount(0);
    await expect(tab(page, 'My Tasks').locator('.count')).toHaveText('8');

    const groceries = await goToTab(page, 'Groceries');
    await expect(titles(groceries)).toHaveText(['Milk', 'Bread', 'Eggs', 'Coffee', 'Apples']);
    await expect(groceries.getByText('Shared with Sam')).toBeVisible();

    // A jump over more than one page.
    const starred = await goToTab(page, 'Starred');
    await expect(titles(starred)).toHaveText(['Buy a birthday present']);
  });

  test('a swipe changes the page, and the tab follows', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'The touch input of this test needs a CDP session, which only Chromium has');
    const touch = await finger(page);
    await touch.swipe({ x: 340, y: 520 }, { x: 60, y: 520 });
    await expect(tab(page, 'Home')).toHaveAttribute('aria-selected', 'true');
    await expect(panel(page, 'Home').getByRole('heading', { name: 'Home' })).toBeInViewport({ ratio: 1 });

    await touch.swipe({ x: 340, y: 520 }, { x: 60, y: 520 });
    await expect(tab(page, 'Groceries')).toHaveAttribute('aria-selected', 'true');
    await expect(panel(page, 'Groceries').getByRole('heading', { name: 'Groceries' })).toBeInViewport({ ratio: 1 });

    // The last page has no page after it.
    await touch.swipe({ x: 340, y: 520 }, { x: 60, y: 520 });
    await expect(tab(page, 'Groceries')).toHaveAttribute('aria-selected', 'true');

    await touch.swipe({ x: 60, y: 520 }, { x: 340, y: 520 });
    await expect(tab(page, 'Home')).toHaveAttribute('aria-selected', 'true');

    // A swipe up and down scrolls the page and keeps the tab.
    await touch.swipe({ x: 200, y: 600 }, { x: 210, y: 300 });
    await expect(tab(page, 'Home')).toHaveAttribute('aria-selected', 'true');
  });

  test('the address can ask for the add sheet, a list, or a task', async ({ page }) => {
    const groceries = await goToTab(page, 'Groceries');
    const listId = await groceries.locator('[data-print-list]').getAttribute('data-print-list');
    const taskId = await row(groceries, 'Eggs').getAttribute('data-dnd-id');
    await goToTab(page, 'My Tasks');

    await page.goto('/?new=1');
    await expect(addSheet(page)).toBeVisible();
    await expect(page).toHaveURL(/\/$/);

    await page.goto(`/?list=${listId}`);
    await expect(tab(page, 'Groceries')).toHaveAttribute('aria-selected', 'true');
    await expect(panel(page, 'Groceries').getByRole('heading', { name: 'Groceries' })).toBeInViewport({ ratio: 1 });
    await goToTab(page, 'My Tasks');

    // A notification opens the app at its task.
    await page.goto(`/?task=${taskId}`);
    await expect(detail(page).getByLabel('Title')).toHaveValue('Eggs');
    await closeDetail(page);
    await expect(tab(page, 'Groceries')).toHaveAttribute('aria-selected', 'true');
    await expect(row(panel(page, 'Groceries'), 'Eggs')).toBeInViewport();
  });

  test('the account button opens Settings', async ({ page }) => {
    await page.getByRole('button', { name: 'Account and settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await goBack(page);
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
  });
});

test.describe('add', () => {
  test('the sheet adds several tasks at the top and stays open', async ({ page }) => {
    const list = panel(page, 'My Tasks');
    await addButton(page).click();
    await expect(addSheet(page)).toBeVisible();
    await expect(addField(page)).toBeFocused();
    const save = addSheet(page).getByRole('button', { name: 'Save' });
    await expect(save).toBeDisabled();

    await addField(page).fill('Buy stamps');
    await addField(page).press('Enter');
    await expect(titles(list).first()).toHaveText('Buy stamps');
    await expect(addField(page)).toHaveValue('');
    await expect(addField(page)).toBeFocused();
    await expect(addSheet(page)).toBeVisible();

    await addField(page).fill('   ');
    await expect(save).toBeDisabled();
    await addField(page).fill('Book the hotel');
    await save.click();
    await expect(titles(list).first()).toHaveText('Book the hotel');
    await expect(addField(page)).toBeFocused();

    await addField(page).fill('Write to Anna');
    await addField(page).press('Enter');
    await expect(titles(list)).toHaveText([/Write to Anna/, /Book the hotel/, /Buy stamps/, /Plan the weekend trip/, /./, /./, /./, /./, /./, /./, /./]);

    await closeAddSheet(page);
    await expect(tab(page, 'Home').locator('.count')).toHaveText('1');
  });

  test('the sheet takes details, a date, and a star', async ({ page }) => {
    const list = panel(page, 'My Tasks');
    await addButton(page).click();
    await addField(page).fill('Renew the passport');
    await addSheet(page).getByRole('button', { name: 'Add details' }).click();
    await addSheet(page).getByLabel('Details', { exact: true }).fill('Bring two photos');
    await addSheet(page).getByRole('button', { name: 'Add date/time' }).click();

    const picker = page.getByRole('dialog', { name: 'Date and time' });
    await picker.locator(`[data-date="${await dayOf(page, 1)}"]`).click();
    await picker.getByRole('button', { name: 'Done' }).click();
    await expect(picker).toHaveCount(0);
    await expect(addSheet(page)).toContainText('Tomorrow');

    await addSheet(page).getByRole('button', { name: 'Add to Starred' }).click();
    await addSheet(page).getByRole('button', { name: 'Save' }).click();

    const added = row(list, 'Renew the passport');
    await expect(added).toContainText('Bring two photos');
    await expect(added).toContainText('Tomorrow');
    await expect(added.getByRole('button', { name: 'Remove from Starred' })).toBeVisible();
    // The sheet is empty for the next task.
    await expect(addField(page)).toHaveValue('');
    await expect(addSheet(page)).not.toContainText('Tomorrow');
  });

  test('on the star tab the sheet has a list selector and the task gets a star', async ({ page }) => {
    const starred = await goToTab(page, 'Starred');
    await addButton(page).click();
    await addSheet(page).getByRole('button', { name: 'List: My Tasks' }).click();
    await menuItem(page, 'Home').click();
    await expect(addSheet(page).getByRole('button', { name: 'List: Home' })).toBeVisible();
    await addField(page).fill('Paint the fence');
    await addField(page).press('Enter');

    await expect(titles(starred)).toHaveText(['Buy a birthday present', 'Paint the fence']);
    await expect(row(starred, 'Paint the fence')).toContainText('Home');
    await closeAddSheet(page);
    const home = await goToTab(page, 'Home');
    await expect(titles(home)).toHaveText(['Paint the fence', 'Water the plants']);
  });
});

test.describe('task detail', () => {
  test('edits of the title and the details save while the person types', async ({ page }) => {
    const list = panel(page, 'My Tasks');
    const screen = await openTask(list, 'Plan the weekend trip');
    await expect(screen.getByLabel('Title')).toHaveValue('Plan the weekend trip');
    await expect(screen.getByLabel('Details', { exact: true })).toHaveValue('Check the train times and book a table for dinner.');

    await screen.getByLabel('Title').fill('Plan the summer trip  ');
    await screen.getByLabel('Details', { exact: true }).fill('Ask Sam about the dates');
    // The list below has the new text before the screen closes.
    await expect(titles(list).first()).toHaveText(/Plan the summer trip/);

    await closeDetail(page);
    await expect(titles(list).first()).toHaveText('Plan the summer trip');
    await expect(row(list, 'Plan the summer trip')).toContainText('Ask Sam about the dates');
  });

  test('an empty title keeps the old title', async ({ page }) => {
    const list = panel(page, 'My Tasks');
    const screen = await openTask(list, 'Call the dentist');
    await screen.getByLabel('Title').fill('');
    await closeDetail(page);
    await expect(row(list, 'Call the dentist')).toBeVisible();
  });

  test('"Mark completed" closes the screen and completes the task', async ({ page }) => {
    const list = panel(page, 'My Tasks');
    const screen = await openTask(list, 'Send the tax documents');
    await screen.getByRole('button', { name: 'Mark completed' }).click();
    await expect(detail(page)).toHaveCount(0);
    await expect(row(list, 'Send the tax documents')).toHaveCount(0);
    await expect(snackbar(page)).toContainText('Task completed');
    await expect(list.getByRole('button', { name: 'Completed (1)' })).toBeVisible();
  });

  test('"Delete" in the menu deletes the task, and "Undo" brings it back', async ({ page }) => {
    const list = panel(page, 'My Tasks');
    const screen = await openTask(list, 'Call the dentist');
    await screen.getByRole('button', { name: 'Task options' }).click();
    await menuItem(page, 'Delete').click();
    await expect(detail(page)).toHaveCount(0);
    await expect(row(list, 'Call the dentist')).toHaveCount(0);
    await expect(snackbar(page)).toContainText('Task deleted');

    await snackbar(page).getByRole('button', { name: 'Undo' }).click();
    await expect(titles(list)).toHaveText([/Plan the weekend trip/, /Call the dentist/, /./, /./, /./, /./, /./, /./]);
    await expect(row(list, 'Call the dentist')).toContainText('Today, 16:30');
  });

  test('the star of the screen sets the star of the task', async ({ page }) => {
    const list = panel(page, 'My Tasks');
    const screen = await openTask(list, 'Call the dentist');
    await screen.getByRole('button', { name: 'Add to Starred' }).click();
    await expect(screen.getByRole('button', { name: 'Remove from Starred' })).toBeVisible();
    await closeDetail(page);
    await expect(row(list, 'Call the dentist').getByRole('button', { name: 'Remove from Starred' })).toBeVisible();
  });

  test('the list selector moves the task to a different list', async ({ page }) => {
    const groceries = await goToTab(page, 'Groceries');
    const screen = await openTask(groceries, 'Milk');
    await screen.getByRole('button', { name: 'List: Groceries' }).click();
    await menuItem(page, 'Home').click();
    await expect(screen.getByRole('button', { name: 'List: Home' })).toBeVisible();
    await closeDetail(page);

    await expect(titles(groceries)).toHaveText(['Bread', 'Eggs', 'Coffee', 'Apples']);
    const home = await goToTab(page, 'Home');
    await expect(titles(home)).toHaveText(['Milk', 'Water the plants']);
  });

  test('subtasks: add with Enter, edit, complete, and delete', async ({ page }) => {
    const list = panel(page, 'My Tasks');
    const screen = await openTask(list, 'Pack for the trip');
    const fields = screen.getByLabel('Subtask', { exact: true });
    await expect(fields).toHaveCount(2);
    await expect(fields.nth(0)).toHaveValue('Passport');

    await screen.getByRole('button', { name: 'Add subtasks' }).click();
    const draft = screen.getByLabel('New subtask');
    await expect(draft).toBeFocused();
    await draft.fill('Sunglasses');
    await draft.press('Enter');
    // Enter adds the subtask, and the field is ready for the next one.
    await expect(draft).toBeFocused();
    await expect(draft).toHaveValue('');
    await draft.fill('Tickets');
    await draft.press('Enter');
    await draft.press('Enter');
    await expect(draft).toHaveCount(0);
    await expect(fields).toHaveCount(4);

    await fields.nth(0).fill('Passports');
    await fields.nth(0).blur();

    // The circle of "Phone charger" completes it.
    await screen.getByTestId('subtask').nth(1).getByRole('checkbox').click();
    await expect(screen.getByTestId('subtask-done')).toHaveText(['Phone charger']);
    await expect(fields).toHaveCount(3);

    // The X of "Tickets" deletes it.
    await screen.getByTestId('subtask').nth(2).getByRole('button', { name: 'Delete subtask' }).click();
    await expect(fields).toHaveCount(2);

    await closeDetail(page);
    await expect(titles(list)).toHaveText([/./, /./, /./, /./, /./, 'Pack for the trip', 'Passports', 'Sunglasses']);
    await expect(row(list, 'Sunglasses')).toHaveAttribute('data-dnd-depth', '1');

    // A subtask opens the same screen, with a way back to its parent and no subtasks of its own.
    const sub = await openTask(list, 'Sunglasses');
    await expect(sub.getByRole('button', { name: 'Add subtasks' })).toHaveCount(0);
    await expect(sub.getByRole('button', { name: 'Pack for the trip' })).toBeVisible();
  });
});

test.describe('complete', () => {
  test('the circle completes the task, and "Undo" brings it back', async ({ page }) => {
    const list = panel(page, 'My Tasks');
    const present = row(list, 'Buy a birthday present');
    await circle(present).click();
    // The row stays for a moment with its check mark.
    await expect(circle(present)).toHaveAttribute('aria-checked', 'true');
    await expect(present).toHaveCount(0);
    await expect(snackbar(page)).toContainText('Task completed');
    await expect(list.getByRole('button', { name: 'Completed (1)' })).toBeVisible();
    await expect(tab(page, 'Starred')).toBeVisible();

    await snackbar(page).getByRole('button', { name: 'Undo' }).click();
    await expect(titles(list)).toHaveText([/./, /./, /./, /./, 'Buy a birthday present', /./, /./, /./]);
    await expect(list.getByRole('button', { name: /Completed/ })).toHaveCount(0);
    await expect(snackbar(page)).toHaveCount(0);
  });

  test('a second press on the circle in time keeps the task open', async ({ page }) => {
    const list = panel(page, 'My Tasks');
    const present = row(list, 'Buy a birthday present');
    // Two Playwright presses can be more than LEAVE_MS apart on a busy machine. Both presses go in
    // one evaluate, with only microtasks between them, so the timer of the first press cannot fire first.
    const between = await circle(present).evaluate(async (button: HTMLElement) => {
      button.click();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      const checked = button.getAttribute('aria-checked');
      button.click();
      return checked;
    });
    // The first press showed the check mark before the second press took it back.
    expect(between).toBe('true');
    await page.waitForTimeout(LEAVE_MS + 200);
    await expect(present).toBeVisible();
    await expect(circle(present)).toHaveAttribute('aria-checked', 'false');
  });

  test('a parent completes its subtasks, and the last task gives "All done"', async ({ page }) => {
    const list = panel(page, 'My Tasks');
    await circle(row(list, 'Pack for the trip')).click();
    await expect(snackbar(page)).toContainText('3 tasks completed');
    await expect(rows(list)).toHaveCount(5);

    const groceries = await goToTab(page, 'Groceries');
    for (const title of ['Milk', 'Bread', 'Eggs', 'Coffee', 'Apples']) {
      await circle(row(groceries, title)).click();
      await expect(row(groceries, title)).toHaveCount(0);
    }
    await expect(groceries.getByText('All done')).toBeVisible();
    await expect(groceries.getByText('Every task in this list is complete')).toBeVisible();
    await expect(groceries.getByRole('button', { name: 'Completed (5)' })).toBeVisible();
  });

  test('the "Completed" card opens, and its check mark makes a task open again', async ({ page }) => {
    const home = await goToTab(page, 'Home');
    const card = home.getByRole('button', { name: 'Completed (3)' });
    await expect(card).toHaveAttribute('aria-expanded', 'false');
    await expect(completedRows(home)).toHaveCount(0);

    await card.click();
    await expect(card).toHaveAttribute('aria-expanded', 'true');
    await expect(completedRows(home).locator('.title')).toHaveText(['Fix the kitchen tap', 'Clean the windows', 'Take out the recycling']);
    await expect(completedRows(home).first()).toContainText('Completed: ');

    await completedRows(home).filter({ hasText: 'Clean the windows' }).getByRole('checkbox', { name: 'Mark uncompleted' }).click();
    await expect(snackbar(page)).toContainText('Task marked uncompleted');
    await expect(titles(home)).toHaveText(['Clean the windows', 'Water the plants']);
    await expect(home.getByRole('button', { name: 'Completed (2)' })).toBeVisible();

    // A completed task opens the same screen in its completed state.
    const screen = await openTask(home, 'Fix the kitchen tap');
    await expect(screen).toContainText('Completed: ');
    await screen.getByRole('button', { name: 'Mark uncompleted' }).click();
    await expect(detail(page)).toHaveCount(0);
    await expect(titles(home)).toHaveText(['Fix the kitchen tap', 'Clean the windows', 'Water the plants']);

    await home.getByRole('button', { name: 'Completed (1)' }).click();
    await expect(completedRows(home)).toHaveCount(0);
  });

  test('a repeating task comes back on its next date', async ({ page }) => {
    const home = await goToTab(page, 'Home');
    await expect(row(home, 'Water the plants')).toContainText('Today');
    await circle(row(home, 'Water the plants')).click();
    await expect(snackbar(page)).toContainText('Task completed. It comes back on');
    await expect(home.getByText('Nothing here yet')).toHaveCount(0);
    await expect(home.getByText('All done')).toBeVisible();

    await home.getByRole('button', { name: 'Completed (4)' }).click();
    const resting = completedRows(home).filter({ hasText: 'Water the plants' });
    await expect(resting).toContainText('Next: Tomorrow');
  });
});

test.describe('dates', () => {
  test('a date and a time through the picker sheet', async ({ page }) => {
    const list = panel(page, 'My Tasks');
    const screen = await openTask(list, 'Plan the weekend trip');
    await screen.getByRole('button', { name: 'Add date/time' }).click();

    const picker = page.getByRole('dialog', { name: 'Date and time' });
    await expect(picker.getByRole('button', { name: 'Done' })).toBeDisabled();
    await picker.locator(`[data-date="${await dayOf(page, 1)}"]`).click();
    const time = picker.getByRole('combobox', { name: 'Time' });
    await time.fill('14:30');
    await time.press('Enter');
    await picker.getByRole('button', { name: 'Done' }).click();
    await expect(picker).toHaveCount(0);

    await expect(screen.getByRole('button', { name: 'Tomorrow, 14:30' })).toBeVisible();
    await expect(screen.getByRole('button', { name: 'Add date/time' })).toHaveCount(0);
    await closeDetail(page);
    await expect(row(list, 'Plan the weekend trip')).toContainText('Tomorrow, 14:30');

    // The chip of the row opens the picker too. The X of the chip in the screen removes the date.
    await row(list, 'Plan the weekend trip').getByRole('button', { name: 'Tomorrow, 14:30' }).click();
    await expect(picker).toBeVisible();
    await expect(detail(page)).toHaveCount(0);
    await picker.getByRole('button', { name: 'Cancel' }).click();
    const again = await openTask(list, 'Plan the weekend trip');
    await again.getByRole('button', { name: 'Remove date' }).click();
    await expect(again.getByRole('button', { name: 'Add date/time' })).toBeVisible();
  });

  test('a deadline', async ({ page }) => {
    const list = panel(page, 'My Tasks');
    const screen = await openTask(list, 'Buy a birthday present');
    await screen.getByRole('button', { name: 'Add deadline' }).click();
    const picker = page.getByRole('dialog', { name: 'Deadline' });
    await picker.locator(`[data-date="${await dayOf(page, 1)}"]`).click();
    await picker.getByRole('button', { name: 'Done' }).click();

    await expect(screen.getByRole('button', { name: 'Due tomorrow' })).toBeVisible();
    await closeDetail(page);
    await expect(row(list, 'Buy a birthday present')).toContainText('Due tomorrow');

    const again = await openTask(list, 'Buy a birthday present');
    await again.getByRole('button', { name: 'Remove deadline' }).click();
    await closeDetail(page);
    await expect(row(list, 'Buy a birthday present')).not.toContainText('Due');
  });

  test('a repeat rule, and "Stop repeating"', async ({ page }) => {
    const list = panel(page, 'My Tasks');
    const screen = await openTask(list, 'Call the dentist');
    await screen.getByRole('button', { name: 'Today, 16:30' }).click();

    const picker = page.getByRole('dialog', { name: 'Date and time' });
    await picker.getByRole('button', { name: 'Repeat', exact: true }).click();
    const repeat = page.getByRole('dialog', { name: 'Repeat' });
    await repeat.getByRole('button', { name: /^Unit:/ }).click();
    await menuItem(page, 'day').click();
    await repeat.getByRole('button', { name: 'Done' }).click();
    await expect(picker).toContainText('Daily');
    await picker.getByRole('button', { name: 'Done' }).click();
    // The dialogs of the picker are on the screen until their exit motion is over.
    await expect(repeat).toHaveCount(0);

    // The screen has a row for the rule. It opens the repeat dialog.
    const rule = screen.getByRole('button', { name: 'Repeats: Daily' });
    await expect(rule).toBeVisible();
    await rule.click();
    await expect(repeat).toBeVisible();
    await repeat.getByLabel('Interval').fill('2');
    await repeat.getByRole('button', { name: 'Done' }).click();
    await expect(screen.getByRole('button', { name: 'Repeats: Every 2 days' })).toBeVisible();

    await screen.getByRole('button', { name: 'Stop repeating' }).click();
    await page.getByRole('dialog', { name: 'Stop repeating?' }).getByRole('button', { name: 'Stop repeating' }).click();
    await expect(screen.getByRole('button', { name: /^Repeats/ })).toHaveCount(0);
    // The task keeps its date.
    await expect(screen.getByRole('button', { name: 'Today, 16:30' })).toBeVisible();
  });
});

test.describe('star and sort', () => {
  test('a star puts the task on the Starred page', async ({ page }) => {
    const list = panel(page, 'My Tasks');
    await row(list, 'Call the dentist').getByRole('button', { name: 'Add to Starred' }).click();
    await expect(row(list, 'Call the dentist').getByRole('button', { name: 'Remove from Starred' })).toBeVisible();

    const starred = await goToTab(page, 'Starred');
    // The date sort has groups.
    await expect(starred.locator('.heading')).toHaveText(['Today', 'No date']);
    await expect(titles(starred)).toHaveText(['Call the dentist', 'Buy a birthday present']);
    await expect(row(starred, 'Call the dentist')).toContainText('My Tasks');

    await starred.getByRole('button', { name: 'Sort' }).click();
    await expect(menuItem(page, 'Date')).toHaveAttribute('aria-checked', 'true');
    await menuItem(page, 'Recently starred').click();
    await expect(starred.locator('.heading')).toHaveCount(0);
    await expect(titles(starred)).toHaveText(['Call the dentist', 'Buy a birthday present']);

    // No star: the row leaves the page.
    await row(starred, 'Call the dentist').getByRole('button', { name: 'Remove from Starred' }).click();
    await row(starred, 'Buy a birthday present').getByRole('button', { name: 'Remove from Starred' }).click();
    await expect(starred.getByText('No starred tasks')).toBeVisible();
  });

  test('the sort button changes the order of a list', async ({ page }) => {
    const groceries = await goToTab(page, 'Groceries');
    await groceries.getByRole('button', { name: 'Sort' }).click();
    await expect(menuItem(page, 'My order')).toHaveAttribute('aria-checked', 'true');
    await menuItem(page, 'Title').click();
    await expect(titles(groceries)).toHaveText(['Apples', 'Bread', 'Coffee', 'Eggs', 'Milk']);

    const list = await goToTab(page, 'My Tasks');
    await list.getByRole('button', { name: 'Sort' }).click();
    await menuItem(page, 'Date').click();
    await expect(list.locator('.heading')).toHaveText(['Past', 'Today', 'No date']);
    await expect(titles(list).first()).toHaveText('Pay the electricity bill');
    // The heading gives the date, so the chip shows only the time. A task in "Past" keeps its chip.
    await expect(row(list, 'Call the dentist')).toContainText('16:30');
    await expect(row(list, 'Call the dentist')).not.toContainText('Today');
    await expect(row(list, 'Pay the electricity bill')).toContainText('3 days ago');

    // The list menu has the same choices.
    await list.getByRole('button', { name: 'List options' }).click();
    await expect(menuItem(page, 'Date')).toHaveAttribute('aria-checked', 'true');
    await menuItem(page, 'Deadline').click();
    await expect(list.locator('.heading').last()).toHaveText('No deadline');
    await expect(titles(list).first()).toHaveText('Send the tax documents');

    await list.getByRole('button', { name: 'Sort' }).click();
    await menuItem(page, 'Starred recently').click();
    await expect(titles(list).first()).toHaveText('Buy a birthday present');
  });
});

test.describe('lists', () => {
  test('create, rename, and delete a list', async ({ page }) => {
    await tabs(page).getByRole('button', { name: 'New list' }).click();
    const create = page.getByRole('dialog', { name: 'Create new list' });
    await create.getByRole('textbox').fill('Garden');
    await create.getByRole('button', { name: 'Done' }).click();

    await expect(tabNames(page)).toHaveText(['My Tasks', 'Home', 'Groceries', 'Garden']);
    await expect(tab(page, 'Garden')).toHaveAttribute('aria-selected', 'true');
    const garden = panel(page, 'Garden');
    await expect(garden.getByRole('heading', { name: 'Garden' })).toBeInViewport({ ratio: 1 });
    await expect(garden.getByText('Nothing here yet')).toBeVisible();
    await expect(garden.getByText('Add a task to get started')).toBeVisible();

    await addTask(page, 'Cut the grass');
    await closeAddSheet(page);
    await expect(titles(garden)).toHaveText(['Cut the grass']);

    await garden.getByRole('button', { name: 'List options' }).click();
    await menuItem(page, 'Rename list').click();
    const rename = page.getByRole('dialog', { name: 'Rename list' });
    await rename.getByRole('textbox').fill('Garden work');
    await rename.getByRole('button', { name: 'Done' }).click();
    await expect(tabNames(page)).toHaveText(['My Tasks', 'Home', 'Groceries', 'Garden work']);
    const renamed = panel(page, 'Garden work');
    await expect(renamed.getByRole('heading', { name: 'Garden work' })).toBeVisible();

    await renamed.getByRole('button', { name: 'List options' }).click();
    await menuItem(page, 'Delete list').click();
    await page.getByRole('dialog', { name: 'Delete this list?' }).getByRole('button', { name: 'Delete' }).click();
    await expect(tabNames(page)).toHaveText(['My Tasks', 'Home', 'Groceries']);
    await expect(snackbar(page)).toContainText('List deleted');
    // The tab at the same place becomes active.
    await expect(tab(page, 'Groceries')).toHaveAttribute('aria-selected', 'true');
    await expect(panel(page, 'Groceries').getByRole('heading', { name: 'Groceries' })).toBeInViewport({ ratio: 1 });
  });

  test('the default list cannot be deleted', async ({ page }) => {
    await panel(page, 'My Tasks').getByRole('button', { name: 'List options' }).click();
    const item = page.getByRole('menu').getByRole('menuitem', { name: /Delete list/ });
    await expect(item).toHaveAttribute('aria-disabled', 'true');
    await expect(item).toContainText("The default list can't be deleted");
  });

  test('"Move list left" changes the order and keeps the list on the screen', async ({ page }) => {
    const groceries = await goToTab(page, 'Groceries');
    await groceries.getByRole('button', { name: 'List options' }).click();
    await expect(menuItem(page, 'Move list right')).toHaveAttribute('aria-disabled', 'true');
    await menuItem(page, 'Move list left').click();

    await expect(tabNames(page)).toHaveText(['My Tasks', 'Groceries', 'Home']);
    await expect(tab(page, 'Groceries')).toHaveAttribute('aria-selected', 'true');
    await expect(groceries.getByRole('heading', { name: 'Groceries' })).toBeInViewport({ ratio: 1 });
    await expect(titles(groceries)).toHaveText(['Milk', 'Bread', 'Eggs', 'Coffee', 'Apples']);

    await groceries.getByRole('button', { name: 'List options' }).click();
    await menuItem(page, 'Move list right').click();
    await expect(tabNames(page)).toHaveText(['My Tasks', 'Home', 'Groceries']);
  });

  test('"Delete all completed tasks" asks first', async ({ page }) => {
    const home = await goToTab(page, 'Home');
    await home.getByRole('button', { name: 'List options' }).click();
    await menuItem(page, 'Delete all completed tasks').click();
    await page.getByRole('dialog', { name: 'Delete all completed tasks?' }).getByRole('button', { name: 'Delete' }).click();
    await expect(home.getByRole('button', { name: /Completed/ })).toHaveCount(0);
    await expect(snackbar(page)).toContainText('3 completed tasks deleted');
  });
});

test.describe('drag', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'The touch input of these tests needs a CDP session, which only Chromium has');

  test('touch and hold moves a row to a new place', async ({ page }) => {
    const groceries = await goToTab(page, 'Groceries');
    const touch = await finger(page);
    const from = await middle(row(groceries, 'Milk').locator('.title'));
    const eggs = await middle(row(groceries, 'Eggs'));

    await touch.hold(from);
    await expect(page.locator('.dnd-layer')).toHaveCount(1);
    await touch.move({ x: from.x, y: eggs.y + 14 }, 10);
    await touch.up();
    await dragSettled(page);
    await expect(titles(groceries)).toHaveText(['Bread', 'Eggs', 'Milk', 'Coffee', 'Apples']);
    // The drag did not change the page and did not open the task.
    await expect(tab(page, 'Groceries')).toHaveAttribute('aria-selected', 'true');
    await expect(detail(page)).toHaveCount(0);

    // Up again, to the first place.
    const milk = await middle(row(groceries, 'Milk').locator('.title'));
    const bread = await middle(row(groceries, 'Bread'));
    await touch.hold(milk);
    await touch.move({ x: milk.x, y: bread.y - 14 }, 10);
    await touch.up();
    await dragSettled(page);
    await expect(titles(groceries)).toHaveText(['Milk', 'Bread', 'Eggs', 'Coffee', 'Apples']);
  });

  test('a move to the right makes a subtask', async ({ page }) => {
    const groceries = await goToTab(page, 'Groceries');
    const touch = await finger(page);
    const from = await middle(row(groceries, 'Bread').locator('.title'));

    await touch.hold(from);
    await touch.move({ x: from.x + 48, y: from.y + 2 }, 8);
    await touch.up();
    await dragSettled(page);
    await expect(row(groceries, 'Bread')).toHaveAttribute('data-dnd-depth', '1');
    await expect(titles(groceries)).toHaveText(['Milk', 'Bread', 'Eggs', 'Coffee', 'Apples']);
    // The sideways move was a drag, not a swipe to the next page.
    await expect(tab(page, 'Groceries')).toHaveAttribute('aria-selected', 'true');

    const screen = await openTask(groceries, 'Milk');
    await expect(screen.getByLabel('Subtask', { exact: true })).toHaveValue('Bread');
  });

  test('a quick swipe on a row scrolls and does not drag', async ({ page }) => {
    const touch = await finger(page);
    const list = panel(page, 'My Tasks');
    const from = await middle(row(list, 'Call the dentist').locator('.title'));
    await touch.swipe(from, { x: from.x - 260, y: from.y + 4 });
    await expect(tab(page, 'Home')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.dnd-layer')).toHaveCount(0);
  });

  test('a list with a sort order has no drag', async ({ page }) => {
    const groceries = await goToTab(page, 'Groceries');
    await groceries.getByRole('button', { name: 'Sort' }).click();
    await menuItem(page, 'Title').click();
    await expect(titles(groceries).first()).toHaveText('Apples');

    const touch = await finger(page);
    const from = await middle(row(groceries, 'Apples').locator('.title'));
    await touch.hold(from);
    await expect(page.locator('.dnd-layer')).toHaveCount(0);
    await touch.move({ x: from.x, y: from.y + 120 }, 8);
    await touch.up();
    await expect(titles(groceries)).toHaveText(['Apples', 'Bread', 'Coffee', 'Eggs', 'Milk']);
  });

  test('touch and hold moves a tab', async ({ page }) => {
    const touch = await finger(page);
    const from = await middle(tab(page, 'Home'));
    const groceries = await tab(page, 'Groceries').boundingBox();

    await touch.hold(from);
    await expect(page.locator('.dnd-layer')).toHaveCount(1);
    await touch.move({ x: groceries!.x + groceries!.width - 6, y: from.y }, 10);
    await touch.up();
    await dragSettled(page);
    await expect(tabNames(page)).toHaveText(['My Tasks', 'Groceries', 'Home']);
    // The page on the screen is the same list as before.
    await expect(tab(page, 'My Tasks')).toHaveAttribute('aria-selected', 'true');
    await expect(panel(page, 'My Tasks').getByRole('heading', { name: 'My Tasks' })).toBeInViewport({ ratio: 1 });
  });
});

test.describe('two people', () => {
  test('a shared list shows the changes of the other person', async ({ page, browser, baseURL }) => {
    const sam = await freshDevice({ browser, baseURL, account: users[1]! });
    // The second person sees the shared list, and not the other lists of the first person.
    await expect(tabNames(sam)).toHaveText(['My Tasks', 'Groceries']);
    const theirs = await goToTab(sam, 'Groceries');
    await expect(theirs.getByText('Shared by Alex')).toBeVisible();
    await expect(titles(theirs)).toHaveText(['Milk', 'Bread', 'Eggs', 'Coffee', 'Apples']);

    const mine = await goToTab(page, 'Groceries');
    await addTask(page, 'Oranges');
    await closeAddSheet(page);
    await expect(titles(theirs).first()).toHaveText('Oranges');

    await circle(row(theirs, 'Oranges')).click();
    await expect(row(mine, 'Oranges')).toHaveCount(0);
    await mine.getByRole('button', { name: 'Completed (1)' }).click();
    await expect(completedRows(mine).first()).toContainText('Sam');

    // The owner stops the sharing: the list goes away on the other phone.
    await mine.getByRole('button', { name: 'List options' }).click();
    await menuItem(page, 'Stop sharing').click();
    await expect(tabNames(sam)).toHaveText(['My Tasks']);
    await expect(tab(sam, 'My Tasks')).toHaveAttribute('aria-selected', 'true');
    await sam.context().close();
  });
});

test.describe('Back, reload, and no network', () => {
  test('the Back action of the browser closes the sheet, the menu, and the detail screen', async ({ page }) => {
    const list = panel(page, 'My Tasks');
    await addButton(page).click();
    await expect(addSheet(page)).toBeVisible();
    await goBack(page);
    await expect(addSheet(page)).toHaveCount(0);
    await expect(rows(list).first()).toBeVisible();

    const screen = await openTask(list, 'Call the dentist');
    await screen.getByRole('button', { name: 'Task options' }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await goBack(page);
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(screen).toBeVisible();
    await goBack(page);
    await expect(detail(page)).toHaveCount(0);
    await expect(rows(list).first()).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
  });

  test('a reload keeps the tasks, the tab, the sort order, and the open "Completed" card', async ({ page }) => {
    const home = await goToTab(page, 'Home');
    await addTask(page, 'Order new keys');
    await closeAddSheet(page);
    await row(home, 'Order new keys').getByRole('button', { name: 'Add to Starred' }).click();
    await home.getByRole('button', { name: 'Completed (3)' }).click();
    await home.getByRole('button', { name: 'Sort' }).click();
    await menuItem(page, 'Title').click();
    await expect(titles(home)).toHaveText(['Order new keys', 'Water the plants']);
    // The menu takes its history entry away when it closes. A reload at that moment is aborted.
    await expect(page.getByRole('menu')).toHaveCount(0);

    await page.reload();
    await expect(tab(page, 'Home')).toHaveAttribute('aria-selected', 'true');
    const again = panel(page, 'Home');
    await expect(again.getByRole('heading', { name: 'Home' })).toBeInViewport({ ratio: 1 });
    await expect(titles(again)).toHaveText(['Order new keys', 'Water the plants']);
    await expect(row(again, 'Order new keys').getByRole('button', { name: 'Remove from Starred' })).toBeVisible();
    await expect(completedRows(again)).toHaveCount(3);
    await again.getByRole('button', { name: 'Sort' }).click();
    await expect(menuItem(page, 'Title')).toHaveAttribute('aria-checked', 'true');
  });

  test('with no network a new task stays after a reload, and reaches the server later', async ({ page, context, browser, baseURL, browserName }) => {
    test.skip(browserName !== 'chromium', 'The WebKit of Playwright cannot reload a page from the service worker with the network off');
    // The reload with no network needs the service worker and its files.
    await page.evaluate(async () => void (await navigator.serviceWorker.ready));
    const list = panel(page, 'My Tasks');

    await context.setOffline(true);
    await addTask(page, 'Made with no network');
    await closeAddSheet(page);
    await circle(row(list, 'Buy a birthday present')).click();
    await expect(row(list, 'Buy a birthday present')).toHaveCount(0);
    await expect(page.getByTestId('sync-badge')).toBeVisible();

    await page.reload();
    const again = panel(page, 'My Tasks');
    await expect(titles(again).first()).toHaveText('Made with no network');
    await expect(row(again, 'Buy a birthday present')).toHaveCount(0);

    await context.setOffline(false);
    await expect(page.getByTestId('sync-badge')).toHaveCount(0);

    const other = await freshDevice({ browser, baseURL });
    const there = panel(other, 'My Tasks');
    await expect(titles(there).first()).toHaveText('Made with no network');
    await expect(row(there, 'Buy a birthday present')).toHaveCount(0);
    await other.context().close();
  });
});
