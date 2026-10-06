// Tests of the wide layout: the columns, the rows, edit in place, the menus, and the sidebar.
// Run: E2E_PORT=5121 E2E_WEB_DIR=<build folder> pnpm exec playwright test wide.desktop --config e2e/playwright.config.ts --project=desktop

import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

interface Account {
  name: string;
  password: string;
}
const { users } = JSON.parse(readFileSync(new URL('../fixtures/users.json', import.meta.url), 'utf8')) as { users: Account[] };
const alex = users[0]!;
const sam = users[1]!;

/** The seed data of the first account, as server/seed.ts writes it. */
const MY_TASKS = [
  'Plan the weekend trip',
  'Call the dentist',
  'Pay the electricity bill',
  'Send the tax documents',
  'Buy a birthday present',
  'Pack for the trip',
  'Passport',
  'Phone charger',
];
const GROCERIES = ['Milk', 'Bread', 'Eggs', 'Coffee', 'Apples'];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The local day of this machine, moved by a number of days. The server and the browser use the same clock. */
function day(offset: number): { iso: string; text: string } {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  const two = (n: number): string => String(n).padStart(2, '0');
  return {
    iso: `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`,
    text: `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`,
  };
}

async function signIn(page: Page, account: Account = alex): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Name').fill(account.name);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByTestId('app-ready')).toBeAttached();
  // The sign-in screen fades out above the app. The tests start when it is gone.
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
  await expect(column(page, 'My Tasks')).toBeVisible();
  // The same test as in web/src/common/shortcuts.ts.
  const mac = await page.evaluate(() =>
    /mac|iphone|ipad|ipod/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? ''),
  );
  MOD = mac ? 'Meta' : 'Control';
}

const columns = (page: Page): Locator => page.getByRole('main').getByRole('region');
const column = (page: Page, list: string): Locator => page.getByRole('main').getByRole('region', { name: list, exact: true });
const openList = (page: Page, list: string): Locator => column(page, list).getByRole('list', { name: 'Tasks', exact: true });
const doneList = (page: Page, list: string): Locator => column(page, list).getByRole('list', { name: 'Completed', exact: true });
const sidebar = (page: Page): Locator => page.locator('#wide-sidebar');
/** The name of the app in the bar. A click on it is a click outside of all rows. */
const appName = (page: Page): Locator => page.getByRole('heading', { name: 'Tasks', exact: true });
const snackbar = (page: Page): Locator => page.getByRole('status').filter({ hasText: /\S/ }).last();
const menu = (page: Page): Locator => page.getByRole('menu');
const titleField = (page: Page): Locator => page.getByRole('textbox', { name: 'Title', exact: true });
const detailsField = (page: Page): Locator => page.getByRole('textbox', { name: 'Details', exact: true });
/** Control, or Command if the browser tells the app that it is on a Mac. Set after the sign-in. */
let MOD: 'Control' | 'Meta' = 'Control';

/** The row of an open task. The row that is open for editing has no title button, so it is not found. */
function row(page: Page, list: string, title: string): Locator {
  return openList(page, list)
    .locator('[data-row-id]')
    .filter({ has: page.getByRole('button', { name: title, exact: true }) });
}

function doneRow(page: Page, list: string, title: string): Locator {
  return doneList(page, list).locator('[data-row-id]').filter({ hasText: title });
}

/** The titles of the open tasks of a column from top to bottom, with the text of the row that is open. */
function titles(page: Page, list: string): Promise<string[]> {
  return openList(page, list)
    .locator('[data-row-id]')
    .evaluateAll((rows) =>
      rows.map((each) => each.querySelector<HTMLTextAreaElement>('textarea[aria-label="Title"]')?.value ?? each.querySelector('button.title')?.textContent ?? ''),
    );
}

const expectTitles = (page: Page, list: string, expected: string[]): Promise<void> => expect.poll(() => titles(page, list)).toEqual(expected);

/** The titles of all tasks that the server has for the signed-in account. The request is a sync with no changes. */
async function serverTitles(page: Page): Promise<string[]> {
  const reply = await page.request.post('/api/sync', { data: { clientId: '00000000-0000-4000-8000-000000000000', since: 0, ops: [], tz: 'UTC' } });
  if (!reply.ok()) return [];
  const body = (await reply.json()) as { tasks: { title: string }[] };
  return body.tasks.map((task) => task.title);
}

/** The indent of each open row: 0, or 1 for a subtask. */
function depths(page: Page, list: string): Promise<number[]> {
  return openList(page, list)
    .locator('[data-row-id]')
    .evaluateAll((rows) => rows.map((each) => Number(each.getAttribute('data-dnd-depth') ?? 0)));
}

function headings(page: Page, list: string): Promise<string[]> {
  return column(page, list).getByRole('heading', { level: 3 }).allInnerTexts();
}

/**
 * A reload, as a person does it: some time after the last click. A menu that closed takes its
 * entry out of the history of the browser in a later task, and a reload in that same moment is refused.
 */
async function reload(page: Page): Promise<void> {
  await page.waitForTimeout(150);
  await page.reload();
  await expect(page.getByTestId('app-ready')).toBeAttached();
}

async function open(page: Page, list: string, title: string): Promise<void> {
  await row(page, list, title).getByRole('button', { name: title, exact: true }).click();
  await expect(titleField(page)).toBeFocused();
}

async function taskMenu(page: Page, list: string, title: string): Promise<Locator> {
  const target = row(page, list, title);
  await target.hover();
  await target.getByRole('button', { name: 'Task options' }).click();
  await expect(menu(page)).toBeVisible();
  return menu(page);
}

async function listMenu(page: Page, list: string): Promise<Locator> {
  await column(page, list).getByRole('button', { name: 'List options' }).click();
  await expect(menu(page)).toBeVisible();
  return menu(page);
}

const item = (page: Page, name: string): Locator => menu(page).getByRole('menuitem', { name, exact: true });
const choice = (page: Page, name: string): Locator => menu(page).getByRole('menuitemradio', { name, exact: true });

async function sortBy(page: Page, list: string, name: string): Promise<void> {
  await listMenu(page, list);
  await choice(page, name).click();
  await expect(menu(page)).toHaveCount(0);
}

/** Selects the row with the keyboard keys of the app: a click on the title, then Esc. */
async function selectRow(page: Page, list: string, title: string): Promise<void> {
  await open(page, list, title);
  await page.keyboard.press('Escape');
  await expect(row(page, list, title)).toHaveClass(/selected/);
}

const selectedTitle = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.querySelector('[data-row-id].selected')?.querySelector('.title')?.textContent ?? null);

test.beforeEach(async ({ page, request }) => {
  // Each test starts from the seed data, with a new browser profile.
  const reply = await request.post('/api/test/reset', { data: {} });
  expect(reply.ok()).toBe(true);
  await signIn(page);
});

test.describe('layout', () => {
  test('shows the bar, the sidebar, and one column for each list', async ({ page }) => {
    await expect(appName(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Keyboard shortcuts' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Settings of Alex' })).toHaveText('A');

    await expect(sidebar(page).getByRole('button', { name: 'Create', exact: true })).toBeVisible();
    await expect(sidebar(page).getByRole('button', { name: 'All tasks' })).toHaveAttribute('aria-current', 'page');
    await expect(sidebar(page).getByRole('button', { name: 'Starred', exact: true })).toBeVisible();
    await expect(sidebar(page).getByRole('button', { name: 'Create new list' })).toBeVisible();
    // Each list has a check box and its number of open tasks.
    await expect(sidebar(page).getByRole('listitem')).toHaveText([/My Tasks\s*8/, /Home\s*1/, /Groceries\s*5/]);

    await expect(columns(page).locator('h2')).toHaveText(['My Tasks', 'Home', 'Groceries']);
    await expectTitles(page, 'My Tasks', MY_TASKS);
    expect(await depths(page, 'My Tasks')).toEqual([0, 0, 0, 0, 0, 0, 1, 1]);
    await expectTitles(page, 'Groceries', GROCERIES);
    // A column is 320 px wide, and a subtask is 28 px to the right.
    expect((await column(page, 'Home').boundingBox())!.width).toBe(320);
    const parent = (await row(page, 'My Tasks', 'Pack for the trip').boundingBox())!;
    const child = (await row(page, 'My Tasks', 'Passport').boundingBox())!;
    expect(child.x - parent.x).toBe(28);

    await expect(column(page, 'Home').getByRole('button', { name: 'Completed (3)' })).toHaveAttribute('aria-expanded', 'false');
    // The shared list tells with whom it is shared.
    await expect(column(page, 'Groceries').getByRole('img', { name: 'Shared with Sam' })).toBeVisible();
  });

  test('a row shows its details and its chips', async ({ page }) => {
    await expect(row(page, 'My Tasks', 'Plan the weekend trip')).toContainText('Check the train times and book a table for dinner.');
    await expect(row(page, 'My Tasks', 'Call the dentist')).toContainText('Today, 16:30');
    const late = row(page, 'My Tasks', 'Pay the electricity bill').locator('.chip');
    await expect(late).toHaveText('3 days ago');
    await expect(late).toHaveClass(/danger/);
    await expect(row(page, 'My Tasks', 'Send the tax documents')).toContainText(`Due ${day(5).text}`);
    await expect(row(page, 'My Tasks', 'Buy a birthday present').getByRole('button', { name: 'Remove from Starred' })).toBeVisible();
    // The star and the three-dot button of a row with no star show with the pointer.
    const plain = row(page, 'My Tasks', 'Call the dentist');
    await expect(plain.getByRole('button', { name: 'Add to Starred' })).toHaveCount(0);
    await plain.hover();
    await expect(plain.getByRole('button', { name: 'Add to Starred' })).toBeVisible();
    await expect(plain.getByRole('button', { name: 'Task options' })).toBeVisible();
  });

  test('the menu button hides and shows the sidebar, and a reload keeps the state', async ({ page }) => {
    const board = column(page, 'My Tasks');
    const before = (await board.boundingBox())!.x;
    await page.getByRole('button', { name: 'Hide the sidebar' }).click();
    await expect(sidebar(page)).toBeHidden();
    await expect.poll(async () => (await board.boundingBox())!.x).toBeLessThan(before - 200);
    await expect(page.getByRole('button', { name: 'Show the sidebar' })).toHaveAttribute('aria-expanded', 'false');

    await reload(page);
    await expect(column(page, 'My Tasks')).toBeVisible();
    await expect(sidebar(page)).toBeHidden();

    await page.getByRole('button', { name: 'Show the sidebar' }).click();
    await expect(sidebar(page)).toBeVisible();
    await expect.poll(async () => (await column(page, 'My Tasks').boundingBox())!.x).toBe(before);
  });

  test('the Lists heading closes and opens the lists', async ({ page }) => {
    const heading = sidebar(page).getByRole('button', { name: 'Lists' });
    await heading.click();
    await expect(heading).toHaveAttribute('aria-expanded', 'false');
    await expect(sidebar(page).getByRole('listitem')).toHaveCount(0);
    await heading.click();
    await expect(sidebar(page).getByRole('listitem')).toHaveCount(3);
  });

  test('the account button opens Settings and the help button opens the shortcut list', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings of Alex' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
    const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(help).toBeVisible();
    await expect(help.getByRole('row')).toHaveCount(17);
  });
});

test.describe('add and edit', () => {
  test('"Add a task" opens a row at the top, and Enter adds one task after the other', async ({ page }) => {
    await column(page, 'Groceries').getByRole('button', { name: 'Add a task' }).click();
    await expect(titleField(page)).toBeFocused();
    await expectTitles(page, 'Groceries', ['', ...GROCERIES]);
    // The open row has the details field, the date chips, the repeat button, and the handle.
    const draft = openList(page, 'Groceries').locator('[data-row-id]').first();
    await expect(detailsField(page)).toBeVisible();
    await expect(draft.getByRole('button', { name: 'Today', exact: true })).toBeVisible();
    await expect(draft.getByRole('button', { name: 'Tomorrow', exact: true })).toBeVisible();
    await expect(draft.getByRole('button', { name: 'Add date/time' })).toBeVisible();
    await expect(draft.getByRole('button', { name: 'Repeat' })).toBeVisible();
    await expect(draft.locator('.grip')).toBeVisible();

    await page.keyboard.type('Butter');
    await page.keyboard.press('Enter');
    await expectTitles(page, 'Groceries', ['Butter', '', ...GROCERIES]);
    await expect(titleField(page)).toBeFocused();
    await page.keyboard.type('Cheese');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Yoghurt');
    await page.keyboard.press('Enter');
    // Enter in a new row with no title makes no task and closes the row.
    await page.keyboard.press('Enter');
    await expect(titleField(page)).toHaveCount(0);
    await expectTitles(page, 'Groceries', ['Butter', 'Cheese', 'Yoghurt', ...GROCERIES]);
    await expect(sidebar(page).getByRole('listitem').filter({ hasText: 'Groceries' })).toContainText('8');

    await reload(page);
    await expectTitles(page, 'Groceries', ['Butter', 'Cheese', 'Yoghurt', ...GROCERIES]);
  });

  test('a new row with an empty title is dropped, with Esc and with a click outside', async ({ page }) => {
    await column(page, 'Home').getByRole('button', { name: 'Add a task' }).click();
    await expect(titleField(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(titleField(page)).toHaveCount(0);
    await expectTitles(page, 'Home', ['Water the plants']);

    await column(page, 'Home').getByRole('button', { name: 'Add a task' }).click();
    await page.keyboard.type('   ');
    await appName(page).click();
    await expect(titleField(page)).toHaveCount(0);
    await expectTitles(page, 'Home', ['Water the plants']);

    // Text that was typed and removed again makes no task.
    await column(page, 'Home').getByRole('button', { name: 'Add a task' }).click();
    await page.keyboard.type('Wrong');
    await expect(sidebar(page).getByRole('listitem').filter({ hasText: 'Home' })).toContainText('2');
    await titleField(page).fill('');
    await page.keyboard.press('Escape');
    await expectTitles(page, 'Home', ['Water the plants']);
    await expect(snackbar(page)).toHaveCount(0);
  });

  test('Backspace in an empty new row closes it and selects the row above', async ({ page }) => {
    await open(page, 'Groceries', 'Bread');
    await page.keyboard.press('Enter');
    await expectTitles(page, 'Groceries', ['Milk', 'Bread', '', 'Eggs', 'Coffee', 'Apples']);
    await page.keyboard.press('Backspace');
    await expect(titleField(page)).toHaveCount(0);
    await expectTitles(page, 'Groceries', GROCERIES);
    await expect(row(page, 'Groceries', 'Bread')).toHaveClass(/selected/);
    await expect(row(page, 'Groceries', 'Bread')).toBeFocused();
  });

  test('a click on a title opens the row with the text selected, and typing replaces the title', async ({ page }) => {
    await open(page, 'My Tasks', 'Call the dentist');
    expect(await titleField(page).evaluate((field: HTMLTextAreaElement) => [field.selectionStart, field.selectionEnd])).toEqual([0, 16]);
    await page.keyboard.type('Call the doctor');
    await detailsField(page).click();
    await page.keyboard.type('Ask for a time on Friday');
    await page.keyboard.press('Escape');
    await expect(titleField(page)).toHaveCount(0);
    const changed = row(page, 'My Tasks', 'Call the doctor');
    await expect(changed).toContainText('Ask for a time on Friday');
    // Esc leaves the row selected, with a ring.
    await expect(changed).toHaveClass(/selected/);
    await expectTitles(page, 'My Tasks', MY_TASKS.map((title) => (title === 'Call the dentist' ? 'Call the doctor' : title)));

    await reload(page);
    await expect(row(page, 'My Tasks', 'Call the doctor')).toContainText('Ask for a time on Friday');
  });

  test('a click on the details puts the cursor there', async ({ page }) => {
    await row(page, 'My Tasks', 'Plan the weekend trip').getByText('Check the train times').click();
    await expect(detailsField(page)).toBeFocused();
    await expect(detailsField(page)).toHaveValue('Check the train times and book a table for dinner.');
    await page.keyboard.type(' Ask Sam.');
    await page.keyboard.press('Escape');
    await expect(row(page, 'My Tasks', 'Plan the weekend trip')).toContainText('book a table for dinner. Ask Sam.');
  });

  test('the text is saved while the person types, with no close of the row', async ({ page }) => {
    await open(page, 'Home', 'Water the plants');
    await page.keyboard.type('Water the garden');
    // The server has the new title, and the row is still open.
    await expect.poll(() => serverTitles(page)).toContain('Water the garden');
    await expect(titleField(page)).toBeFocused();
    await expect(titleField(page)).toHaveValue('Water the garden');
  });

  test('a click outside saves and closes, and a click on a different row opens that row', async ({ page }) => {
    await open(page, 'Groceries', 'Milk');
    await page.keyboard.type('Oat milk ');
    await appName(page).click();
    await expect(titleField(page)).toHaveCount(0);
    // The spaces at the ends are gone.
    await expectTitles(page, 'Groceries', ['Oat milk', 'Bread', 'Eggs', 'Coffee', 'Apples']);

    await open(page, 'Groceries', 'Oat milk');
    await page.keyboard.type('Soy milk');
    // The row below is lower while this row is open. The click must still open it.
    await row(page, 'Groceries', 'Eggs').getByRole('button', { name: 'Eggs' }).click();
    await expect(titleField(page)).toHaveValue('Eggs');
    await expect(titleField(page)).toBeFocused();
    await expectTitles(page, 'Groceries', ['Soy milk', 'Bread', 'Eggs', 'Coffee', 'Apples']);
  });

  test('an empty title keeps the old title', async ({ page }) => {
    await open(page, 'Groceries', 'Coffee');
    await titleField(page).fill('');
    await page.keyboard.press('Escape');
    await expectTitles(page, 'Groceries', GROCERIES);
  });

  test('Enter in a subtask opens a new subtask, and Enter in a parent opens a row below its subtasks', async ({ page }) => {
    await open(page, 'My Tasks', 'Passport');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Tickets');
    await page.keyboard.press('Escape');
    await expectTitles(page, 'My Tasks', [...MY_TASKS.slice(0, 7), 'Tickets', 'Phone charger']);
    expect(await depths(page, 'My Tasks')).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1]);

    await open(page, 'My Tasks', 'Pack for the trip');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Lock the door');
    await page.keyboard.press('Escape');
    await expectTitles(page, 'My Tasks', [...MY_TASKS.slice(0, 7), 'Tickets', 'Phone charger', 'Lock the door']);
    expect(await depths(page, 'My Tasks')).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 0]);
  });

  test('the "Create" button opens a dialog that adds a task to the chosen list', async ({ page }) => {
    await sidebar(page).getByRole('button', { name: 'Create', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create a task' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Title')).toBeFocused();
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
    await dialog.getByLabel('Title').fill('Order a cake');
    await dialog.getByLabel('Details').fill('Chocolate, for 8 people');

    await dialog.getByRole('button', { name: 'Add date/time' }).click();
    const picker = page.getByRole('dialog', { name: 'Date and time' });
    await picker.locator(`[data-date="${day(1).iso}"]`).click();
    await picker.getByRole('button', { name: 'Done' }).click();
    await expect(dialog.getByRole('button', { name: 'Tomorrow', exact: true })).toBeVisible();

    await dialog.getByRole('button', { name: 'List: My Tasks' }).click();
    await choice(page, 'Home').click();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);

    await expectTitles(page, 'Home', ['Order a cake', 'Water the plants']);
    const made = row(page, 'Home', 'Order a cake');
    await expect(made).toContainText('Chocolate, for 8 people');
    await expect(made).toContainText('Tomorrow');
    await expect(made).toHaveClass(/selected/);
  });
});

test.describe('complete', () => {
  test('the circle completes a task: a line through the title, then the row leaves, and Undo brings it back', async ({ page }) => {
    const bread = row(page, 'Groceries', 'Bread');
    await bread.getByRole('checkbox', { name: 'Mark completed' }).click();
    // The same frame shows the result. The data changes after the row is out of view.
    await expect(bread).toHaveClass(/going/);
    await expect(bread.getByRole('checkbox')).toBeChecked();
    expect(await bread.locator('.title').evaluate((title) => getComputedStyle(title).textDecorationLine)).toBe('line-through');
    await expectTitles(page, 'Groceries', ['Milk', 'Eggs', 'Coffee', 'Apples']);
    await expect(snackbar(page)).toContainText('Task completed');
    await expect(column(page, 'Groceries').getByRole('button', { name: 'Completed (1)' })).toBeVisible();
    await expect(sidebar(page).getByRole('listitem').filter({ hasText: 'Groceries' })).toContainText('4');

    await snackbar(page).getByRole('button', { name: 'Undo' }).click();
    await expectTitles(page, 'Groceries', GROCERIES);
    await expect(column(page, 'Groceries').getByRole('button', { name: /Completed/ })).toHaveCount(0);
    await expect(snackbar(page)).toHaveCount(0);
  });

  test('a second click on the circle in the same moment takes the complete back', async ({ page }) => {
    const circle = row(page, 'Groceries', 'Eggs').getByRole('checkbox');
    await circle.click();
    await circle.click();
    await expect(circle).not.toBeChecked();
    await page.waitForTimeout(600);
    await expectTitles(page, 'Groceries', GROCERIES);
    await expect(snackbar(page)).toHaveCount(0);
  });

  test('a parent completes its subtasks: "3 tasks completed"', async ({ page }) => {
    await row(page, 'My Tasks', 'Pack for the trip').getByRole('checkbox').click();
    // The subtasks show as completed with their parent.
    await expect(row(page, 'My Tasks', 'Passport')).toHaveClass(/going/);
    await expectTitles(page, 'My Tasks', MY_TASKS.slice(0, 5));
    await expect(snackbar(page)).toContainText('3 tasks completed');
    await column(page, 'My Tasks').getByRole('button', { name: 'Completed (3)' }).click();
    await expect(doneList(page, 'My Tasks').locator('[data-row-id] .title')).toHaveText(['Pack for the trip', 'Passport', 'Phone charger']);

    // The parent goes back to the top. Its subtasks stay completed.
    await doneRow(page, 'My Tasks', 'Pack for the trip').getByRole('checkbox', { name: 'Mark uncompleted' }).click();
    await expect(snackbar(page)).toContainText('Task marked uncompleted');
    await expectTitles(page, 'My Tasks', ['Pack for the trip', ...MY_TASKS.slice(0, 5)]);
    await expect(column(page, 'My Tasks').getByRole('button', { name: 'Completed (2)' })).toBeVisible();
    // A subtask goes back below its parent.
    await doneRow(page, 'My Tasks', 'Passport').getByRole('checkbox').click();
    await expectTitles(page, 'My Tasks', ['Pack for the trip', 'Passport', ...MY_TASKS.slice(0, 5)]);
    expect((await depths(page, 'My Tasks'))[1]).toBe(1);
  });

  test('"Completed" opens and closes, shows when each task was completed, and a reload keeps it open', async ({ page }) => {
    const head = column(page, 'Home').getByRole('button', { name: 'Completed (3)' });
    await expect(doneList(page, 'Home')).toHaveCount(0);
    await head.click();
    await expect(head).toHaveAttribute('aria-expanded', 'true');
    // The newest is first.
    await expect(doneList(page, 'Home').locator('[data-row-id] .title')).toHaveText(['Fix the kitchen tap', 'Clean the windows', 'Take out the recycling']);
    const first = doneRow(page, 'Home', 'Fix the kitchen tap');
    await expect(first).toContainText(`Completed: ${day(-1).text}`);
    expect(await first.locator('.title').evaluate((title) => getComputedStyle(title).textDecorationLine)).toBe('line-through');
    await expect(first.getByRole('checkbox', { name: 'Mark uncompleted' })).toBeChecked();

    await reload(page);
    await expect(doneList(page, 'Home').locator('[data-row-id]')).toHaveCount(3);

    // The bin button shows with the pointer, and deletes the task.
    const last = doneRow(page, 'Home', 'Take out the recycling');
    await last.hover();
    await last.getByRole('button', { name: 'Delete task' }).click();
    await expect(snackbar(page)).toContainText('Task deleted');
    await expect(column(page, 'Home').getByRole('button', { name: 'Completed (2)' })).toBeVisible();
    await snackbar(page).getByRole('button', { name: 'Undo' }).click();
    await expect(doneList(page, 'Home').locator('[data-row-id]')).toHaveCount(3);

    await column(page, 'Home').getByRole('button', { name: 'Completed (3)' }).click();
    await expect(doneList(page, 'Home')).toHaveCount(0);
  });

  test('a list with no open task shows "All tasks complete", and a new list shows "No tasks yet"', async ({ page }) => {
    await row(page, 'Home', 'Water the plants').getByRole('checkbox').click();
    await expect(column(page, 'Home')).toContainText('All tasks complete');
    await expect(column(page, 'Home')).toContainText('Nice work!');

    await sidebar(page).getByRole('button', { name: 'Create new list' }).click();
    const prompt = page.getByRole('dialog', { name: 'Create new list' });
    await prompt.getByRole('textbox').fill('Work');
    await prompt.getByRole('button', { name: 'Done' }).click();
    await expect(column(page, 'Work')).toContainText('No tasks yet');
    await expect(column(page, 'Work')).toContainText('Add your to-dos and keep track of them here');
  });
});

test.describe('task menu', () => {
  test('the three-dot menu and the right-click menu have the same entries', async ({ page }) => {
    await taskMenu(page, 'My Tasks', 'Call the dentist');
    const expected = ['Move to top', 'Add deadline', 'Add a subtask', 'Indent', 'Delete', 'My Tasks', 'Home', 'Groceries', 'New list'];
    await expect(menu(page).locator('[data-item] .label')).toHaveText(expected);
    await expect(choice(page, 'My Tasks')).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);

    await row(page, 'My Tasks', 'Call the dentist').click({ button: 'right', position: { x: 120, y: 12 } });
    await expect(menu(page).locator('[data-item] .label')).toHaveText(expected);
    // The menu opens at the pointer.
    const box = (await menu(page).boundingBox())!;
    const target = (await row(page, 'My Tasks', 'Call the dentist').boundingBox())!;
    expect(Math.abs(box.x - (target.x + 120))).toBeLessThan(8);
    await page.keyboard.press('Escape');

    // A subtask cannot get subtasks, and it has "Unindent".
    await taskMenu(page, 'My Tasks', 'Passport');
    await expect(menu(page).locator('[data-item] .label')).toHaveText(['Move to top', 'Add deadline', 'Unindent', 'Delete', 'My Tasks', 'Home', 'Groceries', 'New list']);
  });

  test('"Delete" deletes the task and its subtasks, and Undo brings them back', async ({ page }) => {
    await taskMenu(page, 'My Tasks', 'Pack for the trip');
    await item(page, 'Delete').click();
    await expectTitles(page, 'My Tasks', MY_TASKS.slice(0, 5));
    await expect(snackbar(page)).toContainText('3 tasks deleted');
    await snackbar(page).getByRole('button', { name: 'Undo' }).click();
    await expectTitles(page, 'My Tasks', MY_TASKS);
    expect(await depths(page, 'My Tasks')).toEqual([0, 0, 0, 0, 0, 0, 1, 1]);

    await taskMenu(page, 'Groceries', 'Coffee');
    await item(page, 'Delete').click();
    await expect(snackbar(page)).toContainText('Task deleted');
    await expectTitles(page, 'Groceries', ['Milk', 'Bread', 'Eggs', 'Apples']);
    await reload(page);
    await expectTitles(page, 'Groceries', ['Milk', 'Bread', 'Eggs', 'Apples']);
  });

  test('"Move to top", "Indent", and "Unindent"', async ({ page }) => {
    await taskMenu(page, 'Groceries', 'Coffee');
    await item(page, 'Move to top').click();
    await expectTitles(page, 'Groceries', ['Coffee', 'Milk', 'Bread', 'Eggs', 'Apples']);

    await taskMenu(page, 'Groceries', 'Bread');
    await item(page, 'Indent').click();
    expect(await depths(page, 'Groceries')).toEqual([0, 0, 1, 0, 0]);
    await taskMenu(page, 'Groceries', 'Bread');
    await item(page, 'Unindent').click();
    expect(await depths(page, 'Groceries')).toEqual([0, 0, 0, 0, 0]);
    await expectTitles(page, 'Groceries', ['Coffee', 'Milk', 'Bread', 'Eggs', 'Apples']);
  });

  test('"Add a subtask" opens a new row at the end of the subtasks', async ({ page }) => {
    await taskMenu(page, 'My Tasks', 'Pack for the trip');
    await item(page, 'Add a subtask').click();
    await expect(titleField(page)).toBeFocused();
    await expectTitles(page, 'My Tasks', [...MY_TASKS, '']);
    // A subtask cannot repeat.
    await expect(openList(page, 'My Tasks').getByRole('button', { name: 'Repeat' })).toHaveCount(0);
    await page.keyboard.type('Sun cream');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Hat');
    await page.keyboard.press('Escape');
    await expectTitles(page, 'My Tasks', [...MY_TASKS, 'Sun cream', 'Hat']);
    expect(await depths(page, 'My Tasks')).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);

    await taskMenu(page, 'Groceries', 'Milk');
    await item(page, 'Add a subtask').click();
    await page.keyboard.type('Two litres');
    await page.keyboard.press('Escape');
    await expectTitles(page, 'Groceries', ['Milk', 'Two litres', 'Bread', 'Eggs', 'Coffee', 'Apples']);
    expect(await depths(page, 'Groceries')).toEqual([0, 1, 0, 0, 0, 0]);
  });

  test('an entry of a list moves the task to the top of that list, with its subtasks', async ({ page }) => {
    await taskMenu(page, 'My Tasks', 'Pack for the trip');
    await choice(page, 'Groceries').click();
    await expectTitles(page, 'My Tasks', MY_TASKS.slice(0, 5));
    await expectTitles(page, 'Groceries', ['Pack for the trip', 'Passport', 'Phone charger', ...GROCERIES]);
    expect(await depths(page, 'Groceries')).toEqual([0, 1, 1, 0, 0, 0, 0, 0]);
    await expect(sidebar(page).getByRole('listitem')).toHaveText([/My Tasks\s*5/, /Home\s*1/, /Groceries\s*8/]);

    await reload(page);
    await expectTitles(page, 'Groceries', ['Pack for the trip', 'Passport', 'Phone charger', ...GROCERIES]);
  });

  test('"New list" makes a list and moves the task there', async ({ page }) => {
    await taskMenu(page, 'Groceries', 'Apples');
    await item(page, 'New list').click();
    const prompt = page.getByRole('dialog', { name: 'Create new list' });
    await prompt.getByRole('textbox').fill('Fruit');
    await page.keyboard.press('Enter');
    await expectTitles(page, 'Fruit', ['Apples']);
    await expectTitles(page, 'Groceries', ['Milk', 'Bread', 'Eggs', 'Coffee']);
    await expect(columns(page).locator('h2')).toHaveText(['My Tasks', 'Home', 'Groceries', 'Fruit']);
  });
});

test.describe('dates', () => {
  test('the chips "Today" and "Tomorrow" set the date, and the X removes it', async ({ page }) => {
    await open(page, 'Groceries', 'Milk');
    const editing = openList(page, 'Groceries').locator('[data-row-id]').first();
    await editing.getByRole('button', { name: 'Today', exact: true }).click();
    // The date chip with an X takes the place of the two chips.
    await expect(editing.getByRole('button', { name: 'Tomorrow', exact: true })).toHaveCount(0);
    await expect(editing.locator('.chip')).toHaveText('Today');
    await expect(titleField(page)).toBeFocused();
    await editing.getByRole('button', { name: 'Remove date' }).click();
    await editing.getByRole('button', { name: 'Tomorrow', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(row(page, 'Groceries', 'Milk').locator('.chip')).toHaveText('Tomorrow');

    await reload(page);
    await expect(row(page, 'Groceries', 'Milk').locator('.chip')).toHaveText('Tomorrow');
  });

  test('the clock button opens the date picker, with a day and a time', async ({ page }) => {
    await open(page, 'Groceries', 'Eggs');
    await openList(page, 'Groceries').getByRole('button', { name: 'Add date/time' }).click();
    const picker = page.getByRole('dialog', { name: 'Date and time' });
    await expect(picker).toBeVisible();
    await picker.locator(`[data-date="${day(2).iso}"]`).click();
    const time = picker.getByRole('combobox');
    await time.click();
    await time.fill('9:15');
    await page.keyboard.press('Enter');
    await picker.getByRole('button', { name: 'Done' }).click();
    await expect(picker).toHaveCount(0);
    // The row is still open, and the keys go to its text again.
    await expect(titleField(page)).toHaveValue('Eggs');
    await expect(openList(page, 'Groceries').locator('.chip')).toHaveText(`${day(2).text}, 09:15`);
    await expect(titleField(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(row(page, 'Groceries', 'Eggs').locator('.chip')).toHaveText(`${day(2).text}, 09:15`);

    // A click on the chip of a closed row opens the picker too.
    await row(page, 'Groceries', 'Eggs').locator('.chip button').click();
    await expect(picker).toBeVisible();
    await picker.locator(`[data-date="${day(0).iso}"]`).click();
    await picker.getByRole('button', { name: 'Done' }).click();
    await expect(row(page, 'Groceries', 'Eggs').locator('.chip')).toHaveText('Today, 09:15');
  });

  test('a new row gets its date before it has a title', async ({ page }) => {
    await column(page, 'Home').getByRole('button', { name: 'Add a task' }).click();
    await openList(page, 'Home').getByRole('button', { name: 'Tomorrow', exact: true }).click();
    await expect(titleField(page)).toBeFocused();
    await page.keyboard.type('Buy stamps');
    await page.keyboard.press('Escape');
    await expect(row(page, 'Home', 'Buy stamps').locator('.chip')).toHaveText('Tomorrow');
  });

  test('"Add deadline" sets a deadline, and the X of its chip removes it', async ({ page }) => {
    await taskMenu(page, 'Groceries', 'Coffee');
    await item(page, 'Add deadline').click();
    const picker = page.getByRole('dialog', { name: 'Deadline' });
    await picker.locator(`[data-date="${day(1).iso}"]`).click();
    await picker.getByRole('button', { name: 'Done' }).click();
    await expect(row(page, 'Groceries', 'Coffee').locator('.chip')).toHaveText('Due tomorrow');

    await taskMenu(page, 'Groceries', 'Coffee');
    await expect(item(page, 'Change deadline')).toBeVisible();
    await page.keyboard.press('Escape');

    await open(page, 'Groceries', 'Coffee');
    const editing = openList(page, 'Groceries').locator('[data-row-id]').nth(3);
    await expect(editing.locator('.chip').filter({ hasText: 'Due tomorrow' })).toBeVisible();
    await editing.getByRole('button', { name: 'Remove deadline' }).click();
    await page.keyboard.press('Escape');
    await expect(row(page, 'Groceries', 'Coffee').locator('.chip')).toHaveCount(0);
  });

  test('the repeat button sets a rule, and a completed repeating task rests in "Completed" until its next date', async ({ page }) => {
    await open(page, 'Groceries', 'Milk');
    await openList(page, 'Groceries').getByRole('button', { name: 'Repeat' }).click();
    const repeat = page.getByRole('dialog', { name: 'Repeat' });
    await expect(repeat).toBeVisible();
    await repeat.getByRole('button', { name: 'Unit: week' }).click();
    await choice(page, 'day').click();
    await repeat.getByRole('button', { name: 'Done' }).click();
    await expect(repeat).toHaveCount(0);

    // The open row shows the rule and a way to stop it.
    const editing = openList(page, 'Groceries').locator('[data-row-id]').first();
    await expect(editing).toContainText('Daily');
    await expect(editing.getByRole('button', { name: 'Stop repeating' })).toBeVisible();
    await expect(editing.locator('.chip')).toHaveText('Today');
    await page.keyboard.press('Escape');
    await expect(row(page, 'Groceries', 'Milk').locator('.chip svg')).toHaveCount(2);

    await row(page, 'Groceries', 'Milk').getByRole('checkbox').click();
    await expect(snackbar(page)).toContainText(`Task completed. It comes back on ${day(1).text}`);
    await expectTitles(page, 'Groceries', ['Bread', 'Eggs', 'Coffee', 'Apples']);
    await column(page, 'Groceries').getByRole('button', { name: 'Completed (1)' }).click();
    await expect(doneRow(page, 'Groceries', 'Milk')).toContainText('Next: Tomorrow');

    // "Mark uncompleted" puts it back at its date.
    await doneRow(page, 'Groceries', 'Milk').getByRole('checkbox').click();
    await expectTitles(page, 'Groceries', GROCERIES);
    await expect(row(page, 'Groceries', 'Milk').locator('.chip')).toHaveText('Today');
  });

  test('"Stop repeating" asks, then removes the rule and keeps the date', async ({ page }) => {
    await open(page, 'Home', 'Water the plants');
    const editing = openList(page, 'Home').locator('[data-row-id]').first();
    await expect(editing).toContainText('Daily');
    await editing.getByRole('button', { name: 'Stop repeating' }).click();
    const confirm = page.getByRole('dialog', { name: 'Stop repeating?' });
    await confirm.getByRole('button', { name: 'Stop repeating' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(editing.getByRole('button', { name: 'Stop repeating' })).toHaveCount(0);
    await expect(editing.locator('.chip')).toHaveText('Today');
    await page.keyboard.press('Escape');
    await expect(row(page, 'Home', 'Water the plants').locator('.chip svg')).toHaveCount(1);
  });
});

test.describe('sort', () => {
  test('"My order" has no headings, and the menu marks the active sort', async ({ page }) => {
    expect(await headings(page, 'My Tasks')).toEqual([]);
    await listMenu(page, 'My Tasks');
    await expect(menu(page).getByRole('menuitemradio')).toHaveText(['My order', 'Date', 'Deadline', 'Starred recently', 'Title']);
    await expect(choice(page, 'My order')).toHaveAttribute('aria-checked', 'true');
    await expect(choice(page, 'Date')).toHaveAttribute('aria-checked', 'false');
  });

  test('"Date" groups the tasks by date, with "Past" in the danger color', async ({ page }) => {
    await sortBy(page, 'My Tasks', 'Date');
    expect(await headings(page, 'My Tasks')).toEqual(['Past', 'Today', 'No date']);
    await expect(column(page, 'My Tasks').getByRole('heading', { name: 'Past' })).toHaveClass(/past/);
    await expectTitles(page, 'My Tasks', [
      'Pay the electricity bill',
      'Call the dentist',
      'Plan the weekend trip',
      'Send the tax documents',
      'Buy a birthday present',
      'Pack for the trip',
      'Passport',
      'Phone charger',
    ]);
    // The rows have no levels here.
    expect(await depths(page, 'My Tasks')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    // A task in "Past" keeps its date. Below "Today" the heading gives the date, and the chip has only the time.
    await expect(row(page, 'My Tasks', 'Pay the electricity bill').locator('.chip')).toHaveText('3 days ago');
    await expect(row(page, 'My Tasks', 'Call the dentist').locator('.chip')).toHaveText('16:30');
    await expect(row(page, 'My Tasks', 'Send the tax documents').locator('.chip')).toHaveText(`Due ${day(5).text}`);

    await reload(page);
    expect(await headings(page, 'My Tasks')).toEqual(['Past', 'Today', 'No date']);
  });

  test('"Deadline" groups the tasks by deadline', async ({ page }) => {
    await sortBy(page, 'My Tasks', 'Deadline');
    expect(await headings(page, 'My Tasks')).toEqual([day(5).text, 'No deadline']);
    expect((await titles(page, 'My Tasks'))[0]).toBe('Send the tax documents');
  });

  test('"Starred recently" puts the tasks with a star first, and "Title" sorts by the text', async ({ page }) => {
    await sortBy(page, 'My Tasks', 'Starred recently');
    expect(await headings(page, 'My Tasks')).toEqual([]);
    await expectTitles(page, 'My Tasks', ['Buy a birthday present', ...MY_TASKS.filter((title) => title !== 'Buy a birthday present')]);

    await sortBy(page, 'My Tasks', 'Title');
    await expectTitles(page, 'My Tasks', [...MY_TASKS].sort((a, b) => a.localeCompare(b)));
    await listMenu(page, 'My Tasks');
    await expect(choice(page, 'Title')).toHaveAttribute('aria-checked', 'true');
  });

  test('in a sorted list, the open row keeps its place until it closes', async ({ page }) => {
    await sortBy(page, 'Groceries', 'Title');
    await expectTitles(page, 'Groceries', ['Apples', 'Bread', 'Coffee', 'Eggs', 'Milk']);
    await open(page, 'Groceries', 'Apples');
    await page.keyboard.type('Zucchini');
    await page.waitForTimeout(600);
    // The new title is saved, and the row did not jump away from the cursor.
    await expectTitles(page, 'Groceries', ['Zucchini', 'Bread', 'Coffee', 'Eggs', 'Milk']);
    await expect(titleField(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expectTitles(page, 'Groceries', ['Bread', 'Coffee', 'Eggs', 'Milk', 'Zucchini']);

    // A new task starts at the top, and goes to its sort place when its row closes.
    await column(page, 'Groceries').getByRole('button', { name: 'Add a task' }).click();
    await page.keyboard.type('Dates');
    await page.waitForTimeout(600);
    await expectTitles(page, 'Groceries', ['Dates', 'Bread', 'Coffee', 'Eggs', 'Milk', 'Zucchini']);
    await page.keyboard.press('Escape');
    await expectTitles(page, 'Groceries', ['Bread', 'Coffee', 'Dates', 'Eggs', 'Milk', 'Zucchini']);
  });
});

test.describe('star', () => {
  test('the star of a row sets and removes the star', async ({ page }) => {
    const milk = row(page, 'Groceries', 'Milk');
    await milk.hover();
    await milk.getByRole('button', { name: 'Add to Starred' }).click();
    await expect(milk.getByRole('button', { name: 'Remove from Starred' })).toHaveAttribute('aria-pressed', 'true');
    // A set star shows also when the pointer is away.
    await appName(page).hover();
    await expect(milk.getByRole('button', { name: 'Remove from Starred' })).toBeVisible();
    await reload(page);
    await expect(row(page, 'Groceries', 'Milk').getByRole('button', { name: 'Remove from Starred' })).toBeVisible();
  });

  test('the Starred view shows the tasks with a star from all lists, with a sort menu', async ({ page }) => {
    const eggs = row(page, 'Groceries', 'Eggs');
    await eggs.hover();
    await eggs.getByRole('button', { name: 'Add to Starred' }).click();
    await open(page, 'Groceries', 'Eggs');
    await openList(page, 'Groceries').getByRole('button', { name: 'Today', exact: true }).click();
    await page.keyboard.press('Escape');

    await sidebar(page).getByRole('button', { name: 'Starred', exact: true }).click();
    await expect(sidebar(page).getByRole('button', { name: 'Starred', exact: true })).toHaveAttribute('aria-current', 'page');
    const starred = column(page, 'Starred');
    await expect(starred).toBeVisible();
    await expect(columns(page)).toHaveCount(1);
    const rows = starred.getByRole('list', { name: 'Starred tasks' }).locator('[data-row-id]');
    // By date: the task of today, then the task with no date. Each row tells its list.
    expect(await headings(page, 'Starred')).toEqual(['Today', 'No date']);
    await expect(rows.locator('.title')).toHaveText(['Eggs', 'Buy a birthday present']);
    await expect(rows.nth(0)).toContainText('Groceries');
    await expect(rows.nth(1)).toContainText('My Tasks');

    await starred.getByRole('button', { name: 'Starred options' }).click();
    await expect(menu(page).getByRole('menuitemradio')).toHaveText(['Date', 'Recently starred']);
    await choice(page, 'Recently starred').click();
    expect(await headings(page, 'Starred')).toEqual([]);
    await expect(rows.locator('.title')).toHaveText(['Eggs', 'Buy a birthday present']);

    // The view and its sort stay after a reload.
    await reload(page);
    await expect(column(page, 'Starred')).toBeVisible();
    expect(await headings(page, 'Starred')).toEqual([]);

    // A row with no star leaves the view.
    await rows.nth(1).getByRole('button', { name: 'Remove from Starred' }).click();
    await expect(rows.locator('.title')).toHaveText(['Eggs']);
    await rows.nth(0).getByRole('checkbox').click();
    await expect(starred).toContainText('No starred tasks');
    await expect(starred).toContainText('Mark important tasks with a star so you can find them here');

    await sidebar(page).getByRole('button', { name: 'All tasks' }).click();
    await expect(column(page, 'My Tasks')).toBeVisible();
    await expectTitles(page, 'Groceries', ['Milk', 'Bread', 'Coffee', 'Apples']);
  });

  test('the add row of the Starred view makes a task with a star in the chosen list', async ({ page }) => {
    await sidebar(page).getByRole('button', { name: 'Starred', exact: true }).click();
    const starred = column(page, 'Starred');
    await starred.getByRole('button', { name: 'Add a task' }).click();
    await expect(titleField(page)).toBeFocused();
    await starred.getByRole('button', { name: 'My Tasks' }).click();
    await choice(page, 'Home').click();
    await expect(starred.getByRole('button', { name: 'Home' })).toBeVisible();
    await page.keyboard.type('Renew the passport');
    await page.keyboard.press('Escape');
    const rows = starred.getByRole('list', { name: 'Starred tasks' }).locator('[data-row-id]');
    // The view is sorted by date: in "No date", the tasks have the order of their lists.
    await expect(rows.locator('.title')).toHaveText(['Buy a birthday present', 'Renew the passport']);
    await expect(rows.nth(1)).toContainText('Home');

    await sidebar(page).getByRole('button', { name: 'All tasks' }).click();
    await expectTitles(page, 'Home', ['Renew the passport', 'Water the plants']);
    await expect(row(page, 'Home', 'Renew the passport').getByRole('button', { name: 'Remove from Starred' })).toBeVisible();
  });
});

test.describe('lists', () => {
  test('"Create new list" asks for a name and adds a column', async ({ page }) => {
    await sidebar(page).getByRole('button', { name: 'Create new list' }).click();
    const prompt = page.getByRole('dialog', { name: 'Create new list' });
    await expect(prompt.getByRole('textbox')).toBeFocused();
    await expect(prompt.getByRole('textbox')).toHaveAttribute('placeholder', 'Enter name');
    await expect(prompt.getByRole('button', { name: 'Done' })).toBeDisabled();
    await prompt.getByRole('textbox').fill('Work');
    await prompt.getByRole('button', { name: 'Done' }).click();

    await expect(columns(page).locator('h2')).toHaveText(['My Tasks', 'Home', 'Groceries', 'Work']);
    await expect(sidebar(page).getByRole('listitem')).toHaveText([/My Tasks/, /Home/, /Groceries/, /Work/]);
    await column(page, 'Work').getByRole('button', { name: 'Add a task' }).click();
    await page.keyboard.type('Write the report');
    await page.keyboard.press('Escape');
    await expectTitles(page, 'Work', ['Write the report']);

    await reload(page);
    await expect(columns(page).locator('h2')).toHaveText(['My Tasks', 'Home', 'Groceries', 'Work']);
    await expectTitles(page, 'Work', ['Write the report']);
  });

  test('the check box of a list hides and shows its column', async ({ page }) => {
    const box = sidebar(page).getByRole('checkbox', { name: 'Home' });
    await expect(box).toBeChecked();
    await box.uncheck();
    await expect(columns(page).locator('h2')).toHaveText(['My Tasks', 'Groceries']);
    // The list stays in the sidebar with its count.
    await expect(sidebar(page).getByRole('listitem')).toHaveText([/My Tasks\s*8/, /Home\s*1/, /Groceries\s*5/]);

    await reload(page);
    await expect(columns(page).locator('h2')).toHaveText(['My Tasks', 'Groceries']);
    await expect(sidebar(page).getByRole('checkbox', { name: 'Home' })).not.toBeChecked();

    await sidebar(page).getByRole('checkbox', { name: 'Home' }).check();
    await expect(columns(page).locator('h2')).toHaveText(['My Tasks', 'Home', 'Groceries']);

    for (const name of ['My Tasks', 'Home', 'Groceries']) await sidebar(page).getByRole('checkbox', { name }).uncheck();
    await expect(columns(page)).toHaveCount(0);
    await expect(page.getByRole('main')).toContainText('No lists are shown');
  });

  test('the list menu has its entries, and the default list cannot be deleted', async ({ page }) => {
    await listMenu(page, 'My Tasks');
    await expect(menu(page).locator('[data-item] .label')).toHaveText([
      'My order',
      'Date',
      'Deadline',
      'Starred recently',
      'Title',
      'Rename list',
      'Share with Sam',
      'Delete list',
      'Move list to first position',
      'Print list',
      'Delete all completed tasks',
    ]);
    const remove = item(page, 'Delete list The default list can\'t be deleted');
    await expect(remove).toHaveAttribute('aria-disabled', 'true');
    await expect(item(page, 'Move list to first position')).toHaveAttribute('aria-disabled', 'true');
    await expect(item(page, 'Delete all completed tasks')).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');

    await listMenu(page, 'Groceries');
    await expect(item(page, 'Stop sharing')).toBeVisible();
  });

  test('"Rename list" changes the name in the column and in the sidebar', async ({ page }) => {
    await listMenu(page, 'Home');
    await item(page, 'Rename list').click();
    const prompt = page.getByRole('dialog', { name: 'Rename list' });
    await expect(prompt.getByRole('textbox')).toHaveValue('Home');
    await prompt.getByRole('textbox').fill('House');
    await page.keyboard.press('Enter');
    await expect(columns(page).locator('h2')).toHaveText(['My Tasks', 'House', 'Groceries']);
    await expect(sidebar(page).getByRole('listitem')).toHaveText([/My Tasks/, /House/, /Groceries/]);
    await reload(page);
    await expect(column(page, 'House')).toBeVisible();
  });

  test('"Delete list" asks first, and deletes the list with its tasks', async ({ page }) => {
    await listMenu(page, 'Home');
    await item(page, 'Delete list').click();
    const confirm = page.getByRole('dialog', { name: 'Delete this list?' });
    await expect(confirm).toContainText('Its 4 tasks are deleted too.');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(column(page, 'Home')).toBeVisible();

    await listMenu(page, 'Home');
    await item(page, 'Delete list').click();
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(columns(page).locator('h2')).toHaveText(['My Tasks', 'Groceries']);
    await expect(snackbar(page)).toContainText('List deleted');
    await expect(sidebar(page).getByRole('listitem')).toHaveCount(2);
    await reload(page);
    await expect(columns(page).locator('h2')).toHaveText(['My Tasks', 'Groceries']);
  });

  test('"Move list to first position" moves the column', async ({ page }) => {
    await listMenu(page, 'Groceries');
    await item(page, 'Move list to first position').click();
    await expect(columns(page).locator('h2')).toHaveText(['Groceries', 'My Tasks', 'Home']);
    await expect(sidebar(page).getByRole('listitem')).toHaveText([/Groceries/, /My Tasks/, /Home/]);
    await reload(page);
    await expect(columns(page).locator('h2')).toHaveText(['Groceries', 'My Tasks', 'Home']);
  });

  test('"Delete all completed tasks" asks first, and Undo brings the tasks back', async ({ page }) => {
    await listMenu(page, 'Home');
    await item(page, 'Delete all completed tasks').click();
    const confirm = page.getByRole('dialog', { name: 'Delete all completed tasks?' });
    await expect(confirm).toContainText('3 completed tasks are deleted from "Home".');
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(snackbar(page)).toContainText('3 completed tasks deleted');
    await expect(column(page, 'Home').getByRole('button', { name: /Completed/ })).toHaveCount(0);
    await expectTitles(page, 'Home', ['Water the plants']);

    await snackbar(page).getByRole('button', { name: 'Undo' }).click();
    await expect(column(page, 'Home').getByRole('button', { name: 'Completed (3)' })).toBeVisible();
  });

  test('"Share with" and "Stop sharing" change the people icon', async ({ page }) => {
    await listMenu(page, 'Home');
    await item(page, 'Share with Sam').click();
    await page.getByRole('dialog', { name: 'Share "Home" with Sam?' }).getByRole('button', { name: 'Share' }).click();
    await expect(column(page, 'Home').getByRole('img', { name: 'Shared with Sam' })).toBeVisible();
    await expect(snackbar(page)).toContainText('Shared "Home" with Sam');

    await listMenu(page, 'Groceries');
    await item(page, 'Stop sharing').click();
    await expect(column(page, 'Groceries').getByRole('img', { name: 'Shared with Sam' })).toHaveCount(0);
  });

  test('a task that the other person completed shows the name of that person', async ({ page, browser }) => {
    const other = await browser.newContext({ locale: 'en-GB' });
    const theirs = await other.newPage();
    await signIn(theirs, sam);
    // The shared list shows for the second account, with the name of its owner.
    await expect(column(theirs, 'Groceries').getByRole('img', { name: 'Shared by Alex' })).toBeVisible();
    await row(theirs, 'Groceries', 'Coffee').getByRole('checkbox').click();
    await expect(snackbar(theirs)).toContainText('Task completed');

    // The change arrives through the server with no reload.
    await expectTitles(page, 'Groceries', ['Milk', 'Bread', 'Eggs', 'Apples']);
    await column(page, 'Groceries').getByRole('button', { name: 'Completed (1)' }).click();
    await expect(doneRow(page, 'Groceries', 'Coffee')).toContainText(`Completed: ${day(0).text}`);
    await expect(doneRow(page, 'Groceries', 'Coffee')).toContainText('Sam');
    await other.close();
  });
});

test.describe('keyboard', () => {
  test('Down and Up move the selection through all rows of a column, with a visible ring', async ({ page }) => {
    await page.keyboard.press('ArrowDown');
    const first = row(page, 'My Tasks', 'Plan the weekend trip');
    await expect(first).toHaveClass(/selected/);
    await expect(first).toBeFocused();
    expect(await first.evaluate((element) => getComputedStyle(element).boxShadow)).toContain('inset');

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    expect(await selectedTitle(page)).toBe('Pay the electricity bill');
    await page.keyboard.press('ArrowUp');
    expect(await selectedTitle(page)).toBe('Call the dentist');
    await expect(page.locator('[data-row-id].selected')).toHaveCount(1);

    await page.keyboard.press('End');
    expect(await selectedTitle(page)).toBe('Phone charger');
    // The last row is the end.
    await page.keyboard.press('ArrowDown');
    expect(await selectedTitle(page)).toBe('Phone charger');
    await page.keyboard.press('Home');
    expect(await selectedTitle(page)).toBe('Plan the weekend trip');
  });

  test('a click on the board next to the rows takes the ring away', async ({ page }) => {
    await selectRow(page, 'Groceries', 'Eggs');
    await page.getByRole('main').click({ position: { x: 1100, y: 700 } });
    await expect(page.locator('[data-row-id].selected')).toHaveCount(0);
    // The keyboard starts again at the first row.
    await page.keyboard.press('ArrowDown');
    expect(await selectedTitle(page)).toBe('Plan the weekend trip');
  });

  test('a title is one line, also for text with line breaks from the clipboard', async ({ page }) => {
    await open(page, 'Groceries', 'Milk');
    await page.keyboard.insertText('Milk\nand cream');
    await page.keyboard.press('Escape');
    await expectTitles(page, 'Groceries', ['Milk and cream', 'Bread', 'Eggs', 'Coffee', 'Apples']);
  });

  test('Down goes into the rows of "Completed", and Space marks such a row uncompleted', async ({ page }) => {
    await column(page, 'Home').getByRole('button', { name: 'Completed (3)' }).click();
    await selectRow(page, 'Home', 'Water the plants');
    await page.keyboard.press('ArrowDown');
    await expect(doneRow(page, 'Home', 'Fix the kitchen tap')).toHaveClass(/selected/);
    await page.keyboard.press('End');
    await expect(doneRow(page, 'Home', 'Take out the recycling')).toHaveClass(/selected/);
    await page.keyboard.press('Space');
    await expectTitles(page, 'Home', ['Take out the recycling', 'Water the plants']);
    // The selection stays in "Completed".
    await expect(doneRow(page, 'Home', 'Clean the windows')).toHaveClass(/selected/);
    await page.keyboard.press('Delete');
    await expect(snackbar(page)).toContainText('Task deleted');
    await expect(doneRow(page, 'Home', 'Fix the kitchen tap')).toHaveClass(/selected/);
  });

  test('Left and Right change the column, and keep the place in the column', async ({ page }) => {
    await selectRow(page, 'My Tasks', 'Call the dentist');
    await page.keyboard.press('ArrowRight');
    await expect(row(page, 'Home', 'Water the plants')).toHaveClass(/selected/);
    // The second row again, after the column that has one row only.
    await page.keyboard.press('ArrowRight');
    await expect(row(page, 'Groceries', 'Bread')).toHaveClass(/selected/);
    await page.keyboard.press('ArrowRight');
    await expect(row(page, 'Groceries', 'Bread')).toHaveClass(/selected/);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(row(page, 'My Tasks', 'Send the tax documents')).toHaveClass(/selected/);
    await expect(page.locator('[data-row-id].selected')).toHaveCount(1);
  });

  test('Enter edits the selected task, Enter in the title adds a task below, and Esc finishes', async ({ page }) => {
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(titleField(page)).toBeFocused();
    await expect(titleField(page)).toHaveValue('Plan the weekend trip');
    await page.keyboard.type('Plan the summer trip');
    await page.keyboard.press('Enter');
    await expect(titleField(page)).toHaveValue('');
    await page.keyboard.type('Book the hotel');
    await page.keyboard.press('Escape');
    await expect(titleField(page)).toHaveCount(0);
    await expectTitles(page, 'My Tasks', ['Plan the summer trip', 'Book the hotel', ...MY_TASKS.slice(1)]);
    expect(await selectedTitle(page)).toBe('Book the hotel');
    // The keys work on the selection again.
    await page.keyboard.press('ArrowUp');
    expect(await selectedTitle(page)).toBe('Plan the summer trip');
  });

  test('Space completes the selected task and selects the next one', async ({ page }) => {
    await selectRow(page, 'Groceries', 'Bread');
    await page.keyboard.press('Space');
    await expectTitles(page, 'Groceries', ['Milk', 'Eggs', 'Coffee', 'Apples']);
    await expect(snackbar(page)).toContainText('Task completed');
    await expect(row(page, 'Groceries', 'Eggs')).toHaveClass(/selected/);
    await page.keyboard.press('Space');
    await expectTitles(page, 'Groceries', ['Milk', 'Coffee', 'Apples']);
    await expect(row(page, 'Groceries', 'Coffee')).toHaveClass(/selected/);
  });

  test('Ctrl+] indents, Ctrl+[ removes the indent, and Ctrl+Alt+Enter adds a subtask', async ({ page }) => {
    await selectRow(page, 'Groceries', 'Bread');
    await page.keyboard.press(`${MOD}+]`);
    expect(await depths(page, 'Groceries')).toEqual([0, 1, 0, 0, 0]);
    await expect(row(page, 'Groceries', 'Bread')).toHaveClass(/selected/);
    // A subtask cannot get an indent again.
    await page.keyboard.press(`${MOD}+]`);
    expect(await depths(page, 'Groceries')).toEqual([0, 1, 0, 0, 0]);
    await page.keyboard.press(`${MOD}+[`);
    expect(await depths(page, 'Groceries')).toEqual([0, 0, 0, 0, 0]);
    await expectTitles(page, 'Groceries', GROCERIES);

    await page.keyboard.press(`${MOD}+Alt+Enter`);
    await expect(titleField(page)).toBeFocused();
    await page.keyboard.type('Brown');
    // The same keys in a title add one more subtask.
    await page.keyboard.press(`${MOD}+Alt+Enter`);
    await page.keyboard.type('White');
    await page.keyboard.press('Escape');
    await expectTitles(page, 'Groceries', ['Milk', 'Bread', 'Brown', 'White', 'Eggs', 'Coffee', 'Apples']);
    expect(await depths(page, 'Groceries')).toEqual([0, 0, 1, 1, 0, 0, 0]);
  });

  test('Ctrl+] and Ctrl+[ work in the title of an open row', async ({ page }) => {
    await open(page, 'Groceries', 'Eggs');
    await page.keyboard.press(`${MOD}+]`);
    expect(await depths(page, 'Groceries')).toEqual([0, 0, 1, 0, 0]);
    await expect(titleField(page)).toBeFocused();
    await page.keyboard.press(`${MOD}+[`);
    expect(await depths(page, 'Groceries')).toEqual([0, 0, 0, 0, 0]);
    await expect(titleField(page)).toBeFocused();
    await expect(titleField(page)).toHaveValue('Eggs');
  });

  test('"." and "v" open the task menu', async ({ page }) => {
    await selectRow(page, 'Groceries', 'Coffee');
    await page.keyboard.press('.');
    await expect(menu(page)).toBeVisible();
    await expect(item(page, 'Move to top')).toBeVisible();
    // The menu takes the keys: Down and Enter choose an entry.
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);
    await page.keyboard.press('v');
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    await expectTitles(page, 'Groceries', ['Coffee', 'Milk', 'Bread', 'Eggs', 'Apples']);
  });

  test('Ctrl+Up and Ctrl+Down move a task, with Shift to the top and to the bottom', async ({ page }) => {
    await selectRow(page, 'Groceries', 'Eggs');
    await page.keyboard.press(`${MOD}+ArrowUp`);
    await expectTitles(page, 'Groceries', ['Milk', 'Eggs', 'Bread', 'Coffee', 'Apples']);
    await page.keyboard.press(`${MOD}+ArrowDown`);
    await page.keyboard.press(`${MOD}+ArrowDown`);
    await expectTitles(page, 'Groceries', ['Milk', 'Bread', 'Coffee', 'Eggs', 'Apples']);
    await page.keyboard.press(`${MOD}+Shift+ArrowUp`);
    await expectTitles(page, 'Groceries', ['Eggs', 'Milk', 'Bread', 'Coffee', 'Apples']);
    await page.keyboard.press(`${MOD}+Shift+ArrowDown`);
    await expectTitles(page, 'Groceries', ['Milk', 'Bread', 'Coffee', 'Apples', 'Eggs']);
    await expect(row(page, 'Groceries', 'Eggs')).toHaveClass(/selected/);

    // A subtask moves among the subtasks of its parent.
    await selectRow(page, 'My Tasks', 'Phone charger');
    await page.keyboard.press(`${MOD}+ArrowUp`);
    await expectTitles(page, 'My Tasks', [...MY_TASKS.slice(0, 6), 'Phone charger', 'Passport']);
    await page.keyboard.press(`${MOD}+ArrowUp`);
    await expectTitles(page, 'My Tasks', [...MY_TASKS.slice(0, 6), 'Phone charger', 'Passport']);
  });

  test('"s" sets and removes the star, and Delete and Backspace delete', async ({ page }) => {
    await selectRow(page, 'Groceries', 'Milk');
    await page.keyboard.press('s');
    await expect(row(page, 'Groceries', 'Milk').getByRole('button', { name: 'Remove from Starred' })).toBeVisible();
    await page.keyboard.press('s');
    await expect(row(page, 'Groceries', 'Milk').getByRole('button', { name: 'Add to Starred' })).toBeVisible();

    await page.keyboard.press('Delete');
    await expectTitles(page, 'Groceries', ['Bread', 'Eggs', 'Coffee', 'Apples']);
    await expect(snackbar(page)).toContainText('Task deleted');
    await expect(row(page, 'Groceries', 'Bread')).toHaveClass(/selected/);
    await page.keyboard.press('Backspace');
    await expectTitles(page, 'Groceries', ['Eggs', 'Coffee', 'Apples']);
  });

  test('"n" opens a new task in the list of the selection', async ({ page }) => {
    await selectRow(page, 'Home', 'Water the plants');
    await page.keyboard.press('n');
    await expect(titleField(page)).toBeFocused();
    // The key that opened the row is not in its text.
    await expect(titleField(page)).toHaveValue('');
    await page.keyboard.type('Sweep the floor');
    await page.keyboard.press('Escape');
    await expectTitles(page, 'Home', ['Sweep the floor', 'Water the plants']);
  });

  test('"?" and Ctrl+/ open the shortcut list', async ({ page }) => {
    const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await page.keyboard.press('?');
    await expect(help).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(help).toHaveCount(0);
    await page.keyboard.press(`${MOD}+/`);
    await expect(help).toBeVisible();
  });

  test('Ctrl+Z takes back the last action', async ({ page }) => {
    await selectRow(page, 'Groceries', 'Apples');
    await page.keyboard.press('Delete');
    await expectTitles(page, 'Groceries', ['Milk', 'Bread', 'Eggs', 'Coffee']);
    await page.keyboard.press(`${MOD}+z`);
    await expectTitles(page, 'Groceries', GROCERIES);
  });

  test('Ctrl+P prints only the list of the selection', async ({ page }) => {
    await page.evaluate(() => {
      // The print dialog would stop the page. The test reads what the page asks for.
      (window as unknown as { printed: string[] }).printed = [];
      window.print = () => (window as unknown as { printed: string[] }).printed.push(document.documentElement.dataset.printing ?? 'page');
    });
    await selectRow(page, 'Home', 'Water the plants');
    const homeId = await column(page, 'Home').getAttribute('data-print-list');
    await page.keyboard.press(`${MOD}+p`);
    expect(await page.evaluate(() => (window as unknown as { printed: string[] }).printed)).toEqual([homeId]);
  });

  test('single keys do nothing in a text field, in a dialog, and with a menu open', async ({ page }) => {
    await open(page, 'Groceries', 'Milk');
    // The Right key puts the cursor at the end of the selected text.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type(' s n v . ?');
    await expect(titleField(page)).toHaveValue('Milk s n v . ?');
    await page.keyboard.press('Escape');
    await expectTitles(page, 'Groceries', ['Milk s n v . ?', 'Bread', 'Eggs', 'Coffee', 'Apples']);
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await sidebar(page).getByRole('button', { name: 'Create new list' }).click();
    const prompt = page.getByRole('dialog', { name: 'Create new list' });
    await prompt.getByRole('textbox').blur();
    await page.keyboard.press('Delete');
    await page.keyboard.press('Space');
    await page.keyboard.press('Escape');
    await expect(prompt).toHaveCount(0);
    await expectTitles(page, 'Groceries', ['Milk s n v . ?', 'Bread', 'Eggs', 'Coffee', 'Apples']);
  });
});

/** Moves the mouse in steps, as a hand does: the drag engine starts after 4 px and reads each move. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 6, from.y + 6, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  // The engine reads the pointer one time for each frame.
  await page.waitForTimeout(80);
  await page.mouse.up();
  await page.waitForTimeout(350);
}

async function centre(locator: Locator): Promise<{ x: number; y: number; height: number }> {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, height: box.height };
}

test.describe('drag and drop', () => {
  test.beforeEach(async ({ page }) => {
    // The engine loads after the first paint.
    await page.waitForTimeout(400);
  });

  test('a row moves to a new place in its list', async ({ page }) => {
    const from = await centre(row(page, 'Groceries', 'Apples'));
    const to = await centre(row(page, 'Groceries', 'Bread'));
    await drag(page, from, { x: from.x, y: to.y - to.height / 2 + 4 });
    await expectTitles(page, 'Groceries', ['Milk', 'Apples', 'Bread', 'Eggs', 'Coffee']);
    // The click at the end of a drag does not open the row.
    await expect(titleField(page)).toHaveCount(0);

    const milk = await centre(row(page, 'Groceries', 'Milk'));
    const coffee = await centre(row(page, 'Groceries', 'Coffee'));
    await drag(page, milk, { x: milk.x, y: coffee.y + coffee.height / 2 - 4 });
    await expectTitles(page, 'Groceries', ['Apples', 'Bread', 'Eggs', 'Coffee', 'Milk']);

    await reload(page);
    await expectTitles(page, 'Groceries', ['Apples', 'Bread', 'Eggs', 'Coffee', 'Milk']);
  });

  test('a move to the right makes a subtask, and a move to the left makes a task again', async ({ page }) => {
    const eggs = await centre(row(page, 'Groceries', 'Eggs'));
    await drag(page, eggs, { x: eggs.x + 40, y: eggs.y + 2 });
    await expectTitles(page, 'Groceries', GROCERIES);
    expect(await depths(page, 'Groceries')).toEqual([0, 0, 1, 0, 0]);

    const child = await centre(row(page, 'Groceries', 'Eggs'));
    await drag(page, child, { x: child.x - 40, y: child.y + 2 });
    expect(await depths(page, 'Groceries')).toEqual([0, 0, 0, 0, 0]);
    await expectTitles(page, 'Groceries', GROCERIES);
  });

  test('a row moves to a different column, to the place of the drop', async ({ page }) => {
    const from = await centre(row(page, 'Groceries', 'Coffee'));
    const to = await centre(row(page, 'My Tasks', 'Call the dentist'));
    await drag(page, from, { x: to.x, y: to.y - to.height / 2 + 4 });
    await expectTitles(page, 'Groceries', ['Milk', 'Bread', 'Eggs', 'Apples']);
    await expectTitles(page, 'My Tasks', ['Plan the weekend trip', 'Coffee', ...MY_TASKS.slice(1)]);
    await expect(sidebar(page).getByRole('listitem')).toHaveText([/My Tasks\s*9/, /Home\s*1/, /Groceries\s*4/]);

    await reload(page);
    await expectTitles(page, 'My Tasks', ['Plan the weekend trip', 'Coffee', ...MY_TASKS.slice(1)]);
  });

  test('a parent moves with its subtasks to a different column', async ({ page }) => {
    const from = await centre(row(page, 'My Tasks', 'Pack for the trip'));
    const to = await centre(row(page, 'Groceries', 'Milk'));
    await drag(page, from, { x: to.x, y: to.y - to.height / 2 + 2 });
    await expectTitles(page, 'My Tasks', MY_TASKS.slice(0, 5));
    await expectTitles(page, 'Groceries', ['Pack for the trip', 'Passport', 'Phone charger', ...GROCERIES]);
    expect(await depths(page, 'Groceries')).toEqual([0, 1, 1, 0, 0, 0, 0, 0]);
  });

  test('a drop on a column with a different sort puts the task at the top of that list', async ({ page }) => {
    await sortBy(page, 'My Tasks', 'Title');
    const from = await centre(row(page, 'Groceries', 'Milk'));
    const to = await centre(row(page, 'My Tasks', 'Passport'));
    await drag(page, from, { x: to.x, y: to.y });
    await expectTitles(page, 'Groceries', ['Bread', 'Eggs', 'Coffee', 'Apples']);
    // The sort of the list gives the place on the screen.
    await expectTitles(page, 'My Tasks', [...MY_TASKS, 'Milk'].sort((a, b) => a.localeCompare(b)));
    await sortBy(page, 'My Tasks', 'My order');
    await expectTitles(page, 'My Tasks', ['Milk', ...MY_TASKS]);
  });

  test('a row of a sorted list cannot get a new place in that list', async ({ page }) => {
    await sortBy(page, 'Groceries', 'Title');
    const from = await centre(row(page, 'Groceries', 'Apples'));
    const to = await centre(row(page, 'Groceries', 'Eggs'));
    await drag(page, from, { x: from.x, y: to.y + 4 });
    await expectTitles(page, 'Groceries', ['Apples', 'Bread', 'Coffee', 'Eggs', 'Milk']);
    await sortBy(page, 'Groceries', 'My order');
    await expectTitles(page, 'Groceries', GROCERIES);
  });

  test('the header moves a column', async ({ page }) => {
    const from = await centre(column(page, 'Groceries').getByRole('heading', { name: 'Groceries' }));
    const to = await centre(column(page, 'My Tasks').getByRole('heading', { name: 'My Tasks' }));
    await drag(page, from, { x: to.x - 80, y: to.y });
    await expect(columns(page).locator('h2')).toHaveText(['Groceries', 'My Tasks', 'Home']);
    await expect(sidebar(page).getByRole('listitem')).toHaveText([/Groceries/, /My Tasks/, /Home/]);

    await reload(page);
    await expect(columns(page).locator('h2')).toHaveText(['Groceries', 'My Tasks', 'Home']);
  });

  test('a drag closes the open row and saves its text', async ({ page }) => {
    await open(page, 'Groceries', 'Milk');
    await page.keyboard.type('Oat milk');
    const from = await centre(row(page, 'Groceries', 'Apples'));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 6, from.y - 6, { steps: 2 });
    // The open row closed at the start of the drag, so the rows below it moved up.
    await expect(titleField(page)).toHaveCount(0);
    const to = await centre(row(page, 'Groceries', 'Eggs'));
    await page.mouse.move(from.x, to.y - to.height / 2 + 4, { steps: 12 });
    await page.waitForTimeout(80);
    await page.mouse.up();
    await expectTitles(page, 'Groceries', ['Oat milk', 'Bread', 'Apples', 'Eggs', 'Coffee']);
  });
});

test.describe('drag and drop of the open row', () => {
  test('the handle of the open row moves the row', async ({ page }) => {
    await page.waitForTimeout(400);
    await open(page, 'Groceries', 'Apples');
    await page.keyboard.type('Green apples');
    const grip = await centre(openList(page, 'Groceries').locator('.grip'));
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    await page.mouse.move(grip.x + 4, grip.y - 8, { steps: 2 });
    await expect(titleField(page)).toHaveCount(0);
    const to = await centre(row(page, 'Groceries', 'Bread'));
    await page.mouse.move(grip.x + 4, to.y - to.height / 2 + 4, { steps: 12 });
    await page.waitForTimeout(80);
    await page.mouse.up();
    await expectTitles(page, 'Groceries', ['Milk', 'Green apples', 'Bread', 'Eggs', 'Coffee']);
  });
});

test.describe('sync state', () => {
  test('the bar shows an icon while the device is offline, and the changes go to the server later', async ({ page, context }) => {
    const badge = page.getByTestId('sync-badge');
    await expect(badge).toHaveCount(0);
    await context.setOffline(true);
    await column(page, 'Groceries').getByRole('button', { name: 'Add a task' }).click();
    await page.keyboard.type('Rice');
    await page.keyboard.press('Escape');
    await expectTitles(page, 'Groceries', ['Rice', ...GROCERIES]);
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('aria-label', /Offline/);

    await context.setOffline(false);
    await expect(badge).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => serverTitles(page)).toContain('Rice');
  });
});

test.describe('links and print', () => {
  test('the address /?new=1 opens the create dialog', async ({ page }) => {
    await page.goto('/?new=1');
    await expect(page.getByRole('dialog', { name: 'Create a task' })).toBeVisible();
    expect(new URL(page.url()).search).toBe('');
  });

  test('the address /?task=ID opens the row of that task', async ({ page }) => {
    const id = await row(page, 'Groceries', 'Eggs').getAttribute('data-row-id');
    await page.goto(`/?task=${id}`);
    await expect(titleField(page)).toHaveValue('Eggs');
    await expect(titleField(page)).toBeFocused();
  });

  test('the address /?list=ID shows the column of that list, also if it was hidden', async ({ page }) => {
    const id = await column(page, 'Groceries').getAttribute('data-print-list');
    await sidebar(page).getByRole('checkbox', { name: 'Groceries' }).uncheck();
    await expect(columns(page)).toHaveCount(2);
    await page.waitForTimeout(300);
    await page.goto(`/?list=${id}`);
    await expect(column(page, 'Groceries')).toBeVisible();
    await expect(sidebar(page).getByRole('checkbox', { name: 'Groceries' })).toBeChecked();
  });

  test('"Print list" prints only that list, with the completed tasks if the section is open', async ({ page }) => {
    await column(page, 'Home').getByRole('button', { name: 'Completed (3)' }).click();
    await page.evaluate(() => {
      // The print dialog would stop the page. With no dialog, the page keeps its state for paper.
      window.print = () => {
        (window as unknown as { printing: string | undefined }).printing = document.documentElement.dataset.printing;
      };
    });
    await listMenu(page, 'Home');
    await item(page, 'Print list').click();
    const homeId = await column(page, 'Home').getAttribute('data-print-list');
    expect(await page.evaluate(() => (window as unknown as { printing: string | undefined }).printing)).toBe(homeId);
    await page.emulateMedia({ media: 'print' });

    await expect(column(page, 'Home')).toBeVisible();
    await expect(column(page, 'My Tasks')).toBeHidden();
    await expect(column(page, 'Groceries')).toBeHidden();
    await expect(sidebar(page)).toBeHidden();
    await expect(appName(page)).toBeHidden();
    await expect(column(page, 'Home').getByRole('button', { name: 'Add a task' })).toBeHidden();
    await expect(column(page, 'Home').getByText('Water the plants')).toBeVisible();
    await expect(doneList(page, 'Home').getByText('Clean the windows')).toBeVisible();
    // The list uses the width of the paper.
    const width = (await column(page, 'Home').boundingBox())!.width;
    expect(width).toBeGreaterThan(600);
  });
});

test.describe('many tasks', () => {
  test('a list with more than 50 completed tasks shows them in steps', async ({ page }) => {
    test.setTimeout(60_000);
    await column(page, 'Groceries').getByRole('button', { name: 'Add a task' }).click();
    for (let i = 1; i <= 60; i++) {
      await page.keyboard.insertText(`Item ${i}`);
      await page.keyboard.press('Enter');
    }
    await page.keyboard.press('Escape');
    await expect(openList(page, 'Groceries').locator('[data-row-id]')).toHaveCount(65);
    // Complete all with the keyboard: Space completes the selection and selects the next row.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.keyboard.press('Home');
    for (let i = 0; i < 60; i++) await page.keyboard.press('Space');
    await expect(openList(page, 'Groceries').locator('[data-row-id]')).toHaveCount(5);
    const head = column(page, 'Groceries').getByRole('button', { name: 'Completed (60)' });
    await head.click();
    await expect(doneList(page, 'Groceries').locator('[data-row-id]')).toHaveCount(50);
    await doneList(page, 'Groceries').locator('[data-row-id]').last().scrollIntoViewIfNeeded();
    await expect(doneList(page, 'Groceries').locator('[data-row-id]')).toHaveCount(60);
  });
});
