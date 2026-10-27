// Tests of the notes in the phone layout: the Notes tab, the full-screen editor, the note menu
// sheet, and a note that two people share. They run in Chromium (phone) and WebKit (iphone).
// Run: E2E_PORT=5122 pnpm exec playwright test notes.phone --config e2e/playwright.config.ts --project phone
//
// The seed notes (server/seed.ts). Each note is 1 minute older than the note above it:
//   Dinner party menu       orange, Alex, shared with Sam, last edit by Sam.
//                           Body "- [ ] Lasagne", "- [ ] Green salad", "- [x] Tiramisu".
//   Lake house checklist    yellow, Alex, pinned. Sunscreen, Hiking boots, Rain jacket, Board games.
//   (no title)              green, Alex. "Ring the plumber before Friday".
//   Book club reading list  default, Alex. The Remains of the Day, Piranesi, The Overstory.
//   Gift ideas for Grandma  pink, Alex, archived. Silk scarf, A photo book, Orchid.
//   Bike repair parts       blue, Sam. Front brake pads, Inner tube 28 inch, Chain oil.
// Alex sees: Pinned: Lake house checklist. Others: Dinner party menu, the note with no title,
// Book club reading list. Archive: Gift ideas for Grandma. Sam sees: Dinner party menu, Bike repair parts.

import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

interface Account {
  name: string;
  password: string;
}
const { users } = JSON.parse(readFileSync(new URL('../fixtures/users.json', import.meta.url), 'utf8')) as { users: Account[] };
const alex = users[0]!;
const sam = users[1]!;

interface Point {
  x: number;
  y: number;
}

const NOTES = ['Lake house checklist', 'Dinner party menu', 'Ring the plumber before Friday', 'Book club reading list'];
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
/** The editor slides in from the right. A tap during that time can miss. */
const SLIDE_MS = 260;

// ---- Parts of the screen ----

const tabs = (page: Page): Locator => page.getByRole('tablist', { name: 'Lists' });
const tab = (page: Page, name: string): Locator => tabs(page).getByRole('tab', { name });
const panel = (page: Page, name: string): Locator => page.getByRole('tabpanel', { name, exact: true });
const notesPage = (page: Page): Locator => panel(page, 'Notes');
/** A card, found by the name of its open button: the title, the first line of the body, or "Empty note". */
const card = (page: Page, name: string): Locator =>
  notesPage(page).locator('[data-note-id]').filter({ has: page.getByRole('button', { name, exact: true }) });
const newNoteButton = (page: Page): Locator => page.getByRole('button', { name: 'New note' });
/** The editor of a note: "Note", or "New note" for a note that the person makes now. */
const screen = (page: Page, name = 'Note'): Locator => page.getByRole('dialog', { name, exact: true });
const noteField = (scope: Locator): Locator => scope.getByRole('textbox', { name: 'Note', exact: true });
const titleField = (scope: Locator): Locator => scope.getByRole('textbox', { name: 'Title', exact: true });
const archiveToggle = (page: Page): Locator => notesPage(page).getByRole('button', { name: 'Archive', exact: true });
const searchField = (page: Page): Locator => notesPage(page).getByRole('searchbox');
const snackbar = (page: Page): Locator => page.locator('.snackbar');
/** An entry of the open menu sheet, by its label. */
const menuItem = (page: Page, name: string): Locator =>
  page.getByRole('menu').locator('[role^="menuitem"]', { has: page.locator('.label', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });

/** The names of the cards, in the order of the document: "Pinned", then "Others". */
function cardNames(page: Page): Promise<string[]> {
  return notesPage(page)
    .locator('[data-note-id] > button.open')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label') ?? ''));
}
const expectCards = (page: Page, names: string[]): Promise<void> => expect.poll(() => cardNames(page)).toEqual(names);
/** The titles of the open tasks of a list page, with the subtasks. */
const taskTitles = (page: Page, list: string): Locator => panel(page, list).getByTestId('task-row').locator('.title');

async function signIn(page: Page, account: Account = alex): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Name', { exact: true }).fill(account.name);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(tab(page, 'My Tasks')).toBeVisible();
  await expect(panel(page, 'My Tasks').getByTestId('task-row').first()).toBeVisible();
}

/** Shows the Notes page, and waits for its cards. */
async function goToNotes(page: Page): Promise<void> {
  await tab(page, 'Notes').click();
  await expect(tab(page, 'Notes')).toHaveAttribute('aria-selected', 'true');
  await expect(notesPage(page).locator('[data-note-id]').first()).toBeInViewport();
}

async function openNote(page: Page, name: string): Promise<Locator> {
  await card(page, name).getByRole('button', { name, exact: true }).click();
  const editor = screen(page);
  await expect(editor).toBeVisible();
  await page.waitForTimeout(SLIDE_MS);
  return editor;
}

async function closeNote(page: Page, name = 'Note'): Promise<void> {
  await screen(page, name).getByRole('button', { name: 'Back' }).click();
  await expect(screen(page, name)).toHaveCount(0);
}

/** The note menu of a card: a long press gives a context menu event on a phone. */
async function cardMenu(page: Page, name: string): Promise<void> {
  await card(page, name).dispatchEvent('contextmenu', { button: 2, clientX: 200, clientY: 400 });
  await expect(page.getByRole('menu', { name: 'Note options' })).toBeVisible();
}

/** The Back action of the browser. The history entry of an overlay is made in the task after the overlay opens. */
async function goBack(page: Page): Promise<void> {
  await page.waitForTimeout(150);
  await page.goBack();
}

/** A quick touch movement through the DevTools protocol, as a finger does it. Chromium only. */
async function swipe(page: Page, from: Point, to: Point): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: Point[]) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: 1 })) });
  await send('touchStart', [from]);
  for (let i = 1; i <= 6; i++) {
    await send('touchMove', [{ x: from.x + ((to.x - from.x) * i) / 6, y: from.y + ((to.y - from.y) * i) / 6 }]);
    await page.waitForTimeout(16);
  }
  await send('touchEnd', []);
}

/** A second phone with no local data: it shows what the server has for the account. */
async function freshDevice({ browser, baseURL, account }: { browser: Browser; baseURL: string | undefined; account: Account }): Promise<Page> {
  const context = await browser.newContext({ baseURL, viewport: { width: 412, height: 839 }, hasTouch: true, isMobile: true, locale: 'en-GB' });
  const page = await context.newPage();
  await signIn(page, account);
  return page;
}

/** The notes that the server has for the signed-in account. The request is a sync with no changes. */
async function serverNotes(page: Page): Promise<{ title: string; body: string }[]> {
  const reply = await page.request.post('/api/sync', { data: { clientId: '00000000-0000-4000-8000-000000000000', since: 0, ops: [], tz: 'UTC' } });
  if (!reply.ok()) return [];
  return ((await reply.json()) as { notes: { title: string; body: string }[] }).notes;
}

test.beforeEach(async ({ request, page }) => {
  // Each test starts from the seed data.
  const reply = await request.post('/api/test/reset', { data: {} });
  expect(reply.ok()).toBe(true);
  await signIn(page);
});

test.describe('the Notes tab', () => {
  test('sits between Starred and the first list, with the title "Notes" and the add button "New note"', async ({ page }) => {
    const names = await tabs(page)
      .getByRole('tab')
      .evaluateAll((all) => all.map((each) => each.getAttribute('aria-label') ?? each.textContent?.trim() ?? ''));
    expect(names.slice(0, 3)).toEqual(['Starred', 'Notes', 'My Tasks']);
    await goToNotes(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Notes');
    await expect(newNoteButton(page)).toBeEnabled();
    await tab(page, 'Home').click();
    await expect(page.getByRole('button', { name: 'Add a task' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tasks');
  });

  test('a swipe goes from the first list to the Notes page and on to Starred', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'The touch input of this test needs a CDP session, which only Chromium has');
    await swipe(page, { x: 60, y: 520 }, { x: 340, y: 520 });
    await expect(tab(page, 'Notes')).toHaveAttribute('aria-selected', 'true');
    await expect(card(page, 'Dinner party menu')).toBeInViewport();
    await page.waitForTimeout(300);
    await swipe(page, { x: 60, y: 600 }, { x: 340, y: 600 });
    await expect(tab(page, 'Starred')).toHaveAttribute('aria-selected', 'true');
    await page.waitForTimeout(300);
    await swipe(page, { x: 340, y: 600 }, { x: 60, y: 600 });
    await expect(tab(page, 'Notes')).toHaveAttribute('aria-selected', 'true');
    await page.waitForTimeout(300);
    await swipe(page, { x: 340, y: 600 }, { x: 60, y: 600 });
    await expect(tab(page, 'My Tasks')).toHaveAttribute('aria-selected', 'true');
  });

  test('shows "Pinned" and "Others", and the Archive button and the search change the cards', async ({ page }) => {
    await goToNotes(page);
    await expectCards(page, NOTES);
    await expect(notesPage(page).getByRole('heading', { name: 'Pinned' })).toBeVisible();
    await expect(card(page, 'Dinner party menu')).toContainText('Shared with Sam');

    await expect(archiveToggle(page)).toHaveAttribute('aria-pressed', 'false');
    await archiveToggle(page).click();
    await expect(archiveToggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expectCards(page, ['Gift ideas for Grandma']);
    await expect(searchField(page)).toHaveAttribute('placeholder', 'Search archive');
    await archiveToggle(page).click();

    await searchField(page).fill('piranesi');
    await expectCards(page, ['Book club reading list']);
    // Enter puts the keyboard away.
    await searchField(page).press('Enter');
    await expect(searchField(page)).not.toBeFocused();
    await searchField(page).fill('no such words');
    await expect(notesPage(page).getByText('No matching notes')).toBeVisible();
    await notesPage(page).getByRole('button', { name: 'Clear search' }).click();
    await expect(searchField(page)).toHaveValue('');
    await expectCards(page, NOTES);
  });

  test('a reload on the Notes tab starts there, with the add button ready', async ({ page }) => {
    await goToNotes(page);
    await page.waitForTimeout(300);
    await page.reload();
    await expect(tab(page, 'Notes')).toHaveAttribute('aria-selected', 'true');
    await expect(newNoteButton(page)).toBeEnabled();
    await expectCards(page, NOTES);
  });

  test('the page keeps its scroll position when the person comes back to it', async ({ page }) => {
    // The test makes 8 notes, one after the other, for a page that is long enough to scroll.
    test.slow();
    await goToNotes(page);
    for (let i = 0; i < 8; i++) {
      await newNoteButton(page).click();
      await expect(noteField(screen(page, 'New note'))).toBeFocused();
      await noteField(screen(page, 'New note')).fill(`Note number ${i}\nwith a second line\nand a third line\nand a fourth line\nand a fifth line`);
      await closeNote(page, 'New note');
    }
    await expect(notesPage(page).locator('[data-note-id]')).toHaveCount(12);
    await notesPage(page).evaluate((node) => (node.scrollTop = 150));
    await page.waitForTimeout(200);
    await tab(page, 'Groceries').click();
    await expect(tab(page, 'Groceries')).toHaveAttribute('aria-selected', 'true');
    await page.waitForTimeout(600);
    // The Notes page is not next to Groceries, so it has no content now.
    await expect(notesPage(page).locator('[data-note-id]')).toHaveCount(0);
    await tab(page, 'Notes').click();
    await expect.poll(() => notesPage(page).evaluate((node) => Math.round(node.scrollTop))).toBe(150);
  });
});

test.describe('the editor', () => {
  test('"New note" puts the focus in the body, and Back adds the card', async ({ page }) => {
    await goToNotes(page);
    await newNoteButton(page).click();
    const editor = screen(page, 'New note');
    await expect(noteField(editor)).toBeFocused();
    await page.keyboard.type('Milk');
    await titleField(editor).fill('Shopping');
    await goBack(page);
    await expect(editor).toHaveCount(0);
    // A new note is the newest, so it is first in "Others".
    await expectCards(page, ['Lake house checklist', 'Shopping', ...NOTES.slice(1)]);
    await expect(card(page, 'Shopping')).toContainText('Milk');
  });

  test('a new note that is empty again at the close makes no card and no message', async ({ page }) => {
    await goToNotes(page);
    await newNoteButton(page).click();
    const editor = screen(page, 'New note');
    await expect(noteField(editor)).toBeFocused();
    await page.keyboard.type('x');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(250);
    // The emptied note must not show as an "Empty note" card while the screen slides away. While
    // the screen covers the page, the person cannot see the card below it.
    await page.evaluate(() => {
      const state = window as unknown as { sawEmpty: boolean };
      state.sawEmpty = false;
      const look = (): void => {
        const editor = document.querySelector('[role="dialog"][aria-label="New note"]');
        const covered = editor !== null && Math.abs(editor.getBoundingClientRect().left) < 1;
        if (!covered && document.querySelector('[data-note-id] > button.open[aria-label="Empty note"]')) state.sawEmpty = true;
        requestAnimationFrame(look);
      };
      look();
    });
    await goBack(page);
    await expect(editor).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { sawEmpty: boolean }).sawEmpty)).toBe(false);
    await expectCards(page, NOTES);
    await expect(snackbar(page)).toHaveCount(0);
  });

  test('an older note that the person empties is deleted at the close, with Undo', async ({ page }) => {
    await goToNotes(page);
    const editor = await openNote(page, 'Ring the plumber before Friday');
    await noteField(editor).fill('');
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);
    await expect(snackbar(page)).toContainText('Note deleted');
    await expectCards(page, ['Lake house checklist', 'Dinner party menu', 'Book club reading list']);
    await snackbar(page).getByRole('button', { name: 'Undo' }).click();
    await expect(notesPage(page).locator('[data-note-id]')).toHaveCount(4);
  });

  test('the pin button moves the note to "Pinned" and back', async ({ page }) => {
    await goToNotes(page);
    let editor = await openNote(page, 'Book club reading list');
    await editor.getByRole('button', { name: 'Pin note' }).click();
    await expect(editor.getByRole('button', { name: 'Unpin note' })).toBeVisible();
    await closeNote(page);
    await expectCards(page, ['Lake house checklist', 'Book club reading list', 'Dinner party menu', 'Ring the plumber before Friday']);

    editor = await openNote(page, 'Lake house checklist');
    await editor.getByRole('button', { name: 'Unpin note' }).click();
    await closeNote(page);
    await expectCards(page, ['Book club reading list', 'Dinner party menu', 'Lake house checklist', 'Ring the plumber before Friday']);
  });

  test('Back closes the color sheet, then the menu, then the screen', async ({ page }) => {
    await goToNotes(page);
    const editor = await openNote(page, 'Dinner party menu');
    await expect(editor).toContainText(/Edited \d\d:\d\d by Sam/);
    await editor.getByRole('button', { name: 'Change color' }).click();
    const sheet = page.getByRole('dialog', { name: 'Color' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('radio', { name: 'Teal' }).click();
    await expect(sheet.getByRole('radio', { name: 'Teal' })).toHaveAttribute('aria-checked', 'true');
    await goBack(page);
    await expect(sheet).toHaveCount(0);
    await expect(editor).toBeVisible();

    await editor.getByRole('button', { name: 'Note options' }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await goBack(page);
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(editor).toBeVisible();
    await goBack(page);
    await expect(editor).toHaveCount(0);
    await expect(card(page, 'Dinner party menu')).toHaveAttribute('style', /note-teal/);
    await expect(page).toHaveURL(/\/$/);
  });
});

test.describe('the note menu', () => {
  test('"Archive" in the editor menu archives the note and closes the screen', async ({ page }) => {
    await goToNotes(page);
    const editor = await openNote(page, 'Book club reading list');
    await editor.getByRole('button', { name: 'Note options' }).click();
    await menuItem(page, 'Archive').click();
    await expect(editor).toHaveCount(0);
    await expect(snackbar(page)).toContainText('Note archived');
    await expectCards(page, NOTES.slice(0, 3));
    await archiveToggle(page).click();
    await expectCards(page, ['Book club reading list', 'Gift ideas for Grandma']);
  });

  test('"Delete" in the menu of a card deletes the note, and Undo brings it back', async ({ page }) => {
    await goToNotes(page);
    await cardMenu(page, 'Ring the plumber before Friday');
    // The heading of the sheet names the note.
    await expect(page.getByRole('dialog', { name: 'Ring the plumber before Friday' })).toBeVisible();
    await menuItem(page, 'Delete').click();
    await expect(snackbar(page)).toContainText('Note deleted');
    await expectCards(page, ['Lake house checklist', 'Dinner party menu', 'Book club reading list']);
    await snackbar(page).getByRole('button', { name: 'Undo' }).click();
    await expectCards(page, NOTES);
  });

  test('"Make tasks" adds a task for each open line, and Undo takes them back', async ({ page }) => {
    await goToNotes(page);
    await cardMenu(page, 'Dinner party menu');
    await menuItem(page, 'Make tasks').click();
    const ask = page.getByRole('dialog', { name: 'Make tasks' });
    await expect(ask).toBeVisible();
    // Tiramisu is checked, so it gives no task.
    await expect(ask.getByRole('radio', { name: 'A task for each line (2)' })).toBeChecked();
    await ask.getByRole('button', { name: 'Add 2 tasks' }).click();
    await expect(snackbar(page)).toContainText('2 tasks added to My Tasks');

    await tab(page, 'My Tasks').click();
    await expect(taskTitles(page, 'My Tasks')).toHaveText(['Lasagne', 'Green salad', ...MY_TASKS]);
    await snackbar(page).getByRole('button', { name: 'Undo' }).click();
    await expect(taskTitles(page, 'My Tasks')).toHaveText(MY_TASKS);
  });
});

test.describe('two people and no network', () => {
  test('a shared note shows the edits of the other person, and a stop of the sharing removes it there', async ({ page, browser, baseURL }) => {
    const theirs = await freshDevice({ browser, baseURL, account: sam });
    await goToNotes(theirs);
    await expectCards(theirs, ['Dinner party menu', 'Bike repair parts']);
    await expect(card(theirs, 'Dinner party menu')).toContainText('Shared by Alex');
    await goToNotes(page);

    // An edit of Sam arrives on the phone of Alex with no reload.
    const editor = await openNote(theirs, 'Dinner party menu');
    const body = await noteField(editor).inputValue();
    await noteField(editor).fill(`${body}\n- [ ] Garlic bread`);
    await closeNote(theirs);
    await expect(card(page, 'Dinner party menu')).toContainText('Garlic bread', { timeout: 10_000 });

    // The owner stops the sharing: the note goes away on the phone of Sam.
    await cardMenu(page, 'Dinner party menu');
    await menuItem(page, 'Stop sharing').click();
    await expect(snackbar(page)).toContainText('Stopped sharing');
    await expectCards(theirs, ['Bike repair parts']);
    await theirs.context().close();
  });

  test('an edit of a note with no network goes to the server later', async ({ page, context }) => {
    await goToNotes(page);
    const badge = page.getByTestId('sync-badge');
    await context.setOffline(true);
    const editor = await openNote(page, 'Lake house checklist');
    const body = await noteField(editor).inputValue();
    await noteField(editor).fill(`${body}\nTorch`);
    await closeNote(page);
    await expect(card(page, 'Lake house checklist')).toContainText('Torch');
    await expect(badge).toBeVisible();
    expect((await serverNotes(page)).find((note) => note.title === 'Lake house checklist')?.body).not.toContain('Torch');

    await context.setOffline(false);
    await expect(badge).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(async () => (await serverNotes(page)).find((note) => note.title === 'Lake house checklist')?.body).toContain('Torch');
  });
});

test.describe('links', () => {
  test('the addresses /?new=note and /?note=ID open the editor on the Notes tab', async ({ page }) => {
    await goToNotes(page);
    await archiveToggle(page).click();
    await expectCards(page, ['Gift ideas for Grandma']);
    const giftId = await card(page, 'Gift ideas for Grandma').getAttribute('data-note-id');
    await archiveToggle(page).click();
    await tab(page, 'Home').click();
    await page.waitForTimeout(300);

    await page.goto('/?new=note');
    const fresh = screen(page, 'New note');
    await expect(fresh).toBeVisible();
    await expect(tab(page, 'Notes')).toHaveAttribute('aria-selected', 'true');
    await expect(noteField(fresh)).toBeFocused();
    await expect(page).toHaveURL(/\/$/);
    await goBack(page);
    await expect(fresh).toHaveCount(0);

    await tab(page, 'Home').click();
    await page.waitForTimeout(300);
    await page.goto(`/?note=${giftId}`);
    const editor = screen(page);
    await expect(titleField(editor)).toHaveValue('Gift ideas for Grandma');
    await expect(tab(page, 'Notes')).toHaveAttribute('aria-selected', 'true');
    // An archived note opens with the archive on the page below it.
    await expect(archiveToggle(page)).toHaveAttribute('aria-pressed', 'true');
    await goBack(page);
    await expect(editor).toHaveCount(0);

    // /?new=1 on the Notes tab is a new task, in the first list.
    await page.goto('/?new=1');
    await expect(page.getByRole('dialog', { name: 'New task' })).toBeVisible();
    await expect(tab(page, 'My Tasks')).toHaveAttribute('aria-selected', 'true');
  });
});
