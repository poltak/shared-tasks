// Attacks on the server: one person against the private rows of the other person, requests with
// no session or with a bad one, and requests that are not valid.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { dbPath } from './db.ts';
import { makeKit, rawRequest, startTestServer } from './testkit.ts';
import type { Kit, Person, Reply, TestServer } from './testkit.ts';
import type { ApiError, ID, ListFields, MeResponse, Op, Put, SyncResponse, TaskFields } from '../shared/types.ts';

const DAY = 86_400_000;

let server: TestServer;
let kit: Kit;
let alex: Person;
let sam: Person;
let clock = Date.now();

/** The rows of Alex that Sam attacks. */
let secretList: ID;
let secretTasks: [ID, ID];
let alexDefault: ID;
/** A list that Alex shares, with one task. */
let sharedList: ID;
let sharedTask: ID;
let samDefault: ID;
let samList: ID;

const setTask = (id: ID, fields: TaskFields): Put => ({ kind: 'task', id, fields });
const setList = (id: ID, fields: ListFields): Put => ({ kind: 'list', id, fields });
const code = (reply: { data: ApiError }): string => reply.data.error?.code;

beforeAll(async () => {
  server = await startTestServer({ name: 'security', options: { now: () => clock } });
  kit = makeKit(server, () => clock);
  alex = await kit.register('Alex');
  sam = await kit.register('Sam');

  const secret = kit.list({ title: 'Secret plans', pos: 'a1' });
  const shared = kit.list({ title: 'Groceries', shared: true });
  const tasks = [
    kit.task({ listId: secret.id, title: 'Secret task one', notes: 'Secret notes', starred: true, starredAt: 5 }),
    kit.task({ listId: secret.id, title: 'Secret task two' }),
    kit.task({ listId: shared.id, title: 'Milk' }),
  ];
  const first = await alex.sync([secret, shared, ...tasks]);
  expect(first.rejected).toEqual([]);
  alexDefault = first.lists.find((l) => l.isDefault)!.id;
  secretList = secret.id;
  secretTasks = [tasks[0]!.id, tasks[1]!.id];
  sharedList = shared.id;
  sharedTask = tasks[2]!.id;

  const own = kit.list({ title: 'List of Sam' });
  const second = await sam.sync([own]);
  samDefault = second.lists.find((l) => l.isDefault)!.id;
  samList = own.id;
});
afterAll(() => server.stop());
afterEach(() => vi.restoreAllMocks());

/** All rows of the lists and tasks, to see that an attack changed nothing. */
function snapshot(): string {
  const { db } = server.app;
  return JSON.stringify(
    ['lists', 'tasks', 'list_user', 'task_user'].map((table) => db.q(`SELECT * FROM ${table} ORDER BY 1, 2`).all()),
  );
}

/**
 * Sam sends the puts. Each must be rejected, the database must stay as it is, Sam must get no
 * secret text and no id that Sam did not send, and Alex must see no change.
 */
async function attack(puts: (Put | Op)[]): Promise<SyncResponse> {
  await alex.sync();
  const before = snapshot();
  const reply = await sam.sync(puts);
  expect(reply.acked).toEqual([]);
  expect(reply.rejected).toHaveLength(puts.length);
  expect(snapshot()).toBe(before);

  const text = JSON.stringify(reply);
  expect(text).not.toContain('Secret');
  const sent = new Set(puts.map((p) => p.id));
  for (const id of [secretList, ...secretTasks, alexDefault]) {
    if (!sent.has(id)) expect(text).not.toContain(id);
  }
  // A secret id that Sam sent comes back only as a 'gone' id.
  for (const row of [...reply.lists, ...reply.tasks]) expect([secretList, ...secretTasks, alexDefault]).not.toContain(row.id);
  for (const task of reply.tasks) expect([secretList, alexDefault]).not.toContain(task.listId);

  const forAlex = await alex.sync();
  expect(forAlex.lists.length + forAlex.tasks.length + forAlex.gone.lists.length + forAlex.gone.tasks.length).toBe(0);
  return reply;
}

describe('one person against the private rows of the other person', () => {
  test('a new task with the id of a private list of the other person', async () => {
    const reply = await attack([
      kit.task({ listId: secretList, title: 'Planted' }, 'planted-1'),
      kit.task({ listId: alexDefault, title: 'Planted', parentId: secretTasks[0], starred: true }, 'planted-2'),
      // The list of the task changes in the same op.
      setTask('planted-3', { listId: secretList }),
    ]);
    expect([...reply.gone.tasks].sort()).toEqual(['planted-1', 'planted-2', 'planted-3']);
    expect(server.app.db.q("SELECT COUNT(*) AS n FROM tasks WHERE id LIKE 'planted-%'").get()).toEqual({ n: 0 });
  });

  test('a move of a task out of a private list of the other person, or into it', async () => {
    const [one, two] = secretTasks;
    const reply = await attack([
      setTask(one, { listId: samList }),
      setTask(two, { listId: sharedList, parentId: null, pos: 'a0' }),
      // A task that Sam can see must not go into the private list.
      setTask(sharedTask, { listId: secretList }),
      setTask(sharedTask, { listId: alexDefault }),
    ]);
    expect([...reply.gone.tasks].sort()).toEqual([one, two].sort());
    // The true row of the task that Sam can see comes back.
    expect(reply.tasks.map((t) => [t.id, t.listId])).toEqual([[sharedTask, sharedList]]);
  });

  test('a put with the id of a private task of the other person', async () => {
    const [one, two] = secretTasks;
    await attack([
      setTask(one, { title: 'Changed by Sam' }),
      setTask(one, { notes: '' }),
      setTask(one, { completed: true, completedAt: clock, completedBy: sam.user.id }),
      setTask(one, { deleted: true }),
      setTask(two, { parentId: sharedTask, pos: 'a0', due: '2026-10-06', time: '10:00', deadline: '2026-10-07' }),
      // A put with all fields, as if Sam made a task with this id in a list of Sam.
      kit.task({ listId: samList, title: 'Mine now', deleted: false, createdBy: sam.user.id }, two),
      kit.task({ listId: samDefault, title: 'Mine now' }, one),
      // The same with a timestamp of the future.
      kit.op(setTask(one, { title: 'From the future', listId: samList }), kit.at(clock + 10 * DAY)),
    ]);
  });

  test('per-person fields on rows that the person cannot see', async () => {
    const [one] = secretTasks;
    await attack([
      setTask(one, { starred: true, starredAt: clock }),
      setTask(one, { starred: false }),
      setList(secretList, { pos: 'a0' }),
      setList(secretList, { sort: 'title' }),
      setList(secretList, { hidden: true }),
      setList(alexDefault, { hidden: true, pos: null }),
    ]);
    const { db } = server.app;
    expect(db.q('SELECT COUNT(*) AS n FROM task_user WHERE user_id = ? AND task_id = ?').get(sam.user.id, one)).toEqual({ n: 0 });
    expect(db.q('SELECT COUNT(*) AS n FROM list_user WHERE user_id = ? AND list_id IN (?, ?)').get(sam.user.id, secretList, alexDefault)).toEqual({ n: 0 });
  });

  test('a put with the id of a private list of the other person', async () => {
    const reply = await attack([
      setList(secretList, { title: 'Renamed by Sam' }),
      setList(secretList, { shared: true }),
      setList(secretList, { deleted: true }),
      // A put with all fields, as if Sam made a list with this id.
      kit.list({ title: 'Mine now', owner: sam.user.id, shared: true, isDefault: false }, secretList),
      kit.list({ title: 'Mine now', owner: sam.user.id }, alexDefault),
      kit.op(setList(secretList, { title: 'From the future', shared: true }), kit.at(clock + 10 * DAY)),
    ]);
    expect([...reply.gone.lists].sort()).toEqual([secretList, alexDefault].sort());
  });

  test('a list put cannot change the owner or make a default list', async () => {
    await alex.sync();
    const before = snapshot();
    // On a list that Sam can see, the fixed fields are ignored.
    const reply = await sam.sync([
      setList(sharedList, { owner: sam.user.id }),
      setList(sharedList, { isDefault: true }),
      setList(sharedList, { createdAt: 1 }),
      setTask(sharedTask, { createdBy: sam.user.id, createdAt: 1 }),
      { ...kit.op(setList(sharedList, { owner: sam.user.id })), trusted: true } as unknown as Op,
    ]);
    expect(reply.rejected).toEqual([]);
    expect(snapshot()).toBe(before);

    // A new list gets the owner of the session and is never a default list.
    const made = kit.list({ title: 'With wrong fixed fields', owner: alex.user.id, isDefault: true });
    const task = kit.task({ listId: made.id, title: 'With a wrong maker', createdBy: alex.user.id });
    const second = await sam.sync([made, task, { ...kit.op(kit.list({ title: 'Trusted?', isDefault: true }, 'trusted-list')), trusted: true } as unknown as Op]);
    expect(second.lists.find((l) => l.id === made.id)).toMatchObject({ owner: sam.user.id, isDefault: false });
    expect(second.lists.find((l) => l.id === 'trusted-list')).toMatchObject({ owner: sam.user.id, isDefault: false });
    expect(second.tasks.find((t) => t.id === task.id)?.createdBy).toBe(sam.user.id);
    expect(server.app.db.q('SELECT COUNT(*) AS n FROM lists WHERE is_default = 1').get()).toEqual({ n: 2 });
    // Alex gets nothing from the private list of Sam.
    const forAlex = await alex.sync();
    expect(JSON.stringify(forAlex)).not.toContain(made.id);
  });

  test('no put deletes a default list', async () => {
    // The default list of Sam, by Sam.
    await alex.sync();
    for (const fields of [{ deleted: true }, { title: 'Bye', deleted: true }, { deleted: true, shared: true, sort: 'date' }] satisfies ListFields[]) {
      const before = snapshot();
      const reply = await sam.sync([setList(samDefault, fields), kit.op(setList(samDefault, fields), kit.at(clock + 10 * DAY))]);
      expect(reply.rejected).toHaveLength(2);
      expect(reply.lists.find((l) => l.id === samDefault)).toMatchObject({ deleted: false, isDefault: true });
      expect(snapshot()).toBe(before);
    }
    // The default list of Alex, also while Alex shares it.
    await attack([setList(alexDefault, { deleted: true })]);
    await alex.sync([setList(alexDefault, { shared: true })]);
    await sam.sync();
    const before = snapshot();
    const reply = await sam.sync([setList(alexDefault, { deleted: true }), setList(alexDefault, { title: 'x', deleted: true })]);
    expect(reply.rejected).toHaveLength(2);
    expect(snapshot()).toBe(before);
    expect((await alex.sync([setList(alexDefault, { deleted: true })])).rejected).toHaveLength(1);
    await alex.sync([setList(alexDefault, { shared: false })]);
    await sam.sync();
  });

  test('only the owner stops the sharing or deletes the list', async () => {
    await alex.sync();
    const before = snapshot();
    const reply = await sam.sync([
      setList(sharedList, { shared: false }),
      setList(sharedList, { deleted: true }),
      setList(sharedList, { title: 'Renamed too', shared: false }),
      kit.op(setList(sharedList, { shared: false }), kit.at(clock + 10 * DAY)),
    ]);
    expect(reply.acked).toEqual([]);
    expect(reply.rejected).toHaveLength(4);
    expect(reply.lists).toHaveLength(1);
    expect(reply.lists[0]).toMatchObject({ id: sharedList, title: 'Groceries', shared: true, deleted: false });
    expect(snapshot()).toBe(before);
    const forAlex = await alex.sync();
    expect(forAlex.lists.length + forAlex.gone.lists.length).toBe(0);
  });

  test('ids with SQL text or path text are not ids', async () => {
    const bad = ["x' OR '1'='1", 'x"; DROP TABLE tasks; --', '../../etc/passwd', 'a b', 'a\u0000b', 'ü', '', 'x'.repeat(65), 'x'.repeat(1_000_000)];
    const reply = await sam.sync([
      ...bad.map((id) => setTask(id, { listId: samList, title: 'Bad id' })),
      ...bad.map((id) => setList(id, { title: 'Bad id' })),
      ...bad.map((id) => kit.task({ listId: id, title: 'Bad list id' })),
      ...bad.filter((id) => id !== '').map((id) => setTask(sharedTask, { parentId: id })),
      ...bad.map((id) => setTask(sharedTask, { completedBy: id })),
    ]);
    expect(reply.acked).toEqual([]);
    expect(server.app.db.q('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 4 });
    // A very long op id or device id does not go into the database.
    const long = await sam.call<SyncResponse & ApiError>('/api/sync', {
      clientId: sam.clientId,
      since: sam.since,
      ops: [{ ...kit.op(setTask(sharedTask, { title: 'Long op id' })), opId: 'o'.repeat(1_000_000) }],
      tz: 'UTC',
    });
    expect(long.status).toBe(200);
    expect(long.data.acked).toEqual([]);
    const longClient = await sam.call<ApiError>('/api/sync', { clientId: 'c'.repeat(1_000_000), since: 0, ops: [], tz: 'UTC' });
    expect([longClient.status, code(longClient)]).toEqual([400, 'invalid']);
  });

  test('no value of "since" gives rows of the other person', async () => {
    for (const since of [0, 1, sam.since - 1, sam.since, sam.since + 1, 1e9, Number.MAX_SAFE_INTEGER]) {
      const reply = await sam.call<SyncResponse>('/api/sync', { clientId: sam.clientId, since, ops: [], tz: 'UTC' });
      expect(reply.status).toBe(200);
      const text = JSON.stringify(reply.data);
      expect(text).not.toContain('Secret');
      // The default list of Alex was shared for a time in a test above, so its id can be a 'gone' id.
      for (const id of [secretList, ...secretTasks]) expect(text).not.toContain(id);
      for (const row of [...reply.data.lists, ...reply.data.tasks]) expect(row.id).not.toBe(alexDefault);
    }
    for (const since of [-1, 0.5, 1e20, '0', null, [], {}, true]) {
      const reply = await sam.call<ApiError>('/api/sync', { clientId: sam.clientId, since, ops: [], tz: 'UTC' });
      expect([reply.status, code(reply)]).toEqual([400, 'invalid']);
    }
  });
});

describe('wrong types', () => {
  const dates = [5, true, {}, [], '', '2026-13-01', '2026-02-30', '26-10-06', '2026-10-06T10:00', '2026-10-6'];
  const stamps = ['1', -1, true, {}, [], 1e17];
  const flags = [null, 0, 1, 'true', {}, []];
  const texts = [null, 5, true, {}, []];
  const idValues = [5, true, {}, [], '', 'not an id!', 'x'.repeat(65)];
  const badTask: Record<keyof TaskFields, unknown[]> = {
    listId: [null, ...idValues],
    parentId: idValues,
    title: texts,
    notes: texts,
    pos: [null, 5, true, {}, [], 'x'.repeat(1025)],
    due: dates,
    time: [5, true, {}, [], '', '24:00', '9:30', '09:60', '09:30:00', 'noon'],
    deadline: dates,
    repeat: [5, true, 'daily', [], {}, { every: 1 }, { every: '1', unit: 'day', start: '2026-10-06', end: { type: 'never' } }],
    repeatCount: [null, '1', -1, 1.5, true, {}, 1e10],
    hiddenUntil: dates,
    lastDoneAt: stamps,
    lastDoneDue: dates,
    completed: flags,
    completedAt: stamps,
    completedBy: idValues,
    createdAt: [null, ...stamps],
    createdBy: [null, ...idValues],
    deleted: flags,
    starred: flags,
    starredAt: stamps,
  };
  const badList: Record<keyof ListFields, unknown[]> = {
    title: texts,
    owner: [null, ...idValues],
    shared: flags,
    isDefault: flags,
    createdAt: [null, ...stamps],
    deleted: flags,
    pos: [5, true, {}, [], 'x'.repeat(1025)],
    sort: [null, 5, true, {}, [], '', 'random', 'MY'],
    hidden: flags,
  };

  test('a wrong value in each field of a task or a list: the op is rejected and the row stays', async () => {
    const list = kit.list({ title: 'Types', pos: 'a5', sort: 'date' });
    const task = kit.task({
      listId: list.id,
      title: 'Types',
      notes: 'Notes',
      due: '2026-10-06',
      time: '10:00',
      deadline: '2026-10-07',
      repeat: { every: 1, unit: 'day', start: '2026-10-06', end: { type: 'never' } },
      starred: true,
      starredAt: 7,
    });
    await alex.sync([list, task]);
    const rows = async (): Promise<unknown[]> => {
      const all = await (await kit.login('Alex')).sync();
      return [all.lists.find((l) => l.id === list.id), all.tasks.find((t) => t.id === task.id)];
    };
    const before = await rows();
    const rev = alex.since;

    const ops: Op[] = [];
    for (const [field, values] of Object.entries(badTask)) {
      // The bad field stands with a good one: the good one must not apply.
      for (const value of values) ops.push(kit.op(setTask(task.id, { title: 'Must not apply', [field]: value } as TaskFields)));
    }
    for (const [field, values] of Object.entries(badList)) {
      for (const value of values) ops.push(kit.op(setList(list.id, { hidden: true, [field]: value } as ListFields)));
    }
    expect(ops.length).toBeGreaterThan(200);
    const reply = await alex.sync(ops);
    expect(reply.acked).toEqual([]);
    expect(reply.rejected).toEqual(ops.map((op) => op.opId));
    expect(reply.rev).toBe(rev);
    expect(await rows()).toEqual(before);
    // The device gets the true rows back.
    expect([reply.lists.length, reply.tasks.length]).toEqual([1, 1]);
  });

  test('a wrong frame of an op', async () => {
    const good = kit.op(setTask(sharedTask, { title: 'Must not apply' }));
    const frames: unknown[] = [
      { ...good, kind: 'user' },
      { ...good, kind: null },
      { ...good, kind: ['task'] },
      { ...good, id: null },
      { ...good, id: 5 },
      { ...good, id: { toString: 'x' } },
      { ...good, ts: 5 },
      { ...good, ts: null },
      { ...good, ts: 'Z'.repeat(18) },
      { ...good, ts: '0'.repeat(19) },
      { ...good, fields: [] },
      { ...good, fields: 5 },
      { ...good, fields: null },
      { ...good, fields: undefined },
      { ...good, opId: 'has space' },
    ];
    const noise: unknown[] = [null, 5, 'op', true, [], [good], { ...good, opId: 5 }, { ...good, opId: null }, { ...good, opId: {} }];
    await alex.sync();
    const before = snapshot();
    const reply = await alex.call<SyncResponse>('/api/sync', { clientId: alex.clientId, since: alex.since, ops: [...frames, ...noise], tz: 'UTC' });
    expect(reply.status).toBe(200);
    expect(reply.data.acked).toEqual([]);
    expect(reply.data.rejected).toHaveLength(frames.length);
    expect(snapshot()).toBe(before);
  });

  test('a wrong frame of a sync request', async () => {
    const frame = { clientId: 'c1', since: 0, ops: [], tz: 'UTC' };
    const bad: Record<string, unknown>[] = [
      ...[undefined, null, 5, true, '', 'not an id!', {}, []].map((clientId) => ({ clientId })),
      ...[undefined, null, '0', true, {}, [], -1, 1.5, 1e20].map((since) => ({ since })),
      ...[undefined, null, {}, 'ops', 5, true].map((ops) => ({ ops })),
    ];
    for (const change of bad) {
      const reply = await alex.call<ApiError>('/api/sync', { ...frame, ...change });
      expect([reply.status, code(reply)], JSON.stringify(change)).toEqual([400, 'invalid']);
    }
    // A wrong time zone is ignored. It is not an error.
    for (const tz of [undefined, null, 5, {}, [], 'x'.repeat(10_000), "Europe/Berlin'; DROP TABLE users; --"]) {
      expect((await alex.call('/api/sync', { ...frame, tz })).status).toBe(200);
    }
    expect(server.app.db.q('SELECT tz FROM users WHERE id = ?').get(alex.user.id)).toEqual({ tz: 'UTC' });
  });

  test('wrong values for the account routes and the push routes', async () => {
    const wrong = [undefined, null, 5, true, {}, [], ['Alex']];
    const expectInvalid = async (route: string, body: unknown, person?: Person): Promise<void> => {
      const reply = person ? await person.call<ApiError>(route, body) : await kit.call<ApiError>({ path: route, body });
      expect([reply.status, code(reply)], `${route} ${JSON.stringify(body)}`).toEqual([400, 'invalid']);
    };
    const users = server.app.db.q('SELECT id, name, name_key, pw_hash FROM users ORDER BY id').all();
    for (const value of wrong) {
      await expectInvalid('/api/login', { name: value, password: 'password-of-alex' });
      await expectInvalid('/api/login', { name: 'Alex', password: value });
      await expectInvalid('/api/password', { current: value, next: 'a-new-password-1' }, alex);
      await expectInvalid('/api/password', { current: 'password-of-alex', next: value }, alex);
      await expectInvalid('/api/profile', { name: value }, alex);
      await expectInvalid('/api/push/subscribe', { endpoint: value, keys: { p256dh: 'x', auth: 'y' } }, alex);
      await expectInvalid('/api/push/subscribe', { endpoint: 'https://push.example.net/1', keys: value }, alex);
      await expectInvalid('/api/push/subscribe', { endpoint: 'https://push.example.net/1', keys: { p256dh: value, auth: value } }, alex);
      await expectInvalid('/api/push/unsubscribe', { endpoint: value }, alex);
    }
    for (const body of ['"text"', '5', 'null', 'true', '[]', '[{"name":"Alex"}]']) {
      await expectInvalid('/api/login', body);
      await expectInvalid('/api/sync', body, alex);
    }
    // An endpoint that is not an https address of a push service.
    for (const endpoint of ['http://push.example.net/1', 'file:///etc/passwd', 'javascript:alert(1)', 'push.example.net', `https://x/${'y'.repeat(3000)}`]) {
      await expectInvalid('/api/push/subscribe', { endpoint, keys: { p256dh: 'x', auth: 'y' } }, alex);
    }
    expect(server.app.db.q('SELECT id, name, name_key, pw_hash FROM users ORDER BY id').all()).toEqual(users);
    expect(server.app.db.q('SELECT COUNT(*) AS n FROM push_subs').get()).toEqual({ n: 0 });
    // The wrong tries for "current" did not lock the account: they were not valid requests.
    expect((await kit.call({ path: '/api/login', body: { name: 'Alex', password: 'password-of-alex' } })).status).toBe(200);
  });

  test('a name with line breaks or control characters cannot add a header', async () => {
    const lines = 'Eve\r\nSet-Cookie: st_session=stolen\r\nX-Injected: yes';
    const renamed = await sam.call<MeResponse>('/api/profile', { name: lines });
    // The line breaks become spaces, and the name is then too long. No header comes from it.
    expect(renamed.status).toBe(400);
    expect(renamed.headers.get('x-injected')).toBeNull();
    expect(renamed.headers.getSetCookie()).toEqual([]);

    const short = await sam.call<MeResponse>('/api/profile', { name: 'Sam\r\nX-Injected: yes' });
    expect(short.status).toBe(200);
    expect(short.data.me?.name).toBe('Sam X-Injected: yes');
    expect(short.headers.get('x-injected')).toBeNull();
    for (const name of ['Sam\u0000', 'Sam\u001b[31m', 'Sam\u007f', '\u0008Sam']) {
      expect((await sam.call('/api/profile', { name })).status).toBe(400);
    }
    // The name goes out as JSON text only.
    const me = await sam.call<MeResponse>('/api/me');
    expect(me.headers.get('x-injected')).toBeNull();
    expect((await sam.call<MeResponse>('/api/profile', { name: 'Sam' })).data.me?.name).toBe('Sam');
  });
});

describe('requests with no session or with a bad session', () => {
  const routes: { path: string; body?: unknown }[] = [
    { path: '/api/sync', body: { clientId: 'c1', since: 0, ops: [], tz: 'UTC' } },
    { path: '/api/events' },
    { path: '/api/password', body: { current: 'password-of-alex', next: 'a-new-password-1' } },
    { path: '/api/profile', body: { name: 'Intruder' } },
    { path: '/api/push/subscribe', body: { endpoint: 'https://push.example.net/1', keys: { p256dh: 'x', auth: 'y' } } },
    { path: '/api/push/unsubscribe', body: { endpoint: 'https://push.example.net/1' } },
    { path: '/api/push/test', body: {} },
  ];

  test('each route that needs a session gives 401 with no cookie', async () => {
    const before = snapshot();
    for (const route of routes) {
      const reply = await kit.call<ApiError>(route);
      expect([reply.status, code(reply)], route.path).toEqual([401, 'unauthorized']);
      expect(reply.headers.getSetCookie()).toEqual([]);
    }
    expect(snapshot()).toBe(before);
    // The routes with no session tell nothing about the accounts.
    const me = await kit.call<MeResponse>({ path: '/api/me' });
    expect(me.data).toMatchObject({ me: null, users: [], canRegister: false });
    expect(JSON.stringify(me.data)).not.toContain('Alex');
    expect((await kit.call({ path: '/api/health' })).data).toEqual({ ok: true, version: '0.1.0' });
    expect((await kit.call({ path: '/api/logout', body: {} })).status).toBe(200);
    const closed = await kit.call<ApiError>({ path: '/api/register', body: { name: 'Third', password: 'long-enough-1' } });
    expect([closed.status, code(closed)]).toEqual([403, 'closed']);
  });

  test('a cookie that is not a session of the server gives 401', async () => {
    const token = alex.cookie.split('=')[1]!;
    const hash = (server.app.db.q('SELECT hash FROM sessions LIMIT 1').get() as { hash: Uint8Array }).hash;
    const cookies = [
      'st_session=',
      'st_session=x',
      `st_session=${'A'.repeat(43)}`,
      // The token with one character changed, cut, and with more text.
      `st_session=${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`,
      `st_session=${token.slice(0, 20)}`,
      `st_session=${token}x`,
      `st_session=${token.toUpperCase()}`,
      // The database value of the session is not a token.
      `st_session=${Buffer.from(hash).toString('base64url')}`,
      `st_session=${Buffer.from(hash).toString('hex')}`,
      `st_session=${'x'.repeat(100_000)}`,
      "st_session=' OR 1=1 --",
      `other=${token}`,
      `st_session_x=${token}`,
      // The first cookie with the name counts.
      `st_session=wrong; st_session=${token}`,
    ];
    for (const cookie of cookies) {
      for (const route of routes) {
        const reply = await kit.call<ApiError>({ ...route, cookie });
        // A header of 100 kB is too large for the HTTP layer of Node.js.
        expect([401, 431], `${route.path} ${cookie.slice(0, 40)}`).toContain(reply.status);
      }
      if (cookie.length < 1000) expect((await kit.call<MeResponse>({ path: '/api/me', cookie })).data.me).toBeNull();
    }
    // The real cookie works, also with other cookies around it.
    expect((await kit.call<MeResponse>({ path: '/api/me', cookie: `a=b; ${alex.cookie}; c=d` })).data.me?.name).toBe('Alex');
  });

  test('a session that ended is not valid: sign-out, password change, and 400 days', async () => {
    const body = { clientId: 'c1', since: 0, ops: [], tz: 'UTC' };
    const gone = await kit.login('Sam');
    await gone.call('/api/logout', {});
    expect((await gone.call('/api/sync', body)).status).toBe(401);
    expect((await gone.call('/api/events')).status).toBe(401);

    const here = await kit.login('Sam');
    const there = await kit.login('Sam');
    await here.call('/api/password', { current: kit.passwordOf('Sam'), next: 'a-new-password-1' });
    expect((await there.call('/api/sync', body)).status).toBe(401);
    expect((await here.call('/api/sync', body)).status).toBe(200);
    await here.call('/api/password', { current: 'a-new-password-1', next: kit.passwordOf('Sam') });

    const old = await kit.login('Sam');
    clock += 400 * DAY + 1000;
    try {
      expect((await old.call('/api/sync', body)).status).toBe(401);
      expect((await old.call<MeResponse>('/api/me')).data.me).toBeNull();
      // The row of the session is deleted, so the token does not work again when the clock goes back.
    } finally {
      clock -= 400 * DAY + 1000;
    }
    expect((await old.call('/api/sync', body)).status).toBe(401);
  });

  test('the cookie has the flags HttpOnly, SameSite=Lax, Path=/, and 400 days', async () => {
    const flags = /^st_session=[\w-]{43}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=34560000$/;
    const login = await kit.call({ path: '/api/login', body: { name: 'Alex', password: kit.passwordOf('Alex') } });
    expect(login.headers.getSetCookie()).toHaveLength(1);
    expect(login.headers.getSetCookie()[0]).toMatch(flags);
    // No other route sets a cookie.
    const device = await kit.login('Alex');
    const plain = [
      { path: '/api/me' },
      { path: '/api/health' },
      { path: '/api/profile', body: { name: 'Alex' } },
      ...routes.filter((r) => !['/api/events', '/api/password', '/api/profile'].includes(r.path)),
    ];
    for (const route of plain) {
      expect((await device.call(route.path, route.body)).headers.getSetCookie(), route.path).toEqual([]);
    }
    const out = await device.call('/api/logout', {});
    expect(out.headers.getSetCookie()).toEqual(['st_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0']);

    // With a public https address, each cookie is Secure: at the start, at the renewal, and at the end.
    let time = clock;
    const secure = await startTestServer({ name: 'security-https', env: { PUBLIC_ORIGIN: 'https://s22.example.ts.net:8443' }, options: { now: () => time } });
    try {
      const eve = await makeKit(secure, () => time).register('Eve');
      const first = (await makeKit(secure).call({ path: '/api/login', body: { name: 'Eve', password: 'password-of-eve' } })).headers.getSetCookie();
      expect(first[0]).toMatch(/^st_session=[\w-]{43}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=34560000; Secure$/);
      time += 2 * DAY;
      const renewed = (await eve.call('/api/sync', { clientId: 'c1', since: 0, ops: [], tz: 'UTC' })).headers.getSetCookie();
      expect(renewed).toEqual([`${eve.cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=34560000; Secure`]);
      const end = (await eve.call('/api/logout', {})).headers.getSetCookie();
      expect(end).toEqual(['st_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure']);
    } finally {
      await secure.stop();
    }
  });
});

describe('the origin of a POST', () => {
  test('each POST route refuses a different origin, and the request changes nothing', async () => {
    const device = await kit.login('Alex');
    const host = new URL(server.url).host;
    const origins = [
      'https://evil.example',
      'null',
      `http://${host}.evil.example`,
      `http://evil.example/${host}`,
      `http://${host.replace(/:\d+$/, '')}`,
      `http://${host.replace(/:\d+$/, ':1')}`,
      `http://user@evil.example:${host.split(':')[1]}`,
      'not an origin',
      '',
    ];
    const posts: { path: string; body: unknown }[] = [
      { path: '/api/sync', body: { clientId: 'c1', since: 0, ops: [kit.op(setList(sharedList, { title: 'From a different site' }))], tz: 'UTC' } },
      { path: '/api/logout', body: {} },
      { path: '/api/password', body: { current: kit.passwordOf('Alex'), next: 'a-new-password-1' } },
      { path: '/api/profile', body: { name: 'Hacked' } },
      { path: '/api/login', body: { name: 'Alex', password: kit.passwordOf('Alex') } },
      { path: '/api/register', body: { name: 'Third', password: 'long-enough-1' } },
      { path: '/api/push/subscribe', body: { endpoint: 'https://push.example.net/1', keys: { p256dh: 'x', auth: 'y' } } },
      { path: '/api/push/unsubscribe', body: { endpoint: 'https://push.example.net/1' } },
      { path: '/api/push/test', body: {} },
      { path: '/api/test/reset', body: {} },
    ];
    const before = snapshot();
    for (const origin of origins) {
      for (const post of posts) {
        const reply = await device.call<ApiError>(post.path, post.body, { Origin: origin });
        const expected = post.path === '/api/test/reset' ? [404, 'not_found'] : [403, 'forbidden'];
        expect([reply.status, code(reply)], `${post.path} from "${origin}"`).toEqual(expected);
        expect(reply.headers.getSetCookie()).toEqual([]);
      }
    }
    expect(snapshot()).toBe(before);
    // The session lives, the name and the password are the same.
    expect((await device.call<MeResponse>('/api/me')).data.me?.name).toBe('Alex');
    expect((await kit.call({ path: '/api/login', body: { name: 'Alex', password: kit.passwordOf('Alex') } })).status).toBe(200);

    // The own origin is accepted, in each letter case, and a request with no Origin header too.
    const same = await device.call('/api/sync', { clientId: 'c1', since: 0, ops: [], tz: 'UTC' }, { Origin: server.url.toUpperCase().replace('HTTP', 'http') });
    expect(same.status).toBe(200);
  });
});

describe('the size and the form of a body', () => {
  test('a body over 5 MB is refused before the server reads its ops', async () => {
    const before = snapshot();
    const op = kit.op(setList(sharedList, { title: 'From a body that is too large' }));
    const body = JSON.stringify({ clientId: 'c1', since: 0, ops: [op], tz: 'UTC', filler: 'x'.repeat(5 * 1024 * 1024) });
    const sizes: Record<string, string>[] = [{ 'Content-Length': String(Buffer.byteLength(body)) }, { 'Transfer-Encoding': 'chunked' }];
    for (const headers of sizes) {
      const reply = await rawRequest({
        url: server.url,
        path: '/api/sync',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: alex.cookie, ...headers },
        body,
      });
      expect(reply.status).toBe(413);
      expect(JSON.parse(reply.body.toString())).toEqual({ error: { code: 'invalid', message: 'The request body is too large' } });
    }
    // A header that tells a small size does not help: the server stops at that size.
    const lie = await rawRequest({
      url: server.url,
      path: '/api/sync',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: alex.cookie, 'Content-Length': '100', Connection: 'close' },
      body: body.slice(0, 100),
    });
    expect(lie.status).toBe(400);
    expect(snapshot()).toBe(before);
  });

  test('a body that is not JSON, or JSON with a wrong content type, is refused on each POST route', async () => {
    const before = snapshot();
    const good = JSON.stringify({ clientId: 'c1', since: 0, ops: [kit.op(setList(sharedList, { title: 'Must not apply' }))], tz: 'UTC' });
    const posts = ['/api/sync', '/api/login', '/api/register', '/api/password', '/api/profile', '/api/push/subscribe', '/api/push/unsubscribe'];
    for (const route of posts) {
      for (const text of ['{', '{"clientId":', 'clientId=c1&since=0', '<xml/>', '\u0000', "{'since': 0}", '{"since": 0,}', 'NaN', good + good]) {
        const reply = await alex.call<ApiError>(route, text);
        expect([reply.status, code(reply)], `${route} ${text.slice(0, 30)}`).toEqual([400, 'invalid']);
      }
      // The content types that a form of a different site can send.
      for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonx', '']) {
        const reply = await alex.call<ApiError>(route, good, { 'Content-Type': type });
        expect([reply.status, code(reply)], `${route} ${type}`).toEqual([400, 'invalid']);
      }
    }
    expect(snapshot()).toBe(before);
    expect((await alex.call('/api/sync', good, { 'Content-Type': 'application/json; charset=utf-8' })).status).toBe(200);
    await alex.sync([setList(sharedList, { title: 'Groceries' })]);
  });
});

describe('the test route', () => {
  test('exists only when ST_TEST_RESET is exactly 1', async () => {
    const users = server.app.db.q('SELECT id FROM users ORDER BY id').all();
    for (const route of ['/api/test/reset', '/api/test/reset/', '/api/test', '/api/TEST/reset', '/api//test/reset']) {
      for (const person of [alex, sam]) {
        const reply = await person.call<ApiError>(route, {});
        expect([reply.status, code(reply)], route).toEqual([404, 'not_found']);
      }
      expect((await kit.call<ApiError>({ path: route, body: {} })).status).toBe(404);
    }
    expect(server.app.db.q('SELECT id FROM users ORDER BY id').all()).toEqual(users);

    for (const value of ['0', 'true', 'yes', '11', ' 1', '']) {
      const other = await startTestServer({ name: 'security-reset', env: { ST_TEST_RESET: value } });
      try {
        expect((await makeKit(other).call({ path: '/api/test/reset', body: {} })).status, `ST_TEST_RESET="${value}"`).toBe(404);
      } finally {
        await other.stop();
      }
    }
  });
});

describe('files', () => {
  test('no path gives the database or a file outside the folder of the client', async () => {
    const INDEX = '<!doctype html><title>Shared Tasks</title>';
    writeFileSync(path.join(server.dir, 'web', 'index.html'), INDEX);
    const database = path.relative(path.join(server.dir, 'web'), dbPath(path.join(server.dir, 'data'))).split(path.sep).join('/');
    expect(database).toBe('../data/shared-tasks.db');
    const absolute = dbPath(path.join(server.dir, 'data'));
    const attempts = [
      `/${database}`,
      `/assets/../${database}`,
      '/..%2fdata%2fshared-tasks.db',
      '/%2e%2e/data/shared-tasks.db',
      '/%2e%2e%2fdata%2fshared-tasks.db',
      '/.%2e/data/shared-tasks.db',
      '/%2E%2E/data/shared-tasks.db',
      '/..%5cdata%5cshared-tasks.db',
      '/..\\data\\shared-tasks.db',
      '/%252e%252e/data/shared-tasks.db',
      '/..%252fdata%252fshared-tasks.db',
      '/....//data/shared-tasks.db',
      '/..;/data/shared-tasks.db',
      '/%c0%ae%c0%ae/data/shared-tasks.db',
      '/assets/%2e%2e/%2e%2e/data/shared-tasks.db',
      `/${absolute}`,
      `//${absolute}`,
      `/%2f${absolute.slice(1).split('/').join('%2f')}`,
      `/file://${absolute}`,
      '/../data/shared-tasks.db-wal',
      '/../../../../../../../../etc/passwd',
      '/..%2f..%2f..%2f..%2f..%2f..%2f..%2f..%2fetc%2fpasswd',
      '/%00/../data/shared-tasks.db',
      '/index.html%00/../../data/shared-tasks.db',
    ];
    for (const route of attempts) {
      for (const method of ['GET', 'HEAD']) {
        const reply = await rawRequest({ url: server.url, path: route, method, headers: { 'Accept-Encoding': 'br, gzip' } });
        expect([200, 400, 404], route).toContain(reply.status);
        const text = reply.body.toString('latin1');
        expect(text, route).not.toContain('SQLite format 3');
        expect(text, route).not.toContain('root:');
        if (reply.status === 200 && method === 'GET') expect(text, route).toBe(INDEX);
      }
    }
  });
});

describe('secrets', () => {
  /** The text forms in which a binary value could go out. */
  const forms = (value: Uint8Array): string[] => {
    const buffer = Buffer.from(value);
    return [buffer.toString('hex'), buffer.toString('base64'), buffer.toString('base64url')];
  };

  test('passwords, hashes, and tokens are in no answer body and in no log line', async () => {
    let time = Date.now();
    const logs: string[] = [];
    const record = (...args: unknown[]): void => {
      logs.push(args.map((part) => (part instanceof Error ? `${part.stack}\n${JSON.stringify(part)}` : typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
    };
    for (const method of ['error', 'log', 'warn', 'info', 'debug'] as const) vi.spyOn(console, method).mockImplementation(record);
    const other = await startTestServer({ name: 'security-secrets', options: { now: () => time, log: record, loginLockMs: 1 } });
    try {
      const { db } = other.app;
      const bodies: string[] = [];
      const headers: string[] = [];
      const tokens: string[] = [];
      const call = async (input: { path: string; body?: unknown; cookie?: string }): Promise<Reply<unknown>> => {
        const reply = await makeKit(other).call(input);
        bodies.push(typeof reply.data === 'string' ? reply.data : JSON.stringify(reply.data));
        for (const [name, value] of reply.headers) {
          if (name !== 'set-cookie') headers.push(`${name}: ${value}`);
        }
        for (const cookie of reply.headers.getSetCookie()) {
          const token = cookie.split(';')[0]!.split('=')[1]!;
          if (token) tokens.push(token);
        }
        return reply;
      };
      const passwords = ['first-password-Zq81', 'second-password-Zq82', 'wrong-guess-Zq83'];
      const [first, second, guess] = passwords as [string, string, string];

      await call({ path: '/api/register', body: { name: 'Eve', password: first } });
      await call({ path: '/api/register', body: { name: 'Eve', password: second } });
      await call({ path: '/api/register', body: { name: 'Short', password: 'short' } });
      const login = await call({ path: '/api/login', body: { name: 'Eve', password: first } });
      const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
      for (let i = 0; i < 7; i++) {
        await call({ path: '/api/login', body: { name: 'Eve', password: guess } });
        time += 10;
      }
      await call({ path: '/api/login', body: { name: 'Nobody', password: guess } });
      await call({ path: '/api/me', cookie });
      await call({ path: '/api/me' });
      await call({ path: '/api/sync', cookie, body: { clientId: 'c1', since: 0, ops: [], tz: 'UTC' } });
      await call({ path: '/api/profile', cookie, body: { name: 'Eva' } });
      await call({ path: '/api/password', cookie, body: { current: guess, next: second } });
      time += 10;
      await call({ path: '/api/password', cookie, body: { current: first, next: 'short' } });
      await call({ path: '/api/password', cookie, body: { current: first, next: second } });
      await call({ path: '/api/login', body: { name: 'Eva', password: second } });
      await call({ path: '/api/push/test', cookie, body: {} });
      await call({ path: '/api/nothing', cookie, body: { password: first } });
      await call({ path: '/api/login', body: `{"name":"Eva","password":"${second}"` });
      // An error in the server while the request has a password and a cookie.
      db.sql.exec('ALTER TABLE sessions RENAME TO sessions_away');
      try {
        expect((await call({ path: '/api/login', body: { name: 'Eva', password: second } })).status).toBe(500);
        expect((await call({ path: '/api/password', cookie, body: { current: second, next: first } })).status).toBe(500);
        expect((await call({ path: `/api/me?token=${tokens[0]}`, cookie })).status).toBe(500);
      } finally {
        db.sql.exec('ALTER TABLE sessions_away RENAME TO sessions');
      }
      await call({ path: '/api/logout', cookie, body: {} });

      const user = db.q('SELECT pw_hash, pw_salt FROM users').get() as { pw_hash: Uint8Array; pw_salt: Uint8Array };
      const sessions = (db.q('SELECT hash FROM sessions').all() as { hash: Uint8Array }[]).map((s) => s.hash);
      const vapid = JSON.parse(db.getMeta('vapid')!) as { privateKey: string };
      const secrets = [...passwords, ...tokens, ...forms(user.pw_hash), ...forms(user.pw_salt), ...sessions.flatMap(forms), vapid.privateKey];
      expect(tokens.length).toBeGreaterThanOrEqual(3);
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      expect(logs.length).toBeGreaterThanOrEqual(3);

      const everything = [...bodies, ...headers, ...logs].join('\n');
      for (const secret of secrets) expect(everything.includes(secret), `the secret ${secret.slice(0, 6)}… went out`).toBe(false);
      // The log has the route of each error, so the search above did look at real lines.
      expect(logs.join('\n')).toContain('error POST /api/login');
      expect(logs.join('\n')).toContain('error GET /api/me');
      expect(logs.join('\n')).not.toContain('token=');
    } finally {
      await other.stop();
    }
  });
});
