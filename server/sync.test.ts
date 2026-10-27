import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { makeKit, startTestServer } from './testkit.ts';
import type { Kit, Person, TestServer } from './testkit.ts';
import type { ApiError, ID, ListFields, Put, RepeatRule, SyncResponse, TaskFields } from '../shared/types.ts';

const DAY = 86_400_000;

let server: TestServer;
let kit: Kit;
let alex: Person;
let sam: Person;
let kim: Person;
// The clock of the server and of the timestamps. The cleanup test moves it.
let clock = Date.now();

beforeAll(async () => {
  server = await startTestServer({ name: 'sync', env: { MAX_USERS: '3' }, options: { now: () => clock } });
  kit = makeKit(server, () => clock);
  alex = await kit.register('Alex');
  sam = await kit.register('Sam');
  kim = await kit.register('Kim');
});
afterAll(() => server.stop());

const setTask = (id: ID, fields: TaskFields): Put => ({ kind: 'task', id, fields });
const setList = (id: ID, fields: ListFields): Put => ({ kind: 'list', id, fields });
const ids = (rows: { id: ID }[]): ID[] => rows.map((r) => r.id).sort();
const nothing = (r: SyncResponse): boolean =>
  r.lists.length + r.tasks.length + r.notes.length + r.gone.lists.length + r.gone.tasks.length + r.gone.notes.length === 0;
/** The gone ids in a fixed order. The server gives them in no special order. */
const gone = (r: SyncResponse): SyncResponse['gone'] => ({
  lists: [...r.gone.lists].sort(),
  tasks: [...r.gone.tasks].sort(),
  notes: [...r.gone.notes].sort(),
});

/** Brings each person to the newest revision, so the next sync of a person shows only what a test did. */
async function settle(): Promise<void> {
  for (const person of [alex, sam, kim]) await person.sync();
}

/** Makes a list of Alex with tasks. Returns the ids. */
async function makeList(input: { shared: boolean; tasks?: number; owner?: Person }): Promise<{ list: ID; tasks: ID[] }> {
  const owner = input.owner ?? alex;
  const list = kit.list({ title: 'A list', shared: input.shared });
  const tasks = Array.from({ length: input.tasks ?? 0 }, (_, i) => kit.task({ listId: list.id, title: `Task ${i}`, pos: `a${i}` }));
  const reply = await owner.sync([list, ...tasks]);
  expect(reply.rejected).toEqual([]);
  await settle();
  return { list: list.id, tasks: tasks.map((t) => t.id) };
}

describe('rows', () => {
  test('a put makes a row. Missing fields get defaults, and the server sets the fixed fields', async () => {
    const list = kit.list({ title: 'Trip', owner: sam.user.id, isDefault: true, createdAt: 1234 });
    const task = setTask('task-with-defaults', { listId: list.id, title: 'Book the train' });
    const before = alex.since;
    const reply = await alex.sync([list, task]);

    expect(reply.acked).toHaveLength(2);
    expect(reply.rejected).toEqual([]);
    expect(reply.reset).toBe(false);
    expect(reply.rev).toBeGreaterThan(before);
    expect(reply.now).toBe(clock);
    expect(reply.lists.find((l) => l.id === list.id)).toEqual({
      id: list.id,
      title: 'Trip',
      // The owner is the person of the session, and a client cannot make a default list.
      owner: alex.user.id,
      isDefault: false,
      shared: false,
      createdAt: 1234,
      deleted: false,
      pos: null,
      sort: 'my',
      hidden: false,
    });
    expect(reply.tasks).toEqual([
      {
        id: 'task-with-defaults',
        listId: list.id,
        parentId: null,
        title: 'Book the train',
        notes: '',
        pos: 'a0',
        due: null,
        time: null,
        deadline: null,
        repeat: null,
        repeatCount: 0,
        hiddenUntil: null,
        lastDoneAt: null,
        lastDoneDue: null,
        completed: false,
        completedAt: null,
        completedBy: null,
        createdAt: clock,
        createdBy: alex.user.id,
        deleted: false,
        starred: false,
        starredAt: null,
      },
    ]);
  });

  test('all fields of a task come back as they were sent', async () => {
    const { list } = await makeList({ shared: false });
    const repeat: RepeatRule = { every: 2, unit: 'week', weekdays: [1, 3], start: '2026-10-05', end: { type: 'after', count: 30 } };
    const fields: TaskFields = {
      listId: list,
      parentId: 'some-parent',
      title: 'Water the plants',
      notes: 'Not too much',
      pos: 'a5V',
      due: '2026-10-07',
      time: '08:30',
      deadline: '2026-10-09',
      repeat,
      repeatCount: 3,
      hiddenUntil: '2026-10-07',
      lastDoneAt: 1_790_000_000_000,
      lastDoneDue: '2026-10-05',
      completed: true,
      completedAt: 1_790_000_000_001,
      completedBy: sam.user.id,
      createdAt: 1_780_000_000_000,
      starred: true,
      starredAt: 1_790_000_000_002,
    };
    const reply = await alex.sync([setTask('full-task', fields)]);
    expect(reply.tasks).toEqual([{ id: 'full-task', ...fields, createdBy: alex.user.id, deleted: false }]);
  });

  test('the fixed fields do not change after the row is made', async () => {
    const { list, tasks } = await makeList({ shared: true, tasks: 1 });
    const before = await kit.login('Alex');
    const was = await before.sync();
    const rev = alex.since;

    const reply = await sam.sync([
      setList(list, { owner: sam.user.id, isDefault: true, createdAt: 1 }),
      setTask(tasks[0]!, { createdAt: 1, createdBy: sam.user.id }),
    ]);
    // The ops are valid, and they change nothing. So no row gets a new revision.
    expect(reply.acked).toHaveLength(2);
    expect(reply.rev).toBe(rev);
    expect((await before.sync()).rev).toBe(rev);
    const after = await (await kit.login('Alex')).sync();
    expect(after.lists.find((l) => l.id === list)).toEqual(was.lists.find((l) => l.id === list));
    expect(after.tasks.find((t) => t.id === tasks[0])).toEqual(was.tasks.find((t) => t.id === tasks[0]));
  });

  test('a first sync gets all visible rows and no gone ids', async () => {
    const { list, tasks } = await makeList({ shared: false, tasks: 3 });
    await alex.sync([setTask(tasks[0]!, { deleted: true })]);
    const device = await kit.login('Alex');
    const reply = await device.sync();

    expect(reply.reset).toBe(false);
    expect(reply.gone).toEqual({ lists: [], tasks: [], notes: [] });
    expect(reply.lists.map((l) => l.id)).toContain(list);
    expect(reply.lists.some((l) => l.isDefault)).toBe(true);
    const mine = reply.tasks.filter((t) => t.listId === list);
    expect(ids(mine)).toEqual([tasks[1], tasks[2]].sort());
    expect(reply.rev).toBe(alex.since);
    // The next sync of the device has nothing to get.
    expect(nothing(await device.sync())).toBe(true);
  });

  test('a delete puts the id in gone, and a later change of the row keeps it gone', async () => {
    const { tasks } = await makeList({ shared: true, tasks: 1 });
    const reply = await alex.sync([setTask(tasks[0]!, { deleted: true })]);
    expect(reply.tasks).toEqual([]);
    expect(reply.gone.tasks).toEqual(tasks);
    expect((await kim.sync()).gone.tasks).toEqual(tasks);

    // Sam did not sync after the delete, and changes the task. The op is valid, and the task stays deleted.
    const late = await sam.sync([setTask(tasks[0]!, { title: 'Changed while it was deleted' })]);
    expect(late.acked).toHaveLength(1);
    expect(late.tasks).toEqual([]);
    expect(late.gone.tasks).toEqual(tasks);

    // The undo of the delete brings the row back, with the change.
    const back = await alex.sync([setTask(tasks[0]!, { deleted: false })]);
    expect(back.tasks.map((t) => [t.id, t.title, t.deleted])).toEqual([[tasks[0], 'Changed while it was deleted', false]]);
    expect(ids((await sam.sync()).tasks)).toEqual(tasks);
  });
});

describe('merge', () => {
  test.each(['Alex first', 'Sam first'])('each field merges by itself (%s)', async (order) => {
    const { tasks } = await makeList({ shared: true, tasks: 1 });
    const id = tasks[0]!;
    // Later than the timestamps of the new rows, and less than one minute ahead of the server.
    const t = clock;
    // The op of Alex is the newer one. Each op changes a different field.
    const fromAlex = kit.op(setTask(id, { title: 'Title from Alex' }), kit.at(t + 2000, 'alex00'));
    const fromSam = kit.op(setTask(id, { due: '2026-11-01', notes: 'Notes from Sam' }), kit.at(t + 1000, 'sam000'));
    if (order === 'Alex first') {
      await alex.sync([fromAlex]);
      await sam.sync([fromSam]);
    } else {
      await sam.sync([fromSam]);
      await alex.sync([fromAlex]);
    }
    const row = (await (await kit.login('Kim')).sync()).tasks.find((x) => x.id === id);
    expect(row).toMatchObject({ title: 'Title from Alex', due: '2026-11-01', notes: 'Notes from Sam' });
  });

  test.each(['newer first', 'older first'])('the newer value of one field stays (%s)', async (order) => {
    const { list, tasks } = await makeList({ shared: true, tasks: 1 });
    const id = tasks[0]!;
    const t = clock;
    const newer = [
      kit.op(setTask(id, { title: 'Newer', completed: true }), kit.at(t + 5000, 'alex00')),
      kit.op(setList(list, { title: 'Newer list name' }), kit.at(t + 5000, 'alex00')),
    ];
    const older = [
      kit.op(setTask(id, { title: 'Older', completed: false, time: '10:00' }), kit.at(t + 4000, 'sam000')),
      kit.op(setList(list, { title: 'Older list name' }), kit.at(t + 4000, 'sam000')),
    ];
    if (order === 'newer first') {
      await alex.sync(newer);
      const reply = await sam.sync(older);
      // The older op is valid. Its 'time' is new, and its other fields lose.
      expect(reply.acked).toHaveLength(2);
    } else {
      await sam.sync(older);
      await alex.sync(newer);
    }
    const all = await (await kit.login('Kim')).sync();
    expect(all.tasks.find((x) => x.id === id)).toMatchObject({ title: 'Newer', completed: true, time: '10:00' });
    expect(all.lists.find((x) => x.id === list)?.title).toBe('Newer list name');
  });

  test('with equal times, the timestamp of the greater device id wins in each order', async () => {
    const { tasks } = await makeList({ shared: true, tasks: 2 });
    const t = clock + 1000;
    const a = (id: ID) => kit.op(setTask(id, { title: 'From aaa' }), kit.at(t, 'aaaaaa'));
    const b = (id: ID) => kit.op(setTask(id, { title: 'From bbb' }), kit.at(t, 'bbbbbb'));
    await alex.sync([a(tasks[0]!)]);
    await sam.sync([b(tasks[0]!)]);
    await sam.sync([b(tasks[1]!)]);
    await alex.sync([a(tasks[1]!)]);
    const all = (await (await kit.login('Alex')).sync()).tasks.filter((x) => tasks.includes(x.id));
    expect(all.map((x) => x.title)).toEqual(['From bbb', 'From bbb']);
  });

  test('an op that arrives two times changes nothing the second time', async () => {
    const { tasks } = await makeList({ shared: true, tasks: 1 });
    const op = kit.op(setTask(tasks[0]!, { title: 'Sent two times', starred: true, starredAt: 5 }));
    const first = await alex.sync([op]);
    expect(first.acked).toEqual([op.opId]);
    expect(first.tasks).toHaveLength(1);

    const second = await alex.sync([op]);
    expect(second.acked).toEqual([op.opId]);
    expect(second.rev).toBe(first.rev);
    expect(nothing(second)).toBe(true);
    // The other person got the change one time and gets nothing after the repeat.
    expect((await sam.sync()).tasks).toHaveLength(1);
    await alex.sync([op]);
    expect(nothing(await sam.sync())).toBe(true);
  });

  test('a newer op with the same values gives no new revision', async () => {
    const { list, tasks } = await makeList({ shared: true, tasks: 1 });
    const first = await alex.sync([setTask(tasks[0]!, { title: 'Same', due: '2026-10-10' }), setList(list, { title: 'Same list' })]);
    const second = await alex.sync([setTask(tasks[0]!, { title: 'Same', due: '2026-10-10' }), setList(list, { title: 'Same list' })]);
    expect(second.acked).toHaveLength(2);
    expect(second.rev).toBe(first.rev);
  });

  test('a timestamp too far in the future gets the server time', async () => {
    const { tasks } = await makeList({ shared: false, tasks: 2 });
    // The clock of this device is one hour ahead.
    await alex.sync([kit.op(setTask(tasks[0]!, { title: 'From the future' }), kit.at(clock + 3_600_000))]);
    // Without the limit, this change of 5 seconds later would lose for one hour.
    const reply = await alex.sync([kit.op(setTask(tasks[0]!, { title: 'A normal change' }), kit.at(clock + 5_000))]);
    expect(reply.tasks[0]?.title).toBe('A normal change');

    // Two such ops in one request keep their order.
    const both = await alex.sync([
      kit.op(setTask(tasks[1]!, { title: 'One' }), kit.at(clock + 3_600_000)),
      kit.op(setTask(tasks[1]!, { title: 'Two' }), kit.at(clock + 3_600_001)),
    ]);
    expect(both.tasks[0]?.title).toBe('Two');
    // A timestamp of less than one minute ahead stays as it is: the older op loses.
    const ahead = await alex.sync([kit.op(setTask(tasks[1]!, { title: 'Ahead' }), kit.at(clock + 50_000))]);
    const late = await alex.sync([kit.op(setTask(tasks[1]!, { title: 'Behind' }), kit.at(clock + 40_000))]);
    expect(late.acked).toHaveLength(1);
    expect(late.rev).toBe(ahead.rev);
    // The device shows 'Behind' after its own put, so it gets the row that stays.
    expect(late.tasks.map((t) => t.title)).toEqual(['Ahead']);
  });
});

describe('per-person fields', () => {
  test('each person has separate values', async () => {
    const { list, tasks } = await makeList({ shared: true, tasks: 1 });
    const id = tasks[0]!;
    const phone = await kit.login('Alex');
    await phone.sync();

    const reply = await alex.sync([
      setTask(id, { starred: true, starredAt: 111 }),
      setList(list, { pos: 'b1', sort: 'date', hidden: true }),
    ]);
    expect(reply.tasks[0]).toMatchObject({ id, starred: true, starredAt: 111 });
    expect(reply.lists[0]).toMatchObject({ id: list, pos: 'b1', sort: 'date', hidden: true });

    // The shared part of the rows did not change, so the other people get nothing.
    expect(nothing(await sam.sync())).toBe(true);
    expect(nothing(await kim.sync())).toBe(true);
    // The other device of Alex gets the values.
    const other = await phone.sync();
    expect(other.tasks[0]).toMatchObject({ id, starred: true, starredAt: 111 });
    expect(other.lists[0]).toMatchObject({ id: list, pos: 'b1', sort: 'date', hidden: true });

    // Sam sets his own values. Alex gets nothing and keeps her values.
    const fromSam = await sam.sync([setTask(id, { starred: true, starredAt: 222 }), setList(list, { sort: 'title', pos: 'a7' })]);
    expect(fromSam.tasks[0]).toMatchObject({ starred: true, starredAt: 222 });
    expect(fromSam.lists[0]).toMatchObject({ pos: 'a7', sort: 'title', hidden: false });
    expect(nothing(await alex.sync())).toBe(true);

    const fresh = async (name: string) => {
      const all = await (await kit.login(name)).sync();
      return { task: all.tasks.find((t) => t.id === id)!, list: all.lists.find((l) => l.id === list)! };
    };
    expect(await fresh('Alex')).toMatchObject({ task: { starred: true, starredAt: 111 }, list: { pos: 'b1', sort: 'date', hidden: true } });
    expect(await fresh('Sam')).toMatchObject({ task: { starred: true, starredAt: 222 }, list: { pos: 'a7', sort: 'title', hidden: false } });
    expect(await fresh('Kim')).toMatchObject({ task: { starred: false, starredAt: null }, list: { pos: null, sort: 'my', hidden: false } });
  });

  test('a shared change and a per-person change in one op each go to the right people', async () => {
    const { tasks } = await makeList({ shared: true, tasks: 1 });
    await alex.sync([setTask(tasks[0]!, { title: 'New title', starred: true, starredAt: 9 })]);
    const forSam = await sam.sync();
    expect(forSam.tasks).toHaveLength(1);
    expect(forSam.tasks[0]).toMatchObject({ title: 'New title', starred: false, starredAt: null });
  });
});

describe('visibility', () => {
  test('a private list never reaches the other person, not as rows and not as ids', async () => {
    const { list, tasks } = await makeList({ shared: false, tasks: 3 });
    const other = await makeList({ shared: false });
    const secret = [list, other.list, ...tasks];
    const seen: SyncResponse[] = [await (await kit.login('Sam')).sync()];
    const step = async (...puts: Put[]): Promise<void> => {
      expect((await alex.sync(puts)).rejected).toEqual([]);
      seen.push(await sam.sync(), await kim.sync());
    };

    await step(setTask(tasks[0]!, { title: 'Changed', starred: true }));
    await step(setTask(tasks[0]!, { deleted: true }));
    await step(setTask(tasks[1]!, { listId: other.list }));
    await step(setList(list, { title: 'New name', sort: 'date' }));
    await step(setList(list, { deleted: true }));
    await step(setList(list, { deleted: false }));
    await step(setList(other.list, { deleted: true }));
    seen.push(await (await kit.login('Sam')).sync());

    for (const reply of seen) {
      const text = JSON.stringify(reply);
      for (const id of secret) expect(text).not.toContain(id);
    }
    // Each sync of the other people between the steps is empty.
    expect(seen.slice(1, -1).every(nothing)).toBe(true);
  });

  test('share: the list and its tasks arrive. Stop sharing: they go', async () => {
    const { list, tasks } = await makeList({ shared: false, tasks: 3 });
    await alex.sync([setTask(tasks[0]!, { deleted: true }), setTask(tasks[1]!, { completed: true })]);
    await settle();
    const open = [tasks[1]!, tasks[2]!].sort();

    await alex.sync([setList(list, { shared: true })]);
    for (const person of [sam, kim]) {
      const reply = await person.sync();
      expect(ids(reply.lists)).toEqual([list]);
      expect(reply.lists[0]).toMatchObject({ shared: true, owner: alex.user.id, pos: null });
      expect(ids(reply.tasks)).toEqual(open);
      expect(reply.gone).toEqual({ lists: [], tasks: [], notes: [] });
    }

    const stop = await alex.sync([setList(list, { shared: false })]);
    // The owner keeps the rows. The server sends them again with the new state.
    expect(stop.gone).toEqual({ lists: [], tasks: [], notes: [] });
    expect(stop.lists[0]).toMatchObject({ id: list, shared: false });
    for (const person of [sam, kim]) {
      const reply = await person.sync();
      expect(reply.lists).toEqual([]);
      expect(reply.tasks).toEqual([]);
      // The task that was deleted before the share never reached them, so its id does not go out.
      expect(gone(reply)).toEqual({ lists: [list], tasks: open, notes: [] });
      expect(nothing(await person.sync())).toBe(true);
    }

    // After the end of the share, new rows and changes of the list stay with the owner.
    const added = kit.task({ listId: list, title: 'Private again' });
    await alex.sync([added, setTask(tasks[2]!, { deleted: true }), setTask(tasks[1]!, { title: 'x' })]);
    expect(nothing(await sam.sync())).toBe(true);

    await alex.sync([setList(list, { shared: true })]);
    const again = await sam.sync();
    expect(ids(again.lists)).toEqual([list]);
    expect(ids(again.tasks)).toEqual([tasks[1]!, added.id].sort());
    expect(again.gone).toEqual({ lists: [], tasks: [], notes: [] });
  });

  test('a device that was away for the full time of a share gets nothing from it', async () => {
    const { list } = await makeList({ shared: false, tasks: 2 });
    await alex.sync([setList(list, { shared: true })]);
    await alex.sync([setList(list, { shared: false })]);
    // The ids go out as 'gone': the rows were visible for a time. No row goes out.
    const reply = await sam.sync();
    expect(reply.lists).toEqual([]);
    expect(reply.tasks).toEqual([]);
    expect(reply.gone.lists).toEqual([list]);
  });

  test('a device that was away while a list went and came back gets the rows and no gone ids', async () => {
    const { list, tasks } = await makeList({ shared: true, tasks: 2 });
    await alex.sync([setList(list, { shared: false }), setTask(tasks[0]!, { deleted: true })]);
    await alex.sync([setTask(tasks[0]!, { deleted: false }), setList(list, { shared: true })]);
    const reply = await sam.sync();
    expect(ids(reply.lists)).toEqual([list]);
    expect(ids(reply.tasks)).toEqual([...tasks].sort());
    expect(reply.gone).toEqual({ lists: [], tasks: [], notes: [] });
  });

  test('a change of shared gives each task of the list a new revision', async () => {
    const { list, tasks } = await makeList({ shared: false, tasks: 4 });
    const reply = await alex.sync([setList(list, { shared: true })]);
    expect(ids(reply.tasks)).toEqual([...tasks].sort());
    const revs = server.app.db.q('SELECT DISTINCT rev FROM tasks WHERE list_id = ?').all(list) as { rev: number }[];
    expect(revs).toEqual([{ rev: reply.rev }]);
  });

  test('delete of a list: the list and its tasks go for each person, and come back with the undo', async () => {
    const { list, tasks } = await makeList({ shared: true, tasks: 2 });
    const sorted = [...tasks].sort();
    const reply = await alex.sync([setList(list, { deleted: true })]);
    expect(reply.lists).toEqual([]);
    expect(reply.tasks).toEqual([]);
    expect(gone(reply)).toEqual({ lists: [list], tasks: sorted, notes: [] });
    const forSam = await sam.sync();
    expect(gone(forSam)).toEqual({ lists: [list], tasks: sorted, notes: [] });
    expect(forSam.lists).toEqual([]);
    // A first sync does not show the deleted list and its tasks.
    const fresh = await (await kit.login('Kim')).sync();
    expect(fresh.lists.map((l) => l.id)).not.toContain(list);
    expect(fresh.tasks.filter((t) => t.listId === list)).toEqual([]);

    const undo = await alex.sync([setList(list, { deleted: false })]);
    expect(ids(undo.lists)).toEqual([list]);
    expect(ids(undo.tasks)).toEqual(sorted);
    const back = await sam.sync();
    expect(ids(back.lists)).toEqual([list]);
    expect(ids(back.tasks)).toEqual(sorted);
    expect(back.gone).toEqual({ lists: [], tasks: [], notes: [] });
  });

  test('a task that moves to a private list is gone for the other person', async () => {
    const shared = await makeList({ shared: true, tasks: 2 });
    const mine = await makeList({ shared: false });
    const [first, second] = shared.tasks as [ID, ID];

    const moved = await alex.sync([setTask(first, { listId: mine.list })]);
    expect(moved.tasks[0]).toMatchObject({ id: first, listId: mine.list });
    expect(moved.gone.tasks).toEqual([]);
    const forSam = await sam.sync();
    expect(forSam.tasks).toEqual([]);
    expect(forSam.gone).toEqual({ lists: [], tasks: [first], notes: [] });

    // Back in the shared list, the task arrives again.
    await alex.sync([setTask(first, { listId: shared.list })]);
    expect((await sam.sync()).tasks[0]).toMatchObject({ id: first, listId: shared.list });

    // Sam moves a task to a list of his own: now it is gone for Alex and Kim.
    const ofSam = await makeList({ shared: false, owner: sam });
    await sam.sync([setTask(second, { listId: ofSam.list })]);
    expect((await alex.sync()).gone).toEqual({ lists: [], tasks: [second], notes: [] });
    expect((await kim.sync()).gone).toEqual({ lists: [], tasks: [second], notes: [] });
  });
});

describe('permissions', () => {
  test('each person can make a list', async () => {
    for (const person of [alex, sam, kim]) {
      const list = kit.list({ title: `List of ${person.user.name}` });
      const reply = await person.sync([list]);
      expect(reply.rejected).toEqual([]);
      expect(reply.lists.find((l) => l.id === list.id)).toMatchObject({ owner: person.user.id, isDefault: false });
    }
    // A put that makes a list has a title. With no title it is a change of a list that does not exist.
    const reply = await alex.sync([setList('no-such-list', { sort: 'date' })]);
    expect(reply.rejected).toHaveLength(1);
    expect(reply.gone.lists).toEqual(['no-such-list']);
  });

  test('title of a list: each person who can see it', async () => {
    const shared = await makeList({ shared: true });
    const secret = await makeList({ shared: false });
    const ok = await sam.sync([setList(shared.list, { title: 'Renamed by Sam' })]);
    expect(ok.rejected).toEqual([]);
    expect((await alex.sync()).lists[0]).toMatchObject({ id: shared.list, title: 'Renamed by Sam' });

    const no = await sam.sync([setList(secret.list, { title: 'Renamed by Sam' })]);
    expect(no.rejected).toHaveLength(1);
    expect(no.gone.lists).toEqual([secret.list]);
    expect(nothing(await alex.sync())).toBe(true);
  });

  test('shared and deleted of a list: the owner only', async () => {
    const { list } = await makeList({ shared: true, tasks: 1 });
    for (const fields of [{ shared: false }, { deleted: true }, { title: 'Also not', deleted: true }] satisfies ListFields[]) {
      const reply = await sam.sync([setList(list, fields)]);
      expect(reply.acked).toEqual([]);
      expect(reply.rejected).toHaveLength(1);
      // The true row comes back, so the device of Sam drops its change.
      expect(reply.lists).toHaveLength(1);
      expect(reply.lists[0]).toMatchObject({ id: list, title: 'A list', shared: true, deleted: false });
    }
    expect(nothing(await alex.sync())).toBe(true);
    // A value that is equal to the stored value is no change, so the other fields of the op apply.
    const same = await sam.sync([setList(list, { title: 'Good', shared: true, deleted: false })]);
    expect(same.rejected).toEqual([]);
    expect(same.lists[0]).toMatchObject({ title: 'Good', shared: true });

    expect((await alex.sync([setList(list, { shared: false })])).rejected).toEqual([]);
    expect((await alex.sync([setList(list, { deleted: true })])).rejected).toEqual([]);
  });

  test('pos, sort, hidden of a list: each person who can see it, for that person only', async () => {
    const shared = await makeList({ shared: true });
    const secret = await makeList({ shared: false });
    const ok = await sam.sync([setList(shared.list, { pos: 'c3', sort: 'deadline', hidden: true })]);
    expect(ok.rejected).toEqual([]);
    expect(ok.lists[0]).toMatchObject({ pos: 'c3', sort: 'deadline', hidden: true });
    expect(nothing(await alex.sync())).toBe(true);

    const no = await sam.sync([setList(secret.list, { hidden: true })]);
    expect(no.rejected).toHaveLength(1);
    expect(server.app.db.q('SELECT 1 FROM list_user WHERE list_id = ? AND user_id = ?').get(secret.list, sam.user.id)).toBeUndefined();
  });

  test('no person can delete the default list', async () => {
    const all = await (await kit.login('Alex')).sync();
    const home = all.lists.find((l) => l.isDefault)!;
    const reply = await alex.sync([setList(home.id, { deleted: true })]);
    expect(reply.rejected).toHaveLength(1);
    expect(reply.lists.find((l) => l.id === home.id)).toEqual(home);
    // The owner can change its other fields, also 'shared'.
    const share = await alex.sync([setList(home.id, { title: 'Everything', shared: true })]);
    expect(share.rejected).toEqual([]);
    expect((await sam.sync([setList(home.id, { deleted: true })])).rejected).toHaveLength(1);
    await alex.sync([setList(home.id, { title: 'My Tasks', shared: false })]);
    await settle();
  });

  test('tasks: each person who can see the list', async () => {
    const shared = await makeList({ shared: true, tasks: 1 });
    const secret = await makeList({ shared: false, tasks: 1 });

    // In a shared list: make, change, delete.
    const made = kit.task({ listId: shared.list, title: 'Made by Sam' });
    const ok = await sam.sync([made, setTask(shared.tasks[0]!, { title: 'Changed by Sam', completed: true }), setTask(made.id, { deleted: true })]);
    expect(ok.rejected).toEqual([]);
    expect(ok.tasks.find((t) => t.id === made.id)).toBeUndefined();
    expect(ok.gone.tasks).toEqual([made.id]);
    expect(server.app.db.q('SELECT created_by FROM tasks WHERE id = ?').get(made.id)).toEqual({ created_by: sam.user.id });
    expect((await alex.sync()).tasks[0]).toMatchObject({ title: 'Changed by Sam', completed: true });

    // In a list that Sam cannot see: nothing.
    const intruder = kit.task({ listId: secret.list, title: 'Not welcome' });
    const no = await sam.sync([
      intruder,
      setTask(secret.tasks[0]!, { title: 'Changed by Sam' }),
      setTask(secret.tasks[0]!, { starred: true }),
      setTask(secret.tasks[0]!, { deleted: true }),
    ]);
    expect(no.acked).toEqual([]);
    expect(no.rejected).toHaveLength(4);
    expect(gone(no).tasks).toEqual([intruder.id, secret.tasks[0]!].sort());
    expect(no.tasks).toEqual([]);
    expect(server.app.db.q('SELECT 1 FROM tasks WHERE id = ?').get(intruder.id)).toBeUndefined();
    expect(nothing(await alex.sync())).toBe(true);
  });

  test('a move of a task: the person must see the old list and the new list', async () => {
    const shared = await makeList({ shared: true, tasks: 1 });
    const secret = await makeList({ shared: false, tasks: 1 });
    const ofSam = await makeList({ shared: false, owner: sam });

    // To a list that Sam cannot see.
    const out = await sam.sync([setTask(shared.tasks[0]!, { listId: secret.list })]);
    expect(out.rejected).toHaveLength(1);
    expect(out.tasks[0]).toMatchObject({ id: shared.tasks[0], listId: shared.list });
    // From a list that Sam cannot see.
    const pull = await sam.sync([setTask(secret.tasks[0]!, { listId: ofSam.list })]);
    expect(pull.rejected).toHaveLength(1);
    expect(pull.gone.tasks).toEqual(secret.tasks);
    // To a list that does not exist, and a new task with no list or in no list.
    const lost = await sam.sync([
      setTask(shared.tasks[0]!, { listId: 'no-such-list' }),
      setTask('new-task-1', { title: 'No list' }),
      setTask('new-task-2', { listId: 'no-such-list', title: 'No list' }),
    ]);
    expect(lost.rejected).toHaveLength(3);
    expect(gone(lost).tasks).toEqual(['new-task-1', 'new-task-2']);
    expect(nothing(await alex.sync())).toBe(true);

    // Between two lists that Sam can see.
    const fine = await sam.sync([setTask(shared.tasks[0]!, { listId: ofSam.list })]);
    expect(fine.rejected).toEqual([]);
    expect(fine.tasks[0]).toMatchObject({ listId: ofSam.list });
  });
});

describe('ops that the server does not accept', () => {
  test('a bad op is rejected and the other ops of the request apply', async () => {
    const { list, tasks } = await makeList({ shared: false, tasks: 1 });
    const id = tasks[0]!;
    const good1 = kit.op(setTask(id, { title: 'First good op' }));
    const good2 = kit.op(setTask(id, { notes: 'Second good op', color: 'red' } as TaskFields));
    const bad = [
      { ...kit.op(setTask(id, { title: 'x' })), kind: 'user' },
      { ...kit.op(setTask(id, { title: 'x' })), id: 'not a valid id' },
      { ...kit.op(setTask(id, { title: 'x' })), id: 'x'.repeat(65) },
      { ...kit.op(setTask(id, { title: 'x' })), ts: 'not-a-timestamp' },
      { ...kit.op(setTask(id, { title: 'x' })), ts: undefined },
      { ...kit.op(setTask(id, { title: 'x' })), fields: 'title' },
      { ...kit.op(setTask(id, { title: 'x' })), fields: null },
      kit.op(setTask(id, { title: 5 } as never)),
      kit.op(setTask(id, { completed: 'yes' } as never)),
      kit.op(setTask(id, { due: '2026-02-30' })),
      kit.op(setTask(id, { due: '06.10.2026' })),
      kit.op(setTask(id, { time: '25:00' })),
      kit.op(setTask(id, { time: '9:00' })),
      kit.op(setTask(id, { listId: null } as never)),
      kit.op(setTask(id, { parentId: 'not valid!' })),
      kit.op(setTask(id, { repeatCount: -1 })),
      kit.op(setTask(id, { repeatCount: 1.5 })),
      kit.op(setTask(id, { completedAt: 1e300 })),
      kit.op(setTask(id, { pos: null } as never)),
      kit.op(setTask(id, { createdAt: 'now' } as never)),
      kit.op(setList(list, { sort: 'random' } as never)),
      kit.op(setList(list, { hidden: 1 } as never)),
      kit.op(setList(list, { title: null } as never)),
    ];
    // These have no usable op id, so the answer cannot name them. They must not stop the request.
    const noise = [null, 5, 'op', [], { kind: 'task', id, ts: kit.ts(), fields: { title: 'No op id' } }, { opId: 7 }];

    const reply = await alex.call<SyncResponse>('/api/sync', {
      clientId: alex.clientId,
      since: alex.since,
      ops: [good1, ...bad.slice(0, 12), ...noise, ...bad.slice(12), good2],
      tz: 'Europe/Berlin',
    });
    expect(reply.status).toBe(200);
    alex.since = reply.data.rev;
    expect(reply.data.acked).toEqual([good1.opId, good2.opId]);
    expect(reply.data.rejected).toEqual(bad.map((op) => op.opId));
    expect(reply.data.tasks).toHaveLength(1);
    expect(reply.data.tasks[0]).toMatchObject({ id, title: 'First good op', notes: 'Second good op' });
    expect(reply.data.tasks[0]).not.toHaveProperty('color');
    expect(reply.data.gone).toEqual({ lists: [], tasks: [], notes: [] });
  });

  test('the op that makes a list can come after the ops for its tasks', async () => {
    // A device merges its puts for one row into one op. So a task that was made first and then
    // moved to a new list has its op before the op of that list.
    const list = kit.list({ title: 'Made later', shared: true });
    const task = kit.task({ listId: list.id, title: 'Made first' });
    const reply = await sam.sync([task, list]);
    expect(reply.rejected).toEqual([]);
    expect(reply.acked).toHaveLength(2);
    expect(reply.tasks.find((t) => t.id === task.id)).toMatchObject({ listId: list.id, createdBy: sam.user.id });
    expect((await alex.sync()).tasks.map((t) => t.id)).toContain(task.id);
  });

  test('an error in one op does not stop the other ops', async () => {
    const { tasks } = await makeList({ shared: false, tasks: 2 });
    // A row that the merge cannot read.
    server.app.db.q("UPDATE tasks SET ts = 'broken' WHERE id = ?").run(tasks[0]!);
    const errors: unknown[] = [];
    const log = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const bad = kit.op(setTask(tasks[0]!, { title: 'Cannot merge' }));
      const good = kit.op(setTask(tasks[1]!, { title: 'Can merge' }));
      const before = alex.since;
      const reply = await alex.sync([bad, good]);
      expect(reply.rejected).toEqual([bad.opId]);
      expect(reply.acked).toEqual([good.opId]);
      expect(reply.rev).toBe(before + 1);
      expect(reply.tasks.map((t) => [t.id, t.title]).sort()).toEqual([[tasks[0], 'Task 0'], [tasks[1], 'Can merge']].sort());
      expect(errors).toHaveLength(1);
    } finally {
      console.error = log;
    }
  });

  test('a rejected op gives back the true row, or the id in gone', async () => {
    const shared = await makeList({ shared: true, tasks: 1 });
    const secret = await makeList({ shared: false, tasks: 1 });
    const before = sam.since;

    const reply = await sam.sync([
      setTask(shared.tasks[0]!, { title: 7 } as never),
      setList(shared.list, { deleted: true }),
      setTask(secret.tasks[0]!, { title: 'Mine now' }),
      setList(secret.list, { title: 'Mine now' }),
    ]);
    expect(reply.acked).toEqual([]);
    expect(reply.rejected).toHaveLength(4);
    // Nothing changed, so the revision is the same. The rows come back because of the rejected ops.
    expect(reply.rev).toBe(before);
    expect(reply.tasks).toHaveLength(1);
    expect(reply.tasks[0]).toMatchObject({ id: shared.tasks[0], title: 'Task 0' });
    expect(reply.lists).toHaveLength(1);
    expect(reply.lists[0]).toMatchObject({ id: shared.list, deleted: false });
    expect(reply.gone).toEqual({ lists: [secret.list], tasks: secret.tasks, notes: [] });

    // The same on a first sync, where the device has only the rows of its own ops.
    const fresh = await kit.login('Sam');
    const first = await fresh.sync([setTask(secret.tasks[0]!, { title: 'Mine now' }), setTask(shared.tasks[0]!, { title: 7 } as never)]);
    expect(first.gone).toEqual({ lists: [], tasks: secret.tasks, notes: [] });
    expect(first.tasks.filter((t) => t.id === shared.tasks[0])).toHaveLength(1);
  });

  test('text that is too long is cut', async () => {
    const list = kit.list({ title: 'L'.repeat(2000) });
    const task = kit.task({ listId: list.id, title: 'T'.repeat(2000), notes: 'N'.repeat(9000) });
    const emoji = kit.task({ listId: list.id, title: 'x'.repeat(1023) + '🍉' });
    const reply = await alex.sync([list, task, emoji]);
    expect(reply.rejected).toEqual([]);
    expect(reply.lists[0]?.title).toBe('L'.repeat(1024));
    const row = reply.tasks.find((t) => t.id === task.id)!;
    expect(row.title).toBe('T'.repeat(1024));
    expect(row.notes).toBe('N'.repeat(8192));
    // The cut does not leave half of a character.
    expect(reply.tasks.find((t) => t.id === emoji.id)!.title).toBe('x'.repeat(1023));
  });

  test('a repeat rule is checked', async () => {
    const { list } = await makeList({ shared: false });
    const base: RepeatRule = { every: 1, unit: 'day', start: '2026-10-06', end: { type: 'never' } };
    const good: RepeatRule[] = [
      base,
      { ...base, every: 1000, unit: 'week', weekdays: [0, 6] },
      { ...base, unit: 'month', monthMode: 'day', monthDay: -1, end: { type: 'on', date: '2027-01-31' } },
      { ...base, unit: 'month', monthMode: 'weekday', ordinal: -1, weekday: 5, end: { type: 'after', count: 30 } },
      { ...base, unit: 'year' },
    ];
    const made = good.map((repeat) => kit.task({ listId: list, title: 'Repeats', repeat }));
    const reply = await alex.sync(made);
    expect(reply.rejected).toEqual([]);
    expect(made.map((put) => reply.tasks.find((t) => t.id === put.id)!.repeat)).toEqual(good);

    const bad = [
      { ...base, every: 0 },
      { ...base, every: 1001 },
      { ...base, unit: 'hour' },
      { ...base, start: 'today' },
      { ...base, end: undefined },
      { ...base, end: { type: 'on', date: 'soon' } },
      { ...base, end: { type: 'after', count: 0 } },
      { ...base, weekdays: [7] },
      { ...base, monthDay: 0 },
      { ...base, ordinal: 5 },
      'daily',
    ];
    const tried = await alex.sync(bad.map((repeat) => setTask(made[0]!.id, { repeat } as never)));
    expect(tried.acked).toEqual([]);
    expect(tried.rejected).toHaveLength(bad.length);
    // 'null' stops the repeat.
    expect((await alex.sync([setTask(made[0]!.id, { repeat: null })])).tasks[0]?.repeat).toBeNull();
  });

  test('a request with a bad frame or with no session is an error', async () => {
    const frame = { clientId: 'c1', since: 0, ops: [], tz: 'UTC' };
    for (const change of [{ since: -1 }, { since: 1.5 }, { since: '0' }, { ops: {} }, { ops: undefined }, { clientId: '' }, { clientId: undefined }]) {
      const reply = await alex.call<ApiError>('/api/sync', { ...frame, ...change });
      expect([reply.status, reply.data.error.code]).toEqual([400, 'invalid']);
    }
    const anonymous = await kit.call<ApiError>({ path: '/api/sync', body: frame });
    expect([anonymous.status, anonymous.data.error.code]).toEqual([401, 'unauthorized']);
  });

  test('the time zone of the device is stored, and a wrong one is ignored', async () => {
    const tzOf = (): unknown => (server.app.db.q('SELECT tz FROM users WHERE id = ?').get(alex.user.id) as { tz: string }).tz;
    await alex.sync();
    expect(tzOf()).toBe('Europe/Berlin');
    const frame = { clientId: 'c1', since: alex.since, ops: [] };
    expect((await alex.call('/api/sync', { ...frame, tz: 'America/New_York' })).status).toBe(200);
    expect(tzOf()).toBe('America/New_York');
    for (const tz of ['Mars/Olympus', '', 5, undefined]) {
      expect((await alex.call('/api/sync', { ...frame, tz })).status).toBe(200);
    }
    expect(tzOf()).toBe('America/New_York');
  });
});

describe('the true state after an op', () => {
  test('an op that loses against a newer value gets the row back, with no new revision', async () => {
    const { list, tasks } = await makeList({ shared: true, tasks: 1 });
    const id = tasks[0]!;
    const phone = await kit.login('Alex');
    await phone.sync();
    // The clock of the laptop of Alex is 20 seconds ahead of the clock of the phone.
    await alex.sync([
      kit.op(setTask(id, { title: 'From the laptop', starred: true, starredAt: 1 }), kit.at(clock + 20_000, 'laptop')),
      kit.op(setList(list, { title: 'List from the laptop', sort: 'date' }), kit.at(clock + 20_000, 'laptop')),
    ]);
    // The phone has these values already. Then the person changes the same fields on the phone.
    await phone.sync();
    const rev = phone.since;
    const reply = await phone.sync([
      kit.op(setTask(id, { title: 'From the phone', notes: 'A note', starred: false, starredAt: null }), kit.at(clock + 5_000, 'phone0')),
      kit.op(setList(list, { title: 'List from the phone', sort: 'title' }), kit.at(clock + 5_000, 'phone0')),
    ]);
    expect(reply.acked).toHaveLength(2);
    expect(reply.tasks).toHaveLength(1);
    // The field that the laptop did not change is new, so the row has a new revision here.
    expect(reply.tasks[0]).toMatchObject({ id, title: 'From the laptop', notes: 'A note', starred: true, starredAt: 1 });
    expect(reply.lists).toHaveLength(1);
    expect(reply.lists[0]).toMatchObject({ id: list, title: 'List from the laptop', sort: 'date' });
    expect(reply.rev).toBe(rev + 1);

    // An op that changes nothing on the server gives the rows too, and no revision.
    const again = await phone.sync([
      kit.op(setTask(id, { title: 'From the phone again' }), kit.at(clock + 6_000, 'phone0')),
      kit.op(setTask(id, { starred: false }), kit.at(clock + 6_000, 'phone0')),
      kit.op(setList(list, { sort: 'title' }), kit.at(clock + 6_000, 'phone0')),
    ]);
    expect(again.rev).toBe(rev + 1);
    expect(again.tasks.map((t) => [t.title, t.starred])).toEqual([['From the laptop', true]]);
    expect(again.lists.map((l) => [l.title, l.sort])).toEqual([['List from the laptop', 'date']]);
    // The other people get nothing from these ops.
    await sam.sync();
    await phone.sync([kit.op(setTask(id, { title: 'One more time' }), kit.at(clock + 7_000, 'phone0'))]);
    expect(nothing(await sam.sync())).toBe(true);
  });

  test('an op for a row that the person cannot see after it gives the id in gone', async () => {
    const { list, tasks } = await makeList({ shared: false, tasks: 2 });
    const [first, second] = tasks as [ID, ID];
    // A task that is made and deleted before the first sync of the device.
    const made = kit.task({ listId: list, title: 'Made and deleted', deleted: true });
    const reply = await alex.sync([made]);
    expect(reply.acked).toHaveLength(1);
    expect(reply.tasks).toEqual([]);
    expect(reply.gone.tasks).toEqual([made.id]);

    // A second device deleted the task and the list. This device knows that, and its undo is older.
    const laptop = await kit.login('Alex');
    await laptop.sync();
    await laptop.sync([
      kit.op(setTask(first, { deleted: true }), kit.at(clock + 30_000, 'laptop')),
      kit.op(setList(list, { deleted: true }), kit.at(clock + 30_000, 'laptop')),
    ]);
    await alex.sync();
    const undo = await alex.sync([
      kit.op(setTask(first, { deleted: false }), kit.at(clock + 1_000, 'phone0')),
      kit.op(setList(list, { deleted: false }), kit.at(clock + 1_000, 'phone0')),
      // A change and a new task in the deleted list.
      kit.op(setTask(second, { title: 'In a deleted list' })),
      kit.op(kit.task({ listId: list, title: 'New in a deleted list' }, 'new-in-deleted-list')),
    ]);
    expect(undo.acked).toHaveLength(4);
    expect(undo.lists).toEqual([]);
    expect(undo.tasks).toEqual([]);
    expect(gone(undo)).toEqual({ lists: [list], tasks: [first, second, 'new-in-deleted-list'].sort(), notes: [] });
    // A new name for the deleted list: the op applies, and the device must still drop the row.
    const renamed = await alex.sync([kit.op(setList(list, { title: 'A name for a deleted list' }), kit.at(clock + 35_000, 'phone0'))]);
    expect(renamed.acked).toHaveLength(1);
    expect(renamed.lists).toEqual([]);
    expect(renamed.gone.lists).toEqual([list]);
    // The list comes back with all its tasks, also the new one.
    const back = await laptop.sync([kit.op(setList(list, { deleted: false }), kit.at(clock + 40_000, 'laptop'))]);
    expect(back.lists.map((l) => l.title)).toEqual(['A name for a deleted list']);
    expect(ids(back.tasks)).toEqual([second, 'new-in-deleted-list'].sort());
  });

  test('a row that the other person can see only between two ops of one request gives that person no id', async () => {
    const { list, tasks } = await makeList({ shared: false, tasks: 3 });
    const [first, second, third] = tasks as [ID, ID, ID];
    const other = await makeList({ shared: false });
    // The device deleted and moved the tasks before it shared the list. The server applies the
    // list op first, so the tasks are in a shared list for a moment.
    const brief = kit.task({ listId: list, title: 'Made and deleted in one request' });
    const reply = await alex.sync([
      setTask(first, { deleted: true }),
      setTask(second, { listId: other.list }),
      brief,
      setTask(brief.id, { deleted: true }),
      setList(list, { shared: true }),
    ]);
    expect(reply.rejected).toEqual([]);
    for (const person of [sam, kim]) {
      const got = await person.sync();
      expect(ids(got.lists)).toEqual([list]);
      expect(ids(got.tasks)).toEqual([third]);
      expect(got.gone).toEqual({ lists: [], tasks: [], notes: [] });
      const text = JSON.stringify(got);
      for (const secret of [first, second, brief.id, other.list]) expect(text).not.toContain(secret);
    }
    // The same in a list that the other people see: the task did not exist before the request.
    const open = await makeList({ shared: true });
    const short = kit.task({ listId: open.list, title: 'Made and deleted in one request' });
    await alex.sync([short, setTask(short.id, { deleted: true })]);
    expect(nothing(await sam.sync())).toBe(true);
    // A list that is shared and private again in one request: nothing for the other people.
    const flash = await makeList({ shared: false, tasks: 1 });
    await alex.sync([setList(flash.list, { shared: true }), setList(flash.list, { shared: false })]);
    expect(nothing(await sam.sync())).toBe(true);
    // The owner still gets a mark for the rows that are gone for the owner.
    const mine = await (await kit.login('Alex')).sync();
    expect(mine.tasks.find((t) => t.id === first)).toBeUndefined();
    expect(mine.tasks.find((t) => t.id === second)?.listId).toBe(other.list);
  });

  test('an unshare and a change of a task in one request: the task is gone for the other person', async () => {
    const { list, tasks } = await makeList({ shared: true, tasks: 2 });
    await alex.sync([setTask(tasks[0]!, { title: 'Changed in the same request' }), setList(list, { shared: false })]);
    const reply = await sam.sync();
    expect(reply.tasks).toEqual([]);
    expect(gone(reply)).toEqual({ lists: [list], tasks: [...tasks].sort(), notes: [] });
  });

  test('a put that makes a task needs a list and a title', async () => {
    const { list } = await makeList({ shared: false });
    // A move of a task that the server removed a long time ago must not make an empty task.
    const reply = await alex.sync([
      setTask('removed-task-1', { listId: list, parentId: null, pos: 'a5' }),
      setTask('removed-task-2', { deleted: false }),
      setTask('removed-task-3', { title: 'No list' }),
    ]);
    expect(reply.acked).toEqual([]);
    expect(reply.rejected).toHaveLength(3);
    expect(gone(reply).tasks).toEqual(['removed-task-1', 'removed-task-2', 'removed-task-3']);
    expect(server.app.db.q("SELECT COUNT(*) AS n FROM tasks WHERE id LIKE 'removed-task-%'").get()).toEqual({ n: 0 });
  });
});

describe('cleanup of old deleted rows', () => {
  test('the reset path', async () => {
    const shared = await makeList({ shared: true, tasks: 3 });
    const doomed = await makeList({ shared: true, tasks: 2 });
    const [gone1, keep1, keep2] = shared.tasks as [ID, ID, ID];
    const away = await kit.login('Sam');
    await away.sync();
    const stale = away.since;

    await alex.sync([setTask(gone1, { deleted: true }), setList(doomed.list, { deleted: true })]);
    await settle();
    const current = sam.since;
    const exists = (table: string, column: string, id: ID): boolean =>
      server.app.db.q(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(id) !== undefined;

    // After 179 days the rows are still there, and a device that was away gets the ids.
    clock += 179 * DAY;
    server.maintain();
    expect(exists('tasks', 'id', gone1)).toBe(true);
    const normal = await (async () => {
      const reply = await away.call<SyncResponse>('/api/sync', { clientId: away.clientId, since: stale, ops: [], tz: 'UTC' });
      return reply.data;
    })();
    expect(normal.reset).toBe(false);
    expect(gone(normal)).toEqual({ lists: [doomed.list], tasks: [gone1, ...doomed.tasks].sort(), notes: [] });

    clock += 2 * DAY;
    server.maintain();
    expect(exists('tasks', 'id', gone1)).toBe(false);
    expect(exists('task_user', 'task_id', gone1)).toBe(false);
    expect(exists('lists', 'id', doomed.list)).toBe(false);
    expect(exists('list_user', 'list_id', doomed.list)).toBe(false);
    // The tasks of a removed list go with it.
    expect(exists('tasks', 'list_id', doomed.list)).toBe(false);
    expect(exists('tasks', 'id', keep1)).toBe(true);

    // The device that was away cannot learn which rows are gone. It gets all rows and 'reset'.
    away.since = stale;
    const reply = await away.sync();
    expect(reply.reset).toBe(true);
    expect(reply.gone).toEqual({ lists: [], tasks: [], notes: [] });
    expect(reply.lists.map((l) => l.id)).toContain(shared.list);
    expect(reply.lists.map((l) => l.id)).not.toContain(doomed.list);
    expect(ids(reply.tasks.filter((t) => t.listId === shared.list))).toEqual([keep1, keep2].sort());
    expect(reply.tasks.length).toBeGreaterThan(2);
    expect((await away.sync()).reset).toBe(false);

    // A device that did sync after the deletes continues as usual.
    sam.since = current;
    const usual = await sam.sync();
    expect(usual.reset).toBe(false);
    expect(nothing(usual)).toBe(true);
  });

  test('a revision from a different database gives a reset', async () => {
    const device = await kit.login('Alex');
    device.since = alex.since + 1000;
    const reply = await device.sync();
    expect(reply.reset).toBe(true);
    expect(reply.lists.length).toBeGreaterThan(0);
    expect(reply.rev).toBe(alex.since);
  });
});
