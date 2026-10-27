// Helpers for the tests of the server: a real server on a free port with its own folder under
// .tmp/, and people who talk to it through HTTP.
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import { startServer } from './app.ts';
import type { RunningServer, ServerOptions } from './app.ts';
import { loadConfig, ROOT } from './config.ts';
import * as hlc from '../shared/hlc.ts';
import type { HLC, ID, ListFields, MeResponse, NoteFields, Op, Put, SyncResponse, TaskFields, User } from '../shared/types.ts';

let serial = 0;

export interface TestServer extends RunningServer {
  /** The folder of this server. `data/` holds the database, `web/` is the folder of the client. */
  dir: string;
  /** Stops the server and removes the folder. `keep` leaves the folder, to start a server on it again. */
  stop(options?: { keep?: boolean }): Promise<void>;
}

export async function startTestServer(input: {
  name: string;
  /** An existing folder, to start again on the data of an earlier server. */
  dir?: string;
  env?: Record<string, string>;
  options?: Partial<ServerOptions>;
}): Promise<TestServer> {
  const dir = input.dir ?? path.join(ROOT, '.tmp', `test-${input.name}-${process.pid}-${Date.now().toString(36)}-${serial++}`);
  mkdirSync(path.join(dir, 'web'), { recursive: true });
  const config = loadConfig({
    PORT: '0',
    DATA_DIR: path.join(dir, 'data'),
    WEB_DIR: path.join(dir, 'web'),
    ...input.env,
  });
  const server = await startServer({ config, timers: false, log: () => undefined, ...input.options });
  return {
    ...server,
    dir,
    async stop(options) {
      await server.close();
      if (!options?.keep) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface Reply<T> {
  status: number;
  data: T;
  headers: Headers;
}

/** One device of one person. */
export interface Person {
  user: User;
  cookie: string;
  clientId: ID;
  /** The revision of the last sync of this device. */
  since: number;
  /** The time zone that the device sends with each sync. */
  tz: string;
  /** GET with no body, POST with a body. */
  call<T = any>(path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply<T>>;
  /** Sends puts (they get new timestamps) or complete ops, and keeps the new revision. */
  sync(ops?: (Put | Op)[]): Promise<SyncResponse>;
}

export interface Kit {
  /** A new timestamp from the clock of the kit. Each one is later than the one before. */
  ts(): HLC;
  /** A timestamp for an exact time. */
  at(ms: number, node?: string): HLC;
  op(put: Put, ts?: HLC): Op;
  list(fields: ListFields, id?: ID): Put & { kind: 'list' };
  task(fields: TaskFields, id?: ID): Put & { kind: 'task' };
  /** A put that makes a note: it has createdAt, as SPEC section 3 says. */
  note(fields: NoteFields, id?: ID): Put & { kind: 'note' };
  call<T = any>(input: { path: string; body?: unknown; cookie?: string; headers?: Record<string, string> }): Promise<Reply<T>>;
  /** Makes an account and signs in. */
  register(name: string): Promise<Person>;
  /** Signs in on one more device. */
  login(name: string, password?: string): Promise<Person>;
  passwordOf(name: string): string;
}

export function makeKit(server: { url: string }, now: () => number = Date.now): Kit {
  const clock = hlc.makeClock('test01');
  const ts = (): HLC => hlc.tick(clock, now());
  const passwordOf = (name: string): string => `password-of-${name.toLowerCase()}`;

  const call: Kit['call'] = async ({ path: route, body, cookie, headers }) => {
    const response = await fetch(server.url + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      // Not JSON: the test gets the text.
    }
    return { status: response.status, data: data as never, headers: response.headers };
  };

  const op: Kit['op'] = (put, stamp) => ({ ...put, opId: randomUUID(), ts: stamp ?? ts() });

  async function enter(route: string, name: string, password: string): Promise<Person> {
    const reply = await call<MeResponse>({ path: route, body: { name, password } });
    if (reply.status !== 200 || !reply.data.me) throw new Error(`${route} failed: ${reply.status} ${JSON.stringify(reply.data)}`);
    const cookie = reply.headers.getSetCookie()[0]!.split(';')[0]!;
    const person: Person = {
      user: reply.data.me,
      cookie,
      clientId: randomUUID(),
      since: 0,
      tz: 'Europe/Berlin',
      call: (path_, body, headers) => call({ path: path_, body, cookie: person.cookie, headers }),
      async sync(ops = []) {
        const reply2 = await person.call<SyncResponse>('/api/sync', {
          clientId: person.clientId,
          since: person.since,
          ops: ops.map((o) => ('opId' in o ? o : op(o))),
          tz: person.tz,
        });
        if (reply2.status !== 200) throw new Error(`sync failed: ${reply2.status} ${JSON.stringify(reply2.data)}`);
        person.since = reply2.data.rev;
        return reply2.data;
      },
    };
    return person;
  }

  return {
    ts,
    at: (ms, node = 'aaaaaa') => hlc.encode({ ms, counter: 0, node }),
    op,
    list: (fields, id = randomUUID()) => ({ kind: 'list', id, fields: { createdAt: now(), ...fields } }),
    task: (fields, id = randomUUID()) => ({ kind: 'task', id, fields: { createdAt: now(), ...fields } }),
    note: (fields, id = randomUUID()) => ({ kind: 'note', id, fields: { createdAt: now(), ...fields } }),
    call,
    register: (name) => enter('/api/register', name, passwordOf(name)),
    login: (name, password) => enter('/api/login', name, password ?? passwordOf(name)),
    passwordOf,
  };
}

export interface RawReply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/**
 * A request with no change by the client: the path goes out as written (also with '..'), and
 * the body comes back as the server sent it (also if it is compressed).
 */
export function rawRequest(input: {
  url: string;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}): Promise<RawReply> {
  const base = new URL(input.url);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: base.hostname, port: base.port, path: input.path, method: input.method ?? 'GET', headers: input.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(input.body);
  });
}

/** Waits until the test gives true. Throws after the time limit. */
export async function waitFor(test: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error('waitFor: the time limit is over');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
