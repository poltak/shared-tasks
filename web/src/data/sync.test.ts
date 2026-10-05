// The data layer against the real server: `node server/main.ts` as a child process, and some
// devices of two people that talk to it through HTTP.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ID } from '../../../shared/types.ts';
import { makeBrowser, makeDevice, startServerProcess, waitFor } from './testkit.ts';
import type { Browser, Device, ServerProcess } from './testkit.ts';

let server: ServerProcess;
const devices: Device[] = [];

const password = (name: string): string => `password-of-${name.toLowerCase()}`;

function device(input: { browser?: Browser; speed?: number } = {}): Device {
  const made = makeDevice({ server: server.url, ...input });
  devices.push(made);
  return made;
}

/** A new device where the person signs in. */
async function signedIn(name: string, input: { register?: boolean; speed?: number } = {}): Promise<Device> {
  const made = device({ speed: input.speed });
  await made.layer.start();
  expect(made.layer.session.status).toBe('signedOut');
  const result = await made.layer[input.register ? 'register' : 'login']({ name, password: password(name) });
  expect(result).toEqual({ ok: true });
  expect(made.layer.session.status).toBe('signedIn');
  return made;
}

const titlesOf = (made: Device, listId: ID): string[] =>
  made.layer.listView(listId).groups.flatMap((group) => group.items.map((item) => item.task.title));
const listTitles = (made: Device): string[] => made.layer.listsOrdered().map((list) => list.title);
const defaultList = (made: Device): ID => made.layer.listsOrdered().find((list) => list.isDefault)!.id;
const idle = (made: Device): boolean => made.layer.sync.status === 'idle' && made.layer.sync.pending === 0;

// Two devices of Ann and one device of Ben, for all tests of this file.
let ann1: Device;
let ann2: Device;
let ben: Device;

beforeAll(async () => {
  server = await startServerProcess('data-layer');
}, 30_000);

afterAll(async () => {
  await Promise.all(devices.map((made) => made.layer.stop()));
  await server?.remove();
});

describe('accounts', () => {
  it('registers two accounts through the data layer, and signs in on a second device', async () => {
    ann1 = await signedIn('Ann', { register: true });
    expect(ann1.layer.session.me?.name).toBe('Ann');
    expect(ann1.layer.session.canRegister).toBe(true);
    // The account has its default list when the sign-up ends.
    expect(listTitles(ann1)).toEqual(['My Tasks']);
    expect(ann1.layer.otherUser()).toBeNull();

    ben = await signedIn('Ben', { register: true });
    expect(ben.layer.session.canRegister).toBe(false);
    expect(ben.layer.otherUser()?.name).toBe('Ann');
    expect(listTitles(ben)).toEqual(['My Tasks']);
    expect(defaultList(ben)).not.toBe(defaultList(ann1));

    ann2 = await signedIn('Ann');
    expect(ann2.layer.session.me).toEqual(ann1.layer.session.me);
    expect(defaultList(ann2)).toBe(defaultList(ann1));
    expect(ann2.layer.otherUser()?.name).toBe('Ben');

    // The first device of Ann learns about Ben when the app comes to the front.
    ann1.setVisible(false);
    ann1.setVisible(true);
    await waitFor(() => ann1.layer.otherUser()?.name === 'Ben');
  });

  it('gives the text of the server for a sign-up that is closed and for a wrong password', async () => {
    const visitor = device();
    await visitor.layer.start();
    expect(visitor.layer.session.status).toBe('signedOut');
    expect(visitor.layer.session.canRegister).toBe(false);
    expect(visitor.layer.session.users).toEqual([]);
    expect(await visitor.layer.register({ name: 'Cat', password: password('Cat') })).toEqual({ ok: false, message: 'Sign-up is closed' });
    expect(await visitor.layer.login({ name: 'Ann', password: 'wrong password' })).toEqual({
      ok: false,
      message: 'The name or the password is wrong',
    });
    expect(visitor.layer.session.status).toBe('signedOut');
    expect(visitor.browser.storage.accounts()).toEqual([]);
  });
});

describe('two devices of one person', () => {
  it('brings a row from one device to the other through the event stream, with no manual sync', async () => {
    const list = defaultList(ann1);
    const requests = ann2.requests.length;
    const id = ann1.layer.actions.createTask({ listId: list, title: 'Buy milk', notes: 'two bottles', due: '2026-10-07' }).puts[0]!.id;
    expect(titlesOf(ann1, list)).toEqual(['Buy milk']);
    await waitFor(() => ann2.layer.getTask(id) !== undefined, 2000);
    expect(ann2.layer.getTask(id)).toEqual(ann1.layer.getTask(id));
    expect(ann2.layer.getTask(id)).toMatchObject({ notes: 'two bottles', due: '2026-10-07', createdBy: ann1.layer.session.me!.id });
    // The only request of the second device was the sync that the poke started.
    expect(ann2.requests.slice(requests)).toEqual(['/api/sync']);
    await waitFor(() => idle(ann1));

    ann2.layer.actions.completeTask({ id });
    await waitFor(() => ann1.layer.debug.rows.tasks.get(id)?.completed === true, 2000);
    expect(ann1.layer.listView(list).completed.map((task) => task.id)).toEqual([id]);
    expect(ann1.layer.actions.uncompleteTask({ id }).message).toBe('Task marked uncompleted');
    await waitFor(() => titlesOf(ann2, list).includes('Buy milk'), 2000);
  });

  it('merges offline changes of two devices field by field', async () => {
    const list = defaultList(ann1);
    const id = ann1.layer.actions.createTask({ listId: list, title: 'Plan trip' }).puts[0]!.id;
    await waitFor(() => ann2.layer.getTask(id) !== undefined);
    await waitFor(() => idle(ann1) && idle(ann2));

    ann1.setOnline(false);
    ann2.setOnline(false);
    ann1.layer.actions.updateTask({ id, title: 'Plan the trip to Hue' });
    ann1.layer.actions.setStar({ id, starred: true });
    ann2.layer.actions.updateTask({ id, notes: 'Book the train' });
    ann2.layer.actions.setDate({ id, due: '2026-11-02', time: '09:30' });
    // The same field on the two devices: the later change wins.
    ann1.layer.actions.updateTask({ id, deadline: '2026-11-10' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    ann2.layer.actions.updateTask({ id, deadline: '2026-11-20' });
    expect(ann1.layer.sync.status).toBe('offline');
    expect([ann1.layer.sync.pending, ann2.layer.sync.pending]).toEqual([1, 1]);

    ann1.setOnline(true);
    ann2.setOnline(true);
    const merged = {
      title: 'Plan the trip to Hue',
      notes: 'Book the train',
      due: '2026-11-02',
      time: '09:30',
      deadline: '2026-11-20',
      starred: true,
    };
    await waitFor(() => idle(ann1) && idle(ann2) && ann1.layer.getTask(id)?.notes === merged.notes && ann2.layer.getTask(id)?.title === merged.title);
    await waitFor(() => ann1.layer.getTask(id)?.deadline === merged.deadline);
    expect(ann1.layer.getTask(id)).toMatchObject(merged);
    expect(ann2.layer.getTask(id)).toEqual(ann1.layer.getTask(id));
    expect(ann1.layer.starredView().openCount).toBe(1);
    expect(ann2.layer.starredView().openCount).toBe(1);
  });

  it('gives the two devices the value of the newer change when the older one arrives last', async () => {
    const list = defaultList(ann1);
    const id = ann1.layer.actions.createTask({ listId: list, title: 'Name' }).puts[0]!.id;
    await waitFor(() => ann2.layer.getTask(id) !== undefined && idle(ann1) && idle(ann2));

    ann1.setOnline(false);
    ann1.layer.actions.updateTask({ id, title: 'older, from the device that was offline' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    ann2.layer.actions.updateTask({ id, title: 'newer' });
    await waitFor(() => idle(ann2));
    // The op of the first device loses on the server. The device gets the true row back.
    ann1.setOnline(true);
    await waitFor(() => ann1.layer.getTask(id)?.title === 'newer' && idle(ann1));
    expect(ann2.layer.getTask(id)?.title).toBe('newer');
  });

  it('shows the rows after a restart of the device before the network answers', async () => {
    const list = defaultList(ann2);
    await waitFor(() => idle(ann2));
    const before = { lists: listTitles(ann2), titles: titlesOf(ann2, list), completed: ann2.layer.listView(list).completed.length };
    expect(before.titles.length).toBeGreaterThan(1);
    const browser = ann2.browser;
    await ann2.layer.stop();

    ann2 = device({ browser });
    ann2.hold();
    const started = ann2.layer.start();
    await waitFor(() => ann2.layer.session.status === 'signedIn');
    expect(ann2.answered).toEqual([]);
    expect(ann2.layer.session.me?.name).toBe('Ann');
    expect(listTitles(ann2)).toEqual(before.lists);
    expect(titlesOf(ann2, list)).toEqual(before.titles);
    expect(ann2.layer.starredView().openCount).toBe(1);

    // The device was away. A change of that time arrives when the network answers.
    const id = ann1.layer.actions.createTask({ listId: list, title: 'Made while the other device was away' }).puts[0]!.id;
    await waitFor(() => idle(ann1));
    ann2.release();
    await started;
    await waitFor(() => ann2.layer.getTask(id) !== undefined);
    expect(titlesOf(ann2, list)).toEqual(titlesOf(ann1, list));
  });

  it('brings back a deleted task with "Undo" after the device dropped the row', async () => {
    const list = defaultList(ann1);
    const parent = ann1.layer.actions.createTask({ listId: list, title: 'Pack', notes: 'for the trip', due: '2026-10-20' }).puts[0]!.id;
    const child = ann1.layer.actions.createTask({ listId: list, title: 'Passport', position: { parentId: parent, at: 'end' } }).puts[0]!.id;
    ann1.layer.actions.setStar({ id: parent, starred: true });
    await waitFor(() => ann2.layer.subtasksOf(parent).length === 1 && idle(ann1) && idle(ann2));
    const before = { parent: ann1.layer.getTask(parent), child: ann1.layer.getTask(child) };

    expect(ann1.layer.actions.deleteTask({ id: parent }).message).toBe('2 tasks deleted');
    // The server confirms the deletion, and the two devices drop the rows.
    await waitFor(() => !ann1.layer.debug.rows.tasks.has(parent) && !ann1.layer.debug.rows.tasks.has(child));
    await waitFor(() => !ann2.layer.debug.rows.tasks.has(parent) && !ann2.layer.debug.rows.tasks.has(child));
    expect(ann1.layer.toast.current).toMatchObject({ message: '2 tasks deleted', undoable: true });

    expect(ann1.layer.undo()).toBe(true);
    expect(ann1.layer.getTask(parent)).toEqual(before.parent);
    expect(ann1.layer.subtasksOf(parent)).toEqual([before.child]);
    await waitFor(() => ann2.layer.getTask(child) !== undefined && idle(ann1));
    expect(ann2.layer.getTask(parent)).toEqual(before.parent);
    expect(ann2.layer.subtasksOf(parent)).toEqual([before.child]);
    expect(ann1.layer.getTask(parent)).toEqual(before.parent);
  });

  it('brings back a deleted list with its tasks, and the completed tasks that were cleared', async () => {
    const list = ann1.layer.actions.createList({ title: 'Short-lived' }).puts[0]!.id;
    const a = ann1.layer.actions.createTask({ listId: list, title: 'a' }).puts[0]!.id;
    const b = ann1.layer.actions.createTask({ listId: list, title: 'b' }).puts[0]!.id;
    ann1.layer.actions.completeTask({ id: a });
    await waitFor(() => ann2.layer.listView(list).completed.length === 1 && idle(ann1));

    expect(ann1.layer.actions.clearCompleted({ listId: list }).message).toBe('1 completed task deleted');
    await waitFor(() => !ann1.layer.debug.rows.tasks.has(a) && !ann2.layer.debug.rows.tasks.has(a));
    ann1.layer.undo();
    await waitFor(() => ann2.layer.listView(list).completed.length === 1 && idle(ann1));
    expect(ann1.layer.listView(list).completed.map((task) => task.id)).toEqual([a]);

    expect(ann1.layer.actions.deleteList({ id: list }).message).toBe('List deleted');
    expect(ann1.layer.getList(list)).toBeUndefined();
    await waitFor(() => !ann1.layer.debug.rows.lists.has(list) && !ann2.layer.debug.rows.lists.has(list));
    // The tasks of a deleted list go away with it.
    expect([a, b].map((id) => ann1.layer.debug.rows.tasks.has(id) || ann2.layer.debug.rows.tasks.has(id))).toEqual([false, false]);

    ann1.layer.undo();
    expect(ann1.layer.getList(list)?.title).toBe('Short-lived');
    await waitFor(() => titlesOf(ann1, list).join() === 'b' && titlesOf(ann2, list).join() === 'b');
    expect(ann2.layer.listView(list).completed.map((task) => task.id)).toEqual([a]);
    expect(ann2.layer.getList(list)?.title).toBe('Short-lived');
  });

  it('brings a change from one tab to the other tab of the same browser', async () => {
    const tab = device({ browser: ann1.browser });
    await tab.layer.start();
    expect(tab.layer.session.status).toBe('signedIn');
    const list = defaultList(ann1);
    expect(titlesOf(tab, list)).toEqual(titlesOf(ann1, list));

    const id = ann1.layer.actions.createTask({ listId: list, title: 'From the first tab' }).puts[0]!.id;
    await waitFor(() => tab.layer.getTask(id) !== undefined, 2000);
    tab.layer.actions.setStar({ id, starred: true });
    await waitFor(() => ann1.layer.getTask(id)?.starred === true, 2000);
    await tab.layer.stop();
  });
});

describe('two people', () => {
  let shared: ID;
  let task: ID;

  it('shows a list to the other person when the owner shares it', async () => {
    shared = ann1.layer.actions.createList({ title: 'Groceries' }).puts[0]!.id;
    task = ann1.layer.actions.createTask({ listId: shared, title: 'Rice' }).puts[0]!.id;
    ann1.layer.actions.createTask({ listId: shared, title: 'Fish sauce' });
    await waitFor(() => idle(ann1));
    expect(ben.layer.getList(shared)).toBeUndefined();
    expect(listTitles(ben)).toEqual(['My Tasks']);

    ann1.layer.actions.setListShared({ id: shared, shared: true });
    await waitFor(() => ben.layer.getList(shared) !== undefined, 2000);
    expect(ben.layer.getList(shared)).toMatchObject({ title: 'Groceries', shared: true, owner: ann1.layer.session.me!.id });
    expect(titlesOf(ben, shared)).toEqual(['Fish sauce', 'Rice']);
    // The private lists of the owner stay private.
    expect(listTitles(ben).sort()).toEqual(['Groceries', 'My Tasks']);
    expect(ben.layer.getList(defaultList(ann1))).toBeUndefined();
  });

  it('brings the changes of each person to the other person', async () => {
    ben.layer.actions.completeTask({ id: task });
    ben.layer.actions.createTask({ listId: shared, title: 'Limes' });
    await waitFor(() => titlesOf(ann1, shared).includes('Limes') && ann1.layer.debug.rows.tasks.get(task)?.completed === true, 2000);
    expect(ann1.layer.debug.rows.tasks.get(task)?.completedBy).toBe(ben.layer.session.me!.id);
    await waitFor(() => titlesOf(ann2, shared).includes('Limes'), 2000);

    // The star and the place of the list are for each person alone.
    const limes = ann1.layer.listView(shared).groups[0]!.items.find((item) => item.task.title === 'Limes')!.task.id;
    ann1.layer.actions.setStar({ id: limes, starred: true });
    ann1.layer.actions.setListSort({ id: shared, sort: 'title' });
    ann1.layer.actions.updateTask({ id: limes, notes: 'six' });
    await waitFor(() => ben.layer.getTask(limes)?.notes === 'six', 2000);
    await waitFor(() => ann2.layer.getTask(limes)?.starred === true, 2000);
    expect(ben.layer.getTask(limes)?.starred).toBe(false);
    expect(ben.layer.getList(shared)?.sort).toBe('my');
    expect(ann2.layer.getList(shared)?.sort).toBe('title');
  });

  it('rolls back the changes that the server rejects, and takes the list away when the sharing stops', async () => {
    await waitFor(() => idle(ben) && idle(ann1));
    // Ben makes changes with no network. In that time the owner stops the sharing.
    ben.setOnline(false);
    const mine = ben.layer.actions.createTask({ listId: shared, title: 'Made by Ben with no network' }).puts[0]!.id;
    ben.layer.actions.uncompleteTask({ id: task });
    ben.layer.actions.renameList({ id: shared, title: 'Our groceries' });
    expect(titlesOf(ben, shared)).toContain('Made by Ben with no network');
    expect(ben.layer.getList(shared)?.title).toBe('Our groceries');
    expect(ben.layer.sync.pending).toBe(3);

    ann1.layer.actions.setListShared({ id: shared, shared: false });
    await waitFor(() => idle(ann1));

    ben.setOnline(true);
    await waitFor(() => idle(ben) && ben.layer.getList(shared) === undefined);
    expect(listTitles(ben)).toEqual(['My Tasks']);
    expect(ben.layer.getTask(mine)).toBeUndefined();
    expect(ben.layer.getTask(task)).toBeUndefined();
    expect([...ben.layer.debug.rows.tasks.values()].filter((row) => row.listId === shared)).toEqual([]);
    expect(ben.layer.toast.current).toMatchObject({ message: 'The server refused 3 changes', undoable: false });
    await ben.layer.debug.flush();
    const saved = ben.browser.storage.peek(ben.layer.session.me!.id)!;
    expect(saved.outbox).toEqual([]);
    expect(saved.lists.map((list) => list.title)).toEqual(['My Tasks']);
    expect(saved.tasks.filter((row) => row.listId === shared)).toEqual([]);

    // The rows of the owner have no change from the rejected ops.
    await ann1.layer.sync.now();
    expect(ann1.layer.getList(shared)?.title).toBe('Groceries');
    expect(ann1.layer.getTask(mine)).toBeUndefined();
    expect(ann1.layer.debug.rows.tasks.get(task)?.completed).toBe(true);
  });

  it('deletes the local database of the account at sign-out, and ends the session', async () => {
    const id = ben.layer.session.me!.id;
    ben.layer.actions.createTask({ listId: defaultList(ben), title: 'The last change before the sign-out' });
    expect(ben.browser.storage.accounts()).toEqual([id]);
    expect(await ben.layer.logout()).toEqual({ ok: true });
    expect(ben.layer.session.status).toBe('signedOut');
    expect(ben.browser.storage.accounts()).toEqual([]);
    expect(ben.layer.listsOrdered()).toEqual([]);
    expect(ben.browser.cookie).toBe('');

    // The device has no session: a restart shows the sign-in screen.
    const browser = ben.browser;
    ben = device({ browser });
    await ben.layer.start();
    expect(ben.layer.session.status).toBe('signedOut');
    // The change from before the sign-out reached the server.
    expect(await ben.layer.login({ name: 'ben', password: password('Ben') })).toEqual({ ok: true });
    expect(titlesOf(ben, defaultList(ben))).toEqual(['The last change before the sign-out']);
  });
});

describe('a server that goes away', () => {
  it('tries again with longer and longer pauses, and recovers when the server is back', async () => {
    // The timers of this device run 25 times faster. The data layer still asks for the true pauses.
    const fast = await signedIn('Ann', { speed: 25 });
    const list = defaultList(fast);
    await waitFor(() => idle(fast));
    await server.stop();

    const start = fast.delays.length;
    const tries = (): number => fast.requests.filter((route) => route === '/api/sync').length;
    const before = tries();
    const id = fast.layer.actions.createTask({ listId: list, title: 'Made while the server was down' }).puts[0]!.id;
    await waitFor(() => fast.layer.sync.status === 'offline');
    expect(titlesOf(fast, list)).toContain('Made while the server was down');
    await waitFor(() => tries() - before >= 4);
    expect(fast.layer.sync.status).toBe('offline');
    expect(fast.layer.sync.pending).toBe(1);
    // The pauses between the tries, without the timers of the event stream and of the requests.
    const pauses = fast.delays.slice(start).filter((ms) => ms >= 1000 && ms < 15_000);
    for (const pause of [1000, 2000, 4000]) expect(pauses).toContain(pause);

    await server.start();
    await waitFor(() => idle(fast), 10_000);
    // The other device finds the server again by itself and gets the row.
    await waitFor(() => ann1.layer.getTask(id) !== undefined, 10_000);
    expect(ann1.layer.getTask(id)?.title).toBe('Made while the server was down');
    await fast.layer.stop();
  }, 30_000);

  it('goes to the sign-in screen when the server ends the session of the device', async () => {
    const other = await signedIn('Ann');
    await waitFor(() => idle(other));
    // A new password ends the sessions of the other devices.
    expect(await ann1.layer.changePassword({ current: 'not the password', next: 'a new password 1' })).toEqual({
      ok: false,
      message: 'The current password is wrong',
    });
    expect(await ann1.layer.changePassword({ current: password('Ann'), next: password('Ann') + '!' })).toEqual({ ok: true });
    await waitFor(() => other.layer.session.status === 'signedOut', 10_000);
    expect(other.layer.listsOrdered()).toEqual([]);
    // The database stays: the account can sign in again and has its rows at once.
    expect(other.browser.storage.accounts()).toEqual([ann1.layer.session.me!.id]);
    expect(ann1.layer.session.status).toBe('signedIn');
    expect(await ann1.layer.changePassword({ current: password('Ann') + '!', next: password('Ann') })).toEqual({ ok: true });
  }, 20_000);
});

describe('2,000 tasks', () => {
  it('loads them and builds the views fast', async () => {
    const big = ann1.layer.actions.createList({ title: 'Big list' }).puts[0]!.id;
    let made = performance.now();
    for (let i = 0; i < 2000; i++) {
      ann1.layer.actions.createTask({
        listId: big,
        title: `Task number ${i}`,
        notes: i % 4 === 0 ? 'Some notes for this task' : '',
        due: i % 3 === 0 ? `2026-10-${String((i % 28) + 1).padStart(2, '0')}` : null,
        starred: i % 50 === 0,
      });
    }
    made = performance.now() - made;
    expect(await ann1.layer.sync.now()).toBe(true);
    await waitFor(() => idle(ann1), 15_000);

    // A new device: sign-in, first sync, first view.
    const fresh = device();
    await fresh.layer.start();
    let signIn = performance.now();
    expect(await fresh.layer.login({ name: 'Ann', password: password('Ann') })).toEqual({ ok: true });
    signIn = performance.now() - signIn;
    expect(fresh.layer.debug.rows.tasks.size).toBeGreaterThanOrEqual(2000);

    const time = <T>(run: () => T): { ms: number; value: T } => {
      const start = performance.now();
      const value = run();
      return { ms: performance.now() - start, value };
    };
    const first = time(() => fresh.layer.listView(big));
    expect(first.value.openCount).toBe(2000);
    expect(first.value.groups[0]!.items[0]!.task.title).toBe('Task number 1999');
    const again = time(() => fresh.layer.listView(big));
    expect(again.value).toBe(first.value);
    const starred = time(() => fresh.layer.starredView());
    expect(starred.value.openCount).toBeGreaterThanOrEqual(40);

    // One change: the view of the list is built again, and all rows but one keep their objects.
    const target = first.value.groups[0]!.items[1000]!;
    const change = time(() => fresh.layer.actions.updateTask({ id: target.task.id, title: 'Changed' }));
    const rebuilt = time(() => fresh.layer.listView(big));
    const items = rebuilt.value.groups[0]!.items;
    expect(items.filter((item, i) => item !== first.value.groups[0]!.items[i]).map((item) => item.task.title)).toEqual(['Changed']);
    const byDate = time(() => {
      fresh.layer.actions.setListSort({ id: big, sort: 'date' });
      return fresh.layer.listView(big);
    });
    expect(byDate.value.groups.length).toBeGreaterThan(3);
    await waitFor(() => idle(fresh));
    await fresh.layer.debug.flush();

    // The same device again: from the local database to the first view.
    const browser = fresh.browser;
    await fresh.layer.stop();
    const next = device({ browser });
    next.hold();
    let restart = performance.now();
    const started = next.layer.start();
    await waitFor(() => next.layer.session.status === 'signedIn');
    const view = next.layer.listView(big);
    restart = performance.now() - restart;
    expect(next.answered).toEqual([]);
    expect(view.openCount).toBe(2000);
    next.release();
    await started;

    console.log(
      [
        '2,000 tasks, milliseconds:',
        `  2,000 createTask actions on a device        ${made.toFixed(0)}`,
        `  sign-in with the first sync on a new device ${signIn.toFixed(0)}`,
        `  first build of the list view                ${first.ms.toFixed(2)}`,
        `  second read of the view (from the cache)    ${again.ms.toFixed(3)}`,
        `  build of the starred view                   ${starred.ms.toFixed(2)}`,
        `  one updateTask action                       ${change.ms.toFixed(2)}`,
        `  build of the view after that change         ${rebuilt.ms.toFixed(2)}`,
        `  change of the sort to "date" with the build ${byDate.ms.toFixed(2)}`,
        `  restart: local database to the first view   ${restart.toFixed(0)}`,
      ].join('\n'),
    );
    expect(signIn).toBeLessThan(3000);
    expect(first.ms).toBeLessThan(50);
    expect(again.ms).toBeLessThan(1);
    expect(rebuilt.ms).toBeLessThan(50);
    expect(byDate.ms).toBeLessThan(50);
    expect(restart).toBeLessThan(500);
  }, 60_000);
});
