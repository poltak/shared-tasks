// Two people with two devices each make random changes and sync in a random order. Each device is
// a model of the client of SPEC section 4: a local copy, an outbox, and the rules for an answer.
// At the end, each device must hold exactly the rows that a new device of the same person gets.
import { afterAll, describe, expect, test } from 'vitest';
import { insertUser } from './auth.ts';
import { openDb } from './db.ts';
import type { Db } from './db.ts';
import { parseSyncRequest, pruneTombstones, runSync } from './sync.ts';
import { makeKit, startTestServer } from './testkit.ts';
import type { TestServer } from './testkit.ts';
import * as hlc from '../shared/hlc.ts';
import { applyPut, defaultList, defaultNote, defaultTask, emptyRows } from '../shared/merge.ts';
import type { Rows } from '../shared/merge.ts';
import { NOTE_COLORS } from '../shared/types.ts';
import type { ID, ListFields, ListRow, NoteFields, NoteRow, Op, Put, SortMode, SyncRequest, SyncResponse, TaskFields, TaskRow } from '../shared/types.ts';

const STEPS = 400;
const START = Date.UTC(2026, 9, 6, 8);
const DAY = 86_400_000;

interface Random {
  next(): number;
  int(n: number): number;
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
}

/** A random generator that gives the same numbers for the same seed. */
function makeRandom(seed: number): Random {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  return { next, int, chance: (p) => next() < p, pick: (items) => items[int(items.length)]! };
}

interface Device {
  name: string;
  userId: ID;
  clientId: ID;
  rows: Rows;
  outbox: Op[];
  /** The ops of a request that has no answer yet. A new put does not merge into them. */
  inFlight: Set<ID>;
  since: number;
  clock: hlc.Clock;
  /** The error of the device clock in milliseconds. */
  skew: number;
  /** Rows that the device deleted, for the undo of the delete. */
  deletedLists: ID[];
  deletedTasks: ID[];
  /** Notes that the device deleted, with each field from before the delete, for the undo. */
  deletedNotes: NoteRow[];
}

interface World {
  seed: number;
  random: Random;
  db: Db;
  /** The true time. The server uses it. */
  time: number;
  devices: Device[];
  /** Each id of a row that a person could see at some time, or made. A 'gone' id must be one of them. */
  known: Map<ID, Set<ID>>;
  serial: number;
  /** Counts that show that the run did real work. */
  work: { acked: number; rejected: number; fromOther: number; notesFromOther: number; resets: number };
  send(device: Device, request: SyncRequest): Promise<SyncResponse>;
  /** The rows of a new device of the person. */
  fresh(userId: ID): Promise<SyncResponse>;
  /** The daily cleanup of the server. */
  prune(): void;
}

const live = (rows: Rows): { lists: ListRow[]; tasks: TaskRow[] } => {
  const lists = [...rows.lists.values()].filter((l) => !l.deleted);
  const open = new Set(lists.map((l) => l.id));
  return { lists, tasks: [...rows.tasks.values()].filter((t) => !t.deleted && open.has(t.listId)) };
};

const withoutId = <T extends { id: ID }>(row: T): Omit<T, 'id'> => {
  const { id: _id, ...fields } = row;
  return fields;
};

/** Applies a put on the device and adds it to the outbox, as SPEC section 4 says. */
function put(world: World, device: Device, change: Put): void {
  applyPut(device.rows, change);
  world.known.get(device.userId)!.add(change.id);
  const ts = hlc.tick(device.clock, world.time + device.skew);
  const pending = device.outbox.find((op) => op.kind === change.kind && op.id === change.id && !device.inFlight.has(op.opId));
  if (pending) {
    Object.assign(pending.fields, change.fields);
    pending.ts = ts;
  } else {
    device.outbox.push({ ...change, fields: { ...change.fields }, opId: `op-${world.serial++}`, ts } as Op);
  }
}

const TITLES = ['Milk', 'Bread', 'Call the bank', 'Book the train', 'Water the plants', 'Pay the bill'];
const DATES = ['2026-10-06', '2026-10-07', '2026-10-20', null];
const SORTS: SortMode[] = ['my', 'date', 'deadline', 'starred', 'title'];

/** One random change that is valid for the rows that the device has. */
function act(world: World, device: Device): void {
  const { random } = world;
  const me = device.userId;
  const now = world.time + device.skew;
  const { lists, tasks } = live(device.rows);
  const setTask = (id: ID, fields: TaskFields): void => put(world, device, { kind: 'task', id, fields });
  const setList = (id: ID, fields: ListFields): void => put(world, device, { kind: 'list', id, fields });
  const pos = (): string => `a${random.int(1000).toString(36)}`;
  const title = (): string => `${random.pick(TITLES)} ${random.int(100)}`;
  const mine = lists.filter((l) => l.owner === me);
  const notes = [...device.rows.notes.values()].filter((n) => !n.deleted);
  const myNotes = notes.filter((n) => n.owner === me);
  const setNote = (id: ID, fields: NoteFields): void => put(world, device, { kind: 'note', id, fields });

  const actions: [number, () => void][] = [
    [
      6,
      () => {
        if (lists.length === 0) return;
        const id = `t-${world.serial++}`;
        const starred = random.chance(0.2);
        setTask(id, {
          ...withoutId(defaultTask(id)),
          listId: random.pick(lists).id,
          title: title(),
          pos: pos(),
          due: random.pick(DATES),
          createdAt: now,
          createdBy: me,
          starred,
          starredAt: starred ? now : null,
        });
      },
    ],
    [
      7,
      () => {
        if (tasks.length === 0) return;
        const task = random.pick(tasks);
        const fields: TaskFields = {};
        if (random.chance(0.5)) fields.title = title();
        if (random.chance(0.3)) fields.notes = `Notes ${random.int(100)}`;
        if (random.chance(0.3)) fields.due = random.pick(DATES);
        if (random.chance(0.2)) fields.time = random.pick(['09:30', '18:00', null]);
        if (random.chance(0.2)) fields.deadline = random.pick(DATES);
        if (random.chance(0.3)) fields.pos = pos();
        if (random.chance(0.2)) {
          const others = tasks.filter((t) => t.listId === task.listId && t.id !== task.id);
          fields.parentId = others.length > 0 && random.chance(0.7) ? random.pick(others).id : null;
        }
        if (Object.keys(fields).length === 0) fields.title = title();
        setTask(task.id, fields);
      },
    ],
    [
      3,
      () => {
        if (tasks.length === 0) return;
        const task = random.pick(tasks);
        setTask(task.id, task.completed ? { completed: false, completedAt: null, completedBy: null } : { completed: true, completedAt: now, completedBy: me });
      },
    ],
    [
      2,
      () => {
        if (tasks.length === 0) return;
        const task = random.pick(tasks);
        device.deletedTasks.push(task.id);
        setTask(task.id, { deleted: true });
      },
    ],
    [
      1,
      () => {
        if (device.deletedTasks.length === 0) return;
        const id = device.deletedTasks.splice(random.int(device.deletedTasks.length), 1)[0]!;
        setTask(id, { deleted: false });
      },
    ],
    [
      3,
      () => {
        if (tasks.length === 0 || lists.length < 2) return;
        const task = random.pick(tasks);
        const target = random.pick(lists.filter((l) => l.id !== task.listId));
        setTask(task.id, { listId: target.id, parentId: null, pos: pos() });
      },
    ],
    [
      2,
      () => {
        if (tasks.length === 0) return;
        const task = random.pick(tasks);
        setTask(task.id, task.starred ? { starred: false, starredAt: null } : { starred: true, starredAt: now });
      },
    ],
    [
      1,
      () => {
        if (lists.length > 6) return;
        const id = `l-${world.serial++}`;
        setList(id, { ...withoutId(defaultList(id)), title: `List ${world.serial}`, owner: me, createdAt: now, pos: pos(), shared: random.chance(0.3) });
      },
    ],
    [1, () => lists.length > 0 && setList(random.pick(lists).id, { title: `List ${world.serial++}` })],
    [3, () => mine.length > 0 && ((list) => setList(list.id, { shared: !list.shared }))(random.pick(mine))],
    [
      1,
      () => {
        const candidates = mine.filter((l) => !l.isDefault);
        if (candidates.length === 0) return;
        const list = random.pick(candidates);
        device.deletedLists.push(list.id);
        setList(list.id, { deleted: true });
      },
    ],
    [
      1,
      () => {
        if (device.deletedLists.length === 0) return;
        const id = device.deletedLists.splice(random.int(device.deletedLists.length), 1)[0]!;
        setList(id, { deleted: false });
      },
    ],
    [
      2,
      () => {
        if (lists.length === 0) return;
        const fields: ListFields = random.pick([{ sort: random.pick(SORTS) }, { pos: pos() }, { hidden: random.chance(0.5) }]);
        setList(random.pick(lists).id, fields);
      },
    ],
    [
      3,
      () => {
        const id = `n-${world.serial++}`;
        // A note can have no title.
        setNote(id, {
          ...withoutId(defaultNote(id)),
          title: random.chance(0.3) ? '' : title(),
          body: `Body ${random.int(100)}`,
          color: random.pick(NOTE_COLORS),
          shared: random.chance(0.4),
          pinned: random.chance(0.2),
          owner: me,
          createdAt: now,
          editedAt: now,
          editedBy: me,
        });
      },
    ],
    [
      4,
      () => {
        if (notes.length === 0) return;
        const note = random.pick(notes);
        const fields: NoteFields = random.chance(0.5) ? { title: random.chance(0.2) ? '' : title() } : { body: `Body ${random.int(100)}` };
        // An op of a person who is not the owner can have the stored value of 'shared'.
        if (random.chance(0.1)) fields.shared = note.shared;
        setNote(note.id, { ...fields, editedAt: now, editedBy: me });
      },
    ],
    [1, () => notes.length > 0 && setNote(random.pick(notes).id, { color: random.pick(NOTE_COLORS) })],
    [
      2,
      () => {
        if (notes.length === 0) return;
        const note = random.pick(notes);
        if (random.chance(0.5)) setNote(note.id, note.pinned ? { pinned: false } : { pinned: true, archived: false });
        else setNote(note.id, note.archived ? { archived: false } : { archived: true, pinned: false });
      },
    ],
    [2, () => myNotes.length > 0 && ((note) => setNote(note.id, { shared: !note.shared }))(random.pick(myNotes))],
    [
      1,
      () => {
        if (myNotes.length === 0) return;
        const note = random.pick(myNotes);
        device.deletedNotes.push(note);
        setNote(note.id, { deleted: true });
      },
    ],
    [
      1,
      () => {
        if (device.deletedNotes.length === 0) return;
        // The undo sends each field from before the delete, createdAt too.
        const note = device.deletedNotes.splice(random.int(device.deletedNotes.length), 1)[0]!;
        setNote(note.id, { ...withoutId(note), deleted: false });
      },
    ],
    [
      1,
      () => {
        // A change that only the owner can make, from a device of the other person. The server
        // refuses it, and the device must come back to the true note.
        const others = notes.filter((n) => n.owner !== me);
        if (others.length === 0) return;
        setNote(random.pick(others).id, random.pick([{ deleted: true }, { shared: false }, { title: title(), shared: false }]));
      },
    ],
  ];
  let roll = random.int(actions.reduce((sum, [weight]) => sum + weight, 0));
  for (const [weight, run] of actions) {
    if (roll < weight) return void run();
    roll -= weight;
  }
}

/** true if the person can see the note, from the database of the server. */
function visibleNote(db: Db, userId: ID, noteId: ID): boolean {
  const note = db.q('SELECT owner, shared, deleted FROM notes WHERE id = ?').get(noteId) as
    | { owner: ID; shared: number; deleted: number }
    | undefined;
  return note !== undefined && note.deleted === 0 && (note.owner === userId || note.shared === 1);
}

/** true if the person can see the list, from the database of the server. */
function visible(db: Db, userId: ID, listId: ID): boolean {
  const list = db.q('SELECT owner, shared, deleted FROM lists WHERE id = ?').get(listId) as
    | { owner: ID; shared: number; deleted: number }
    | undefined;
  return list !== undefined && list.deleted === 0 && (list.owner === userId || list.shared === 1);
}

const VISIBLE = `l.deleted = 0 AND (l.owner = ? OR l.shared = 1)`;

/** Records the rows that each person can see at this moment. The rows change only in a sync. */
function noteVisible(world: World): void {
  for (const [userId, known] of world.known) {
    const rows = [
      ...world.db.q(`SELECT l.id FROM lists l WHERE ${VISIBLE}`).all(userId),
      ...world.db.q(`SELECT t.id FROM tasks t JOIN lists l ON l.id = t.list_id WHERE t.deleted = 0 AND ${VISIBLE}`).all(userId),
      ...world.db.q('SELECT id FROM notes WHERE deleted = 0 AND (owner = ? OR shared = 1)').all(userId),
    ] as { id: ID }[];
    for (const row of rows) known.add(row.id);
  }
}

async function sync(world: World, device: Device, options: { lose?: boolean; during?: () => void } = {}): Promise<SyncResponse> {
  const request: SyncRequest = { clientId: device.clientId, since: device.since, ops: structuredClone(device.outbox), tz: 'UTC' };
  for (const op of request.ops) device.inFlight.add(op.opId);
  const response = await world.send(device, request);
  // To find the cause of a failure: CONVERGE_LOG=1 pnpm exec vitest run server/converge.test.ts -t "seed 7)"
  if (process.env.CONVERGE_LOG) console.log(JSON.stringify({ device: device.name, request, response }));
  noteVisible(world);
  const where = `seed ${world.seed}, ${device.name}, revision ${response.rev}`;

  // The answer never has a row of a list that the person cannot see, and never the id of a row that the person could never see.
  const known = world.known.get(device.userId)!;
  for (const list of response.lists) {
    expect(list.owner === device.userId || list.shared, `${where}: list ${list.id}`).toBe(true);
    expect(list.deleted, `${where}: list ${list.id}`).toBe(false);
    known.add(list.id);
    if (list.owner !== device.userId) world.work.fromOther += 1;
  }
  world.work.acked += response.acked.length;
  world.work.rejected += response.rejected.length;
  if (response.reset) world.work.resets += 1;
  for (const task of response.tasks) {
    expect(visible(world.db, device.userId, task.listId), `${where}: task ${task.id}`).toBe(true);
    expect(task.deleted, `${where}: task ${task.id}`).toBe(false);
    known.add(task.id);
  }
  for (const note of response.notes) {
    expect(note.owner === device.userId || note.shared, `${where}: note ${note.id}`).toBe(true);
    expect(note.deleted, `${where}: note ${note.id}`).toBe(false);
    known.add(note.id);
    if (note.owner !== device.userId) world.work.notesFromOther += 1;
  }
  const rowIds = new Set([...response.lists, ...response.tasks, ...response.notes].map((row) => row.id));
  for (const id of [...response.gone.lists, ...response.gone.tasks, ...response.gone.notes]) {
    expect(known.has(id), `${where}: the gone id ${id} is not an id of this person`).toBe(true);
    expect(rowIds.has(id), `${where}: ${id} is a row and a gone id`).toBe(false);
  }
  expect([...response.acked, ...response.rejected].sort(), where).toEqual(request.ops.map((op) => op.opId).sort());

  // Changes that the person makes while the request is in the air.
  options.during?.();
  device.inFlight.clear();
  // An answer that does not arrive: the device keeps its ops and its revision, and sends them again.
  if (options.lose) return response;

  if (response.reset) {
    device.rows.lists.clear();
    device.rows.tasks.clear();
    device.rows.notes.clear();
  }
  for (const list of response.lists) device.rows.lists.set(list.id, list);
  for (const task of response.tasks) device.rows.tasks.set(task.id, task);
  for (const note of response.notes) device.rows.notes.set(note.id, note);
  for (const id of response.gone.lists) device.rows.lists.delete(id);
  for (const id of response.gone.tasks) device.rows.tasks.delete(id);
  for (const id of response.gone.notes) device.rows.notes.delete(id);
  const done = new Set([...response.acked, ...response.rejected]);
  device.outbox = device.outbox.filter((op) => !done.has(op.opId));
  for (const op of device.outbox) applyPut(device.rows, op);
  device.since = response.rev;
  return response;
}

const byId = <T extends { id: ID }>(rows: Iterable<T>): T[] => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));

async function run(world: World): Promise<void> {
  const { random, devices } = world;
  // In each third run, 181 days go by in the middle, and the server removes its old deleted rows.
  // A device that did not sync after the deletes then gets 'reset' and keeps its outbox.
  const pruneAt = world.seed % 3 === 0 ? STEPS / 2 + random.int(STEPS / 4) : -1;
  for (let step = 0; step < STEPS; step++) {
    world.time += random.int(1000);
    if (step === pruneAt) {
      world.time += 181 * DAY;
      world.prune();
    }
    const device = random.pick(devices);
    if (random.chance(0.3)) {
      await sync(world, device, {
        lose: random.chance(0.1),
        during: random.chance(0.25) ? () => act(world, device) : undefined,
      });
    } else {
      act(world, device);
    }
  }

  // All devices sync until no device has a change to send or to get.
  for (let round = 0; ; round++) {
    expect(round, `seed ${world.seed}: the devices do not come to rest`).toBeLessThan(10);
    let quiet = true;
    for (const device of devices) {
      world.time += 500;
      const sent = device.outbox.length;
      const answer = await sync(world, device);
      const got = answer.lists.length + answer.tasks.length + answer.notes.length;
      if (sent + got + answer.gone.lists.length + answer.gone.tasks.length + answer.gone.notes.length > 0) quiet = false;
    }
    if (quiet) break;
  }

  for (const device of devices) {
    const where = `seed ${world.seed}, ${device.name}`;
    const fresh = await world.fresh(device.userId);
    expect(byId(device.rows.lists.values()), `${where}: lists`).toEqual(byId(fresh.lists));
    expect(byId(device.rows.tasks.values()), `${where}: tasks`).toEqual(byId(fresh.tasks));
    expect(byId(device.rows.notes.values()), `${where}: notes`).toEqual(byId(fresh.notes));
    for (const list of device.rows.lists.values()) {
      expect(list.owner === device.userId || list.shared, `${where}: holds the private list ${list.id}`).toBe(true);
    }
    for (const task of device.rows.tasks.values()) {
      expect(visible(world.db, device.userId, task.listId), `${where}: holds the task ${task.id} of a private list`).toBe(true);
    }
    for (const note of device.rows.notes.values()) {
      expect(visibleNote(world.db, device.userId, note.id), `${where}: holds the private note ${note.id}`).toBe(true);
    }
  }
  // The run did real work: many ops, and each person got lists and notes of the other person.
  expect(world.work.acked, `seed ${world.seed}`).toBeGreaterThan(100);
  expect(world.work.fromOther, `seed ${world.seed}`).toBeGreaterThan(0);
  expect(world.work.notesFromOther, `seed ${world.seed}`).toBeGreaterThan(0);
}

function makeDevices(input: { random: Random; seed: number; users: { id: ID; name: string }[] }): Device[] {
  const { random, seed } = input;
  return input.users.flatMap((user, u) =>
    ['phone', 'laptop'].map((kind, d) => {
      // Each clock is wrong by up to 20 seconds. In some runs one clock is 2 minutes ahead, which
      // is more than the server accepts.
      const far = seed % 4 === 0 && u === 0 && d === 1;
      return {
        name: `${user.name} ${kind}`,
        userId: user.id,
        clientId: `client-${u}${d}`,
        rows: emptyRows(),
        outbox: [],
        inFlight: new Set<ID>(),
        since: 0,
        clock: hlc.makeClock(`dev${u}${d}0`),
        skew: far ? 120_000 : random.int(40_000) - 20_000,
        deletedLists: [],
        deletedTasks: [],
        deletedNotes: [],
      };
    }),
  );
}

describe('convergence', () => {
  const seeds = Array.from({ length: 40 }, (_, i) => i + 1);
  const total = { rejected: 0, resets: 0 };

  test.each(seeds)('all devices hold the rows of the server at the end (seed %i)', async (seed) => {
    const random = makeRandom(seed);
    const db = openDb(':memory:');
    try {
      const password = { hash: Buffer.alloc(32), salt: Buffer.alloc(16) };
      const users = ['Alex', 'Sam'].map((name, i) => insertUser({ db, name, password, now: START + i }));
      const direct = (userId: ID, request: SyncRequest): SyncResponse => {
        // The request and the answer go through JSON, as they do on the network.
        const result = runSync({
          db,
          userId,
          request: parseSyncRequest(JSON.parse(JSON.stringify(request)) as Record<string, unknown>),
          now: world.time,
          onError: (error) => {
            throw error;
          },
        });
        return JSON.parse(JSON.stringify(result.response)) as SyncResponse;
      };
      const world: World = {
        seed,
        random,
        db,
        time: START + 1000,
        devices: makeDevices({ random, seed, users }),
        known: new Map(users.map((u) => [u.id, new Set<ID>()])),
        serial: 0,
        work: { acked: 0, rejected: 0, fromOther: 0, notesFromOther: 0, resets: 0 },
        send: async (device, request) => direct(device.userId, request),
        fresh: async (userId) => direct(userId, { clientId: 'fresh', since: 0, ops: [], tz: 'UTC' }),
        prune: () => pruneTombstones({ db, now: world.time }),
      };
      await run(world);
      total.rejected += world.work.rejected;
      total.resets += world.work.resets;
    } finally {
      db.close();
    }
  });

  test('the runs had rejected ops, and devices that started again after a reset', () => {
    expect(total.resets).toBeGreaterThan(10);
    expect(total.rejected).toBeGreaterThan(300);
  });

  describe('through HTTP', () => {
    let server: TestServer | null = null;
    afterAll(() => server?.stop());

    test('the same result with the real route', async () => {
      // A multiple of 3, so the run has the cleanup.
      const seed = 1002;
      const random = makeRandom(seed);
      let time = START;
      server = await startTestServer({ name: 'converge', options: { now: () => time } });
      const kit = makeKit(server, () => time);
      const people = [await kit.register('Alex'), await kit.register('Sam')];
      const cookies = new Map<string, string>();
      const world: World = {
        seed,
        random,
        db: server.app.db,
        get time() {
          return time;
        },
        set time(value) {
          time = value;
        },
        devices: makeDevices({ random, seed, users: people.map((p) => p.user) }),
        known: new Map(people.map((p) => [p.user.id, new Set<ID>()])),
        serial: 0,
        work: { acked: 0, rejected: 0, fromOther: 0, notesFromOther: 0, resets: 0 },
        async send(device, request) {
          const reply = await kit.call<SyncResponse>({ path: '/api/sync', body: request, cookie: cookies.get(device.name) });
          expect(reply.status).toBe(200);
          return reply.data;
        },
        async fresh(userId) {
          const person = people.find((p) => p.user.id === userId)!;
          return (await person.call<SyncResponse>('/api/sync', { clientId: 'fresh', since: 0, ops: [], tz: 'UTC' })).data;
        },
        prune: () => server!.maintain(),
      };
      // Each device has its own session.
      for (const device of world.devices) {
        const person = people.find((p) => p.user.id === device.userId)!;
        cookies.set(device.name, (await kit.login(person.user.name)).cookie);
      }
      await run(world);
    });
  });
});
