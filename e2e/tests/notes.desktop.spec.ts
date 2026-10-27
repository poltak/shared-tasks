// Tests of the notes in the wide layout: the Notes and Archive views, the composer, the cards,
// the editor dialog, the note menu, and a note that two people share.
// Run: E2E_PORT=5121 pnpm exec playwright test notes.desktop --config e2e/playwright.config.ts --project=desktop
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

import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

interface Account {
  name: string;
  password: string;
}
const { users } = JSON.parse(readFileSync(new URL('../fixtures/users.json', import.meta.url), 'utf8')) as { users: Account[] };
const alex = users[0]!;
const sam = users[1]!;

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

/** Control, or Command if the browser tells the app that it is on a Mac. Set after the sign-in. */
let MOD: 'Control' | 'Meta' = 'Control';

async function signIn(page: Page, account: Account = alex): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Name').fill(account.name);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByTestId('app-ready')).toBeAttached();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('region', { name: 'My Tasks', exact: true })).toBeVisible();
  const mac = await page.evaluate(() =>
    /mac|iphone|ipad|ipod/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? ''),
  );
  MOD = mac ? 'Meta' : 'Control';
}

// ---- Parts of the screen ----

const sidebar = (page: Page): Locator => page.locator('#wide-sidebar');
const notesView = (page: Page): Locator => sidebar(page).getByRole('button', { name: 'Notes', exact: true });
const archiveView = (page: Page): Locator => sidebar(page).getByRole('button', { name: 'Archive', exact: true });
const allTasks = (page: Page): Locator => sidebar(page).getByRole('button', { name: 'All tasks' });
/** A card, found by the name of its open button: the title, the first line of the body, or "Empty note". */
const card = (page: Page, name: string): Locator => page.locator('[data-note-id]').filter({ has: page.getByRole('button', { name, exact: true }) });
const cardButton = (page: Page, name: string): Locator => card(page, name).getByRole('button', { name, exact: true });
const composerButton = (page: Page): Locator => page.getByRole('button', { name: 'Take a note…' });
const noteField = (scope: Page | Locator): Locator => scope.getByRole('textbox', { name: 'Note', exact: true });
const titleField = (scope: Page | Locator): Locator => scope.getByRole('textbox', { name: 'Title', exact: true });
const dialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Note', exact: true });
const search = (page: Page, name = 'Search notes'): Locator => page.getByRole('searchbox', { name });
const snackbar = (page: Page): Locator => page.getByRole('status').filter({ hasText: /\S/ }).last();
const item = (page: Page, name: string): Locator => page.getByRole('menu').getByRole('menuitem', { name, exact: true });

/** The names of the cards, in the order of the document: "Pinned", then "Others". */
function cardNames(page: Page): Promise<string[]> {
  return page.locator('[data-note-id] > button.open').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label') ?? ''));
}
const expectCards = (page: Page, names: string[]): Promise<void> => expect.poll(() => cardNames(page)).toEqual(names);

async function showNotes(page: Page): Promise<void> {
  await notesView(page).click();
  await expect(notesView(page)).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('[data-note-id]').first()).toBeVisible();
}

async function openCard(page: Page, name: string): Promise<Locator> {
  await cardButton(page, name).click();
  await expect(dialog(page)).toBeVisible();
  await expect(titleField(dialog(page))).toBeVisible();
  return dialog(page);
}

/** The note menu of a card, from a right click. */
async function cardMenu(page: Page, name: string): Promise<void> {
  await card(page, name).click({ button: 'right', position: { x: 40, y: 20 } });
  await expect(page.getByRole('menu', { name: 'Note options' })).toBeVisible();
}

/** The text of the column "My Tasks", top to bottom. */
function taskTitles(page: Page): Promise<string[]> {
  return page
    .getByRole('main')
    .getByRole('region', { name: 'My Tasks', exact: true })
    .getByRole('list', { name: 'Tasks', exact: true })
    .locator('[data-row-id] button.title')
    .allTextContents();
}

/** The notes that the server has for the signed-in account. The request is a sync with no changes. */
async function serverNotes(page: Page): Promise<{ title: string; body: string; color: string }[]> {
  const reply = await page.request.post('/api/sync', { data: { clientId: '00000000-0000-4000-8000-000000000000', since: 0, ops: [], tz: 'UTC' } });
  if (!reply.ok()) return [];
  return ((await reply.json()) as { notes: { title: string; body: string; color: string }[] }).notes;
}

test.beforeEach(async ({ page, request }) => {
  // Each test starts from the seed data, with a new browser profile.
  const reply = await request.post('/api/test/reset', { data: {} });
  expect(reply.ok()).toBe(true);
  await signIn(page);
});

test.describe('views', () => {
  test('"Notes" shows the pinned notes first, and "Archive" shows the archived notes', async ({ page }) => {
    await showNotes(page);
    await expect(allTasks(page)).not.toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'Notes', exact: true })).toBeVisible();
    await expect(search(page)).toBeVisible();
    await expect(composerButton(page)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pinned' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Others' })).toBeVisible();
    await expectCards(page, NOTES);
    await expect(card(page, 'Dinner party menu')).toContainText('Shared with Sam');
    await expect(card(page, 'Dinner party menu')).toContainText('Lasagne');

    await archiveView(page).click();
    await expect(archiveView(page)).toHaveAttribute('aria-current', 'page');
    await expect(search(page, 'Search archive')).toBeVisible();
    await expect(composerButton(page)).toHaveCount(0);
    await expectCards(page, ['Gift ideas for Grandma']);

    await allTasks(page).click();
    await expect(page.getByRole('main').getByRole('region', { name: 'My Tasks', exact: true })).toBeVisible();
  });

  test('a reload in the archive starts with the notes', async ({ page }) => {
    await archiveView(page).click();
    await expect(card(page, 'Gift ideas for Grandma')).toBeVisible();
    await page.waitForTimeout(200);
    await page.reload();
    await expect(composerButton(page)).toBeVisible();
    await expect(notesView(page)).toHaveAttribute('aria-current', 'page');
  });

  test('the search filters the notes of the view, and with no result shows "No matching notes"', async ({ page }) => {
    await showNotes(page);
    await search(page).fill('piranesi');
    await expectCards(page, ['Book club reading list']);
    // The search ignores case and accents.
    await search(page).fill('PIRANÉSI');
    await expectCards(page, ['Book club reading list']);
    await search(page).fill('plumber friday');
    await expectCards(page, ['Ring the plumber before Friday']);
    await search(page).fill('no such words');
    await expect(page.getByText('No matching notes')).toBeVisible();
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(search(page)).toHaveValue('');
    await expectCards(page, NOTES);

    await archiveView(page).click();
    await search(page, 'Search archive').fill('scarf');
    await expectCards(page, ['Gift ideas for Grandma']);
    await search(page, 'Search archive').fill('piranesi');
    await expect(page.getByText('No matching notes')).toBeVisible();
  });

  test('keys: n opens the composer, Esc closes it, and / goes to the search', async ({ page }) => {
    await showNotes(page);
    await page.locator('body').click({ position: { x: 700, y: 850 } });
    await page.keyboard.press('n');
    await expect(noteField(page)).toBeFocused();
    await page.keyboard.type('From the keyboard');
    await page.keyboard.press('Escape');
    await expect(composerButton(page)).toBeFocused();
    await expect(card(page, 'From the keyboard')).toBeVisible();

    await page.locator('body').click({ position: { x: 700, y: 850 } });
    await page.keyboard.press('/');
    await expect(search(page)).toBeFocused();
    await page.keyboard.type('piranesi');
    await expectCards(page, ['Book club reading list']);
    // The first Esc clears the field, the second leaves it.
    await page.keyboard.press('Escape');
    await expect(search(page)).toHaveValue('');
    await page.keyboard.press('Escape');
    await expect(search(page)).not.toBeFocused();
  });
});

test.describe('add and edit', () => {
  test('the composer adds a note, which stays out of the grid until the composer closes', async ({ page }) => {
    await showNotes(page);
    await composerButton(page).click();
    await expect(noteField(page)).toBeFocused();
    await page.keyboard.type('Stamps\nEnvelopes');
    await titleField(page).click();
    await page.keyboard.type('Post office');
    await expect(card(page, 'Post office')).toHaveCount(0);

    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(composerButton(page)).toBeVisible();
    // A new note is the newest, so it is first in "Others".
    await expectCards(page, ['Lake house checklist', 'Post office', ...NOTES.slice(1)]);
    await expect(card(page, 'Post office')).toContainText('Envelopes');
    await expect.poll(async () => (await serverNotes(page)).find((note) => note.title === 'Post office')?.body).toBe('Stamps\nEnvelopes');

    // A click outside closes the composer too. A composer with no text makes no note.
    await composerButton(page).click();
    await page.keyboard.type('Second note');
    await page.getByRole('heading', { name: 'Notes', exact: true }).click();
    await expect(card(page, 'Second note')).toBeVisible();
    await composerButton(page).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-note-id]')).toHaveCount(6);
  });

  test('the dialog saves while the person types, and shows who made the last edit', async ({ page }) => {
    await showNotes(page);
    const editor = await openCard(page, 'Dinner party menu');
    await expect(editor).toContainText(/Edited \d\d:\d\d by Sam/);
    await expect(titleField(editor)).toHaveValue('Dinner party menu');

    await noteField(editor).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n- [ ] Garlic bread');
    // The text goes to the server with no close of the dialog.
    await expect.poll(async () => (await serverNotes(page)).find((note) => note.title === 'Dinner party menu')?.body).toContain('Garlic bread');
    await expect(editor).toContainText(/Edited \d\d:\d\d/);
    await expect(editor).not.toContainText('by Sam');

    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(card(page, 'Dinner party menu')).toContainText('Garlic bread');
    // The focus goes back to the card.
    await expect(cardButton(page, 'Dinner party menu')).toBeFocused();
  });

  test('a note that the person empties is deleted at the close, with Undo', async ({ page }) => {
    await showNotes(page);
    const editor = await openCard(page, 'Book club reading list');
    await titleField(editor).fill('');
    await noteField(editor).fill('');
    await page.waitForTimeout(200);
    // A click outside of the dialog closes it.
    await page.mouse.click(20, 850);
    await expect(dialog(page)).toHaveCount(0);
    await expect(snackbar(page)).toContainText('Note deleted');
    await expect(card(page, 'Book club reading list')).toHaveCount(0);
    await expect(card(page, 'Empty note')).toHaveCount(0);
    // The undo of the delete brings back the note as the close found it. The text that the person
    // removed is the undo step before it.
    await snackbar(page).getByRole('button', { name: 'Undo' }).click();
    await expectCards(page, [...NOTES.slice(0, 3), 'Empty note']);
    await page.keyboard.press(`${MOD}+z`);
    await expectCards(page, NOTES);
    await expect(card(page, 'Book club reading list')).toContainText('Piranesi');
  });
});

test.describe('card and menu', () => {
  test('color: the color button of a card, and "Change color" in the dialog menu', async ({ page }) => {
    await showNotes(page);
    const book = card(page, 'Book club reading list');
    await book.hover();
    await book.getByRole('button', { name: 'Change color' }).click();
    const picker = page.getByRole('radiogroup', { name: 'Note color' });
    await expect(picker).toBeVisible();
    await picker.getByRole('radio', { name: 'Purple' }).click();
    await expect(book).toHaveAttribute('style', /note-purple/);
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);

    const editor = await openCard(page, 'Dinner party menu');
    await editor.getByRole('button', { name: 'Note options' }).click();
    await item(page, 'Change color').click();
    await page.getByRole('radio', { name: 'Teal' }).click();
    await expect(page.getByRole('radio', { name: 'Teal' })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(card(page, 'Dinner party menu')).toHaveAttribute('style', /note-teal/);
    await expect.poll(async () => (await serverNotes(page)).find((note) => note.title === 'Dinner party menu')?.color).toBe('teal');
  });

  test('pin: the pin button of a card and the menu move the note between "Pinned" and "Others"', async ({ page }) => {
    await showNotes(page);
    const lake = card(page, 'Lake house checklist');
    await lake.hover();
    await lake.getByRole('button', { name: 'Unpin note' }).click();
    // With no pinned note, the grid has no headings.
    await expect(page.getByRole('heading', { name: 'Pinned' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Others' })).toHaveCount(0);
    await expectCards(page, ['Dinner party menu', 'Lake house checklist', 'Ring the plumber before Friday', 'Book club reading list']);

    await cardMenu(page, 'Book club reading list');
    await item(page, 'Pin').click();
    await expect(page.getByRole('heading', { name: 'Pinned' })).toBeVisible();
    await expectCards(page, ['Book club reading list', 'Dinner party menu', 'Lake house checklist', 'Ring the plumber before Friday']);
    await cardMenu(page, 'Book club reading list');
    await expect(item(page, 'Unpin')).toBeVisible();
  });

  test('archive: the archive button of a card, Undo, and "Unarchive" in the Archive view', async ({ page }) => {
    await showNotes(page);
    const book = card(page, 'Book club reading list');
    await book.hover();
    await book.getByRole('button', { name: 'Archive' }).click();
    await expect(snackbar(page)).toContainText('Note archived');
    await expectCards(page, NOTES.slice(0, 3));
    await snackbar(page).getByRole('button', { name: 'Undo' }).click();
    await expectCards(page, NOTES);

    // The archive button of the dialog archives the note and closes the dialog.
    const editor = await openCard(page, 'Lake house checklist');
    await editor.getByRole('button', { name: 'Archive' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(snackbar(page)).toContainText('Note archived');
    await expect(page.getByRole('heading', { name: 'Pinned' })).toHaveCount(0);

    await archiveView(page).click();
    // An archived note is not pinned any more.
    await expectCards(page, ['Lake house checklist', 'Gift ideas for Grandma']);
    const gift = card(page, 'Gift ideas for Grandma');
    await gift.hover();
    await gift.getByRole('button', { name: 'Unarchive' }).click();
    await expect(snackbar(page)).toContainText('Note unarchived');
    await expectCards(page, ['Lake house checklist']);
    await notesView(page).click();
    await expectCards(page, ['Dinner party menu', 'Ring the plumber before Friday', 'Book club reading list', 'Gift ideas for Grandma']);
  });

  test('"Delete" in the menu deletes the note, and Undo and Ctrl+Z bring it back', async ({ page }) => {
    await showNotes(page);
    await cardMenu(page, 'Ring the plumber before Friday');
    await item(page, 'Delete').click();
    await expect(snackbar(page)).toContainText('Note deleted');
    await expectCards(page, ['Lake house checklist', 'Dinner party menu', 'Book club reading list']);
    await snackbar(page).getByRole('button', { name: 'Undo' }).click();
    await expectCards(page, NOTES);

    await cardMenu(page, 'Book club reading list');
    await item(page, 'Delete').click();
    await expect(card(page, 'Book club reading list')).toHaveCount(0);
    await expect(page.getByRole('menu')).toHaveCount(0);
    await page.keyboard.press(`${MOD}+z`);
    await expectCards(page, NOTES);
    await expect.poll(async () => (await serverNotes(page)).length).toBe(5);
  });

  test('"Make tasks" adds a task for each open line of a list, and Undo takes them back', async ({ page }) => {
    await showNotes(page);
    await cardMenu(page, 'Dinner party menu');
    await item(page, 'Make tasks').click();
    const ask = page.getByRole('dialog', { name: 'Make tasks' });
    await expect(ask).toBeVisible();
    // Tiramisu is checked, so it gives no task.
    await expect(ask.getByRole('radio', { name: 'A task for each line (2)' })).toBeChecked();
    await ask.getByRole('checkbox', { name: 'Archive the note' }).check();
    await ask.getByRole('button', { name: 'Add 2 tasks' }).click();
    await expect(snackbar(page)).toContainText('2 tasks added to My Tasks');
    // The shell takes Ctrl+Z only when no overlay is open, and the dialog is one until its exit motion ends.
    await expect(ask).toHaveCount(0);
    await expect(card(page, 'Dinner party menu')).toHaveCount(0);

    await allTasks(page).click();
    await expect.poll(() => taskTitles(page)).toEqual(['Lasagne', 'Green salad', ...MY_TASKS]);
    // One undo step takes back the tasks and the archive.
    await page.keyboard.press(`${MOD}+z`);
    await expect.poll(() => taskTitles(page)).toEqual(MY_TASKS);
    await showNotes(page);
    await expectCards(page, NOTES);
  });
});

test.describe('two people', () => {
  test('a shared note shows the edits of the other person, and a stop of the sharing removes it there', async ({ page, browser }) => {
    const other = await browser.newContext({ locale: 'en-GB' });
    const theirs = await other.newPage();
    await signIn(theirs, sam);
    await showNotes(theirs);
    await expectCards(theirs, ['Dinner party menu', 'Bike repair parts']);
    await expect(card(theirs, 'Dinner party menu')).toContainText('Shared by Alex');
    await showNotes(page);

    // An edit of Sam arrives in the grid of Alex with no reload.
    const editor = await openCard(theirs, 'Dinner party menu');
    await noteField(editor).click();
    await theirs.keyboard.press('Control+End');
    await theirs.keyboard.type('\n- [ ] Garlic bread');
    await theirs.keyboard.press('Escape');
    await expect(dialog(theirs)).toHaveCount(0);
    await expect(card(page, 'Dinner party menu')).toContainText('Garlic bread', { timeout: 10_000 });

    // Only the owner can delete the note.
    await cardMenu(theirs, 'Dinner party menu');
    const remove = theirs.getByRole('menu').locator('[data-item="delete"]');
    await expect(remove).toHaveAttribute('aria-disabled', 'true');
    await expect(remove).toContainText('Only Alex can delete this note');
    await expect(item(theirs, 'Shared by Alex')).toHaveAttribute('aria-disabled', 'true');
    await theirs.keyboard.press('Escape');

    // A share shows the note for Sam.
    await cardMenu(page, 'Book club reading list');
    await item(page, 'Share with Sam').click();
    await expect(snackbar(page)).toContainText('Shared with Sam');
    await expectCards(theirs, ['Dinner party menu', 'Book club reading list', 'Bike repair parts']);

    // A stop of the sharing removes the note for Sam.
    await cardMenu(page, 'Dinner party menu');
    await item(page, 'Stop sharing').click();
    await expect(snackbar(page)).toContainText('Stopped sharing');
    await expectCards(theirs, ['Book club reading list', 'Bike repair parts']);
    await expect(card(page, 'Dinner party menu')).not.toContainText('Shared with Sam');
    await other.close();
  });
});

test.describe('no network', () => {
  test('an edit of a note with no network goes to the server later', async ({ page, context }) => {
    await showNotes(page);
    const badge = page.getByTestId('sync-badge');
    await context.setOffline(true);
    const editor = await openCard(page, 'Lake house checklist');
    await noteField(editor).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nTorch');
    await page.keyboard.press('Escape');
    await expect(card(page, 'Lake house checklist')).toContainText('Torch');
    await expect(badge).toHaveAttribute('aria-label', /Offline/);
    expect((await serverNotes(page)).find((note) => note.title === 'Lake house checklist')?.body).not.toContain('Torch');

    await context.setOffline(false);
    await expect(badge).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(async () => (await serverNotes(page)).find((note) => note.title === 'Lake house checklist')?.body).toContain('Torch');
  });
});

test.describe('links', () => {
  test('the address /?new=note opens the composer, and /?note=ID opens that note', async ({ page }) => {
    await page.goto('/?new=note');
    await expect(noteField(page)).toBeFocused();
    await expect(notesView(page)).toHaveAttribute('aria-current', 'page');
    await page.keyboard.type('Launched');
    await page.keyboard.press('Escape');
    await expect(card(page, 'Launched')).toBeVisible();

    await archiveView(page).click();
    const giftId = await card(page, 'Gift ideas for Grandma').getAttribute('data-note-id');
    await allTasks(page).click();
    await page.waitForTimeout(200);
    await page.goto(`/?note=${giftId}`);
    await expect(dialog(page)).toBeVisible();
    // An archived note opens in the Archive view.
    await expect(archiveView(page)).toHaveAttribute('aria-current', 'page');
    await expect(titleField(dialog(page))).toHaveValue('Gift ideas for Grandma');
    expect(page.url()).not.toContain('note=');
  });
});
