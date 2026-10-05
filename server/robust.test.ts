// The server must not stop on any request, and a client that goes away must do no harm.
import { connect } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { makeKit, rawRequest, startTestServer, waitFor } from './testkit.ts';
import type { Kit, Person, TestServer } from './testkit.ts';
import type { ApiError, SyncResponse } from '../shared/types.ts';

let server: TestServer;
let kit: Kit;
let alex: Person;
let listId: string;

beforeAll(async () => {
  // One account only, so a random body cannot make a second one.
  server = await startTestServer({ name: 'robust', env: { MAX_USERS: '1' } });
  kit = makeKit(server);
  alex = await kit.register('Alex');
  listId = (await alex.sync()).lists[0]!.id;
});
afterAll(() => server.stop());
afterEach(() => vi.restoreAllMocks());

/**
 * Sends raw bytes on a new connection. Gives all bytes that came back when the connection closed.
 * `until` closes the connection when the answer has this text.
 */
function rawSocket(input: { send: (string | Buffer)[]; closeAfterMs?: number; until?: string }): Promise<string> {
  const { port } = new URL(server.url);
  return new Promise((resolve) => {
    const socket = connect(Number(port), '127.0.0.1');
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk.toString('latin1');
      if (input.until && text.includes(input.until)) socket.destroy();
    });
    socket.on('close', () => resolve(text));
    socket.on('error', () => undefined);
    socket.on('connect', () => {
      for (const part of input.send) socket.write(part);
      if (input.closeAfterMs !== undefined) setTimeout(() => socket.destroy(), input.closeAfterMs);
    });
  });
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function alive(): Promise<void> {
  const reply = await kit.call({ path: '/api/health' });
  expect(reply.status).toBe(200);
  expect((await alex.sync()).reset).toBe(false);
}

describe('errors in the server', () => {
  test('an error in a handler gives 500 and one log line, and the server continues', async () => {
    const lines: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => void lines.push(args));
    // The table of the sessions is away for a moment, so each request with a cookie fails.
    const { db } = server.app;
    db.sql.exec('ALTER TABLE sessions RENAME TO sessions_away');
    let replies: { status: number; data: ApiError }[];
    try {
      replies = [
        await alex.call<ApiError>('/api/sync', { clientId: 'c1', since: 0, ops: [], tz: 'UTC', secret: 'in-the-body' }),
        await alex.call<ApiError>('/api/me?secret=in-the-query'),
        await alex.call<ApiError>('/api/events'),
        await alex.call<ApiError>('/api/push/test', {}),
      ];
    } finally {
      db.sql.exec('ALTER TABLE sessions_away RENAME TO sessions');
    }
    for (const reply of replies) {
      expect(reply.status).toBe(500);
      expect(reply.data).toEqual({ error: { code: 'server', message: 'Internal error' } });
    }
    expect(lines).toHaveLength(4);
    expect(lines.map((line) => String(line[0]).replace(/^\S+ /, ''))).toEqual([
      'error POST /api/sync',
      'error GET /api/me',
      'error GET /api/events',
      'error POST /api/push/test',
    ]);
    // The line has the error, and not the body, the query, or the cookie of the request.
    const text = lines.map((line) => line.map((part) => (part instanceof Error ? `${part.stack}` : String(part))).join(' ')).join('\n');
    expect(text).toContain('no such table: sessions');
    expect(text).not.toContain('in-the-body');
    expect(text).not.toContain('in-the-query');
    expect(text).not.toContain(alex.cookie.split('=')[1]);
    await alive();
  });

  test('an error while the push service is called gives 500 and the server continues', async () => {
    const lines: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => void lines.push(args));
    const { app } = server;
    app.db
      .q('INSERT INTO push_subs (endpoint, user_id, session_hash, p256dh, auth, created_at) SELECT ?, user_id, hash, ?, ?, 1 FROM sessions LIMIT 1')
      .run('https://push.example.net/x', 'p', 'a');
    const send = app.send;
    app.send = () => Promise.reject(new Error('The push service broke'));
    try {
      const reply = await alex.call<ApiError>('/api/push/test', {});
      expect(reply.status).toBe(500);
      expect(reply.data.error.code).toBe('server');
    } finally {
      app.send = send;
      app.db.q('DELETE FROM push_subs').run();
    }
    expect(lines).toHaveLength(1);
    await alive();
  });
});

describe('requests that are not complete or not valid', () => {
  test('a client that goes away in the middle of a body does no harm and leaves no log line', async () => {
    const lines: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => void lines.push(args));
    const head =
      `POST /api/sync HTTP/1.1\r\nHost: x\r\nCookie: ${alex.cookie}\r\nContent-Type: application/json\r\nContent-Length: 5000\r\n\r\n` +
      '{"clientId":"c1","since":0,"ops":[';
    for (let i = 0; i < 5; i++) await rawSocket({ send: [head], closeAfterMs: 30 });
    await pause(50);
    expect(lines).toEqual([]);
    await alive();
  });

  test('a client that goes away before it reads a large answer does no harm', async () => {
    const lines: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => void lines.push(args));
    await alex.sync(Array.from({ length: 600 }, (_, i) => kit.task({ listId, title: `Task ${i} ${'x'.repeat(200)}`, pos: `a${i}` })));
    const body = JSON.stringify({ clientId: 'c1', since: 0, ops: [], tz: 'UTC' });
    const request =
      `POST /api/sync HTTP/1.1\r\nHost: x\r\nCookie: ${alex.cookie}\r\nContent-Type: application/json\r\n` +
      `Accept-Encoding: gzip\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
    // With no wait, the connection is gone while the server makes the answer.
    for (const closeAfterMs of [0, 0, 1, 2, 5]) await rawSocket({ send: [request], closeAfterMs });
    await pause(50);
    expect(lines).toEqual([]);
    await alive();
  });

  test('a client that goes away from the event stream does no harm', async () => {
    const before = server.app.events.size();
    const request = `GET /api/events HTTP/1.1\r\nHost: x\r\nCookie: ${alex.cookie}\r\n\r\n`;
    const streams = [0, 1, 2].map(() => rawSocket({ send: [request], closeAfterMs: 400 }));
    await waitFor(() => server.app.events.size() === before + 3);
    const texts = await Promise.all(streams);
    for (const text of texts) expect(text).toContain('event: poke');
    await waitFor(() => server.app.events.size() === before);
    // A change after that: the poke has no stream to go to, and nothing breaks.
    await alex.sync([kit.task({ listId, title: 'After the streams closed' })]);
    server.app.events.poke({ users: 'all', rev: 1 });
    await alive();
  });

  test('bytes that are not HTTP, a bad path, and a very long header get an error answer', async () => {
    const answers = [
      await rawSocket({ send: ['\x00\x01\x02 not http at all\r\n\r\n'] }),
      await rawSocket({ send: ['GET /%zz%%% HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'] }),
      await rawSocket({ send: ['GET http://[bad HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'] }),
      await rawSocket({ send: [`GET / HTTP/1.1\r\nHost: x\r\nX-Long: ${'a'.repeat(100_000)}\r\n\r\n`] }),
      await rawSocket({ send: ['POST /api/sync HTTP/1.1\r\nHost: x\r\nContent-Length: -5\r\n\r\n'] }),
      await rawSocket({ send: ['POST /api/sync HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\n\r\nzz\r\n'] }),
    ];
    for (const answer of answers) expect(answer).toMatch(/^HTTP\/1\.1 4\d\d /);
    await alive();
  });

  test('JSON with very deep nesting is an error and not a crash', async () => {
    const deep = '['.repeat(2_000_000);
    const reply = await alex.call<ApiError>('/api/sync', `{"clientId":"c1","since":0,"tz":"UTC","ops":${deep}`);
    expect([reply.status, reply.data.error.code]).toEqual([400, 'invalid']);
    const closed = await alex.call<ApiError>('/api/sync', `{"clientId":"c1","since":0,"tz":"UTC","ops":${'['.repeat(100_000)}${']'.repeat(100_000)}}`);
    expect([400, 200]).toContain(closed.status);
    await alive();
  });

  test('a body that is larger than its limit in chunks is refused', async () => {
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    const size = chunk.length.toString(16);
    const parts: (string | Buffer)[] = [
      `POST /api/sync HTTP/1.1\r\nHost: x\r\nCookie: ${alex.cookie}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n`,
    ];
    // 6 MB with no Content-Length header. The connection stays open, as that of a browser does:
    // the server reads the rest of the body and drops it, so the answer can arrive.
    for (let i = 0; i < 96; i++) parts.push(`${size}\r\n`, chunk, '\r\n');
    parts.push('0\r\n\r\n');
    const answer = await rawSocket({ send: parts, until: '"The request body is too large"' });
    expect(answer).toMatch(/^HTTP\/1\.1 413 /);
    expect(answer).toContain('"code":"invalid"');
    await alive();
  });

  test('many requests at the same time all get their answer', async () => {
    const device = await kit.login('Alex');
    const replies = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        device.call<SyncResponse>('/api/sync', {
          clientId: `c${i}`,
          since: 0,
          ops: [kit.op(kit.task({ listId, title: `At the same time ${i}` }))],
          tz: 'UTC',
        }),
      ),
    );
    expect(replies.map((r) => r.status)).toEqual(Array(40).fill(200));
    expect(replies.every((r) => r.data.acked.length === 1)).toBe(true);
    // Each request made one row, so the revisions are 40 different numbers.
    expect(new Set(replies.map((r) => r.data.rev)).size).toBe(40);
  });

  test('random ops and random bodies give no error in the server', async () => {
    const lines: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => void lines.push(args));
    let seed = 20261006;
    const random = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed % n;
    };
    const pick = <T>(items: readonly T[]): T => items[random(items.length)]!;
    const ids = ['fuzz-list', 'fuzz-task-1', 'fuzz-task-2', listId, 'no-such-row', '', 'bad id', 5, null];
    const values = [
      null, true, false, 0, 1, -1, 1.5, 1e300, '', 'text', 'a0', '2026-10-06', '09:30', '24:61', 'x'.repeat(3000), '\u0000', '🍉',
      [], [1], {}, { type: 'never' }, { every: 1, unit: 'day', start: '2026-10-06', end: { type: 'never' } },
      { every: 1, unit: 'week', weekdays: [1, 8], start: '2026-10-06', end: { type: 'after', count: 2 } }, 'fuzz-list', 'fuzz-task-1', listId,
    ];
    const names = [
      'listId', 'parentId', 'title', 'notes', 'pos', 'due', 'time', 'deadline', 'repeat', 'repeatCount', 'hiddenUntil', 'lastDoneAt',
      'lastDoneDue', 'completed', 'completedAt', 'completedBy', 'createdAt', 'createdBy', 'deleted', 'starred', 'starredAt',
      'owner', 'shared', 'isDefault', 'sort', 'hidden', '__proto__', 'constructor', 'toString', 'rev', 'ts', 'id',
    ];
    const stamps = [kit.ts(), kit.at(Date.now() + 3_600_000), kit.at(1), '0'.repeat(18), 'z'.repeat(18), 'bad', 5, null];
    await alex.sync([kit.list({ title: 'Fuzz' }, 'fuzz-list'), kit.task({ listId: 'fuzz-list', title: 'Fuzz' }, 'fuzz-task-1')]);

    for (let round = 0; round < 60; round++) {
      const ops = Array.from({ length: 40 }, (_, i) => {
        const fields: Record<string, unknown> = {};
        for (let n = random(5); n >= 0; n--) fields[pick(names)] = pick(values);
        // Some ops are valid, so the rows do change between the bad ops.
        if (random(4) === 0) return kit.op({ kind: 'task', id: pick(['fuzz-task-1', 'fuzz-task-2']), fields: { listId: pick(['fuzz-list', listId]), title: `Fuzz ${i}`, deleted: random(3) === 0 } });
        return { opId: random(20) === 0 ? pick(values) : `fuzz-${round}-${i}`, ts: pick(stamps), kind: pick(['task', 'list', 'task', 'list', 'user', null]), id: pick(ids), fields: random(15) === 0 ? pick(values) : fields };
      });
      const text = JSON.stringify({ clientId: 'fuzz', since: pick([0, 1, alex.since, 1e9]), ops, tz: pick(['UTC', 'x', null]) });
      const reply = await alex.call<SyncResponse>('/api/sync', text);
      expect(reply.status).toBe(200);
      const named = (JSON.parse(text) as { ops: { opId: unknown }[] }).ops.filter((op) => typeof op.opId === 'string').map((op) => op.opId);
      expect([...reply.data.acked, ...reply.data.rejected].sort()).toEqual(named.sort());
      // No row is in the answer two times, and no row is also a 'gone' id.
      for (const kind of ['lists', 'tasks'] as const) {
        const all = [...reply.data[kind].map((row) => row.id), ...reply.data.gone[kind]];
        expect(new Set(all).size).toBe(all.length);
      }
    }
    // Random values as the body of each other POST route.
    const device = await kit.login('Alex');
    for (const route of ['/api/login', '/api/register', '/api/password', '/api/push/subscribe', '/api/push/unsubscribe', '/api/profile', '/api/logout']) {
      for (let i = 0; i < 25; i++) {
        const body: Record<string, unknown> = {};
        for (const key of ['name', 'password', 'current', 'next', 'endpoint', 'keys']) if (random(3) > 0) body[key] = pick(values);
        const reply = await device.call(route, random(10) === 0 ? pick(values) : body);
        expect(reply.status, `${route} ${JSON.stringify(body).slice(0, 200)}`).toBeLessThan(500);
      }
      // A random name can be a valid name. The account gets its name back.
      if (route === '/api/profile') expect((await device.call('/api/profile', { name: 'Alex' })).status).toBe(200);
    }
    expect(lines).toEqual([]);
    // The account has its password and its default list, and no second account came from the random bodies.
    const all = await (await kit.login('Alex')).sync();
    expect(all.lists.filter((l) => l.isDefault)).toHaveLength(1);
    expect(server.app.db.q('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 });
  });

  test('a HEAD request to an API route gives the headers and no body', async () => {
    const reply = await rawRequest({ url: server.url, path: '/api/health', method: 'HEAD' });
    expect(reply.status).toBe(200);
    expect(reply.body.length).toBe(0);
  });
});
