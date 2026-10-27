// Tests of the parts around the server: the seed, the commands, the entry file, and the database copy.
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { hashPassword } from './auth.ts';
import { runBackup } from './backup.ts';
import { ROOT } from './config.ts';
import { dbPath, openDb } from './db.ts';
import { seed } from './seed.ts';
import { runSync } from './sync.ts';
import { makeKit, startTestServer } from './testkit.ts';
import type { MeResponse, SyncResponse, TaskRow } from '../shared/types.ts';

const base = path.join(ROOT, '.tmp', `test-admin-${process.pid}-${Date.now().toString(36)}`);
const fixtures = JSON.parse(readFileSync(path.join(ROOT, 'e2e', 'fixtures', 'users.json'), 'utf8')) as {
  users: { name: string; password: string }[];
};
const [alexLogin, samLogin] = fixtures.users as [{ name: string; password: string }, { name: string; password: string }];
const children: ChildProcess[] = [];

afterAll(() => {
  for (const child of children) child.kill('SIGKILL');
  rmSync(base, { recursive: true, force: true });
});

function localDay(ms: number, offset = 0): string {
  const d = new Date(ms);
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function cli(dataDir: string, args: string[], options: { input?: string; env?: Record<string, string> } = {}) {
  const result = spawnSync(process.execPath, ['server/cli.ts', ...args], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, NODE_NO_WARNINGS: '1', ...options.env },
    input: options.input,
    encoding: 'utf8',
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

/** Starts `node server/main.ts` and waits for its start line. */
async function startMain(env: Record<string, string>): Promise<{ child: ChildProcess; url: string; exit: Promise<number | null> }> {
  const child = spawn(process.execPath, ['server/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', NODE_NO_WARNINGS: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const exit = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const url = await new Promise<string>((resolve, reject) => {
    let out = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const match = /listens on (http:\/\/\S+)/.exec(out);
      if (match) resolve(match[1]!);
    });
    void exit.then((code) => reject(new Error(`The server stopped with code ${code}`)));
  });
  return { child, url, exit };
}

describe('seed', () => {
  test('makes the test accounts and the sample rows', async () => {
    const db = openDb(dbPath(path.join(base, 'seed')));
    const now = Date.now();
    const accounts = await Promise.all(
      ['Alex', 'Sam'].map(async (name) => ({ name, password: await hashPassword(`password-of-${name}`) })),
    );
    const [alex, sam] = seed({ db, accounts, now }) as [{ id: string; name: string }, { id: string; name: string }];
    expect([alex.name, sam.name]).toEqual(['Alex', 'Sam']);
    const rowsOf = (userId: string): SyncResponse => runSync({ db, userId, request: { since: 0, ops: [] }, now }).response;
    const byPos = (rows: TaskRow[]): TaskRow[] => [...rows].sort((a, b) => (a.pos < b.pos ? -1 : 1));
    const today = localDay(now);

    const a = rowsOf(alex.id);
    expect(a.lists.map((l) => [l.title, l.pos, l.shared, l.isDefault])).toEqual([
      ['My Tasks', 'a0', false, true],
      ['Home', 'a1', false, false],
      ['Groceries', 'a2', true, false],
    ]);
    expect(a.lists.every((l) => l.owner === alex.id)).toBe(true);
    const [mine, home, groceries] = a.lists.map((l) => l.id) as [string, string, string];

    const top = byPos(a.tasks.filter((t) => t.listId === mine && t.parentId === null));
    expect(top.map((t) => [t.pos, t.title])).toEqual([
      ['a0', 'Plan the weekend trip'],
      ['a1', 'Call the dentist'],
      ['a2', 'Pay the electricity bill'],
      ['a3', 'Send the tax documents'],
      ['a4', 'Buy a birthday present'],
      ['a5', 'Pack for the trip'],
    ]);
    expect(top[0]!.notes).toBe('Check the train times and book a table for dinner.');
    expect([top[1]!.due, top[1]!.time]).toEqual([today, '16:30']);
    expect([top[2]!.due, top[2]!.time]).toEqual([localDay(now, -3), null]);
    expect([top[3]!.deadline, top[3]!.due]).toEqual([localDay(now, 5), null]);
    expect([top[4]!.starred, top[4]!.starredAt]).toEqual([true, now]);
    expect(top.filter((t) => t.starred)).toHaveLength(1);
    const subtasks = byPos(a.tasks.filter((t) => t.parentId !== null));
    expect(subtasks.map((t) => [t.pos, t.title, t.parentId, t.listId])).toEqual([
      ['a0', 'Passport', top[5]!.id, mine],
      ['a1', 'Phone charger', top[5]!.id, mine],
    ]);

    const atHome = byPos(a.tasks.filter((t) => t.listId === home));
    expect(atHome.map((t) => [t.title, t.completed])).toEqual([
      ['Water the plants', false],
      ['Fix the kitchen tap', true],
      ['Clean the windows', true],
      ['Take out the recycling', true],
    ]);
    expect(atHome[0]).toMatchObject({ due: today, repeat: { every: 1, unit: 'day', start: today, end: { type: 'never' } } });
    expect(atHome.slice(1).map((t) => [now - t.completedAt!, t.completedBy])).toEqual([
      [86_400_000, alex.id],
      [2 * 86_400_000, alex.id],
      [3 * 86_400_000, alex.id],
    ]);
    expect(byPos(a.tasks.filter((t) => t.listId === groceries)).map((t) => t.title)).toEqual(['Milk', 'Bread', 'Eggs', 'Coffee', 'Apples']);
    expect(a.tasks).toHaveLength(8 + 4 + 5);

    const s = rowsOf(sam.id);
    expect(s.lists.map((l) => [l.title, l.owner, l.pos]).sort()).toEqual([
      ['Groceries', alex.id, null],
      ['My Tasks', sam.id, 'a0'],
    ]);
    const ofSam = s.lists.find((l) => l.isDefault)!.id;
    expect(byPos(s.tasks.filter((t) => t.listId === ofSam)).map((t) => t.title)).toEqual(['Book the car service', 'Reply to the landlord']);
    expect(s.tasks).toHaveLength(2 + 5);
    expect(s.tasks.every((t) => !t.starred)).toBe(true);

    // The notes, newest first, as the screen shows them: title, color, owner, shared, pinned, archived.
    const notes = (r: SyncResponse): unknown[] =>
      [...r.notes]
        .sort((x, y) => y.createdAt - x.createdAt)
        .map((n) => [n.title, n.color, n.owner === alex.id ? 'Alex' : 'Sam', n.shared, n.pinned, n.archived]);
    expect(notes(a)).toEqual([
      ['Dinner party menu', 'orange', 'Alex', true, false, false],
      ['Lake house checklist', 'yellow', 'Alex', false, true, false],
      ['', 'green', 'Alex', false, false, false],
      ['Book club reading list', 'default', 'Alex', false, false, false],
      ['Gift ideas for Grandma', 'pink', 'Alex', false, false, true],
    ]);
    const menu = a.notes.find((n) => n.title === 'Dinner party menu')!;
    expect(menu).toMatchObject({ body: '- [ ] Lasagne\n- [ ] Green salad\n- [x] Tiramisu', createdAt: now, editedAt: now, editedBy: sam.id });
    expect(a.notes.find((n) => n.title === '')?.body).toBe('Ring the plumber before Friday');
    expect(a.notes.filter((n) => n !== menu).every((n) => n.editedBy === alex.id && n.editedAt === n.createdAt)).toBe(true);
    // Sam sees the shared note with his own per-person values, and his own note.
    expect(notes(s)).toEqual([
      ['Dinner party menu', 'orange', 'Alex', true, false, false],
      ['Bike repair parts', 'blue', 'Sam', false, false, false],
    ]);
    expect(s.notes.find((n) => n.owner === sam.id)?.body).toBe('Front brake pads\nInner tube 28 inch\nChain oil');

    // Only for a database with no accounts.
    expect(() => seed({ db, accounts, now })).toThrow(/has accounts/);
    db.close();
  });
});

describe('commands', () => {
  test('seed, list-users, add-user, and reset-password', async () => {
    const dataDir = path.join(base, 'cli');
    expect(cli(dataDir, ['list-users']).out).toBe('No accounts\n');

    const seeded = cli(dataDir, ['seed']);
    expect([seeded.code, seeded.out]).toEqual([0, 'Made the test accounts "Alex" and "Sam" with sample lists\n']);
    const again = cli(dataDir, ['seed']);
    expect(again.code).toBe(1);
    expect(again.err).toContain('only for an empty database');

    const list = cli(dataDir, ['list-users']);
    expect(list.code).toBe(0);
    expect(list.out).toMatch(/^[\w-]{36}  Alex\n[\w-]{36}  Sam\n$/);

    // add-user works when sign-up is closed. The password comes from the command, the variable, or the input.
    expect(cli(dataDir, ['add-user', 'Kim', 'kim-password-1']).out).toMatch(/^Made the account "Kim" \([\w-]{36}\)\n$/);
    expect(cli(dataDir, ['add-user', 'Lee'], { env: { ST_PASSWORD: 'lee-password-1' } }).code).toBe(0);
    expect(cli(dataDir, ['add-user', 'Max'], { input: 'max-password-1\n' }).code).toBe(0);
    const taken = cli(dataDir, ['add-user', 'kim', 'kim-password-2']);
    expect([taken.code, taken.err]).toEqual([1, 'This name is in use\n']);
    const short = cli(dataDir, ['add-user', 'Ann', 'short']);
    expect([short.code, short.err]).toEqual([1, 'The password must have at least 8 characters\n']);

    expect(cli(dataDir, ['reset-password', 'KIM', 'kim-password-3']).code).toBe(0);
    const unknown = cli(dataDir, ['reset-password', 'Nobody', 'some-password-1']);
    expect([unknown.code, unknown.err]).toEqual([1, 'No account has the name "Nobody"\n']);

    for (const args of [[], ['help'], ['add-user'], ['reset-password']]) {
      const usage = cli(dataDir, args);
      expect(usage.code).toBe(2);
      expect(usage.err).toContain('Usage: node server/cli.ts <command>');
    }

    // A server on this database knows the accounts and their passwords.
    const server = await startTestServer({ name: 'admin-cli', env: { DATA_DIR: dataDir } });
    try {
      const kit = makeKit(server);
      const login = (name: string, password: string) => kit.call<MeResponse>({ path: '/api/login', body: { name, password } });
      expect((await login(alexLogin.name, alexLogin.password)).status).toBe(200);
      expect((await login(samLogin.name, samLogin.password)).status).toBe(200);
      expect((await login('Kim', 'kim-password-1')).status).toBe(401);
      expect((await login('Kim', 'kim-password-3')).status).toBe(200);
      expect((await login('Lee', 'lee-password-1')).status).toBe(200);
      const max = await login('Max', 'max-password-1');
      expect(max.data.users.map((u) => u.name)).toEqual(['Alex', 'Sam', 'Kim', 'Lee', 'Max']);
      expect(max.data.canRegister).toBe(false);
      // Each account of add-user has its default list.
      const reply = await kit.call<SyncResponse>({
        path: '/api/sync',
        body: { clientId: 'c1', since: 0, ops: [], tz: 'UTC' },
        cookie: max.headers.getSetCookie()[0]!.split(';')[0],
      });
      expect(reply.data.lists.filter((l) => l.isDefault && l.title === 'My Tasks')).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });
});

describe('the entry file', () => {
  test('starts, has the reset route only with ST_TEST_RESET=1, and stops at SIGTERM', async () => {
    const dataDir = path.join(base, 'main');
    expect(cli(dataDir, ['seed']).code).toBe(0);
    const { child, url, exit } = await startMain({ DATA_DIR: dataDir, WEB_DIR: path.join(base, 'no-web'), ST_TEST_RESET: '1' });
    const kit = makeKit({ url });

    expect((await kit.call({ path: '/api/health' })).data).toEqual({ ok: true, version: '0.1.0' });
    const alex = await kit.login(alexLogin.name, alexLogin.password);
    const first = await alex.sync();
    const groceries = first.lists.find((l) => l.title === 'Groceries')!;
    await alex.sync([
      kit.task({ listId: groceries.id, title: 'Not in the seed' }),
      { kind: 'list', id: groceries.id, fields: { title: 'Changed' } },
      kit.note({ title: 'Not in the seed' }),
    ]);
    const stale = alex.since;

    const reset = await kit.call({ path: '/api/test/reset', body: {} });
    expect([reset.status, reset.data]).toEqual([200, { ok: true }]);
    // The sessions are gone with the old accounts.
    expect((await alex.call('/api/sync', { clientId: 'c1', since: stale, ops: [], tz: 'UTC' })).status).toBe(401);
    const fresh = await kit.login(alexLogin.name, alexLogin.password);
    expect(fresh.user.id).not.toBe(alex.user.id);
    // A device with rows of the old data gets all rows of the new data.
    fresh.since = stale;
    const after = await fresh.sync();
    expect(after.reset).toBe(true);
    expect(after.lists.map((l) => l.title).sort()).toEqual(['Groceries', 'Home', 'My Tasks']);
    expect(after.tasks).toHaveLength(17);
    expect(after.tasks.some((t) => t.title === 'Not in the seed')).toBe(false);
    expect(after.notes.map((n) => n.title).sort()).toEqual(['', 'Book club reading list', 'Dinner party menu', 'Gift ideas for Grandma', 'Lake house checklist']);
    // A second reset is quick, because the password hashes are made one time.
    const started = Date.now();
    expect((await kit.call({ path: '/api/test/reset', body: {} })).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1000);

    // An open event stream must not hold the stop.
    const again = await kit.login(samLogin.name, samLogin.password);
    const stream = await fetch(`${url}/api/events`, { headers: { Cookie: again.cookie } });
    expect(stream.status).toBe(200);
    child.kill('SIGTERM');
    expect(await exit).toBe(0);
    await expect(fetch(`${url}/api/health`)).rejects.toThrow();
    await stream.body?.cancel().catch(() => undefined);
  });

  test('stops at SIGINT, and has no reset route by default', async () => {
    const { child, url, exit } = await startMain({ DATA_DIR: path.join(base, 'main-2'), WEB_DIR: path.join(base, 'no-web') });
    expect((await makeKit({ url }).call({ path: '/api/test/reset', body: {} })).status).toBe(404);
    child.kill('SIGINT');
    expect(await exit).toBe(0);
  });

  test('tells the reason and stops if the port is in use', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = String((blocker.address() as AddressInfo).port);
    const result = spawnSync(process.execPath, ['server/main.ts'], {
      cwd: ROOT,
      env: { ...process.env, PORT: port, DATA_DIR: path.join(base, 'main-3'), NODE_NO_WARNINGS: '1' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    await new Promise((resolve) => blocker.close(resolve));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('EADDRINUSE');
  });
});

describe('a database copy that is put back', () => {
  test('each device starts again from the rows of the copy, and keeps its outbox', async () => {
    const dir = path.join(base, 'restore-backups');
    const lines: string[] = [];
    const first = await startTestServer({ name: 'admin-restore', env: { BACKUP_DIR: dir } });
    const kit = makeKit(first);
    const phone = await kit.register('Alex');
    const laptop = await kit.login('Alex');
    const listId = (await phone.sync()).lists[0]!.id;
    await phone.sync([kit.task({ listId, title: 'In the copy' }, 'in-the-copy')]);
    first.maintain();
    const copyFile = path.join(dir, readdirSync(dir)[0]!);

    // More changes after the copy. The two devices have them, and a revision that the copy does not have.
    await phone.sync(Array.from({ length: 5 }, (_, i) => kit.task({ listId, title: `After the copy ${i}` }, `after-${i}`)));
    await laptop.sync();
    const revBefore = laptop.since;
    await first.stop({ keep: true });

    // The administrator puts the copy back and starts the server.
    const dataFile = dbPath(path.join(first.dir, 'data'));
    for (const suffix of ['', '-wal', '-shm']) rmSync(dataFile + suffix, { force: true });
    writeFileSync(dataFile, readFileSync(copyFile));
    const second = await startTestServer({ name: 'admin-restore', dir: first.dir, options: { log: (line) => lines.push(line) } });
    try {
      expect(lines.some((line) => line.includes('copy'))).toBe(true);
      const call = (person: typeof phone, ops: unknown[] = []) =>
        makeKit(second).call<SyncResponse>({ path: '/api/sync', cookie: person.cookie, body: { clientId: person.clientId, since: person.since, ops, tz: 'UTC' } });

      // The phone syncs first and makes new rows. The counter is far ahead of the revision of the laptop.
      const one = await call(phone, [makeKit(second).op(kit.task({ listId, title: 'After the start' }, 'after-the-start'))]);
      expect(one.data.reset).toBe(true);
      expect(one.data.rev).toBeGreaterThan(revBefore + 1_000_000);
      expect(one.data.tasks.map((t) => t.id).sort()).toEqual(['after-the-start', 'in-the-copy']);
      phone.since = one.data.rev;
      for (let i = 0; i < 10; i++) {
        const more = await call(phone, [makeKit(second).op(kit.task({ listId, title: `More ${i}` }, `more-${i}`))]);
        expect(more.data.reset).toBe(false);
        phone.since = more.data.rev;
      }
      // The laptop was away. It gets 'reset' and all rows, and not only the rows after its old revision.
      const two = await call(laptop);
      expect(two.data.reset).toBe(true);
      expect(two.data.tasks).toHaveLength(12);
      expect(two.data.tasks.some((t) => t.id.startsWith('after-') && t.id !== 'after-the-start')).toBe(false);

      // A second start on the same database is a usual start.
      await second.stop({ keep: true });
      const third = await startTestServer({ name: 'admin-restore', dir: first.dir });
      try {
        laptop.since = two.data.rev;
        const reply = await makeKit(third).call<SyncResponse>({
          path: '/api/sync',
          cookie: laptop.cookie,
          body: { clientId: laptop.clientId, since: laptop.since, ops: [], tz: 'UTC' },
        });
        expect(reply.data).toMatchObject({ reset: false, rev: two.data.rev, tasks: [] });
      } finally {
        await third.stop();
      }
    } finally {
      await second.stop().catch(() => undefined);
    }
  });
});

describe('database copy', () => {
  test('one copy for each day, and the newest 30 stay', async () => {
    const dir = path.join(base, 'backups');
    const server = await startTestServer({ name: 'admin-backup', env: { BACKUP_DIR: dir } });
    try {
      const kit = makeKit(server);
      await kit.register('Alex');
      const { db } = server.app;
      const now = Date.now();
      const name = `shared-tasks-${localDay(now)}.db`;

      // The daily jobs of the server write the copy of the day.
      server.maintain();
      expect(readdirSync(dir)).toEqual([name]);
      server.maintain();
      expect(readdirSync(dir)).toEqual([name]);
      expect(runBackup({ db, dir, now })).toBeNull();

      // The copy is a complete database, with the mark of a copy. The database of the server has no mark.
      const copy = openDb(path.join(dir, name));
      expect(copy.q('SELECT name FROM users').all()).toEqual([{ name: 'Alex' }]);
      expect(copy.q('SELECT title FROM lists').all()).toEqual([{ title: 'My Tasks' }]);
      expect(copy.getMeta('copy')).toBe('1');
      expect(db.getMeta('copy')).toBeNull();
      copy.close();
      expect(readdirSync(dir)).toEqual([name]);

      // 35 older copies, a file of a different kind, and the rest of a copy that did not finish.
      for (let i = 1; i <= 35; i++) writeFileSync(path.join(dir, `shared-tasks-${localDay(now, -i)}.db`), 'old');
      writeFileSync(path.join(dir, 'notes.txt'), 'keep me');
      rmSync(path.join(dir, name));
      writeFileSync(path.join(dir, `${name}.partial`), 'broken');
      expect(runBackup({ db, dir, now })).toBe(path.join(dir, name));
      const copies = readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
      expect(copies).toHaveLength(30);
      expect(copies.at(-1)).toBe(name);
      expect(copies[0]).toBe(`shared-tasks-${localDay(now, -29)}.db`);
      expect(existsSync(path.join(dir, 'notes.txt'))).toBe(true);
      expect(existsSync(path.join(dir, `${name}.partial`))).toBe(false);

      expect(runBackup({ db, dir, now: now + 86_400_000, keep: 2 })).toBe(path.join(dir, `shared-tasks-${localDay(now, 1)}.db`));
      expect(readdirSync(dir).filter((f) => f.endsWith('.db')).sort()).toEqual([name, `shared-tasks-${localDay(now, 1)}.db`]);
    } finally {
      await server.stop();
    }
  });
});
