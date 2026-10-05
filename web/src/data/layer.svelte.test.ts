// The local logic of the data layer, against a stand-in for the server and a clock that the test moves.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as hlc from '../../../shared/hlc.ts';
import { todayOf } from '../../../shared/dates.ts';
import type { Op, RepeatRule, TaskRow } from '../../../shared/types.ts';
import type { PushEnv, PushSubscriptionData } from './env.ts';
import { PREFS_KEY } from './prefs.svelte.ts';
import { fakeClock, makeBrowser, makeDevice, settle, stubServer } from './testkit.ts';
import type { Browser, Device, FakeClock, StubServer } from './testkit.ts';
import { flushSync, reactive, watch } from './watch.svelte.ts';

const LIST = 'list-1';
const PASSWORD = 'password-of-alex';

const running: Device[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const device of running.splice(0)) await device.layer.stop();
});

function device(input: { server: StubServer; clock: FakeClock; browser?: Browser; push?: PushEnv }): Device {
  const made = makeDevice(input);
  running.push(made);
  return made;
}

/** A device that is signed in and has its first rows. */
async function boot(input: { clock?: FakeClock; server?: StubServer; browser?: Browser; push?: PushEnv } = {}) {
  const clock = input.clock ?? fakeClock();
  const server = input.server ?? stubServer(clock.now);
  const made = device({ server, clock, browser: input.browser, push: input.push });
  await made.layer.start();
  // The timer of the first write to the local database.
  await clock.advance(0);
  return { clock, server, device: made, layer: made.layer, browser: made.browser };
}

const syncCount = (server: StubServer): number => server.syncs.length;
const lastOps = (server: StubServer): Op[] => server.syncs.at(-1)!.ops;
const openTitles = (layer: Device['layer']): string[] =>
  layer.listView(LIST).groups.flatMap((group) => group.items.map((item) => item.task.title));

describe('start', () => {
  it('goes from loading to signedIn with the rows of the server', async () => {
    const clock = fakeClock();
    const server = stubServer(clock.now);
    const { layer } = device({ server, clock });
    expect(layer.session.status).toBe('loading');
    await layer.start();
    expect(layer.session.status).toBe('signedIn');
    expect(layer.session.me).toEqual({ id: 'user-1', name: 'Alex' });
    expect(layer.session.users.map((user) => user.name)).toEqual(['Alex', 'Sam']);
    expect(layer.otherUser()).toEqual({ id: 'user-2', name: 'Sam' });
    expect(layer.session.version).toBe('1.2.3');
    expect(layer.listsOrdered().map((list) => list.title)).toEqual(['My Tasks']);
    expect(layer.getList(LIST)?.isDefault).toBe(true);
    expect(layer.sync.status).toBe('idle');
    expect(layer.sync.lastSyncedAt).toBe(clock.now());
    expect(server.calls).toEqual(['GET /api/me', 'POST /api/sync']);
    expect(server.syncs[0]!.since).toBe(0);
  });

  it('shows the sign-in screen when the server has no session', async () => {
    const clock = fakeClock();
    const server = stubServer(clock.now);
    server.session = false;
    const { layer } = device({ server, clock });
    await layer.start();
    expect(layer.session.status).toBe('signedOut');
    expect(layer.session.me).toBeNull();
    expect(layer.otherUser()).toBeNull();
    expect(layer.listsOrdered()).toEqual([]);
  });

  it('shows the sign-in screen when there is no account on the device and no network', async () => {
    const clock = fakeClock();
    const server = stubServer(clock.now);
    server.down = 0;
    const { layer } = device({ server, clock });
    await layer.start();
    expect(layer.session.status).toBe('signedOut');
    expect(await layer.login({ name: 'Alex', password: PASSWORD })).toEqual({
      ok: false,
      message: 'No connection to the server. Try again',
    });
  });

  it('does nothing for an action when no person is signed in', async () => {
    const clock = fakeClock();
    const server = stubServer(clock.now);
    server.session = false;
    const { layer } = device({ server, clock });
    await layer.start();
    expect(layer.actions.createTask({ listId: LIST, title: 'x' })).toEqual({ puts: [], undo: [], message: null });
    expect(layer.undo()).toBe(false);
    expect(await layer.sync.now()).toBe(false);
  });
});

describe('sign-in and sign-out', () => {
  it('signs in, and gives a text for a wrong password', async () => {
    const clock = fakeClock();
    const server = stubServer(clock.now);
    server.session = false;
    const { layer } = device({ server, clock });
    await layer.start();
    expect(await layer.login({ name: 'Alex', password: 'wrong' })).toEqual({ ok: false, message: 'The name or the password is wrong' });
    expect(await layer.login({ name: ' ', password: '' })).toEqual({ ok: false, message: 'Enter your name and your password' });
    expect(layer.session.status).toBe('signedOut');
    expect(await layer.login({ name: ' Alex ', password: PASSWORD })).toEqual({ ok: true });
    expect(server.bodies['/api/login']).toEqual({ name: 'Alex', password: PASSWORD });
    expect(layer.session.status).toBe('signedIn');
    // The rows are there when the result comes: the screen never shows an empty app.
    expect(layer.listsOrdered().length).toBe(1);
  });

  it('checks the name and the password of a new account before it asks the server', async () => {
    const clock = fakeClock();
    const server = stubServer(clock.now);
    server.session = false;
    const { layer } = device({ server, clock });
    await layer.start();
    const calls = server.calls.length;
    expect(await layer.register({ name: '  ', password: PASSWORD })).toEqual({ ok: false, message: 'Enter a name' });
    expect(await layer.register({ name: 'x'.repeat(41), password: PASSWORD })).toEqual({
      ok: false,
      message: 'The name can have 40 characters at most',
    });
    expect(await layer.register({ name: 'Alex', password: 'short' })).toEqual({
      ok: false,
      message: 'The password must have at least 8 characters',
    });
    expect(server.calls.length).toBe(calls);
    expect(await layer.register({ name: 'Alex', password: PASSWORD })).toEqual({ ok: true });
    expect(layer.session.status).toBe('signedIn');
  });

  it('deletes the local database at sign-out and ends the session on the server', async () => {
    const { layer, server, browser, clock } = await boot();
    layer.actions.createTask({ listId: LIST, title: 'last change' });
    layer.prefs.lastTab = LIST;
    layer.prefs.completedOpen = { [LIST]: true };
    expect(browser.storage.accounts()).toEqual(['user-1']);

    const result = layer.logout();
    await clock.advance(0);
    expect(await result).toEqual({ ok: true });
    expect(layer.session.status).toBe('signedOut');
    expect(layer.session.me).toBeNull();
    expect(layer.listsOrdered()).toEqual([]);
    expect(layer.sync.pending).toBe(0);
    expect(layer.canUndo()).toBe(false);
    expect(browser.storage.accounts()).toEqual([]);
    expect(server.session).toBe(false);
    expect(browser.kv.get('st.logout')).toBeNull();
    expect([layer.prefs.lastTab, layer.prefs.completedOpen]).toEqual([null, {}]);
    // The change that waited went to the server before the database went away.
    expect(server.syncs.at(-1)!.ops.map((op) => op.fields.title)).toEqual(['last change']);
    expect(server.calls.slice(-3)).toEqual(['POST /api/sync', 'POST /api/logout', 'GET /api/me']);
  });

  it('ends the session at the next start when the sign-out did not reach the server', async () => {
    const { layer, server, browser, clock } = await boot();
    server.down = 0;
    expect(await layer.logout()).toEqual({ ok: true });
    expect(layer.session.status).toBe('signedOut');
    expect(browser.storage.accounts()).toEqual([]);
    expect(browser.kv.get('st.logout')).toBe('1');
    expect(server.session).toBe(true);

    server.down = null;
    server.calls.length = 0;
    const next = device({ server, clock, browser });
    await next.layer.start();
    expect(server.calls).toEqual(['POST /api/logout', 'GET /api/me']);
    expect(next.layer.session.status).toBe('signedOut');
    expect(browser.kv.get('st.logout')).toBeNull();
  });

  it('goes to signedOut when the server ends the session, and keeps the changes for the next sign-in', async () => {
    const { layer, server, browser, clock } = await boot();
    server.session = false;
    layer.actions.createTask({ listId: LIST, title: 'made with no session' });
    await clock.advance(60);
    expect(layer.session.status).toBe('signedOut');
    expect(layer.session.me).toBeNull();
    expect(layer.listsOrdered()).toEqual([]);
    expect(browser.storage.accounts()).toEqual(['user-1']);
    await clock.advance(0);
    expect(browser.storage.peek('user-1')!.outbox.length).toBe(1);

    expect(await layer.login({ name: 'Alex', password: PASSWORD })).toEqual({ ok: true });
    expect(openTitles(layer)).toEqual(['made with no session']);
    await clock.advance(0);
    expect(lastOps(server).map((op) => op.fields.title)).toEqual(['made with no session']);
    expect(layer.sync.pending).toBe(0);
  });

  it('changes the name and the password, with the text of the server for an error', async () => {
    const { layer, server } = await boot();
    expect(await layer.rename({ name: ' Alexandra ' })).toEqual({ ok: true });
    expect(layer.session.me?.name).toBe('Alexandra');
    expect(layer.session.users[0]!.name).toBe('Alexandra');
    expect(await layer.rename({ name: '' })).toEqual({ ok: false, message: 'Enter a name' });
    expect(await layer.changePassword({ current: 'a', next: 'short' })).toEqual({
      ok: false,
      message: 'The password must have at least 8 characters',
    });
    expect(await layer.changePassword({ current: PASSWORD, next: 'a new password' })).toEqual({ ok: true });
    expect(server.bodies['/api/password']).toEqual({ current: PASSWORD, next: 'a new password' });
    server.down = 500;
    expect(await layer.rename({ name: 'Al' })).toEqual({ ok: false, message: 'Internal error' });
  });
});

describe('actions', () => {
  it('changes the rows at once and sends the op 50 ms later', async () => {
    const { layer, server, clock } = await boot();
    const before = syncCount(server);
    const result = layer.actions.createTask({ listId: LIST, title: '  Buy milk ' });
    const id = result.puts[0]!.id;
    expect(layer.getTask(id)?.title).toBe('Buy milk');
    expect(openTitles(layer)).toEqual(['Buy milk']);
    expect(layer.listView(LIST).openCount).toBe(1);
    expect(layer.sync.pending).toBe(1);

    await clock.advance(49);
    expect(syncCount(server)).toBe(before);
    await clock.advance(1);
    expect(syncCount(server)).toBe(before + 1);
    const [op] = lastOps(server);
    expect(op).toMatchObject({ kind: 'task', id, fields: { title: 'Buy milk', listId: LIST, createdBy: 'user-1' } });
    expect(hlc.isValid(op!.ts)).toBe(true);
    expect(layer.sync.pending).toBe(0);
    expect(layer.sync.status).toBe('idle');
  });

  it('gives the task the time and the person of the device', async () => {
    const { layer, clock } = await boot();
    const id = layer.actions.createTask({ listId: LIST, title: 'T' }).puts[0]!.id;
    expect(layer.getTask(id)?.createdAt).toBe(clock.now());
    layer.actions.completeTask({ id });
    expect(layer.debug.rows.tasks.get(id)).toMatchObject({ completed: true, completedBy: 'user-1', completedAt: clock.now() });
  });

  it('has one function for each action of the shared logic', async () => {
    const { layer } = await boot();
    expect(Object.keys(layer.actions).sort()).toEqual(
      [
        'clearCompleted', 'completeTask', 'createList', 'createTask', 'deleteList', 'deleteTask', 'indentTask',
        'moveList', 'moveTask', 'moveToTop', 'renameList', 'setDate', 'setListHidden', 'setListShared', 'setListSort',
        'setRepeat', 'setStar', 'uncompleteTask', 'unindentTask', 'updateTask',
      ],
    );
    const listId = layer.actions.createList({ title: 'Work' }).puts[0]!.id;
    const a = layer.actions.createTask({ listId, title: 'a' }).puts[0]!.id;
    const b = layer.actions.createTask({ listId, title: 'b', position: { after: a } }).puts[0]!.id;
    layer.actions.indentTask({ id: b });
    expect(layer.subtasksOf(a).map((task) => task.id)).toEqual([b]);
    layer.actions.setListSort({ id: listId, sort: 'title' });
    layer.actions.setStar({ id: a, starred: true });
    expect(layer.starredView().openCount).toBe(1);
    expect(layer.listsOrdered().map((list) => list.title)).toEqual(['My Tasks', 'Work']);
    layer.actions.moveList({ id: listId, toFirst: true });
    expect(layer.listsOrdered().map((list) => list.title)).toEqual(['Work', 'My Tasks']);
  });

  it('gives no puts and records nothing for an action that is not possible', async () => {
    const { layer, server, clock } = await boot();
    const before = syncCount(server);
    expect(layer.actions.createTask({ listId: LIST, title: '   ' }).puts).toEqual([]);
    expect(layer.actions.deleteList({ id: LIST }).puts).toEqual([]);
    expect(layer.actions.completeTask({ id: 'not-there' }).puts).toEqual([]);
    expect(layer.canUndo()).toBe(false);
    expect(layer.toast.current).toBeNull();
    await clock.advance(1000);
    expect(syncCount(server)).toBe(before);
  });

  it('tells if an action is possible, and does not do it', async () => {
    const { layer, server, clock } = await boot();
    const a = layer.actions.createTask({ listId: LIST, title: 'a' }).puts[0]!.id;
    const b = layer.actions.createTask({ listId: LIST, title: 'b', position: { after: a } }).puts[0]!.id;
    await clock.advance(60);
    const before = { syncs: syncCount(server), rows: [...layer.debug.rows.tasks.values()] };

    expect(layer.store.can('indentTask', { id: a })).toBe(false);
    expect(layer.store.can('indentTask', { id: b })).toBe(true);
    expect(layer.store.can('unindentTask', { id: b })).toBe(false);
    expect(layer.store.can('moveToTop', { id: a })).toBe(false);
    expect(layer.store.can('moveToTop', { id: b })).toBe(true);
    expect(layer.store.can('deleteList', { id: LIST })).toBe(false);
    expect(layer.store.can('createTask', { listId: LIST, title: ' ' })).toBe(false);
    expect(layer.store.can('createTask', { listId: LIST, title: 'c' })).toBe(true);
    expect(layer.store.can('completeTask', { id: 'not-there' })).toBe(false);

    await clock.advance(1000);
    expect([...layer.debug.rows.tasks.values()]).toEqual(before.rows);
    expect(syncCount(server)).toBe(before.syncs);
    expect(layer.canUndo()).toBe(true);
    expect(layer.sync.pending).toBe(0);

    layer.actions.indentTask({ id: b });
    expect(layer.store.can('indentTask', { id: b })).toBe(false);
    expect(layer.store.can('unindentTask', { id: b })).toBe(true);
  });

  it('sends text 800 ms after the last change, as one op', async () => {
    const { layer, server, clock } = await boot();
    const id = layer.actions.createTask({ listId: LIST, title: 'T' }).puts[0]!.id;
    await clock.advance(60);
    const before = syncCount(server);

    for (const title of ['Th', 'The', 'The ', 'The e', 'The en', 'The end']) {
      layer.actions.updateTask({ id, title });
      await clock.advance(300);
    }
    layer.actions.updateTask({ id, notes: 'some notes' });
    expect(layer.getTask(id)?.title).toBe('The end');
    expect(layer.sync.pending).toBe(1);
    await clock.advance(799);
    expect(syncCount(server)).toBe(before);
    await clock.advance(1);
    expect(syncCount(server)).toBe(before + 1);
    expect(lastOps(server)).toMatchObject([{ kind: 'task', id, fields: { title: 'The end', notes: 'some notes' } }]);
    expect(Object.keys(lastOps(server)[0]!.fields).sort()).toEqual(['notes', 'title']);
  });

  it('does not make a discrete action wait for text', async () => {
    const { layer, server, clock } = await boot();
    const id = layer.actions.createTask({ listId: LIST, title: 'T' }).puts[0]!.id;
    await clock.advance(60);
    const before = syncCount(server);

    // Text first, then a star: the star goes after 50 ms and takes the text with it.
    layer.actions.updateTask({ id, title: 'Tx' });
    await clock.advance(100);
    layer.actions.setStar({ id, starred: true });
    await clock.advance(50);
    expect(syncCount(server)).toBe(before + 1);
    expect(lastOps(server)[0]!.fields).toMatchObject({ title: 'Tx', starred: true });

    // A star first, then text: the text does not move the timer of the star.
    layer.actions.setStar({ id, starred: false });
    layer.actions.updateTask({ id, title: 'Txy' });
    await clock.advance(50);
    expect(syncCount(server)).toBe(before + 2);

    // A date is not text: updateTask with a date is a discrete action.
    layer.actions.updateTask({ id, title: 'Txyz', due: '2026-10-09' });
    await clock.advance(50);
    expect(syncCount(server)).toBe(before + 3);
  });

  it('uses the time of the server for timestamps', async () => {
    const clock = fakeClock();
    const HOUR = 3_600_000;
    const server = stubServer(() => clock.now() + HOUR);
    const { layer } = await boot({ clock, server });
    const id = layer.actions.createTask({ listId: LIST, title: 'T' }).puts[0]!.id;
    expect(layer.getTask(id)?.createdAt).toBe(clock.now() + HOUR);
    await clock.advance(60);
    expect(hlc.decode(lastOps(server)[0]!.ts).ms).toBe(clock.now() - 60 + HOUR);
    // The date of the device stays the date of its own clock.
    expect(layer.store.today).toBe(todayOf(clock.now()));
  });

  it('gives each op a later timestamp, also after a restart with a clock that went back', async () => {
    const first = await boot();
    first.layer.actions.createTask({ listId: LIST, title: 'one' });
    await first.clock.advance(60);
    const before = lastOps(first.server)[0]!.ts;
    await first.layer.stop();

    const clock = fakeClock(first.clock.now() - 86_400_000);
    first.server.onSync = (_request, response) => void (response.now = clock.now());
    const second = await boot({ clock, server: first.server, browser: first.browser });
    second.layer.actions.createTask({ listId: LIST, title: 'two' });
    await clock.advance(60);
    expect(lastOps(first.server)[0]!.ts > before).toBe(true);
  });
});

describe('undo', () => {
  it('takes back the last action, one action for each call', async () => {
    const { layer, server, clock } = await boot();
    expect(layer.canUndo()).toBe(false);
    expect(layer.undo()).toBe(false);

    const a = layer.actions.createTask({ listId: LIST, title: 'a' }).puts[0]!.id;
    const b = layer.actions.createTask({ listId: LIST, title: 'b' }).puts[0]!.id;
    layer.actions.setStar({ id: a, starred: true });
    layer.actions.deleteTask({ id: b });
    expect(openTitles(layer)).toEqual(['a']);
    await clock.advance(60);

    expect(layer.canUndo()).toBe(true);
    expect(layer.undo()).toBe(true);
    expect(openTitles(layer)).toEqual(['b', 'a']);
    // An undo is a change like each other change: it goes to the server.
    await clock.advance(50);
    expect(lastOps(server)).toMatchObject([{ id: b, fields: { deleted: false, title: 'b' } }]);

    expect(layer.undo()).toBe(true);
    expect(layer.getTask(a)?.starred).toBe(false);
    expect(layer.undo()).toBe(true);
    expect(openTitles(layer)).toEqual(['a']);
    expect(layer.undo()).toBe(true);
    expect(openTitles(layer)).toEqual([]);
    expect(layer.canUndo()).toBe(false);
    expect(layer.undo()).toBe(false);
  });

  it('takes back a completed task with its subtasks', async () => {
    const { layer } = await boot();
    const parent = layer.actions.createTask({ listId: LIST, title: 'parent' }).puts[0]!.id;
    const child = layer.actions.createTask({ listId: LIST, title: 'child', position: { parentId: parent, at: 'end' } }).puts[0]!.id;
    layer.actions.completeTask({ id: parent });
    expect(layer.toast.current).toMatchObject({ message: '2 tasks completed', undoable: true });
    expect(layer.listView(LIST).completed.map((task) => task.id)).toEqual([parent, child]);
    layer.undo();
    expect(layer.listView(LIST).openCount).toBe(2);
    expect(layer.subtasksOf(parent).map((task) => task.id)).toEqual([child]);
  });

  it('keeps the last 50 actions', async () => {
    const { layer } = await boot();
    for (let i = 0; i < 60; i++) layer.actions.createTask({ listId: LIST, title: `task ${i}` });
    let count = 0;
    while (layer.undo()) count += 1;
    expect(count).toBe(50);
    expect(layer.listView(LIST).openCount).toBe(10);
  });

  it('makes one undo step from a burst of typing', async () => {
    const { layer, clock } = await boot();
    const id = layer.actions.createTask({ listId: LIST, title: 'start', notes: 'old notes' }).puts[0]!.id;
    for (const title of ['start 1', 'start 12', 'start 123']) {
      layer.actions.updateTask({ id, title });
      await clock.advance(200);
    }
    layer.actions.updateTask({ id, notes: 'new notes' });
    // A pause: the next text is a new step.
    await clock.advance(3000);
    layer.actions.updateTask({ id, title: 'later' });

    layer.undo();
    expect(layer.getTask(id)).toMatchObject({ title: 'start 123', notes: 'new notes' });
    layer.undo();
    expect(layer.getTask(id)).toMatchObject({ title: 'start', notes: 'old notes' });
    layer.undo();
    expect(layer.getTask(id)).toBeUndefined();
  });

  it('does not put the text of two tasks, or text and a different action, into one step', async () => {
    const { layer } = await boot();
    const a = layer.actions.createTask({ listId: LIST, title: 'a' }).puts[0]!.id;
    const b = layer.actions.createTask({ listId: LIST, title: 'b' }).puts[0]!.id;
    layer.actions.updateTask({ id: a, title: 'a1' });
    layer.actions.updateTask({ id: b, title: 'b1' });
    layer.actions.updateTask({ id: b, title: 'b2' });
    layer.actions.setStar({ id: b, starred: true });
    layer.actions.updateTask({ id: b, title: 'b3' });
    layer.undo();
    expect(layer.getTask(b)).toMatchObject({ title: 'b2', starred: true });
    layer.undo();
    layer.undo();
    expect([layer.getTask(a)?.title, layer.getTask(b)?.title]).toEqual(['a1', 'b']);
  });

  it('does not send an undo for a row that the device dropped', async () => {
    const { layer, server, clock } = await boot();
    const id = layer.actions.createTask({ listId: LIST, title: 'a' }).puts[0]!.id;
    layer.actions.setStar({ id, starred: true });
    await clock.advance(60);
    // The other person deleted the task.
    server.onSync = (_request, response) => void (response.gone.tasks = [id]);
    await layer.sync.now();
    server.onSync = null;
    expect(layer.getTask(id)).toBeUndefined();
    const before = syncCount(server);
    // The undo of the star is a late change to a row that is not there.
    expect(layer.undo()).toBe(true);
    expect(layer.debug.rows.tasks.has(id)).toBe(false);
    expect(layer.sync.pending).toBe(0);
    await clock.advance(100);
    expect(server.syncs.slice(before).flatMap((sync) => sync.ops)).toEqual([]);
  });
});

describe('snackbar', () => {
  it('shows the message of an action with "Undo" and clears it after 6 seconds', async () => {
    const { layer, clock } = await boot();
    const id = layer.actions.createTask({ listId: LIST, title: 'a' }).puts[0]!.id;
    expect(layer.toast.current).toBeNull();
    layer.actions.deleteTask({ id });
    const first = layer.toast.current!;
    expect(first).toMatchObject({ message: 'Task deleted', undoable: true, action: null });
    await clock.advance(5999);
    expect(layer.toast.current).toBe(first);
    await clock.advance(1);
    expect(layer.toast.current).toBeNull();
  });

  it('replaces a message, and the new message has its own 6 seconds', async () => {
    const { layer, clock } = await boot();
    const a = layer.actions.createTask({ listId: LIST, title: 'a' }).puts[0]!.id;
    const b = layer.actions.createTask({ listId: LIST, title: 'b' }).puts[0]!.id;
    layer.actions.completeTask({ id: a });
    const first = layer.toast.current!;
    await clock.advance(4000);
    layer.actions.completeTask({ id: b });
    expect(layer.toast.current!.id).not.toBe(first.id);
    await clock.advance(4000);
    expect(layer.toast.current?.message).toBe('Task completed');
    await clock.advance(2000);
    expect(layer.toast.current).toBeNull();
  });

  it('removes the message when "Undo" would not take back its action', async () => {
    const { layer } = await boot();
    const a = layer.actions.createTask({ listId: LIST, title: 'a' }).puts[0]!.id;
    const b = layer.actions.createTask({ listId: LIST, title: 'b' }).puts[0]!.id;
    layer.actions.deleteTask({ id: a });
    expect(layer.toast.current?.undoable).toBe(true);
    // The star has no message. With the old message on the screen, "Undo" would take back the star.
    layer.actions.setStar({ id: b, starred: true });
    expect(layer.toast.current).toBeNull();

    layer.actions.deleteTask({ id: b });
    expect(layer.toast.current?.message).toBe('Task deleted');
    expect(layer.undo()).toBe(true);
    expect(layer.toast.current).toBeNull();
    expect(layer.getTask(b)?.title).toBe('b');
  });

  it('shows a message of the caller, with a button and with its own time', async () => {
    const { layer, clock } = await boot();
    const run = vi.fn();
    layer.toast.show({ message: 'New version ready', action: { label: 'Reload', run }, duration: 0 });
    await clock.advance(60_000);
    expect(layer.toast.current).toMatchObject({ message: 'New version ready', undoable: false, action: { label: 'Reload' } });
    // A message of the caller is not for the last action, so an action with no message leaves it.
    layer.actions.createTask({ listId: LIST, title: 'a' });
    expect(layer.toast.current?.message).toBe('New version ready');
    layer.toast.show({ message: 'Short', duration: 100 });
    await clock.advance(100);
    expect(layer.toast.current).toBeNull();
    layer.toast.show({ message: 'x' });
    layer.toast.dismiss();
    expect(layer.toast.current).toBeNull();
  });
});

describe('the date of the device', () => {
  const lateEvening = (): FakeClock => fakeClock(new Date(2026, 9, 6, 23, 58, 30).getTime());

  it('changes store.today at local midnight', async () => {
    const { layer, clock } = await boot({ clock: lateEvening() });
    expect(layer.store.today).toBe('2026-10-06');
    await clock.advance(89_000);
    expect(layer.store.today).toBe('2026-10-06');
    await clock.advance(1100);
    expect(layer.store.today).toBe('2026-10-07');
    // And at the next midnight.
    await clock.advance(86_400_000);
    expect(layer.store.today).toBe('2026-10-08');
  });

  it('shows a resting task again at midnight, and moves a task with a date to "Past"', async () => {
    const { layer, clock } = await boot({ clock: lateEvening() });
    const rule: RepeatRule = { every: 1, unit: 'day', start: '2026-10-06', end: { type: 'never' } };
    const daily = layer.actions.createTask({ listId: LIST, title: 'daily', repeat: rule }).puts[0]!.id;
    layer.actions.createTask({ listId: LIST, title: 'due today', due: '2026-10-06' });
    layer.actions.setListSort({ id: LIST, sort: 'date' });
    layer.actions.completeTask({ id: daily });
    expect(layer.toast.current?.message).toBe('Task completed. It comes back on Wed 7 Oct');
    expect(layer.listView(LIST).groups.map((group) => [group.heading, group.items.length])).toEqual([['Today', 1]]);
    expect(layer.listView(LIST).completed.map((task) => task.id)).toEqual([daily]);
    const builds = layer.debug.builds.list;

    await clock.advance(120_000);
    expect(layer.listView(LIST).groups.map((group) => [group.heading, group.tone, group.items.length])).toEqual([
      ['Past', 'past', 1],
      ['Today', 'normal', 1],
    ]);
    expect(layer.listView(LIST).completed).toEqual([]);
    expect(layer.debug.builds.list).toBe(builds + 1);
  });

  it('reads the date again when the app becomes visible', async () => {
    const { layer, device: made } = await boot({ clock: lateEvening() });
    // A phone stops the timers of an app in the background. The clock of the test jumps the same way.
    made.setVisible(false);
    vi.spyOn(made.env, 'now').mockReturnValue(new Date(2026, 9, 9, 8, 0, 0).getTime());
    expect(layer.store.today).toBe('2026-10-06');
    made.setVisible(true);
    expect(layer.store.today).toBe('2026-10-09');
  });
});

describe('local database', () => {
  it('writes all changes of one tick in one transaction', async () => {
    const { layer, browser, clock } = await boot();
    const before = browser.storage.writes();
    for (let i = 0; i < 100; i++) layer.actions.createTask({ listId: LIST, title: `task ${i}` });
    const a = layer.listView(LIST).groups[0]!.items[0]!.task.id;
    layer.actions.completeTask({ id: a });
    layer.actions.setListSort({ id: LIST, sort: 'title' });
    // The memory has the changes, the database not yet: the write comes after the screen.
    expect(browser.storage.writes()).toBe(before);
    expect(browser.storage.peek('user-1')!.tasks.length).toBe(0);
    await clock.advance(0);
    expect(browser.storage.writes()).toBe(before + 1);
    const saved = browser.storage.peek('user-1')!;
    expect(saved.tasks.length).toBe(100);
    expect(saved.outbox.length).toBe(101);
    expect(saved.lists[0]!.sort).toBe('title');
    expect(saved.tasks.find((task) => task.id === a)?.completed).toBe(true);

    // The answer of the server removes the ops, again in one transaction.
    await clock.advance(50);
    expect(browser.storage.writes()).toBe(before + 2);
    expect(browser.storage.peek('user-1')!.outbox).toEqual([]);
    expect(browser.storage.peek('user-1')!.meta).toMatchObject({ since: 2, me: { id: 'user-1', name: 'Alex' } });
  });

  it('shows the rows after a restart before the network answers', async () => {
    const first = await boot();
    first.layer.actions.createTask({ listId: LIST, title: 'kept' });
    first.layer.actions.createList({ title: 'Second list' });
    await first.clock.advance(60);
    const syncedAt = first.layer.sync.lastSyncedAt;
    expect(syncedAt).toBe(first.clock.now() - 10);
    await first.layer.stop();

    const next = device({ server: first.server, clock: first.clock, browser: first.browser });
    next.hold();
    const started = next.layer.start();
    for (let i = 0; i < 5; i++) await settle();
    expect(next.answered).toEqual([]);
    expect(next.layer.session.status).toBe('signedIn');
    expect(next.layer.session.me?.name).toBe('Alex');
    expect(next.layer.otherUser()?.name).toBe('Sam');
    expect(next.layer.listsOrdered().map((list) => list.title)).toEqual(['My Tasks', 'Second list']);
    expect(openTitles(next.layer)).toEqual(['kept']);
    expect(next.layer.sync.lastSyncedAt).toBe(syncedAt);

    next.release();
    await started;
    expect(next.answered.sort()).toEqual(['/api/me', '/api/sync']);
    // The device asked only for the rows after its last revision.
    expect(first.server.syncs.at(-1)!.since).toBeGreaterThan(0);
  });

  it('starts with no network, keeps the changes of that time, and sends them later', async () => {
    const first = await boot();
    first.layer.actions.createTask({ listId: LIST, title: 'one' });
    await first.clock.advance(60);
    first.device.setOnline(false);
    first.layer.actions.createTask({ listId: LIST, title: 'made offline' });
    expect(first.layer.sync.status).toBe('offline');
    await first.clock.advance(1000);
    expect(first.layer.sync.pending).toBe(1);
    await first.layer.stop();

    const next = device({ server: first.server, clock: first.clock, browser: first.browser });
    next.setOnline(false);
    await next.layer.start();
    expect(next.layer.session.status).toBe('signedIn');
    expect(openTitles(next.layer)).toEqual(['made offline', 'one']);
    expect(next.layer.sync.pending).toBe(1);
    expect(next.layer.sync.status).toBe('offline');
    next.layer.actions.updateTask({ id: next.layer.listView(LIST).groups[0]!.items[0]!.task.id, notes: 'more' });
    // The two puts are on the same row, so they are one op.
    expect(next.layer.sync.pending).toBe(1);

    const before = syncCount(first.server);
    next.setOnline(true);
    await first.clock.advance(0);
    expect(syncCount(first.server)).toBe(before + 1);
    expect(lastOps(first.server)).toMatchObject([{ fields: { title: 'made offline', notes: 'more' } }]);
    expect(next.layer.sync.pending).toBe(0);
    expect(next.layer.sync.status).toBe('idle');
  });

  it('applies the outbox again over the rows of the local database at the start', async () => {
    const first = await boot();
    const id = first.layer.actions.createTask({ listId: LIST, title: 'old title' }).puts[0]!.id;
    await first.clock.advance(60);
    first.device.setOnline(false);
    first.layer.actions.updateTask({ id, title: 'new title', notes: 'new notes' });
    await first.clock.advance(0);
    await first.layer.stop();
    // A second tab of the browser wrote its older copy of the row over the row.
    const storage = await first.browser.storage.open('user-1');
    const row = first.browser.storage.peek('user-1')!.tasks[0]!;
    await storage.write({
      clear: false,
      lists: [],
      listsGone: [],
      tasks: [{ ...row, title: 'old title', notes: '', starred: true }],
      tasksGone: [],
      ops: [],
      opsGone: [],
      meta: {},
    });

    const next = device({ server: first.server, clock: first.clock, browser: first.browser });
    next.setOnline(false);
    await next.layer.start();
    expect(next.layer.getTask(id)).toMatchObject({ title: 'new title', notes: 'new notes', starred: true });
    expect(next.layer.sync.pending).toBe(1);
    await first.clock.advance(0);
    expect(first.browser.storage.peek('user-1')!.tasks[0]).toMatchObject({ title: 'new title', starred: true });
  });

  it('works in memory when the browser refuses the local database', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const browser = makeBrowser();
    browser.storage.open = () => Promise.reject(new Error('IndexedDB is not there'));
    const { layer, server, clock } = await boot({ browser });
    expect(layer.session.status).toBe('signedIn');
    expect(warn).toHaveBeenCalledTimes(1);
    layer.actions.createTask({ listId: LIST, title: 'kept in memory' });
    await clock.advance(60);
    expect(openTitles(layer)).toEqual(['kept in memory']);
    expect(lastOps(server).length).toBe(1);
    expect(layer.sync.pending).toBe(0);
  });

  it('does not wait on the start screen for a local database that gives no answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const clock = fakeClock();
    const browser = makeBrowser();
    browser.storage.open = () => new Promise(() => undefined);
    const made = device({ server: stubServer(clock.now), clock, browser });
    const started = made.layer.start();
    await clock.advance(4999);
    expect(made.layer.session.status).toBe('loading');
    await clock.advance(1);
    await started;
    expect(made.layer.session.status).toBe('signedIn');
    expect(made.layer.listsOrdered().length).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('goes on when a write to the local database fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const browser = makeBrowser();
    const open = browser.storage.open;
    browser.storage.open = async (userId) => {
      const storage = await open(userId);
      return { ...storage, write: () => Promise.reject(new Error('The disk is full')) };
    };
    const { layer, server, clock } = await boot({ browser });
    layer.actions.createTask({ listId: LIST, title: 'a' });
    await clock.advance(60);
    layer.actions.createTask({ listId: LIST, title: 'b' });
    await clock.advance(60);
    expect(openTitles(layer)).toEqual(['b', 'a']);
    expect(server.syncs.flatMap((sync) => sync.ops).length).toBe(2);
    expect(warn).toHaveBeenCalled();
  });

  it('uses one client id for the life of the local database', async () => {
    const first = await boot();
    await first.layer.stop();
    const next = await boot({ server: first.server, clock: first.clock, browser: first.browser });
    await next.layer.sync.now();
    const ids = new Set(first.server.syncs.map((sync) => sync.clientId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('answers of the server', () => {
  async function withTask() {
    const made = await boot();
    const id = made.layer.actions.createTask({ listId: LIST, title: 'start' }).puts[0]!.id;
    await made.clock.advance(60);
    return { ...made, id, row: made.layer.getTask(id)! };
  }

  it('keeps a change that was made while a request was in flight', async () => {
    const { layer, server, clock, device: made, id, row } = await withTask();
    layer.actions.updateTask({ id, title: 'one' });
    made.hold();
    await clock.advance(800);
    // The first op is in the request. This put makes a second op.
    layer.actions.updateTask({ id, title: 'two' });
    expect(layer.debug.outbox().map((op) => op.fields.title)).toEqual(['one', 'two']);

    // The server sends the row as it is after the first op.
    server.onSync = (_request, response) => void (response.tasks = [{ ...row, title: 'one' }]);
    made.release();
    await clock.advance(0);
    server.onSync = null;
    expect(lastOps(server).map((op) => op.fields.title)).toEqual(['one']);
    expect(layer.getTask(id)?.title).toBe('two');
    expect(layer.sync.pending).toBe(1);

    await clock.advance(800);
    expect(lastOps(server).map((op) => op.fields.title)).toEqual(['two']);
    expect(layer.sync.pending).toBe(0);
  });

  it('goes back to the row of the server for a rejected op, and tells the person', async () => {
    const { layer, server, clock, id, row } = await withTask();
    const before = layer.getTask(id);
    layer.actions.updateTask({ id, title: 'not permitted' });
    server.onSync = (request, response) => {
      response.rejected = request.ops.map((op) => op.opId);
      response.acked = [];
      response.tasks = [{ ...row }];
    };
    await clock.advance(800);
    expect(layer.getTask(id)?.title).toBe('start');
    // The row has the values from before the change, so it is the same object again.
    expect(layer.getTask(id)).not.toBe(before);
    expect(layer.sync.pending).toBe(0);
    expect(layer.toast.current).toMatchObject({ message: 'The server refused a change', undoable: false });
  });

  it('drops a new task that the server refused', async () => {
    const { layer, server, clock, browser } = await boot();
    server.onSync = (request, response) => {
      response.rejected = request.ops.map((op) => op.opId);
      response.acked = [];
      response.gone.tasks = request.ops.map((op) => op.id);
    };
    layer.actions.createTask({ listId: LIST, title: 'a' });
    layer.actions.createTask({ listId: LIST, title: 'b' });
    await clock.advance(50);
    expect(openTitles(layer)).toEqual([]);
    expect(layer.debug.rows.tasks.size).toBe(0);
    expect(layer.toast.current?.message).toBe('The server refused 2 changes');
    await clock.advance(0);
    expect(browser.storage.peek('user-1')!.tasks).toEqual([]);
    expect(browser.storage.peek('user-1')!.outbox).toEqual([]);
  });

  it('keeps the object of a row that the server sends back with the same values', async () => {
    const { layer, server, clock, id, row } = await withTask();
    layer.actions.updateTask({ id, title: 'changed' });
    const mine = layer.getTask(id)!;
    const view = layer.listView(LIST);
    // The server sends the row of the op back, with its fields in a different order.
    server.onSync = (_request, response) => {
      response.tasks = [Object.fromEntries(Object.entries({ ...row, title: 'changed' }).reverse()) as unknown as TaskRow];
    };
    await clock.advance(800);
    expect(layer.getTask(id)).toBe(mine);
    expect(layer.listView(LIST)).toBe(view);
  });

  it('removes the rows that are gone, and their tasks stay away', async () => {
    const { layer, server, clock, browser, id } = await withTask();
    const other = layer.actions.createTask({ listId: LIST, title: 'stays' }).puts[0]!.id;
    await clock.advance(60);
    server.onSync = (_request, response) => void (response.gone.tasks = [id, 'never-seen']);
    await layer.sync.now();
    expect(layer.debug.rows.tasks.has(id)).toBe(false);
    expect(openTitles(layer)).toEqual(['stays']);
    await clock.advance(0);
    expect(browser.storage.peek('user-1')!.tasks.map((task) => task.id)).toEqual([other]);
  });

  it('replaces all rows for a reset, keeps the outbox, and applies it again', async () => {
    const { layer, server, clock, browser, id, row } = await withTask();
    const listId = layer.actions.createList({ title: 'Old list' }).puts[0]!.id;
    layer.actions.createTask({ listId, title: 'in the old list' });
    await clock.advance(60);

    layer.actions.updateTask({ id, title: 'my change' });
    const fresh: TaskRow = { ...row, id: 'from-the-server', title: 'new on the server', pos: 'b0' };
    server.onSync = (request, response) => {
      // The server lost the op: it is still in the outbox when the rows come.
      response.acked = [];
      expect(request.ops.length).toBe(1);
      response.reset = true;
      response.lists = [server.list];
      response.tasks = [{ ...row, title: 'server title', notes: 'server notes' }, fresh];
    };
    await clock.advance(800);
    server.onSync = null;
    expect(layer.listsOrdered().map((list) => list.id)).toEqual([LIST]);
    expect(layer.debug.rows.tasks.size).toBe(2);
    expect(layer.getTask(id)).toMatchObject({ title: 'my change', notes: 'server notes' });
    expect(openTitles(layer)).toEqual(['my change', 'new on the server']);
    expect(layer.sync.pending).toBe(1);
    await clock.advance(0);
    const saved = browser.storage.peek('user-1')!;
    expect(saved.lists.map((list) => list.id)).toEqual([LIST]);
    expect(saved.tasks.map((task) => task.title).sort()).toEqual(['my change', 'new on the server']);
    expect(saved.outbox.length).toBe(1);
  });

  it('sends a large outbox in parts that the server accepts', async () => {
    const { layer, server, clock, device: made } = await boot();
    made.setOnline(false);
    const notes = 'ñ'.repeat(8192);
    for (let i = 0; i < 400; i++) layer.actions.createTask({ listId: LIST, title: `task ${i}`, notes });
    const before = syncCount(server);
    made.setOnline(true);
    await clock.advance(0);
    const parts = server.syncs.slice(before);
    expect(parts.length).toBe(3);
    expect(parts.reduce((sum, part) => sum + part.ops.length, 0)).toBe(400);
    // 'ñ' is 2 bytes. The limit of the server is 5 MB.
    for (const part of parts) expect(part.chars).toBeLessThanOrEqual(1_500_100);
    expect(layer.sync.pending).toBe(0);
  });
});

describe('sync state', () => {
  it('tries again after 1 s, 2 s, 4 s, up to 60 s, and then gets the changes through', async () => {
    const { layer, server, clock } = await boot();
    const tries = (): number => server.calls.filter((call) => call === 'POST /api/sync').length;
    server.down = 0;
    layer.actions.createTask({ listId: LIST, title: 'a' });
    await clock.advance(50);
    const first = tries();
    expect(layer.sync.status).toBe('offline');
    expect(layer.sync.pending).toBe(1);

    const seen: number[] = [];
    for (const wait of [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]) {
      await clock.advance(wait - 1);
      seen.push(tries());
      await clock.advance(1);
      seen.push(tries());
    }
    expect(seen.map((count) => count - first)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8]);

    // An action in this time does not start a request of its own.
    layer.actions.createTask({ listId: LIST, title: 'b' });
    await clock.advance(1000);
    expect(tries() - first).toBe(8);
    expect(layer.sync.status).toBe('offline');

    server.down = null;
    await clock.advance(59_000);
    expect(tries() - first).toBe(9);
    expect(layer.sync.status).toBe('idle');
    expect(layer.sync.pending).toBe(0);
    expect(lastOps(server).map((op) => op.fields.title)).toEqual(['a', 'b']);

    // After the recovery the next failure starts at 1 s again.
    server.down = 0;
    layer.actions.createTask({ listId: LIST, title: 'c' });
    await clock.advance(50);
    const again = tries();
    await clock.advance(1000);
    expect(tries()).toBe(again + 1);
  });

  it('has the status "error" for an error answer, and "Sync now" tries at once', async () => {
    const { layer, server, clock } = await boot();
    server.down = 500;
    layer.actions.createTask({ listId: LIST, title: 'a' });
    await clock.advance(50);
    expect(layer.sync.status).toBe('error');
    expect(layer.sync.pending).toBe(1);
    expect(await layer.sync.now()).toBe(false);
    server.down = null;
    expect(await layer.sync.now()).toBe(true);
    expect(layer.sync.status).toBe('idle');
    expect(layer.sync.pending).toBe(0);
  });

  it('makes no request with no network, and syncs when the network comes back', async () => {
    const { layer, server, clock, device: made } = await boot();
    const before = server.calls.length;
    made.setOnline(false);
    expect(layer.sync.status).toBe('offline');
    layer.actions.createTask({ listId: LIST, title: 'a' });
    await clock.advance(120_000);
    expect(made.requests.filter((route) => route === '/api/sync').length).toBe(1);
    expect(server.calls.length).toBe(before);
    made.setOnline(true);
    await clock.advance(0);
    expect(layer.sync.status).toBe('idle');
    expect(layer.sync.pending).toBe(0);
  });

  it('asks the server each 60 seconds while the app is visible and has no event stream', async () => {
    const { layer, server, clock, device: made } = await boot();
    const start = syncCount(server);
    await clock.advance(59_999);
    expect(syncCount(server)).toBe(start);
    await clock.advance(1);
    expect(syncCount(server)).toBe(start + 1);
    await clock.advance(120_000);
    expect(syncCount(server)).toBe(start + 3);

    made.setVisible(false);
    await clock.advance(600_000);
    expect(syncCount(server)).toBe(start + 3);
    made.setVisible(true);
    await clock.advance(0);
    expect(syncCount(server)).toBe(start + 4);
    await clock.advance(60_000);
    expect(syncCount(server)).toBe(start + 5);
    expect(layer.sync.lastSyncedAt).toBe(clock.now());
  });

  it('sends the changes at once when the app goes to the background', async () => {
    const { layer, server, clock, browser, device: made } = await boot();
    const id = layer.actions.createTask({ listId: LIST, title: 'T' }).puts[0]!.id;
    await clock.advance(60);
    const before = syncCount(server);
    const writes = browser.storage.writes();
    layer.actions.updateTask({ id, title: 'typed just before the person left' });
    made.setVisible(false);
    // No timer ran: the write and the request started in the signal.
    await settle();
    expect(browser.storage.writes()).toBe(writes + 1);
    expect(syncCount(server)).toBe(before + 1);
    expect(lastOps(server)[0]!.fields.title).toBe('typed just before the person left');
  });

  it('makes the other tabs of the browser sync after a change', async () => {
    const first = await boot();
    const second = await boot({ server: first.server, clock: first.clock, browser: first.browser });
    const before = syncCount(first.server);
    first.layer.actions.createTask({ listId: LIST, title: 'from tab 1' });
    await first.clock.advance(50);
    await first.clock.advance(0);
    const syncs = first.server.syncs.slice(before);
    expect(syncs.map((sync) => sync.ops.length)).toEqual([1, 0]);
    // The two tabs have one local database, so they have one client id.
    expect(syncs[0]!.clientId).toBe(syncs[1]!.clientId);
    expect(second.layer.session.status).toBe('signedIn');
  });

  it('signs the other tabs out with the tab of the person', async () => {
    const first = await boot();
    const second = await boot({ server: first.server, clock: first.clock, browser: first.browser });
    await first.layer.logout();
    await first.clock.advance(0);
    expect(second.layer.session.status).toBe('signedOut');
    expect(second.layer.listsOrdered()).toEqual([]);
  });
});

describe('settings of the device', () => {
  it('has defaults, and saves each change as one JSON object', async () => {
    const { layer, browser, device: made } = await boot();
    expect({ ...layer.prefs }).toEqual({ theme: 'system', starredSort: 'date', completedOpen: {}, lastTab: null, sidebarOpen: true });
    layer.prefs.theme = 'dark';
    expect(made.theme).toBe('dark');
    layer.prefs.starredSort = 'starred';
    layer.prefs.lastTab = 'starred';
    layer.prefs.sidebarOpen = false;
    layer.prefs.completedOpen = { ...layer.prefs.completedOpen, a: true, b: false };
    expect(JSON.parse(browser.kv.get(PREFS_KEY)!)).toEqual({
      theme: 'dark',
      starredSort: 'starred',
      completedOpen: { a: true },
      lastTab: 'starred',
      sidebarOpen: false,
    });
    layer.prefs.theme = 'system';
    expect(made.theme).toBe('system');
    // A change in place would be lost, so it is an error.
    expect(() => ((layer.prefs.completedOpen as Record<string, boolean>).c = true)).toThrow(TypeError);
  });

  it('reads the saved settings at the next start, and ignores values that are not valid', async () => {
    const browser = makeBrowser();
    browser.kv.set(PREFS_KEY, JSON.stringify({ theme: 'light', starredSort: 'starred', completedOpen: { x: true, y: 'no' }, lastTab: 7, extra: 1 }));
    const { layer } = await boot({ browser });
    expect({ ...layer.prefs }).toEqual({ theme: 'light', starredSort: 'starred', completedOpen: { x: true }, lastTab: null, sidebarOpen: true });
    browser.kv.set(PREFS_KEY, 'not json');
    expect((await boot({ browser })).layer.prefs.theme).toBe('system');
  });

  it('sorts the starred view by the setting', async () => {
    const { layer } = await boot();
    const a = layer.actions.createTask({ listId: LIST, title: 'a', due: '2026-10-08' }).puts[0]!.id;
    const b = layer.actions.createTask({ listId: LIST, title: 'b' }).puts[0]!.id;
    layer.actions.setStar({ id: a, starred: true });
    layer.actions.setStar({ id: b, starred: true });
    expect(layer.starredView().groups.map((group) => group.heading)).toEqual(['Thu 8 Oct', 'No date']);
    layer.prefs.starredSort = 'starred';
    expect(layer.starredView().groups.map((group) => group.heading)).toEqual([null]);
  });
});

describe('notifications', () => {
  function fakePush(answer: NotificationPermission = 'granted') {
    const state = { permission: 'default' as NotificationPermission, subscription: null as PushSubscriptionData | null, key: '' };
    const push: PushEnv = {
      permission: () => state.permission,
      ask: async () => (state.permission = answer),
      current: async () => state.subscription,
      subscribe: async (key) => {
        state.key = key;
        return (state.subscription = { endpoint: 'https://push.example/device-1', keys: { p256dh: 'p', auth: 'a' } });
      },
      unsubscribe: async () => {
        const endpoint = state.subscription?.endpoint ?? null;
        state.subscription = null;
        return endpoint;
      },
    };
    return { state, push };
  }

  it('is not supported with no push of the browser', async () => {
    const { layer } = await boot();
    expect([layer.push.supported, layer.push.enabled, layer.push.permission]).toEqual([false, false, 'default']);
    expect(await layer.push.enable()).toEqual({ ok: false, message: 'This browser cannot show notifications' });
  });

  it('subscribes with the key of the server, sends a test, and unsubscribes', async () => {
    const { state, push } = fakePush();
    const { layer, server } = await boot({ push });
    expect([layer.push.supported, layer.push.enabled]).toEqual([true, false]);
    expect(await layer.push.enable()).toEqual({ ok: true, message: 'Notifications are on' });
    expect(state.key).toBe('stub-key');
    expect(server.bodies['/api/push/subscribe']).toEqual({ endpoint: 'https://push.example/device-1', keys: { p256dh: 'p', auth: 'a' } });
    expect([layer.push.enabled, layer.push.permission]).toEqual([true, 'granted']);
    expect(await layer.push.test()).toEqual({ ok: true, message: 'Test notification sent' });
    expect(await layer.push.disable()).toEqual({ ok: true, message: 'Notifications are off' });
    expect(server.bodies['/api/push/unsubscribe']).toEqual({ endpoint: 'https://push.example/device-1' });
    expect(layer.push.enabled).toBe(false);
  });

  it('gives a text when the person or the browser does not permit notifications', async () => {
    const denied = await boot({ push: fakePush('denied').push });
    expect(await denied.layer.push.enable()).toEqual({
      ok: false,
      message: 'Notifications are blocked. Permit them for this app in the browser settings',
    });
    expect(denied.layer.push.permission).toBe('denied');
    const later = await boot({ push: fakePush('default').push });
    expect((await later.layer.push.enable()).ok).toBe(false);
    expect(later.layer.push.enabled).toBe(false);
  });

  it('sends the subscription of the device again at each start, and removes it at sign-out', async () => {
    const { state, push } = fakePush();
    const first = await boot({ push });
    await first.layer.push.enable();
    await first.layer.stop();
    delete first.server.bodies['/api/push/subscribe'];

    const next = await boot({ push, server: first.server, clock: first.clock, browser: first.browser });
    await settle();
    expect(next.layer.push.enabled).toBe(true);
    expect(first.server.bodies['/api/push/subscribe']).toMatchObject({ endpoint: 'https://push.example/device-1' });

    await next.layer.logout();
    expect(state.subscription).toBeNull();
    expect(next.layer.push.enabled).toBe(false);
  });
});

describe.runIf(reactive)('readers (only with the compiler output for a browser)', () => {
  it('tells the readers of the session, the sync state, the snackbar, and the undo state', async () => {
    const { layer, clock } = await boot();
    const seen = watch(() => ({
      status: layer.session.status,
      sync: layer.sync.status,
      pending: layer.sync.pending,
      toast: layer.toast.current?.message ?? null,
      canUndo: layer.canUndo(),
      open: layer.listView(LIST).openCount,
    }));
    expect(seen.value).toEqual({ status: 'signedIn', sync: 'idle', pending: 0, toast: null, canUndo: false, open: 0 });
    const id = layer.actions.createTask({ listId: LIST, title: 'a' }).puts[0]!.id;
    layer.actions.deleteTask({ id });
    flushSync();
    expect(seen.value).toEqual({ status: 'signedIn', sync: 'idle', pending: 1, toast: 'Task deleted', canUndo: true, open: 0 });
    layer.undo();
    flushSync();
    expect(seen.value).toMatchObject({ toast: null, canUndo: true, open: 1 });
    await clock.advance(60);
    flushSync();
    expect(seen.value).toMatchObject({ pending: 0, sync: 'idle' });
    seen.stop();
  });

  it('tells the readers of the date and of the settings', async () => {
    const { layer, clock } = await boot({ clock: fakeClock(new Date(2026, 9, 6, 23, 59, 59).getTime()) });
    const today = watch(() => layer.store.today);
    const theme = watch(() => layer.prefs.theme);
    const open = watch(() => layer.prefs.completedOpen[LIST] ?? false);
    await clock.advance(2000);
    flushSync();
    expect([today.value, today.runs]).toEqual(['2026-10-07', 2]);
    layer.prefs.completedOpen = { [LIST]: true };
    flushSync();
    expect([open.value, open.runs, theme.runs]).toEqual([true, 2, 1]);
    layer.prefs.theme = 'dark';
    flushSync();
    expect([theme.value, theme.runs, open.runs]).toEqual(['dark', 2, 2]);
    [today, theme, open].forEach((each) => each.stop());
  });

  it('tells the reader of store.can when a change makes an action possible', async () => {
    const { layer } = await boot();
    const a = layer.actions.createTask({ listId: LIST, title: 'a' }).puts[0]!.id;
    const indent = watch(() => layer.store.can('indentTask', { id: a }));
    expect(indent.value).toBe(false);
    layer.actions.createTask({ listId: LIST, title: 'above a' });
    flushSync();
    expect(indent.value).toBe(true);
    indent.stop();
  });

  it('runs an effect one time when the effect does an action', async () => {
    const { layer } = await boot();
    const seen = watch(() => {
      layer.actions.createTask({ listId: LIST, title: 'from an effect' });
      layer.prefs.sidebarOpen = false;
      layer.toast.show({ message: 'from an effect' });
    });
    flushSync();
    await settle();
    expect(seen.runs).toBe(1);
    expect(layer.listView(LIST).openCount).toBe(1);
    seen.stop();
  });

  it('does not run the readers of a list for a sync that brings no change to it', async () => {
    const { layer, server, clock } = await boot();
    const other = layer.actions.createList({ title: 'Other' }).puts[0]!.id;
    const id = layer.actions.createTask({ listId: other, title: 'in the other list' }).puts[0]!.id;
    await clock.advance(60);
    const mine = watch(() => layer.listView(LIST));
    const theirs = watch(() => layer.listView(other));
    const row = layer.getTask(id)!;
    server.onSync = (_request, response) => void (response.tasks = [{ ...row, title: 'changed by the other person' }]);
    await layer.sync.now();
    flushSync();
    expect([mine.runs, theirs.runs]).toEqual([1, 2]);
    expect(theirs.value.groups[0]!.items[0]!.task.title).toBe('changed by the other person');
    [mine, theirs].forEach((each) => each.stop());
  });
});
