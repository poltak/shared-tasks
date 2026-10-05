import { untrack } from 'svelte';
import * as shared from '../../../shared/actions.ts';
import type { ActionContext } from '../../../shared/actions.ts';
import { addDays, toJsDate, todayOf } from '../../../shared/dates.ts';
import * as hlc from '../../../shared/hlc.ts';
import { newId } from '../../../shared/ids.ts';
import { applyPut, emptyRows } from '../../../shared/merge.ts';
import { LIMITS } from '../../../shared/types.ts';
import type {
  ActionResult,
  ApiError,
  DateStr,
  ID,
  MeResponse,
  Op,
  Put,
  SyncResponse,
  User,
} from '../../../shared/types.ts';
import type { Channel, Env, PokeStream, Signal } from './env.ts';
import { createOutbox } from './outbox.ts';
import { createPrefs } from './prefs.svelte.ts';
import { createPush } from './push.svelte.ts';
import { createRowStore } from './rows.svelte.ts';
import type { Changed, RowChanges } from './rows.svelte.ts';
import { memoryStorage } from './storage.ts';
import type { Snapshot, Storage, WriteBatch } from './storage.ts';
import { createToast } from './toast.svelte.ts';

export type SessionStatus = 'loading' | 'signedOut' | 'signedIn';
export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error';
/** `message` is a text for the person. */
export type Result = { ok: true } | { ok: false; message: string };

/** One function for each function of shared/actions.ts, with the intent as its only input. */
export type Actions = {
  [Name in keyof typeof shared]: (intent: Parameters<(typeof shared)[Name]>[1]) => ActionResult;
};

export type DataLayer = ReturnType<typeof createDataLayer>;

/** The last answer of /api/me. A start with no network reads the account from it. */
const SESSION_KEY = 'st.session';
/** Set while a sign-out did not reach the server. */
const LOGOUT_KEY = 'st.logout';
const CHANNEL = 'st';

const ACTION_DELAY_MS = 50;
const TEXT_DELAY_MS = 800;
const POLL_MS = 60_000;
const RETRY_MAX_MS = 60_000;
const SYNC_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 15_000;
/** How long a device with no rows waits for its first rows before it shows the empty app. */
const FIRST_SYNC_WAIT_MS = 8000;
/** How long the start waits for the local database before it goes on without one. */
const LOCAL_DB_WAIT_MS = 5000;
/** How long a sign-out waits for the last changes to reach the server. */
const LAST_SYNC_WAIT_MS = 4000;
const UNDO_MAX = 50;
/** Text changes of one task that are closer together than this are one undo step. */
const TYPING_MS = 3000;
/** A character is 3 bytes at most, so a body of this length is below the 5 MB limit of the server. */
const MAX_BODY_CHARS = 1_500_000;
/** A browser sends 64 KiB at most in requests that can continue after the page closes. */
const KEEPALIVE_MAX_CHARS = 20_000;
/** The clock difference to the server is stored again only if it moved by more than this. */
const CLOCK_SLACK_MS = 250;
const NO_NETWORK = 'No connection to the server. Try again';

const NOTHING: ActionResult = { puts: [], undo: [], message: null };

interface Reply<T> {
  /** The HTTP status. 0: no answer. */
  status: number;
  data: T | null;
  /** The error text for a person. '' if the request was ok. */
  message: string;
}

/** The rows that the local database must write. */
interface Dirt {
  clear: boolean;
  lists: Set<ID>;
  tasks: Set<ID>;
  /** null: the op is not in the outbox now. */
  ops: Map<ID, Op | null>;
  meta: Record<string, unknown>;
}

const noDirt = (): Dirt => ({ clear: false, lists: new Set(), tasks: new Set(), ops: new Map(), meta: {} });

/** The state of the account that is open on this device. */
interface Account {
  userId: ID;
  storage: Storage;
  clientId: ID;
  clock: hlc.Clock;
  /** The revision of the last answer of the server. */
  since: number;
  /** Server time minus device time. */
  offset: number;
  dirt: Dirt;
  flushTimer: unknown;
  /** Ends when the last write to the local database ends. */
  writing: Promise<void>;
  /** The time of the last sync that is in the local database. */
  syncedAtSaved: number;
}

interface UndoEntry {
  puts: Put[];
  /** Set for a text change: the next text change of the same task goes into this entry. */
  key: string | null;
  at: number;
}

type Entered = MeResponse & { me: User };

const fail = (message: string): Result => ({ ok: false, message });
const backoff = (failures: number): number => Math.min(RETRY_MAX_MS, 1000 * 2 ** (failures - 1));
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * The data layer: the session, the rows in memory, the local database, the outbox, and the sync
 * with the server. All that it needs from the browser comes through `env`, so it runs in a test
 * in Node.js too. Call `start()` one time.
 */
export function createDataLayer(env: Env) {
  let status = $state<SessionStatus>('loading');
  let me = $state.raw<User | null>(null);
  let users = $state.raw<User[]>([]);
  let canRegister = $state(false);
  let version = $state('');
  let today = $state<DateStr>(todayOf(env.now()));
  let syncStatus = $state<SyncStatus>('idle');
  let pending = $state(0);
  let lastSyncedAt = $state<number | null>(null);
  let undoCount = $state(0);
  let vapidKey = '';

  const toast = createToast(env);
  const prefs = createPrefs(env);
  const store = createRowStore({ locale: env.locale, today: () => today, starredSort: () => prefs.starredSort });
  const outbox = createOutbox();

  let account: Account | null = null;
  let undoStack: UndoEntry[] = [];

  // ---- Requests ----

  async function call<T>({
    path,
    body,
    timeout = CALL_TIMEOUT_MS,
    keepalive = false,
  }: {
    path: string;
    /** With a body the request is a POST. Text goes out as it is. */
    body?: unknown;
    timeout?: number;
    keepalive?: boolean;
  }): Promise<Reply<T>> {
    const abort = new AbortController();
    const timer = env.setTimeout(() => abort.abort(), timeout);
    try {
      const response = await env.fetch(
        path,
        body === undefined
          ? { signal: abort.signal }
          : {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: typeof body === 'string' ? body : JSON.stringify(body),
              signal: abort.signal,
              keepalive,
            },
      );
      const data = (await response.json().catch(() => null)) as (T & Partial<ApiError>) | null;
      if (response.ok && data !== null) return { status: response.status, data, message: '' };
      // An answer that is ok but not JSON comes from something between the device and the server.
      const status = response.ok ? 502 : response.status;
      return { status, data: null, message: data?.error?.message ?? `The server answered with the error ${status}` };
    } catch {
      return { status: 0, data: null, message: NO_NETWORK };
    } finally {
      env.clearTimeout(timer);
    }
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => env.setTimeout(resolve, ms));

  const push = createPush({
    device: env.push,
    post: (path, body) => call({ path, body }),
    vapidKey: () => vapidKey,
  });

  // ---- Local database ----

  function warnStorage(error: unknown): void {
    console.warn('Shared Tasks: the local database refused a write', error);
  }

  function flush(acc: Account): Promise<void> {
    env.clearTimeout(acc.flushTimer);
    acc.flushTimer = null;
    // The rows in memory are the rows of the open account only.
    if (acc !== account) return acc.writing;
    const dirt = acc.dirt;
    const batch: WriteBatch = {
      clear: dirt.clear,
      lists: [],
      listsGone: [],
      tasks: [],
      tasksGone: [],
      ops: [],
      opsGone: [],
      meta: dirt.meta,
    };
    for (const id of dirt.lists) {
      const row = store.rows.lists.get(id);
      if (row) batch.lists.push(row);
      else batch.listsGone.push(id);
    }
    for (const id of dirt.tasks) {
      const row = store.rows.tasks.get(id);
      if (row) batch.tasks.push(row);
      else batch.tasksGone.push(id);
    }
    for (const [id, op] of dirt.ops) {
      if (op) batch.ops.push(op);
      else batch.opsGone.push(id);
    }
    const empty =
      !dirt.clear && dirt.lists.size === 0 && dirt.tasks.size === 0 && dirt.ops.size === 0 && Object.keys(dirt.meta).length === 0;
    acc.dirt = noDirt();
    // One write after the other: a later batch must not arrive before an earlier one.
    if (!empty) acc.writing = acc.writing.then(() => acc.storage.write(batch)).catch(warnStorage);
    return acc.writing;
  }

  /** One transaction for all changes of this tick. The timer lets the screen go first. */
  function flushSoon(acc: Account): void {
    acc.flushTimer ??= env.setTimeout(() => void flush(acc), 0);
  }

  function mark(acc: Account, changed: Changed): void {
    for (const id of changed.lists) acc.dirt.lists.add(id);
    for (const id of changed.tasks) acc.dirt.tasks.add(id);
  }

  // ---- Local changes ----

  /** The time for timestamps and for date fields: the clock of the device, moved to the clock of the server. */
  const clockNow = (acc: Account): number => env.now() + acc.offset;

  /** Applies puts to the rows now and puts them into the outbox. */
  function commit(acc: Account, puts: readonly Put[]): void {
    const { applied, changed } = store.apply(puts);
    if (applied.length === 0) return;
    for (const put of applied) {
      const op = outbox.add({ put, ts: hlc.tick(acc.clock, clockNow(acc)), opId: newId() });
      acc.dirt.ops.set(op.opId, op);
    }
    mark(acc, changed);
    // The clock is stored, so a timestamp after a restart is later than each one before it.
    acc.dirt.meta.clock = { ms: acc.clock.ms, counter: acc.clock.counter };
    pending = outbox.size;
    flushSoon(acc);
  }

  function record(puts: Put[], key: string | null): void {
    const at = env.now();
    const top = undoStack.at(-1);
    if (key !== null && top?.key === key && at - top.at < TYPING_MS) {
      // One undo step for a burst of typing. The values from before the first key stay.
      const old = new Map(top.puts.map((put) => [put.id, put]));
      for (const put of puts) {
        const first = old.get(put.id);
        old.set(put.id, (first ? { ...first, fields: { ...put.fields, ...first.fields } } : put) as Put);
      }
      top.puts = [...old.values()];
      top.at = at;
      return;
    }
    undoStack.push({ puts, key, at });
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    undoCount = undoStack.length;
  }

  type Run = (ctx: ActionContext, intent: never) => ActionResult;

  function perform(name: string, intent: { id?: ID }): ActionResult {
    // An action can run in an effect of the screen. It must not make that effect depend on the
    // state that it reads here.
    return untrack(() => {
      const acc = account;
      if (!acc || !me) return NOTHING;
      const ctx: ActionContext = { rows: store.rows, now: clockNow(acc), today, me: me.id, locale: env.locale };
      const result = (shared[name as keyof typeof shared] as Run)(ctx, intent as never);
      if (result.puts.length === 0) return result;
      commit(acc, result.puts);
      const typing = name === 'updateTask' && Object.keys(intent).every((key) => key === 'id' || key === 'title' || key === 'notes');
      record(result.undo, typing ? `text:${intent.id}` : null);
      if (result.message) toast.show({ message: result.message, undoable: true });
      // "Undo" on the snackbar takes back the last action. A message of an older action must go.
      else if (toast.current?.undoable) toast.dismiss();
      plan(typing ? TEXT_DELAY_MS : ACTION_DELAY_MS, typing ? 'text' : 'action');
      return result;
    });
  }

  const actions = {} as Actions;
  for (const name of Object.keys(shared)) {
    (actions as Record<string, unknown>)[name] = (intent: { id?: ID }) => perform(name, intent);
  }

  /**
   * true if the action would change a row now. It does not do the action. A menu uses it to show
   * or to disable an entry. A reader runs again after each change of a row.
   */
  function can<Name extends keyof Actions>(name: Name, intent: Parameters<Actions[Name]>[0]): boolean {
    const acc = account;
    if (!acc || !me) return false;
    store.watchAll();
    const ctx: ActionContext = { rows: store.rows, now: clockNow(acc), today, me: me.id, locale: env.locale };
    return (shared[name] as Run)(ctx, intent as never).puts.length > 0;
  }

  function undo(): boolean {
    return untrack(() => {
      const acc = account;
      const entry = acc && undoStack.pop();
      if (!acc || !entry) return false;
      undoCount = undoStack.length;
      commit(acc, entry.puts);
      toast.dismiss();
      plan(ACTION_DELAY_MS, 'action');
      return true;
    });
  }

  // ---- Sync ----

  type PlanKind = 'action' | 'text' | 'retry' | 'poll';
  let timer: unknown = null;
  let timerAt = 0;
  let timerKind: PlanKind = 'action';
  /** The round that is in flight. */
  let running: Promise<boolean> | null = null;
  /** A trigger came while a round was in flight. */
  let again = false;
  /** The body limit kept ops out of the last request. */
  let limited = false;
  /** The newest revision that a poke named. */
  let wantRev = 0;
  let failures = 0;

  let stream: PokeStream | null = null;
  let streamUp = false;
  let streamFailures = 0;
  let streamTimer: unknown = null;
  let channel: Channel | null = null;

  function clearPlan(): void {
    env.clearTimeout(timer);
    timer = null;
  }

  /** Plans a sync. One timer: the earlier time stays, but typing moves a typing timer to a later time. */
  function plan(ms: number, kind: PlanKind): void {
    if (!account) return;
    const at = env.now() + ms;
    if (timer !== null) {
      // After a failure only the retry timer decides. An action must not start one more request
      // to a server that does not answer.
      if (timerKind === 'retry' && kind !== 'retry') return;
      if (!(kind === 'text' && timerKind === 'text') && at >= timerAt) return;
      env.clearTimeout(timer);
    }
    timerAt = at;
    timerKind = kind;
    timer = env.setTimeout(() => {
      timer = null;
      void syncNow();
    }, ms);
  }

  /** Writes the answer of the server into the rows, the outbox, and the local database. */
  function receive({ acc, response, sentAt }: { acc: Account; response: SyncResponse; sentAt: number }): void {
    const answered = new Set(outbox.remove([...response.acked, ...response.rejected]));
    for (const id of answered) acc.dirt.ops.set(id, null);
    // A server that names no op must not get the same ops again and again with no pause.
    if (answered.size === 0) limited = false;

    const changes: RowChanges = { lists: new Map(), tasks: new Map() };
    if (response.reset) {
      for (const id of store.rows.lists.keys()) changes.lists.set(id, null);
      for (const id of store.rows.tasks.keys()) changes.tasks.set(id, null);
    }
    for (const row of response.lists) changes.lists.set(row.id, row);
    for (const row of response.tasks) changes.tasks.set(row.id, row);
    for (const id of response.gone.lists) changes.lists.set(id, null);
    for (const id of response.gone.tasks) changes.tasks.set(id, null);

    // The server does not have the ops that are still in the outbox. They apply again over its
    // rows, on a copy: the screen then sees only the result, and a row that ends with the
    // values that it has keeps its object.
    if (outbox.size > 0 && changes.lists.size + changes.tasks.size > 0) {
      const scratch = emptyRows();
      for (const [id, row] of changes.lists) if (row) scratch.lists.set(id, row);
      for (const [id, row] of changes.tasks) if (row) scratch.tasks.set(id, row);
      for (const op of outbox.all()) {
        if (op.kind === 'list' && changes.lists.has(op.id)) changes.lists.set(op.id, applyPut(scratch, op));
        else if (op.kind === 'task' && changes.tasks.has(op.id)) changes.tasks.set(op.id, applyPut(scratch, op));
      }
    }

    mark(acc, store.replace(changes));
    if (response.reset) {
      acc.dirt.clear = true;
      mark(acc, { lists: [...store.rows.lists.keys()], tasks: [...store.rows.tasks.keys()] });
    }

    const now = env.now();
    if (response.rev !== acc.since) {
      acc.since = response.rev;
      acc.dirt.meta.since = response.rev;
    }
    const offset = Math.round(response.now - sentAt);
    if (Math.abs(offset - acc.offset) > CLOCK_SLACK_MS) {
      acc.offset = offset;
      acc.dirt.meta.offset = offset;
    }
    // An empty sync each minute must not write to the disk each minute.
    if ('since' in acc.dirt.meta || now - acc.syncedAtSaved > POLL_MS) {
      acc.dirt.meta.syncedAt = now;
      acc.syncedAtSaved = now;
    }
    lastSyncedAt = now;
    pending = outbox.size;
    syncStatus = 'idle';
    flushSoon(acc);

    if (answered.size > 0) {
      // The other tabs of this browser have the same client id, so the server sends them no poke.
      channel?.post({ type: 'synced', user: acc.userId });
      const refused = response.rejected.filter((id) => answered.has(id)).length;
      if (refused > 0) {
        toast.show({ message: refused === 1 ? 'The server refused a change' : `The server refused ${refused} changes` });
      }
    }
  }

  /** One request. true: the server answered and the device has its rows. */
  async function once(acc: Account): Promise<boolean> {
    if (!env.online()) {
      syncStatus = 'offline';
      return false;
    }
    if (syncStatus === 'idle') syncStatus = 'syncing';

    const sent: Op[] = [];
    const texts: string[] = [];
    let size = 0;
    limited = false;
    for (const op of outbox.all()) {
      const text = JSON.stringify(op);
      if (sent.length > 0 && size + text.length > MAX_BODY_CHARS) {
        limited = true;
        break;
      }
      sent.push(op);
      texts.push(text);
      size += text.length;
    }
    outbox.freeze(sent);
    const head = JSON.stringify({ clientId: acc.clientId, since: acc.since, tz: env.timeZone });
    const body = `${head.slice(0, -1)},"ops":[${texts.join(',')}]}`;

    const startedAt = env.now();
    const reply = await call<SyncResponse>({
      path: '/api/sync',
      body,
      timeout: SYNC_TIMEOUT_MS,
      // The page closes or goes to the background: the request must continue.
      keepalive: !env.visible() && body.length <= KEEPALIVE_MAX_CHARS,
    });
    // The person signed out, or a different person signed in, while the request was open.
    if (account !== acc) return false;
    if (reply.data === null) {
      outbox.release();
      if (reply.status === 401) expire();
      else syncStatus = reply.status === 0 ? 'offline' : 'error';
      return false;
    }
    // The server read its clock near the middle of the request.
    receive({ acc, response: reply.data, sentAt: (startedAt + env.now()) / 2 });
    return true;
  }

  function afterRound(acc: Account, ok: boolean): void {
    if (account !== acc) return;
    if (ok) {
      failures = 0;
      // Without the event stream the device asks the server each minute while the person looks.
      if (!streamUp && env.visible()) plan(POLL_MS, 'poll');
      return;
    }
    // With no network the 'online' signal starts the next try. A hidden app with nothing to send
    // waits until the person comes back.
    if (!env.online() || (!env.visible() && outbox.size === 0)) return;
    failures += 1;
    plan(backoff(failures), 'retry');
  }

  /** Starts a sync, or asks the round in flight for one more request. true: the device has the rows of the server. */
  function syncNow(): Promise<boolean> {
    const acc = account;
    if (!acc) return Promise.resolve(false);
    clearPlan();
    if (running) {
      again = true;
      return running;
    }
    const round = requests(acc).then((ok) => {
      // A sign-out in the flight took the round away already.
      if (running === round) {
        running = null;
        afterRound(acc, ok);
      }
      return ok;
    });
    running = round;
    return round;
  }

  /** The requests of one round, one after the other. */
  async function requests(acc: Account): Promise<boolean> {
    let ok: boolean;
    let more: boolean;
    do {
      again = false;
      ok = await once(acc);
      // One more request: a trigger came in the flight, ops are left, or a poke named a
      // revision that the answer did not reach. A poke asks for one request only.
      more = again || limited || wantRev > acc.since;
      wantRev = 0;
    } while (ok && account === acc && more);
    return ok;
  }

  function closeStream(): void {
    env.clearTimeout(streamTimer);
    streamTimer = null;
    stream?.close();
    stream = null;
    streamUp = false;
  }

  function openStream(): void {
    const acc = account;
    if (!acc || stream || !env.visible() || !env.online()) return;
    env.clearTimeout(streamTimer);
    streamTimer = null;
    let closed = false;
    const opened = env.openEvents(`/api/events?client=${encodeURIComponent(acc.clientId)}`, {
      onOpen() {
        if (account !== acc) return;
        streamUp = true;
        streamFailures = 0;
        // The stream tells about each change from now on, so the poll is not necessary.
        if (timer !== null && timerKind === 'poll') clearPlan();
      },
      onPoke(rev) {
        if (account !== acc || rev <= acc.since) return;
        wantRev = Math.max(wantRev, rev);
        // A round in flight looks at `wantRev` when it has its answer.
        if (!running) void syncNow();
      },
      onClose(code) {
        closed = true;
        if (account !== acc) return;
        stream = null;
        streamUp = false;
        if (code === 401) return expire();
        streamFailures += 1;
        streamTimer = env.setTimeout(openStream, backoff(streamFailures));
        if (env.visible()) plan(POLL_MS, 'poll');
      },
    });
    if (!closed) stream = opened;
  }

  // ---- Session ----

  /** Session commands run one after the other: a sign-in must not mix with the check of a start. */
  let gate: Promise<unknown> = Promise.resolve();
  function exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = gate.then(run, run);
    gate = next.catch(() => undefined);
    return next;
  }

  function saved(): MeResponse | null {
    try {
      const info = JSON.parse(env.kv.get(SESSION_KEY) ?? 'null') as MeResponse | null;
      return info && Array.isArray(info.users) ? info : null;
    } catch {
      return null;
    }
  }

  function adopt(info: MeResponse): void {
    // The same values keep their objects, so no reader runs again for an answer with no news.
    if (JSON.stringify(info.me) !== JSON.stringify(me)) me = info.me;
    if (JSON.stringify(info.users) !== JSON.stringify(users)) users = info.users;
    canRegister = info.canRegister;
    version = info.version;
    vapidKey = info.vapidPublicKey;
    env.kv.set(SESSION_KEY, JSON.stringify(info));
  }

  /** Closes the account on this device. The memory is empty at once, the database follows. */
  function leave({ remove }: { remove: boolean }): Promise<void> {
    const old = account;
    if (!old) return Promise.resolve();
    clearPlan();
    closeStream();
    const last = remove ? old.writing : flush(old);
    env.clearTimeout(old.flushTimer);
    account = null;
    running = null;
    again = false;
    failures = 0;
    wantRev = 0;
    store.load({ lists: [], tasks: [] });
    outbox.load([]);
    undoStack = [];
    undoCount = 0;
    pending = 0;
    lastSyncedAt = null;
    syncStatus = 'idle';
    toast.dismiss();
    return last
      .then(() => {
        old.storage.close();
        return remove ? env.storage.remove(old.userId) : undefined;
      })
      .catch(warnStorage);
  }

  /** The server has no session for this device. The local database stays for the next sign-in of the account. */
  function expire(): void {
    void leave({ remove: false });
    adopt({ me: null, users: [], canRegister, vapidPublicKey: vapidKey, version });
    status = 'signedOut';
  }

  async function open(userId: ID): Promise<{ storage: Storage; snapshot: Snapshot }> {
    const read = async (factory: Env['storage']): Promise<{ storage: Storage; snapshot: Snapshot }> => {
      const storage = await factory.open(userId);
      return { storage, snapshot: await storage.load() };
    };
    try {
      // Some browsers have left a request to IndexedDB with no answer. The app must not wait
      // on its start screen for that.
      const late = sleep(LOCAL_DB_WAIT_MS).then(() => Promise.reject(new Error('The local database did not answer')));
      return await Promise.race([read(env.storage), late]);
    } catch (error) {
      // A browser can also refuse IndexedDB. The app then works until the page closes.
      console.warn('Shared Tasks: no local database. The data stays in memory only', error);
      return read(memoryStorage());
    }
  }

  /** Opens the account on this device: first the rows of the local database, then the server. */
  async function enter(info: Entered): Promise<void> {
    if (account?.userId === info.me.id) {
      adopt(info);
      return;
    }
    void leave({ remove: false });
    const { storage, snapshot } = await open(info.me.id);
    const { meta } = snapshot;
    const clientId = typeof meta.clientId === 'string' ? meta.clientId : newId();
    const clock = hlc.makeClock(clientId);
    const stored = meta.clock as Partial<hlc.Clock> | undefined;
    clock.ms = num(stored?.ms);
    clock.counter = num(stored?.counter);
    const acc: Account = {
      userId: info.me.id,
      storage,
      clientId,
      clock,
      since: num(meta.since),
      offset: num(meta.offset),
      dirt: noDirt(),
      flushTimer: null,
      writing: Promise.resolve(),
      syncedAtSaved: num(meta.syncedAt),
    };
    if (meta.clientId !== clientId) acc.dirt.meta.clientId = clientId;
    if (JSON.stringify(meta.me) !== JSON.stringify(info.me)) acc.dirt.meta.me = info.me;
    account = acc;
    store.load(snapshot);
    outbox.load(snapshot.outbox);
    // The rows have the ops of the outbox already, with one exception: a second tab wrote its
    // older copy of a row over the row. The ops apply again, so the screen never shows less
    // than the outbox has.
    mark(acc, store.apply(outbox.all()).changed);
    pending = outbox.size;
    lastSyncedAt = acc.syncedAtSaved || null;
    adopt(info);
    flushSoon(acc);

    if (acc.since === 0 && env.online()) {
      // A device with no rows waits for its first rows, so the screen does not show an empty
      // app for a moment.
      await Promise.race([syncNow(), sleep(FIRST_SYNC_WAIT_MS)]);
      if (account !== acc) return;
    } else {
      void syncNow();
    }
    status = 'signedIn';
    openStream();
    void push.refresh();
  }

  /** Asks the server who is signed in on this device, and follows the answer. */
  async function check(): Promise<void> {
    if (env.kv.get(LOGOUT_KEY) !== null) {
      // The person signed out, in this tab or in a different one, and the server did not get it
      // yet. No tab keeps the account open, and the session must end before a new one can start.
      void leave({ remove: true });
      adopt({ me: null, users: [], canRegister, vapidPublicKey: vapidKey, version });
      status = 'signedOut';
      const reply = await call({ path: '/api/logout', body: {} });
      if (reply.data === null) return;
      env.kv.remove(LOGOUT_KEY);
    }
    const reply = await call<MeResponse>({ path: '/api/me' });
    if (reply.data === null) {
      // No answer. A device with an open account shows its rows. A device with none can only
      // show the sign-in screen.
      if (!account) status = 'signedOut';
      return;
    }
    if (reply.data.me) return enter(reply.data as Entered);
    void leave({ remove: false });
    adopt(reply.data);
    status = 'signedOut';
  }

  function signIn(path: string, body: { name: string; password: string }): Promise<Result> {
    return exclusive(async () => {
      const reply = await call<MeResponse>({ path, body });
      if (!reply.data?.me) return fail(reply.message || 'The server gave no account');
      // The new session has a new cookie. The old session cannot be reached from this device.
      env.kv.remove(LOGOUT_KEY);
      await enter(reply.data as Entered);
      channel?.post({ type: 'session' });
      return { ok: true };
    });
  }

  async function login({ name, password }: { name: string; password: string }): Promise<Result> {
    if (!name.trim() || !password) return fail('Enter your name and your password');
    return signIn('/api/login', { name: name.trim(), password });
  }

  function checkName(name: string): string | null {
    if (!name) return 'Enter a name';
    return name.length > LIMITS.name ? `The name can have ${LIMITS.name} characters at most` : null;
  }

  const checkPassword = (password: string): string | null =>
    password.length < LIMITS.passwordMin ? `The password must have at least ${LIMITS.passwordMin} characters` : null;

  async function register({ name, password }: { name: string; password: string }): Promise<Result> {
    const problem = checkName(name.trim()) ?? checkPassword(password);
    return problem ? fail(problem) : signIn('/api/register', { name: name.trim(), password });
  }

  function logout(): Promise<Result> {
    return exclusive(async () => {
      // The database goes away, so the changes that the server does not have would be lost.
      if (account && outbox.size > 0 && env.online()) await Promise.race([syncNow(), sleep(LAST_SYNC_WAIT_MS)]);
      if (push.enabled) await Promise.race([push.disable(), sleep(LAST_SYNC_WAIT_MS)]);
      // The cookie is not readable from here: only the server can end the session. The mark
      // makes the next start end it, if the server does not answer now.
      env.kv.set(LOGOUT_KEY, '1');
      const removed = leave({ remove: true });
      adopt({ me: null, users: [], canRegister, vapidPublicKey: vapidKey, version });
      status = 'signedOut';
      prefs.lastTab = null;
      prefs.completedOpen = {};
      await removed;
      await check();
      channel?.post({ type: 'session' });
      return { ok: true };
    });
  }

  function resultOf(reply: Reply<unknown>): Result {
    if (reply.data !== null) return { ok: true };
    if (reply.status === 401) expire();
    return fail(reply.message);
  }

  async function changePassword({ current, next }: { current: string; next: string }): Promise<Result> {
    const problem = checkPassword(next);
    return problem ? fail(problem) : resultOf(await call({ path: '/api/password', body: { current, next } }));
  }

  async function rename({ name }: { name: string }): Promise<Result> {
    const problem = checkName(name.trim());
    if (problem) return fail(problem);
    const reply = await call<MeResponse>({ path: '/api/profile', body: { name: name.trim() } });
    if (reply.data?.me && account?.userId === reply.data.me.id) adopt(reply.data);
    return resultOf(reply);
  }

  // ---- Signals of the device ----

  let midnightTimer: unknown = null;

  function refreshToday(): void {
    const now = todayOf(env.now());
    if (now !== untrack(() => today)) today = now;
  }

  function armMidnight(): void {
    env.clearTimeout(midnightTimer);
    const next = toJsDate(addDays(todayOf(env.now()), 1)).getTime();
    // A timer that fires a moment early finds the old date. It then tries again after a second.
    midnightTimer = env.setTimeout(
      () => {
        refreshToday();
        armMidnight();
      },
      Math.max(1000, next - env.now()),
    );
  }

  function onSignal(signal: Signal): void {
    const acc = account;
    if (signal === 'visible') {
      // A phone stops the timers of an app in the background, so midnight can go by with no timer.
      refreshToday();
      armMidnight();
    }
    // The server tells who is signed in and who the other person is. The answer can be different
    // now: the session ended, the other person made an account or has a new name, or sign-up closed.
    if ((signal === 'visible' || signal === 'online') && status !== 'loading') void exclusive(check);
    if (!acc) return;
    if (signal === 'visible' || signal === 'online') {
      failures = 0;
      void syncNow();
      openStream();
    } else if (signal === 'hidden') {
      // The system can end a hidden app at each moment, so the changes go out now. The poll stops.
      void flush(acc);
      clearPlan();
      if (outbox.size > 0) void syncNow();
      closeStream();
    } else {
      clearPlan();
      closeStream();
      syncStatus = 'offline';
    }
  }

  function onMessage(message: unknown): void {
    const { type, user } = (message ?? {}) as { type?: unknown; user?: unknown };
    if (type === 'synced' && account?.userId === user) void syncNow();
    else if (type === 'session') void exclusive(check);
  }

  let stopListening: (() => void) | null = null;

  /**
   * Starts the device: the rows of the last account show from the local database, then the
   * server tells if the session is valid. The result ends when the two are done.
   */
  function start(): Promise<void> {
    if (stopListening) return gate.then(() => undefined);
    stopListening = env.listen(onSignal);
    channel = env.channel({ name: CHANNEL, onMessage });
    armMidnight();
    return exclusive(async () => {
      const info = saved();
      if (info?.me && env.kv.get(LOGOUT_KEY) === null) await enter(info as Entered);
      await check();
    });
  }

  /** Ends all timers and connections and waits for the local database. The data stays. For a test. */
  async function stop(): Promise<void> {
    stopListening?.();
    stopListening = null;
    channel?.close();
    channel = null;
    env.clearTimeout(midnightTimer);
    await leave({ remove: false });
  }

  return {
    session: {
      get status(): SessionStatus {
        return status;
      },
      get me(): User | null {
        return me;
      },
      /** All accounts on the server. Empty while no person is signed in. */
      get users(): User[] {
        return users;
      },
      get canRegister(): boolean {
        return canRegister;
      },
      /** The version of the server, for the "About" part of the settings. */
      get version(): string {
        return version;
      },
    },
    login,
    register,
    logout,
    changePassword,
    rename,

    store: {
      get today(): DateStr {
        return today;
      },
      can,
    },
    listsOrdered: store.listsOrdered,
    getList: store.getList,
    getTask: store.getTask,
    listView: store.listView,
    starredView: store.starredView,
    subtasksOf: store.subtasksOf,
    otherUser: (): User | null => users.find((user) => user.id !== me?.id) ?? null,

    actions,
    undo,
    canUndo: (): boolean => undoCount > 0,

    sync: {
      get status(): SyncStatus {
        return syncStatus;
      },
      /** The number of ops in the outbox. */
      get pending(): number {
        return pending;
      },
      /** The device time of the last answer of the server. */
      get lastSyncedAt(): number | null {
        return lastSyncedAt;
      },
      /** Starts a sync. true: the server answered. */
      now: syncNow,
    },

    toast,
    prefs,
    push: push as Omit<typeof push, 'refresh'>,

    start,
    stop,
    /** For tests. */
    debug: {
      /** The rows with no dependency for the reader. */
      rows: store.rows,
      builds: store.builds,
      outbox: () => outbox.all(),
      /** Writes the waiting changes to the local database now. */
      flush: (): Promise<void> => (account ? flush(account) : Promise.resolve()),
    },
  };
}
