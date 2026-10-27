import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { createEvents } from './events.ts';
import { makeKit, startTestServer, waitFor } from './testkit.ts';
import type { Kit, Person, TestServer } from './testkit.ts';
import type { Put } from '../shared/types.ts';

let server: TestServer;
let kit: Kit;
let alex: Person;
let sam: Person;
let sharedList = '';
let privateList = '';

interface Stream {
  response: Response;
  /** All text of the stream up to now. */
  text(): string;
  /** The next poke. Throws if none comes in the time. */
  poke(ms?: number): Promise<{ rev: number }>;
  /** true after the server ended the stream. */
  ended(): boolean;
  close(): void;
}

const open: Stream[] = [];

/** Reads an event stream as a browser does. */
async function listen(input: { url: string; cookie?: string; query?: string }): Promise<Stream> {
  const abort = new AbortController();
  const response = await fetch(`${input.url}/api/events${input.query ?? ''}`, {
    headers: input.cookie ? { Cookie: input.cookie } : {},
    signal: abort.signal,
  });
  let text = '';
  let taken = 0;
  let ended = false;
  if (response.status === 200 && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
        }
      } catch {
        // The test closed the stream.
      }
      ended = true;
    })();
  }
  const stream: Stream = {
    response,
    text: () => text,
    ended: () => ended,
    async poke(ms = 2000) {
      const pattern = /event: poke\ndata: (\{.*\})\n\n/g;
      let match: RegExpExecArray | null = null;
      await waitFor(() => {
        pattern.lastIndex = taken;
        match = pattern.exec(text);
        return match !== null;
      }, ms);
      taken = pattern.lastIndex;
      return JSON.parse(match![1]!) as { rev: number };
    },
    close: () => abort.abort(),
  };
  open.push(stream);
  return stream;
}

/** Opens the stream of a device and takes the first poke, which each stream gets at its start. */
async function listenAs(person: Person, query = ''): Promise<Stream> {
  const stream = await listen({ url: server.url, cookie: person.cookie, query });
  await stream.poke();
  return stream;
}

const quiet = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const rename = (id: string, title: string): Put => ({ kind: 'list', id, fields: { title } });

beforeAll(async () => {
  server = await startTestServer({ name: 'events' });
  kit = makeKit(server);
  alex = await kit.register('Alex');
  sam = await kit.register('Sam');
  const shared = kit.list({ title: 'Shared', shared: true });
  const mine = kit.list({ title: 'Private' });
  await alex.sync([shared, mine]);
  sharedList = shared.id;
  privateList = mine.id;
});
afterEach(() => {
  for (const stream of open.splice(0)) stream.close();
});
afterAll(() => server.stop());

test('the stream has the headers of an event stream and starts with the current revision', async () => {
  const stream = await listen({ url: server.url, cookie: sam.cookie });
  expect(stream.response.status).toBe(200);
  expect(stream.response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
  expect(stream.response.headers.get('x-accel-buffering')).toBe('no');
  expect(stream.response.headers.get('cache-control')).toContain('no-cache');
  expect(await stream.poke()).toEqual({ rev: alex.since });
});

test('a stream needs a session', async () => {
  const stream = await listen({ url: server.url });
  expect(stream.response.status).toBe(401);
  expect(server.app.events.size()).toBe(0);
});

test('a poke arrives at the other person after a sync', async () => {
  const stream = await listenAs(sam);
  const reply = await alex.sync([kit.task({ listId: sharedList, title: 'Milk' })]);
  expect(await stream.poke()).toEqual({ rev: reply.rev });
});

test('a change in a private list gives no poke to the other person', async () => {
  const ofSam = await listenAs(sam);
  const ofAlex = await listenAs(await kit.login('Alex'));
  const hidden = await alex.sync([kit.task({ listId: privateList, title: 'Secret' }), rename(privateList, 'Still private')]);
  // The other device of Alex gets the poke.
  expect(await ofAlex.poke()).toEqual({ rev: hidden.rev });
  const visible = await alex.sync([rename(sharedList, 'Shared, new name')]);
  // The next poke of Sam is the one for the shared list. So no poke came for the private list.
  expect(await ofSam.poke()).toEqual({ rev: visible.rev });
  expect(await ofAlex.poke()).toEqual({ rev: visible.rev });
});

test('a sync that changes nothing gives no poke', async () => {
  const stream = await listenAs(sam);
  await alex.sync();
  await alex.sync([rename(sharedList, 'Shared, new name')]);
  await quiet();
  expect(stream.text()).not.toMatch(/poke[\s\S]*poke/);
});

test('a per-person change gives a poke only to the devices of that person', async () => {
  const task = kit.task({ listId: sharedList, title: 'Star me' });
  await alex.sync([task]);
  const ofSam = await listenAs(sam);
  const ofAlex = await listenAs(await kit.login('Alex'));
  const star = await alex.sync([{ kind: 'task', id: task.id, fields: { starred: true, starredAt: 1 } }]);
  expect(await ofAlex.poke()).toEqual({ rev: star.rev });
  await quiet();
  expect(ofSam.text()).not.toMatch(/poke[\s\S]*poke/);
});

test('a device that gives its id gets no poke for its own change', async () => {
  const own = await listenAs(alex, `?client=${alex.clientId}`);
  const other = await listenAs(sam, `?client=${sam.clientId}`);
  const first = await alex.sync([rename(sharedList, 'Changed by Alex')]);
  expect(await other.poke()).toEqual({ rev: first.rev });
  const second = await sam.sync([rename(sharedList, 'Changed by Sam')]);
  // The first poke that the device of Alex gets is for the change of Sam.
  expect(await own.poke()).toEqual({ rev: second.rev });
  await quiet();
  expect(other.text()).not.toMatch(/poke[\s\S]*poke[\s\S]*poke/);
});

test('a person who sends the device id of the other person does not stop the pokes to that device', async () => {
  const ofAlex = await listenAs(alex, `?client=${alex.clientId}`);
  const reply = await sam.call<{ rev: number }>('/api/sync', {
    clientId: alex.clientId,
    since: sam.since,
    ops: [kit.op(rename(sharedList, 'Changed with the device id of Alex'))],
    tz: 'UTC',
  });
  expect(reply.status).toBe(200);
  expect(await ofAlex.poke()).toEqual({ rev: reply.data.rev });
});

test('a share change gives a poke to the person who gets or loses the list', async () => {
  const stream = await listenAs(sam);
  const share = await alex.sync([{ kind: 'list', id: privateList, fields: { shared: true } }]);
  expect(await stream.poke()).toEqual({ rev: share.rev });
  const stop = await alex.sync([{ kind: 'list', id: privateList, fields: { shared: false } }]);
  expect(await stream.poke()).toEqual({ rev: stop.rev });
});

test('a change of a private note gives no poke to the other person. A share and its end give one', async () => {
  const note = kit.note({ title: 'Private note' });
  await alex.sync([note]);
  const ofSam = await listenAs(sam);
  const ofAlex = await listenAs(await kit.login('Alex'));
  const hidden = await alex.sync([{ kind: 'note', id: note.id, fields: { body: 'Still private' } }]);
  expect(await ofAlex.poke()).toEqual({ rev: hidden.rev });
  const share = await alex.sync([{ kind: 'note', id: note.id, fields: { shared: true } }]);
  // The next poke of Sam is the one for the share. So no poke came for the private change.
  expect(await ofSam.poke()).toEqual({ rev: share.rev });
  const stop = await alex.sync([{ kind: 'note', id: note.id, fields: { shared: false } }]);
  expect(await ofSam.poke()).toEqual({ rev: stop.rev });
});

test('the server removes a stream when the client closes it, and ends the stream at a sign-out', async () => {
  await waitFor(() => server.app.events.size() === 0);
  const phone = await kit.login('Sam');
  const first = await listenAs(sam);
  const second = await listenAs(phone);
  expect(server.app.events.size()).toBe(2);

  first.close();
  await waitFor(() => server.app.events.size() === 1);

  await phone.call('/api/logout', {});
  await waitFor(() => second.ended());
  expect(server.app.events.size()).toBe(0);
});

test('a quiet stream gets a comment line at each interval', async () => {
  const events = createEvents(40);
  const http = createServer((req, res) => events.open({ req, res, userId: 'u1', sessionKey: 's1', clientId: null, rev: 7 }));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  try {
    const stream = await listen({ url: `http://127.0.0.1:${(http.address() as AddressInfo).port}` });
    expect(await stream.poke()).toEqual({ rev: 7 });
    await waitFor(() => (stream.text().match(/^: ping\n\n/gm) ?? []).length >= 2);
    expect(stream.text().startsWith('retry: 3000\n\n')).toBe(true);
    // stop() ends each stream.
    events.stop();
    await waitFor(() => stream.ended());
    expect(events.size()).toBe(0);
  } finally {
    events.stop();
    await new Promise((resolve) => http.close(resolve));
  }
});
