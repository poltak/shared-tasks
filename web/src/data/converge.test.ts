// Random actions on three devices, with random times with no network. At the end each device
// must show the same rows. The real server is in the middle.
import { afterAll, expect, it } from 'vitest';
import type { ID, ListRow, TaskRow } from '../../../shared/types.ts';
import { makeDevice, startServerProcess, waitFor } from './testkit.ts';
import type { Device, ServerProcess } from './testkit.ts';

const servers: ServerProcess[] = [];
const devices: Device[] = [];

afterAll(async () => {
  await Promise.all(devices.map((made) => made.layer.stop()));
  await Promise.all(servers.map((server) => server.remove()));
});

/** A random number generator that gives the same numbers for the same seed. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    below: (n: number): number => Math.floor(next() * n),
    pick: <T>(items: readonly T[]): T | undefined => items[Math.floor(next() * items.length)],
  };
}

async function signedIn(input: { server: ServerProcess; name: string; register: boolean }): Promise<Device> {
  const { server, name, register } = input;
  const made = makeDevice({ server: server.url });
  devices.push(made);
  await made.layer.start();
  const result = await made.layer[register ? 'register' : 'login']({ name, password: `password-of-${name.toLowerCase()}` });
  expect(result).toEqual({ ok: true });
  return made;
}

const DATES = ['2026-10-01', '2026-10-06', '2026-10-07', '2026-10-20', '2027-01-03'];

/** One random action on the device, on rows that the device shows. */
function act(made: Device, rng: ReturnType<typeof random>, serial: number): void {
  const { layer } = made;
  const { actions } = layer;
  const lists = layer.listsOrdered();
  const list = rng.pick(lists);
  if (!list) return;
  const tasks = [...layer.debug.rows.tasks.values()].filter((task) => !task.deleted && layer.getList(task.listId));
  const task = rng.pick(tasks);
  const other = rng.pick(tasks);
  const kind = rng.below(100);

  if (kind < 22 || !task) {
    const position =
      task && task.listId === list.id && rng.below(3) === 0
        ? rng.below(2) === 0
          ? { after: task.id }
          : { parentId: task.id, at: 'end' as const }
        : undefined;
    actions.createTask({
      listId: list.id,
      title: `Task ${serial}`,
      due: rng.below(3) === 0 ? rng.pick(DATES) : null,
      starred: rng.below(8) === 0,
      position,
    });
  } else if (kind < 34) actions.updateTask({ id: task.id, title: `Title ${serial}` });
  else if (kind < 40) actions.updateTask({ id: task.id, notes: `Notes ${serial}`, deadline: rng.below(2) ? rng.pick(DATES) : null });
  else if (kind < 50) actions.completeTask({ id: task.id });
  else if (kind < 55) actions.uncompleteTask({ id: task.id });
  else if (kind < 61) actions.deleteTask({ id: task.id });
  else if (kind < 67) actions.setStar({ id: task.id, starred: !task.starred });
  else if (kind < 72) actions.setDate({ id: task.id, due: rng.below(4) ? rng.pick(DATES)! : null, time: rng.below(3) ? null : '09:30' });
  else if (kind < 75) {
    actions.setRepeat({
      id: task.id,
      rule: rng.below(3) ? { every: 1 + rng.below(3), unit: 'day', start: rng.pick(DATES)!, end: { type: 'never' } } : null,
    });
  } else if (kind < 82) {
    // A new place: in its list, in a different list, or below a different task.
    const choice = rng.below(3);
    if (choice === 0) actions.moveTask({ id: task.id, parentId: null, beforeId: other?.id ?? null });
    else if (choice === 1) actions.moveTask({ id: task.id, listId: list.id });
    else if (other) actions.moveTask({ id: task.id, listId: other.listId, parentId: other.id });
  } else if (kind < 85) actions.indentTask({ id: task.id });
  else if (kind < 87) actions.unindentTask({ id: task.id });
  else if (kind < 89) actions.moveToTop({ id: task.id });
  else if (kind < 91) actions.createList({ title: `List ${serial}` });
  else if (kind < 93) actions.renameList({ id: list.id, title: `Renamed ${serial}` });
  else if (kind < 94) actions.setListSort({ id: list.id, sort: rng.pick(['my', 'date', 'title'] as const)! });
  else if (kind < 95) actions.moveList({ id: list.id, toFirst: true });
  else if (kind < 96) actions.setListShared({ id: list.id, shared: !list.shared });
  else if (kind < 97) actions.clearCompleted({ listId: list.id });
  else if (kind < 98 && lists.length > 3) actions.deleteList({ id: list.id });
  else layer.undo();
}

/** The fields that all people share. */
const sharedPart = (row: TaskRow | ListRow): Record<string, unknown> => {
  const { starred: _1, starredAt: _2, pos, sort: _4, hidden: _5, ...rest } = row as TaskRow & ListRow;
  // The place of a task is shared. The place of a list is for each person.
  return 'listId' in row ? { ...rest, pos } : rest;
};

const sorted = <Row extends { id: ID }>(rows: Iterable<Row>): Row[] => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));

it.each([1, 2, 3])(
  'three devices show the same rows after random actions with and without the network (seed %i)',
  async (seed) => {
    const rng = random(seed);
    // Each seed has its own server, so each run starts from two new accounts.
    const server = await startServerProcess(`converge-${seed}`);
    servers.push(server);
    const ann1 = await signedIn({ server, name: 'Ann', register: true });
    const ben = await signedIn({ server, name: 'Ben', register: true });
    const ann2 = await signedIn({ server, name: 'Ann', register: false });
    const all = [ann1, ann2, ben];
    // A shared list from the start, so the two people work on the same rows.
    const shared = ann1.layer.actions.createList({ title: 'Shared' }).puts[0]!.id;
    ann1.layer.actions.setListShared({ id: shared, shared: true });
    await waitFor(() => ben.layer.getList(shared) !== undefined && ann2.layer.getList(shared) !== undefined);

    for (let step = 0; step < 400; step++) {
      const made = rng.pick(all)!;
      const dice = rng.below(100);
      if (dice < 6) made.setOnline(rng.below(2) === 0);
      else if (dice < 9) void made.layer.sync.now();
      else act(made, rng, step);
      // A pause now and then lets requests and pokes go between the actions.
      if (rng.below(4) === 0) await new Promise((resolve) => setTimeout(resolve, rng.below(4)));
    }

    for (const made of all) made.setOnline(true);
    const quiet = (): boolean => all.every((made) => made.layer.sync.status === 'idle' && made.layer.sync.pending === 0);
    // Each sync can make a poke for the others, so the devices sync until no device has news.
    for (let round = 0; round < 4; round++) {
      await waitFor(quiet, 20_000);
      for (const made of all) expect(await made.layer.sync.now()).toBe(true);
    }
    await waitFor(quiet, 20_000);

    // Two devices of one person: the same rows with the same values.
    const rows1 = ann1.layer.debug.rows;
    const rows2 = ann2.layer.debug.rows;
    expect(sorted(rows2.lists.values())).toEqual(sorted(rows1.lists.values()));
    expect(sorted(rows2.tasks.values())).toEqual(sorted(rows1.tasks.values()));
    expect(ann2.layer.listsOrdered().map((list) => list.id)).toEqual(ann1.layer.listsOrdered().map((list) => list.id));
    for (const list of ann1.layer.listsOrdered()) expect(ann2.layer.listView(list.id)).toEqual(ann1.layer.listView(list.id));
    expect(ann2.layer.starredView()).toEqual(ann1.layer.starredView());

    // The other person: the same shared lists, and the same shared values of their tasks.
    const benRows = ben.layer.debug.rows;
    const annShared = sorted(rows1.lists.values()).filter((list) => list.shared);
    const benShared = sorted(benRows.lists.values()).filter((list) => list.shared);
    expect(benShared.map(sharedPart)).toEqual(annShared.map(sharedPart));
    const inShared = (rows: Iterable<TaskRow>, lists: ListRow[]): Record<string, unknown>[] =>
      sorted(rows)
        .filter((task) => lists.some((list) => list.id === task.listId))
        .map(sharedPart);
    expect(inShared(benRows.tasks.values(), benShared)).toEqual(inShared(rows1.tasks.values(), annShared));
    // Each person sees only the lists of that person and the shared lists.
    const mine = (made: Device): boolean => [...made.layer.debug.rows.lists.values()].every((list) => list.shared || list.owner === made.layer.session.me!.id);
    expect(all.map(mine)).toEqual([true, true, true]);
    // No row is left with no list.
    for (const made of all) {
      const { lists, tasks } = made.layer.debug.rows;
      expect([...tasks.values()].filter((task) => !lists.has(task.listId))).toEqual([]);
    }
    expect(rows1.tasks.size).toBeGreaterThan(10);

    // The local database of each device has the rows of its memory, and no op is left.
    for (const made of all) {
      await made.layer.debug.flush();
      const saved = made.browser.storage.peek(made.layer.session.me!.id)!;
      expect(sorted(saved.lists)).toEqual(sorted(made.layer.debug.rows.lists.values()));
      expect(sorted(saved.tasks)).toEqual(sorted(made.layer.debug.rows.tasks.values()));
      expect(saved.outbox).toEqual([]);
    }
    await Promise.all(all.map((made) => made.layer.stop()));
  },
  60_000,
);
