// Tests of the app shell: sign-in, the session, Settings. They do not use the content of a layout.
// Run: E2E_PORT=5123 E2E_WEB_DIR=<build folder> pnpm exec playwright test --config e2e/playwright.config.ts shell

import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

interface Account {
  name: string;
  password: string;
}
const { users } = JSON.parse(readFileSync(new URL('../fixtures/users.json', import.meta.url), 'utf8')) as { users: Account[] };
const alex = users[0]!;
const sam = users[1]!;

const isPhone = (page: Page): boolean => page.viewportSize()!.width < 840;
const app = (page: Page): Locator => page.getByTestId('app-ready');
const nameField = (page: Page): Locator => page.locator('input[name="username"]');
const passwordField = (page: Page): Locator => page.locator('input[name="password"]');
const againField = (page: Page): Locator => page.locator('input[name="password-again"]');
const signInButton = (page: Page): Locator => page.getByRole('button', { name: 'Sign in', exact: true });
const settings = (page: Page): Locator => page.getByRole('dialog', { name: 'Settings' });

async function signIn(page: Page, account: Account = alex): Promise<void> {
  await page.goto('/');
  await nameField(page).fill(account.name);
  await passwordField(page).fill(account.password);
  await signInButton(page).click();
  // The root of the signed-in app has no box of its own, so "attached" is the test.
  await expect(app(page)).toBeAttached();
  await expect(signInButton(page)).toHaveCount(0);
}

/** The address /#settings is the way into Settings that needs no control of a layout. */
async function openSettings(page: Page): Promise<Locator> {
  await page.evaluate(() => {
    location.hash = '#settings';
  });
  const dialog = settings(page);
  await expect(dialog).toBeVisible();
  await expect.poll(() => historyDepth(page)).toBe(1);
  // A click during the entry animation makes Playwright scroll the content.
  await page.waitForTimeout(250);
  return dialog;
}

/**
 * The number of overlay entries in the history. The overlay stack adds the entry of a dialog a
 * moment after the dialog shows, so a test waits for the number before it goes back.
 */
const historyDepth = (page: Page): Promise<number> =>
  page.evaluate(() => (history.state as { stOverlay?: number } | null)?.stOverlay ?? 0);

const localDatabases = (page: Page): Promise<string[]> =>
  page.evaluate(async () => (await indexedDB.databases()).map((database) => database.name ?? '').filter((name) => name.startsWith('st-')));

test.beforeEach(async ({ request }) => {
  // Each test starts from the seed data: two accounts, and room for one more.
  const reply = await request.post('/api/test/reset', { data: {} });
  expect(reply.ok()).toBe(true);
});

test.describe('sign-in', () => {
  test('shows the card with the name of the app and no app content', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Shared Tasks' })).toBeVisible();
    await expect(page.locator('img[src="/icons/icon.svg"]')).toBeVisible();
    await expect(nameField(page)).toHaveAttribute('autocomplete', 'username');
    await expect(passwordField(page)).toHaveAttribute('autocomplete', 'current-password');
    await expect(app(page)).toHaveCount(0);
    // A mouse user can type at once. On a phone, the keyboard must not cover the screen at the start.
    if (isPhone(page)) await expect(nameField(page)).not.toBeFocused();
    else await expect(nameField(page)).toBeFocused();
  });

  test('a wrong password shows the error below the field', async ({ page }) => {
    await page.goto('/');
    await nameField(page).fill(alex.name);
    await passwordField(page).fill('not-the-password');
    await signInButton(page).click();

    await expect(page.getByRole('alert')).toHaveText('The name or the password is wrong');
    await expect(passwordField(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(passwordField(page)).toBeFocused();
    await expect(app(page)).toHaveCount(0);

    // The error goes away when the person types again, and the right password then works.
    await passwordField(page).fill(alex.password);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await signInButton(page).click();
    await expect(app(page)).toBeAttached();
  });

  test('empty fields show their errors and send no request', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/login')) requests.push(request.url());
    });
    await page.goto('/');
    await signInButton(page).click();
    await expect(page.getByRole('alert')).toHaveText(['Enter your name', 'Enter your password']);
    await expect(nameField(page)).toBeFocused();
    expect(requests).toEqual([]);
  });

  test('sign in works and shows the app', async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole('heading', { name: 'Shared Tasks' })).toHaveCount(0);
  });

  test('the keyboard alone signs in', async ({ page }) => {
    await page.goto('/');
    await nameField(page).focus();
    await page.keyboard.type(alex.name);
    // With no password, Enter goes to the password field.
    await page.keyboard.press('Enter');
    await expect(passwordField(page)).toBeFocused();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.keyboard.type(alex.password);
    await page.keyboard.press('Enter');
    await expect(app(page)).toBeAttached();
  });

  test('the button is disabled while the request runs', async ({ page }) => {
    await page.route('**/api/login', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.continue();
    });
    await page.goto('/');
    await nameField(page).fill(alex.name);
    await passwordField(page).fill(alex.password);
    await signInButton(page).click();
    await expect(signInButton(page)).toBeDisabled();
    await expect(app(page)).toBeAttached();
  });

  test('a reload stays signed in and never shows the sign-in screen', async ({ page }) => {
    await signIn(page);
    await page.addInitScript(() => {
      const state = window as unknown as { sawSignIn: boolean };
      state.sawSignIn = false;
      new MutationObserver(() => {
        if (document.querySelector('input[name="username"]')) state.sawSignIn = true;
      }).observe(document, { childList: true, subtree: true });
    });
    await page.reload();
    await expect(app(page)).toBeAttached();
    expect(await page.evaluate(() => (window as unknown as { sawSignIn: boolean }).sawSignIn)).toBe(false);
  });

  test('a reload with no answer from the server still shows the app', async ({ page }) => {
    await signIn(page);
    await page.route('**/api/**', (route) => route.abort());
    await page.reload();
    await expect(app(page)).toBeAttached();
    await expect(signInButton(page)).toHaveCount(0);
  });

  test('create account works, and sign-up then closes', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('radio', { name: 'Create account' }).click();
    await expect(passwordField(page)).toHaveAttribute('autocomplete', 'new-password');
    await expect(againField(page)).toHaveAttribute('autocomplete', 'new-password');

    await nameField(page).fill('Kim');
    await passwordField(page).fill('kim-secret-77');
    await againField(page).fill('kim-secret-78');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('alert')).toHaveText('The two passwords are not the same');
    await expect(againField(page)).toBeFocused();

    await againField(page).fill('kim-secret-77');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(app(page)).toBeAttached();

    const dialog = await openSettings(page);
    await expect(dialog.getByTestId('account-name')).toHaveText('Kim');
    await expect(dialog.getByTestId('accounts')).toContainText('Kim (you)');

    // The test server has room for three accounts. Kim is the third.
    await dialog.getByRole('button', { name: 'Sign out' }).click();
    await expect(signInButton(page)).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Create account' })).toHaveCount(0);

    await nameField(page).fill('kim');
    await passwordField(page).fill('kim-secret-77');
    await signInButton(page).click();
    await expect(app(page)).toBeAttached();
  });

  test('create account shows the error of the server below the name', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('radio', { name: 'Create account' }).click();
    await nameField(page).fill(sam.name);
    await passwordField(page).fill('a-long-password');
    await againField(page).fill('a-long-password');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('alert')).toHaveText('This name is in use');
    await expect(nameField(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(nameField(page)).toBeFocused();
  });
});

test.describe('settings', () => {
  test('Settings opens and Back closes it', async ({ page }) => {
    await signIn(page);
    const dialog = await openSettings(page);
    for (const part of ['Account', 'Appearance', 'Notifications', 'Sync', 'About']) {
      await expect(dialog.getByRole('heading', { name: part, exact: true })).toBeVisible();
    }
    await expect(dialog.getByTestId('account-name')).toHaveText(alex.name);
    await expect(dialog.getByTestId('version')).toHaveText(/^Version \d+\.\d+\.\d+/);
    await expect(dialog.getByTestId('accounts')).toHaveText(`Accounts: ${alex.name} (you) and ${sam.name}`);
    await expect(dialog.getByTestId('sync-state')).toHaveText('Up to date');
    await expect(dialog.getByTestId('sync-pending')).toHaveText('No pending changes');
    await expect(dialog.getByTestId('sync-last')).toHaveText(/^Last sync: Today, \d\d:\d\d$/);
    // The address is clean, so a reload does not open Settings again.
    expect(new URL(page.url()).hash).toBe('');

    await page.goBack();
    await expect(dialog).toBeHidden();
    await expect(app(page)).toBeAttached();
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('Back closes the dialog on top first, then Settings', async ({ page, browserName }) => {
    await signIn(page);
    const dialog = await openSettings(page);
    await dialog.getByRole('button', { name: 'Change password' }).click();
    const form = page.getByRole('dialog', { name: 'Change password' });
    await expect(form).toBeVisible();
    await expect.poll(() => historyDepth(page)).toBe(2);

    await page.goBack();
    await expect(form).toBeHidden();
    await expect(dialog).toBeVisible();
    // The focus goes back to the control that opened the dialog. Safari does not give the focus
    // to a button on a click, so there is no control to go back to.
    if (browserName !== 'webkit') await expect(dialog.getByRole('button', { name: 'Change password' })).toBeFocused();
    await expect.poll(() => historyDepth(page)).toBe(1);

    await page.goBack();
    await expect(dialog).toBeHidden();
    await expect(app(page)).toBeAttached();
    await expect.poll(() => historyDepth(page)).toBe(0);
  });

  test('Settings is a full screen on the phone and a dialog on a wide screen', async ({ page }) => {
    await signIn(page);
    const dialog = await openSettings(page);
    const box = (await dialog.boundingBox())!;
    const view = page.viewportSize()!;
    if (isPhone(page)) {
      expect(box.width).toBe(view.width);
      expect(box.height).toBe(view.height);
      await dialog.getByRole('button', { name: 'Back' }).click();
    } else {
      expect(box.width).toBe(480);
      expect(box.height).toBeLessThan(view.height);
      // All parts show with no scroll at the size of the desktop project.
      await expect(dialog.getByTestId('accounts')).toBeInViewport({ ratio: 1 });
      await page.keyboard.press('Escape');
    }
    await expect(dialog).toBeHidden();
    await expect(app(page)).toBeAttached();
  });

  test('the address /#settings opens Settings at the start', async ({ page }) => {
    await signIn(page);
    await page.goto('/#settings');
    await expect(settings(page)).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
  });

  test('the theme setting changes data-theme and stays after a reload', async ({ page }) => {
    const html = page.locator('html');
    await signIn(page);
    await expect(html).not.toHaveAttribute('data-theme');

    let dialog = await openSettings(page);
    await expect(dialog.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true');
    await dialog.getByRole('radio', { name: 'Dark' }).click();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(17, 19, 24)');

    // The inline script of index.html sets the theme before the scripts of the app run.
    await page.addInitScript(() => {
      const state = window as unknown as { themeAtBody?: string | null; barAtBody?: string | null };
      const watch = new MutationObserver(() => {
        if (!document.body) return;
        state.themeAtBody = document.documentElement.dataset.theme ?? null;
        state.barAtBody = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content ?? null;
        watch.disconnect();
      });
      watch.observe(document, { childList: true, subtree: true });
    });
    await page.reload();
    await expect(app(page)).toBeAttached();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => (window as unknown as { themeAtBody?: string | null }).themeAtBody)).toBe('dark');
    expect(await page.evaluate(() => (window as unknown as { barAtBody?: string | null }).barAtBody)).toBe('#111318');

    dialog = await openSettings(page);
    await expect(dialog.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
    await dialog.getByRole('radio', { name: 'Light' }).click();
    await expect(html).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(246, 248, 252)');
    await dialog.getByRole('radio', { name: 'System' }).click();
    await expect(html).not.toHaveAttribute('data-theme');
  });

  test('sign out returns to sign-in and clears the local data', async ({ page }) => {
    await signIn(page);
    expect(await localDatabases(page)).toHaveLength(1);

    const dialog = await openSettings(page);
    await dialog.getByRole('button', { name: 'Sign out' }).click();

    await expect(signInButton(page)).toBeVisible();
    await expect(app(page)).toHaveCount(0);
    await expect(dialog).toBeHidden();
    await expect.poll(() => localDatabases(page)).toEqual([]);
    expect(await page.evaluate(() => (JSON.parse(localStorage.getItem('st.session') ?? '{}') as { me?: unknown }).me)).toBeNull();

    // The session is over on the server too.
    await page.reload();
    await expect(signInButton(page)).toBeVisible();
    expect(await (await page.request.get('/api/me')).json()).toMatchObject({ me: null });
  });

  test('the name changes, and a name in use shows its error', async ({ page }) => {
    await signIn(page);
    const dialog = await openSettings(page);
    await dialog.getByRole('button', { name: 'Edit name' }).click();
    const field = dialog.locator('input[name="username"]');
    await expect(field).toBeFocused();
    await expect(field).toHaveValue(alex.name);

    await field.fill(sam.name);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('This name is in use');

    await field.fill('Alexandra');
    await page.keyboard.press('Enter');
    await expect(dialog.getByTestId('account-name')).toHaveText('Alexandra');
    await expect(dialog.getByTestId('accounts')).toContainText('Alexandra (you)');

    // Esc ends the edit and keeps Settings open.
    await dialog.getByRole('button', { name: 'Edit name' }).click();
    await field.fill('Other');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('account-name')).toHaveText('Alexandra');
  });

  test('the password changes, and the new one signs in', async ({ page }) => {
    await signIn(page);
    const dialog = await openSettings(page);
    await dialog.getByRole('button', { name: 'Change password' }).click();
    const form = page.getByRole('dialog', { name: 'Change password' });
    const current = form.locator('input[name="current-password"]');
    const next = form.locator('input[name="new-password"]');
    const again = form.locator('input[name="new-password-again"]');
    await expect(current).toBeFocused();

    await current.fill('not-the-password');
    await next.fill('new-secret-123');
    await again.fill('new-secret-123');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form.getByRole('alert')).toHaveText('The current password is wrong');

    await current.fill(alex.password);
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'Password changed' })).toBeVisible();
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Sign out' }).click();
    await nameField(page).fill(alex.name);
    await passwordField(page).fill(alex.password);
    await signInButton(page).click();
    await expect(page.getByRole('alert')).toHaveText('The name or the password is wrong');
    await passwordField(page).fill('new-secret-123');
    await signInButton(page).click();
    await expect(app(page)).toBeAttached();
  });

  test('"Sync now" asks the server, and "Send test notification" shows its result', async ({ page }) => {
    await signIn(page);
    const dialog = await openSettings(page);
    const sync = page.waitForRequest((request) => request.url().endsWith('/api/sync') && request.method() === 'POST');
    await dialog.getByRole('button', { name: 'Sync now' }).click();
    await sync;
    await expect(dialog.getByTestId('sync-state')).toHaveText('Up to date');

    await dialog.getByRole('button', { name: 'Send test notification' }).click();
    await expect(dialog.getByTestId('notify-result')).toHaveText('No device has notifications turned on');
  });
});

test.describe('first download', () => {
  // SPEC.md section 1. The app loads its layout with a dynamic import, so index.html names only
  // a part of the first screen and the number of scripts/postbuild.ts is too small. This test
  // counts all of it: the scripts of index.html, the file of the layout, and each file that
  // these import with a static import.
  const LIMIT = 90_000;
  const STATIC_IMPORT = /\b(?:import|export)\s*(?:[^"'()]*?\bfrom\s*)?["'](\.\/[^"']+\.js)["']/g;

  async function firstScreen({ request, layout }: { request: APIRequestContext; layout: string }): Promise<Map<string, number>> {
    const html = await (await request.get('/')).text();
    const entries = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((match) => match[1]!);
    expect(entries.length, 'index.html names a script').toBeGreaterThan(0);

    const sizes = new Map<string, number>();
    const texts = new Map<string, string>();
    async function add(file: string): Promise<void> {
      if (sizes.has(file)) return;
      const reply = await request.get(file);
      expect(reply.ok(), `${file} is there`).toBe(true);
      const body = await reply.body();
      // The same compression as scripts/postbuild.ts.
      sizes.set(file, gzipSync(body, { level: 9 }).length);
      const text = body.toString('utf8');
      texts.set(file, text);
      for (const match of text.matchAll(STATIC_IMPORT)) await add(new URL(match[1]!, `http://x${file}`).pathname);
    }
    for (const entry of entries) await add(entry);

    // The entry names the file of a dynamic import in a list for the preload, or in the import itself.
    const name = new RegExp(`\\b${layout}-[\\w-]+\\.js`);
    let chunk: string | undefined;
    for (const [file, text] of texts) {
      const found = name.exec(text)?.[0];
      // All script files of a build are in one folder.
      if (found) chunk = new URL(found, `http://x${file}`).pathname;
    }
    expect(chunk, `a script of index.html names the file of ${layout}`).toBeDefined();
    await add(chunk!);
    return sizes;
  }

  for (const layout of ['WideLayout', 'PhoneLayout']) {
    test(`the JavaScript of the first screen with ${layout} is below 90 kB after gzip`, async ({ request }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', 'The files are the same in each project');
      const sizes = await firstScreen({ request, layout });
      const total = [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0);
      const list = [...sizes].map(([file, bytes]) => `${file} ${(bytes / 1000).toFixed(1)} kB`).join(', ');
      testInfo.annotations.push({ type: 'first screen', description: `${(total / 1000).toFixed(1)} kB gzip: ${list}` });
      console.log(`first screen with ${layout}: ${(total / 1000).toFixed(1)} kB gzip (${list})`);
      expect(total, `The first screen has ${list}`).toBeLessThan(LIMIT);
    });
  }
});
