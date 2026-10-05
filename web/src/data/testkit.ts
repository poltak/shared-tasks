// Helpers for the tests of the data layer: a device with its own storage, clock, and network
// switch, a small stand-in for the server, and the real server as a child process.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { ID, ListRow, MeResponse, Op, SyncResponse, User } from '../../../shared/types.ts';
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

export interface StubServer {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  me: User;
  /** The list that the first sync of a device gets. */
  list: ListRow;
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
  onSync: ((request: StubSync, response: SyncResponse) => void) | null;
}

/**
 * Answers as a server with one account and one list. It accepts each op, and it sends no rows
 * back after the first sync of a device: the tests of the local logic do not need more.
 */
export function stubServer(now: () => number = Date.now): StubServer {
  const me: User = { id: 'user-1', name: 'Alex' };
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
    users: stub.session ? [me, { id: 'user-2', name: 'Sam' }] : [],
    canRegister: false,
    vapidPublicKey: 'stub-key',
    version: '1.2.3',
  });
  const stub: StubServer = {
    me,
    list,
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
      if (request.ops.length > 0) rev += 1;
      const response: SyncResponse = {
        rev,
        reset: false,
        lists: request.since === 0 ? [list] : [],
        tasks: [],
        gone: { lists: [], tasks: [] },
        acked: request.ops.map((op) => op.opId),
        rejected: [],
        now: now(),
      };
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
