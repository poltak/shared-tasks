// Helpers for the tests of the data layer: a device with its own storage, clock, and network
// switch, a small stand-in for the server, and the real server as a child process.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { defaultNote } from '../../../shared/merge.ts';
import { LIMITS, NOTE_COLORS } from '../../../shared/types.ts';
import type { ID, ListRow, MeResponse, NoteFields, NoteRow, Op, SyncAnswer, User } from '../../../shared/types.ts';
import type { Env, PushEnv, Signal, Theme } from './env.ts';
import { eventStreamOver } from './events.ts';
import { createDataLayer } from './layer.svelte.ts';
import type { DataLayer } from './layer.svelte.ts';
import { memoryKeyValue, memoryStorage } from './storage.ts';
import type { KeyValue, MemoryStorage } from './storage.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');

/** Lets each promise that is ready now run to its end. */
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Waits until the test gives true. Throws after the time limit. */
export async function waitFor(test: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error(`waitFor: no result after ${ms} ms for ${test}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---- A clock that a test moves ----

export interface FakeClock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Moves the time and runs each timer that is due, in the order of their times. */
  advance(ms: number): Promise<void>;
  /** The number of timers that wait. */
  waiting(): number;
}

export function fakeClock(start: number = new Date(2026, 9, 6, 10, 0, 0).getTime()): FakeClock {
  let now = start;
  let serial = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    setTimeout(run, ms) {
      timers.set(++serial, { at: now + Math.max(0, ms), run });
      return serial;
    },
    clearTimeout: (handle) => void timers.delete(handle as number),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await settle();
        let next: [number, { at: number; run: () => void }] | undefined;
        for (const entry of timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].run();
      }
      now = end;
      await settle();
    },
    waiting: () => timers.size,
  };
}

// ---- A stand-in for the server, for tests of the local logic ----

export interface StubSync {
  clientId: ID;
  since: number;
  ops: Op[];
  /** The length of the request body. */
  chars: number;
}

/** A note on the stand-in server. The row has the shared fields. */
export interface StubNote {
  row: NoteRow;
  /** The revision of the last change of a shared field. */
  rev: number;
  /** The per-person fields of each person. */
  users: Map<ID, { pinned: boolean; archived: boolean }>;
  /** The revision of the last change of the per-person fields of each person. */
  userRevs: Map<ID, number>;
  /** The revision at which each person stopped seeing the note. Only these people get its id in `gone`. */
  lost: Map<ID, number>;
}

export interface StubServer {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  me: User;
  /** The second account. It has no device: a test makes its changes with `putNote`. */
  other: User;
  /** The list that the first sync of a device gets. */
  list: ListRow;
  notes: Map<ID, StubNote>;
  /**
   * true: the server is from before notes. It refuses each note op, and its answers have no
   * `notes` and no `gone.notes`.
   */
  legacy: boolean;
  /** Applies a note put of a person with the rules of SPEC.md section 4. true: the put was permitted. */
  putNote(input: { user: ID; id: ID; fields: NoteFields }): boolean;
  /** The note as the person sees it, or null if the person cannot see it. */
  noteFor(input: { user: ID; id: ID }): NoteRow | null;
  /** Each request, for example 'POST /api/sync'. */
  calls: string[];
  /** The body of each request that had one, by path. The last one wins. */
  bodies: Record<string, unknown>;
  syncs: StubSync[];
  /** false: no person is signed in, and a route that needs a session answers 401. */
  session: boolean;
  /** A status: each request gets it. 0: each request fails as with no network. */
  down: number | null;
  /** Can change the answer of a sync before it goes out. */
  onSync: ((request: StubSync, response: SyncAnswer) => void) | null;
}

const NOTE_SHARED_FIELDS = ['title', 'body', 'color', 'shared', 'editedAt', 'editedBy', 'deleted'] as const;
const NOTE_OWNER_FIELDS: readonly string[] = ['shared', 'deleted'];

const isBool = (value: unknown): boolean => typeof value === 'boolean';
const isText = (value: unknown): boolean => typeof value === 'string';
const isStamp = (value: unknown): boolean => typeof value === 'number' && value >= 0 && value <= 8.64e15;
const isIdValue = (value: unknown): boolean => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);

/** The checks of the real server (server/sync.ts) for each field of a note op. */
const NOTE_CHECKS: Record<keyof NoteFields, (value: unknown) => boolean> = {
  title: isText,
  body: isText,
  color: (value) => (NOTE_COLORS as readonly unknown[]).includes(value),
  shared: isBool,
  editedAt: isStamp,
  editedBy: (value) => value === null || isIdValue(value),
  deleted: isBool,
  owner: isIdValue,
  createdAt: isStamp,
  pinned: isBool,
  archived: isBool,
};

/** Cuts as the server does: half of a character pair at the end would be invalid text. */
function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * The fields of a note op as the server keeps them, or null if a field has a wrong value: the
 * server then refuses the full op. It cuts a text that is too long, and ignores an unknown field.
 */
function cleanNoteFields(fields: unknown): NoteFields | null {
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return null;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const check = NOTE_CHECKS[key as keyof NoteFields] as ((value: unknown) => boolean) | undefined;
    if (!check) continue;
    if (!check(value)) return null;
    clean[key] = key === 'title' || key === 'body' ? cutText(value as string, LIMITS[key === 'title' ? 'noteTitle' : 'noteBody']) : value;
  }
  for (const key of ['editedAt', 'createdAt']) if (typeof clean[key] === 'number') clean[key] = Math.round(clean[key]);
  return clean as NoteFields;
}

/**
 * Answers as a server with one account and one list. It accepts each list and task op, and it
 * sends no list or task rows back after the first sync of a device: the tests of the local logic
 * do not need more. Notes follow the rules of the real server: the owner, the visibility, the
 * values, the per-person fields, and the rows and `gone` ids after `since`. Only the field
 * timestamps are missing: a later op wins for each field it has.
 */
export function stubServer(now: () => number = Date.now): StubServer {
  const me: User = { id: 'user-1', name: 'Alex' };
  const other: User = { id: 'user-2', name: 'Sam' };
  const list: ListRow = {
    id: 'list-1',
    title: 'My Tasks',
    owner: me.id,
    shared: false,
    isDefault: true,
    createdAt: 1,
    deleted: false,
    pos: 'a0',
    sort: 'my',
    hidden: false,
  };
  let rev = 1;
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const info = (): MeResponse => ({
    me: stub.session ? me : null,
    users: stub.session ? [me, other] : [],
    canRegister: false,
    vapidPublicKey: 'stub-key',
    version: '1.2.3',
  });
  const sees = (note: StubNote, user: ID): boolean => !note.row.deleted && (note.row.owner === user || note.row.shared);

  /** One op. A change of a value gives one new revision, as on the server. */
  function applyNote({ user, id, fields }: { user: ID; id: ID; fields: unknown }): boolean {
    const clean = cleanNoteFields(fields);
    if (!clean) return false;
    let note = stub.notes.get(id);
    let made = false;
    let shared: Record<string, unknown> = {};
    for (const key of NOTE_SHARED_FIELDS) if (clean[key] !== undefined) shared[key] = clean[key];
    if (!note) {
      // Only the put that makes a note has createdAt.
      if (clean.createdAt === undefined) return false;
      const row: NoteRow = { ...defaultNote(id), editedAt: clean.createdAt, owner: user, createdAt: clean.createdAt };
      note = { row, rev: 0, users: new Map(), userRevs: new Map(), lost: new Map() };
      stub.notes.set(id, note);
      made = true;
    } else if (note.row.owner !== user) {
      if (!note.row.shared) return false;
      // Only the owner changes these. A value equal to the stored one is no change.
      const row = note.row as unknown as Record<string, unknown>;
      if (NOTE_OWNER_FIELDS.some((key) => key in shared && shared[key] !== row[key])) return false;
      shared = Object.fromEntries(Object.entries(shared).filter(([key]) => !NOTE_OWNER_FIELDS.includes(key)));
    }
    const old = note.row as unknown as Record<string, unknown>;
    const sharedChange = made || Object.entries(shared).some(([key, value]) => old[key] !== value);
    const mine = note.users.get(user) ?? { pinned: false, archived: false };
    const next = { pinned: clean.pinned ?? mine.pinned, archived: clean.archived ?? mine.archived };
    const userChange = next.pinned !== mine.pinned || next.archived !== mine.archived;
    if (!sharedChange && !userChange) return true;
    rev += 1;
    if (sharedChange) {
      note.row = { ...note.row, ...(shared as Partial<NoteRow>) };
      note.rev = rev;
    }
    if (userChange) {
      note.users.set(user, next);
      note.userRevs.set(user, rev);
    }
    return true;
  }

  /**
   * The note ops of one request of a person. A person who could see a note at the start of the
   * request and cannot see it at the end gets a `gone` mark. So a person who never saw a note
   * never gets its id, as on the server.
   */
  function applyNotes({ user, puts }: { user: ID; puts: { id: ID; fields: unknown }[] }): boolean[] {
    const people = [me.id, other.id];
    const before = new Map<ID, ID[]>();
    for (const { id } of puts) {
      const note = stub.notes.get(id);
      if (!before.has(id)) before.set(id, note ? people.filter((person) => sees(note, person)) : []);
    }
    const results = puts.map((put) => applyNote({ user, ...put }));
    for (const [id, saw] of before) {
      const note = stub.notes.get(id);
      for (const person of saw) if (note && !sees(note, person)) note.lost.set(person, rev);
    }
    return results;
  }

  function putNote({ user, id, fields }: { user: ID; id: ID; fields: NoteFields }): boolean {
    return applyNotes({ user, puts: [{ id, fields }] })[0]!;
  }

  function noteFor({ user, id }: { user: ID; id: ID }): NoteRow | null {
    const note = stub.notes.get(id);
    if (!note || !sees(note, user)) return null;
    return { ...note.row, ...(note.users.get(user) ?? { pinned: false, archived: false }) };
  }

  const stub: StubServer = {
    me,
    other,
    list,
    notes: new Map(),
    legacy: false,
    putNote,
    noteFor,
    calls: [],
    bodies: {},
    syncs: [],
    session: true,
    down: null,
    onSync: null,
    async fetch(route, init) {
      stub.calls.push(`${init?.method ?? 'GET'} ${route}`);
      const text = typeof init?.body === 'string' ? init.body : null;
      const body = text === null ? null : (JSON.parse(text) as Record<string, unknown>);
      if (body) stub.bodies[route] = body;
      if (stub.down === 0) throw new TypeError('fetch failed');
      if (stub.down !== null) return json({ error: { code: 'server', message: 'Internal error' } }, stub.down);
      if (route === '/api/me') return json(info());
      if (route === '/api/login' || route === '/api/register') {
        if (body?.password !== 'password-of-alex') {
          return json({ error: { code: 'unauthorized', message: 'The name or the password is wrong' } }, 401);
        }
        stub.session = true;
        return json(info());
      }
      if (route === '/api/logout') {
        stub.session = false;
        return json({ ok: true });
      }
      if (!stub.session) return json({ error: { code: 'unauthorized', message: 'Sign in first' } }, 401);
      if (route === '/api/profile') {
        me.name = String(body?.name);
        return json(info());
      }
      if (route === '/api/push/test') return json({ sent: 1, failed: 0 });
      if (route !== '/api/sync') return json({ ok: true });

      const request = { ...(body as unknown as Omit<StubSync, 'chars'>), chars: text!.length };
      stub.syncs.push(request);
      const { since } = request;
      const acked: ID[] = [];
      const rejected: ID[] = [];
      const noteOps = stub.legacy ? [] : request.ops.filter((op) => op.kind === 'note');
      const results = applyNotes({ user: me.id, puts: noteOps });
      const okNote = new Map(noteOps.map((op, i) => [op.opId, results[i]!]));
      // A server from before notes does not know the kind, so it refuses each note op.
      for (const op of request.ops) (op.kind !== 'note' || okNote.get(op.opId) ? acked : rejected).push(op.opId);
      // The device applied each of its ops. For a refused op and for a note that the person cannot
      // see now (a delete), the device gets the true row or the id in `gone`, also for `since: 0`.
      const stale = new Set(noteOps.filter((op) => !okNote.get(op.opId) || !noteFor({ user: me.id, id: op.id })).map((op) => op.id));
      if (request.ops.length > 0) rev += 1;
      const response: SyncAnswer = {
        rev,
        reset: false,
        lists: since === 0 ? [list] : [],
        tasks: [],
        gone: { lists: [], tasks: [] },
        acked,
        rejected,
        now: now(),
      };
      if (!stub.legacy) {
        const notes: NoteRow[] = [];
        const gone: ID[] = [];
        for (const note of stub.notes.values()) {
          const row = noteFor({ user: me.id, id: note.row.id });
          const changed = since === 0 || note.rev > since || (note.userRevs.get(me.id) ?? 0) > since;
          if (row && (changed || stale.has(note.row.id))) notes.push(row);
          else if (!row && since !== 0 && (note.lost.get(me.id) ?? 0) > since) gone.push(note.row.id);
        }
        for (const id of stale) {
          if (!noteFor({ user: me.id, id }) && !gone.includes(id)) gone.push(id);
        }
        response.notes = notes;
        response.gone.notes = gone;
      }
      stub.onSync?.(request, response);
      return json(response);
    },
  };
  return stub;
}

// ---- A device ----

/** What the tabs of one browser share: the databases, localStorage, the cookie, and the channel. */
export interface Browser {
  storage: MemoryStorage;
  kv: KeyValue;
  cookie: string;
  tabs: Set<(message: unknown) => void>;
}

export const makeBrowser = (): Browser => ({ storage: memoryStorage(), kv: memoryKeyValue(), cookie: '', tabs: new Set() });

export interface Device {
  env: Env;
  layer: DataLayer;
  browser: Browser;
  /** false: each request fails and the event stream ends, as with no network. */
  setOnline(online: boolean): void;
  setVisible(visible: boolean): void;
  /** Requests wait until release(). */
  hold(): void;
  release(): void;
  /** The path of each request that the layer started. */
  requests: string[];
  /** The path of each request that got an answer. */
  answered: string[];
  /** The delay of each timer that the layer asked for. */
  delays: number[];
  theme: Theme | null;
}

export function makeDevice(input: {
  /** The address of the real server, or a stand-in. */
  server: string | StubServer;
  /** The same browser again: a second tab, or the device after a restart. */
  browser?: Browser;
  /** Without it the device uses real time and real timers. */
  clock?: FakeClock;
  /** Real timers run this many times faster. The layer still asks for the true delays. */
  speed?: number;
  locale?: string;
  push?: PushEnv;
}): Device {
  const { server, clock, speed = 1 } = input;
  const browser = input.browser ?? makeBrowser();
  let online = true;
  let visible = true;
  let gate: Promise<void> | null = null;
  let openGate: (() => void) | null = null;
  const listeners = new Set<(signal: Signal) => void>();
  const open = new Set<AbortController>();
  const emit = (signal: Signal): void => listeners.forEach((listener) => listener(signal));

  const io = {
    async fetch(route: string, init: RequestInit = {}): Promise<Response> {
      device.requests.push(route);
      if (!online) throw new TypeError('fetch failed');
      if (gate) await gate;
      const cut = new AbortController();
      open.add(cut);
      const headers = new Headers(init.headers);
      if (browser.cookie) headers.set('Cookie', browser.cookie);
      const signal = init.signal ? AbortSignal.any([init.signal, cut.signal]) : cut.signal;
      try {
        const response =
          typeof server === 'string' ? await fetch(server + route, { ...init, headers, signal }) : await server.fetch(route, init);
        // A cookie with no value is the sign-out.
        for (const line of response.headers.getSetCookie()) {
          const pair = line.split(';')[0]!;
          browser.cookie = pair.endsWith('=') ? '' : pair;
        }
        device.answered.push(route);
        return response;
      } finally {
        // An event stream stays in `open` through its fetch only. Its body ends with the signal.
        if (!route.startsWith('/api/events')) open.delete(cut);
      }
    },
    setTimeout(run: () => void, ms: number): unknown {
      device.delays.push(ms);
      return clock ? clock.setTimeout(run, ms) : setTimeout(run, ms / speed);
    },
    clearTimeout(handle: unknown): void {
      if (clock) clock.clearTimeout(handle);
      else clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };

  const env: Env = {
    ...io,
    storage: browser.storage,
    kv: browser.kv,
    // The stand-in has no event stream.
    openEvents: typeof server === 'string' ? eventStreamOver(io) : () => ({ close: () => undefined }),
    now: clock ? clock.now : () => Date.now(),
    locale: input.locale ?? 'en-GB',
    timeZone: 'Europe/Berlin',
    online: () => online,
    visible: () => visible,
    listen(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    channel({ onMessage }) {
      browser.tabs.add(onMessage);
      return {
        // A real channel delivers later, and not to the tab that sent the message.
        post: (message) => void setImmediate(() => browser.tabs.forEach((tab) => tab !== onMessage && tab(message))),
        close: () => void browser.tabs.delete(onMessage),
      };
    },
    setTheme: (theme) => void (device.theme = theme),
    push: input.push ?? null,
  };

  const device: Device = {
    env,
    layer: undefined as unknown as DataLayer,
    browser,
    setOnline(next) {
      if (online === next) return;
      online = next;
      if (!next) {
        for (const cut of open) cut.abort();
        open.clear();
      }
      emit(next ? 'online' : 'offline');
    },
    setVisible(next) {
      if (visible === next) return;
      visible = next;
      emit(next ? 'visible' : 'hidden');
    },
    hold() {
      gate ??= new Promise((resolve) => (openGate = resolve));
    },
    release() {
      openGate?.();
      gate = openGate = null;
    },
    requests: [],
    answered: [],
    delays: [],
    theme: null,
  };
  device.layer = createDataLayer(env);
  return device;
}

// ---- The real server ----

export interface ServerProcess {
  url: string;
  /** Stops the process. The data stays. */
  stop(): Promise<void>;
  /** Starts the process again on the same port and the same data. */
  start(): Promise<void>;
  /** Stops the process and removes its folder. */
  remove(): Promise<void>;
}

/** Starts `node server/main.ts` on a free port with a new data folder under .tmp/. */
export async function startServerProcess(name: string): Promise<ServerProcess> {
  const dir = path.join(ROOT, '.tmp', `data-${name}-${process.pid}-${Date.now().toString(36)}`);
  mkdirSync(path.join(dir, 'web'), { recursive: true });
  let child: ChildProcess | null = null;
  let port = 0;

  async function start(): Promise<void> {
    const errors: string[] = [];
    const started = spawn(process.execPath, ['server/main.ts'], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        HOST: '127.0.0.1',
        // 0: the system gives a free port. The next start uses the same one.
        PORT: String(port),
        DATA_DIR: path.join(dir, 'data'),
        WEB_DIR: path.join(dir, 'web'),
        NODE_NO_WARNINGS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = started;
    started.stderr!.on('data', (chunk: Buffer) => errors.push(chunk.toString()));
    port = await new Promise<number>((resolve, reject) => {
      let text = '';
      started.stdout!.on('data', (chunk: Buffer) => {
        text += chunk.toString();
        const match = /listens on http:\/\/127\.0\.0\.1:(\d+)/.exec(text);
        if (match) resolve(Number(match[1]));
      });
      started.once('exit', (code) => reject(new Error(`The server stopped with code ${code}: ${errors.join('')}`)));
    });
  }

  async function stop(): Promise<void> {
    const old = child;
    child = null;
    if (!old || old.exitCode !== null) return;
    await new Promise((resolve) => {
      old.once('exit', resolve);
      old.kill('SIGTERM');
    });
  }

  await start();
  return {
    url: `http://127.0.0.1:${port}`,
    stop,
    start,
    async remove() {
      await stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The ids of the accounts that have a local database in the browser. */
export const accountsOf = (browser: Browser): ID[] => browser.storage.accounts();
