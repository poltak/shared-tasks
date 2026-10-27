// The stand-in server of testkit.ts must follow the note rules of the real server. Else the tests
// of the data layer pass against rules that the real server does not have. Each step goes to the
// two servers, and the answers must be the same.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as hlc from '../../../shared/hlc.ts';
import type { ID, MeResponse, NoteRow, Op, SyncAnswer } from '../../../shared/types.ts';
import { startServerProcess, stubServer } from './testkit.ts';
import type { ServerProcess } from './testkit.ts';

let real: ServerProcess;

beforeAll(async () => {
  real = await startServerProcess('stand-in');
}, 30_000);

afterAll(async () => {
  await real?.remove();
});

interface Account {
  id: ID;
  cookie: string;
  clientId: ID;
  since: number;
}

async function register(name: string): Promise<Account> {
  const response = await fetch(`${real.url}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password: `password-of-${name.toLowerCase()}` }),
  });
  const data = (await response.json()) as MeResponse;
  return { id: data.me!.id, cookie: response.headers.getSetCookie()[0]!.split(';')[0]!, clientId: randomUUID(), since: 0 };
}

async function post(input: { fetch: typeof fetch; cookie?: string; body: object }): Promise<SyncAnswer> {
  const response = await input.fetch('/api/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(input.cookie ? { Cookie: input.cookie } : {}) },
    body: JSON.stringify({ tz: 'Europe/Berlin', ...input.body }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as SyncAnswer;
}

type Who = 'alex' | 'sam';
/** A value '$alex' or '$sam' in the fields is the id of that person on each server. */
type Step = { who: Who; puts: { id: ID; fields: Record<string, unknown> }[] };

const B_FIELDS = { title: 'Shared', body: 'x', color: 'teal', shared: true, editedAt: 1001, editedBy: '$alex', owner: '$alex', createdAt: 1001 };

const STEPS: Step[] = [
  // A note with no createdAt is not made, and its id comes back in gone. Owner is set by the server.
  {
    who: 'alex',
    puts: [
      { id: 'a', fields: { createdAt: 1000, title: 'Private of Alex', owner: '$sam' } },
      { id: 'b', fields: { ...B_FIELDS, pinned: true } },
      { id: 'ghost', fields: { title: 'no createdAt' } },
    ],
  },
  { who: 'sam', puts: [{ id: 's', fields: { createdAt: 1002, title: 'Private of Sam' } }] },
  { who: 'sam', puts: [{ id: 'b', fields: { title: 'Edited by Sam', editedAt: 2000, editedBy: '$sam' } }] },
  // A pin of Sam is for Sam only, so Alex gets no row for it.
  { who: 'sam', puts: [{ id: 'b', fields: { pinned: true } }] },
  { who: 'alex', puts: [] },
  { who: 'sam', puts: [{ id: 'b', fields: { deleted: true } }] },
  // The value of shared is the stored one: no change, and the body applies.
  { who: 'sam', puts: [{ id: 'b', fields: { shared: true, body: 'Body by Sam' } }] },
  { who: 'sam', puts: [{ id: 'a', fields: { title: 'Not mine' } }] },
  { who: 'sam', puts: [{ id: 'a', fields: { pinned: true } }] },
  {
    who: 'alex',
    puts: [
      { id: 'a', fields: { color: 'magenta' } },
      { id: 'b', fields: { archived: true } },
    ],
  },
  { who: 'alex', puts: [{ id: 'a', fields: { title: 'T'.repeat(1100), body: `${'B'.repeat(15_999)}😀` } }] },
  {
    who: 'alex',
    puts: [
      { id: 'a', fields: { title: 5 } },
      { id: 'a', fields: { pinned: 'yes' } },
      { id: 'a', fields: { editedBy: 'not an id!' } },
      { id: 'a', fields: { editedAt: -1 } },
      { id: 'a', fields: { foo: 1, title: 'Short again' } },
    ],
  },
  { who: 'alex', puts: [{ id: 'b', fields: { shared: false } }] },
  { who: 'sam', puts: [{ id: 'b', fields: { title: 'Too late' } }] },
  { who: 'alex', puts: [{ id: 'b', fields: { shared: true } }] },
  { who: 'alex', puts: [{ id: 'b', fields: { deleted: true } }] },
  // The undo of a delete has each field.
  { who: 'alex', puts: [{ id: 'b', fields: { ...B_FIELDS, title: 'Edited by Sam', body: 'Body by Sam', deleted: false, pinned: true, archived: true } }] },
  {
    who: 'alex',
    puts: [
      { id: 'c', fields: { createdAt: 1003, title: 'Made and deleted' } },
      { id: 'c', fields: { deleted: true } },
      { id: 'ghost2', fields: { deleted: true } },
    ],
  },
  { who: 'sam', puts: [{ id: 's2', fields: { createdAt: 1004, title: 'Shared by Sam', shared: true } }] },
  { who: 'alex', puts: [] },
  { who: 'sam', puts: [{ id: 's2', fields: { shared: false } }] },
  { who: 'alex', puts: [] },
  { who: 'sam', puts: [{ id: 's', fields: { deleted: true } }] },
  { who: 'alex', puts: [] },
  // Alex does not sync while the note is shared, and still gets its id.
  { who: 'sam', puts: [{ id: 's3', fields: { createdAt: 1005, title: 'Shared for a moment' } }] },
  { who: 'sam', puts: [{ id: 's3', fields: { shared: true } }] },
  { who: 'sam', puts: [{ id: 's3', fields: { shared: false } }] },
  { who: 'alex', puts: [] },
  { who: 'sam', puts: [{ id: 'b', fields: { title: 'Sam after the undo', color: 'red', archived: true } }] },
  { who: 'alex', puts: [{ id: 'b', fields: { pinned: false, color: 'blue' } }] },
];

it('answers each note op as the real server does', async () => {
  const alex = await register('Alex');
  const sam = await register('Sam');
  const stub = stubServer();
  let stubSince = 0;
  const clock = hlc.makeClock('parity');

  const ids = { real: { alex: alex.id, sam: sam.id }, stub: { alex: stub.me.id, sam: stub.other.id } };
  const fill = (fields: Record<string, unknown>, side: 'real' | 'stub'): Record<string, unknown> =>
    Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value === '$alex' ? ids[side].alex : value === '$sam' ? ids[side].sam : value]));
  /** The rows of the real server with the ids of the people of the stand-in. */
  const same = (rows: NoteRow[] | undefined): NoteRow[] =>
    (rows ?? [])
      .map((row) => {
        const person = (id: ID | null): ID | null => (id === alex.id ? stub.me.id : id === sam.id ? stub.other.id : id);
        return { ...row, owner: person(row.owner)!, editedBy: person(row.editedBy) };
      })
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  const sorted = (rows: NoteRow[] | undefined): NoteRow[] => [...(rows ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1));
  const realPost = (account: Account, body: object): Promise<SyncAnswer> =>
    post({ fetch: (path, init) => fetch(real.url + String(path), init), cookie: account.cookie, body: { clientId: account.clientId, ...body } });
  const stubPost = (body: object): Promise<SyncAnswer> => post({ fetch: (path, init) => stub.fetch(String(path), init), body: { clientId: 'device-1', ...body } });

  for (const [index, step] of STEPS.entries()) {
    const label = `step ${index}: ${JSON.stringify(step).slice(0, 120)}`;
    const ops = (side: 'real' | 'stub'): Op[] =>
      step.puts.map((put) => ({ kind: 'note', id: put.id, fields: fill(put.fields, side), opId: `op-${index}-${put.id}-${randomUUID()}`, ts: hlc.tick(clock, Date.now()) }));

    if (step.who === 'alex') {
      const realOps = ops('real');
      const stubOps = ops('stub');
      const realAnswer = await realPost(alex, { since: alex.since, ops: realOps });
      const stubAnswer = await stubPost({ since: stubSince, ops: stubOps });
      alex.since = realAnswer.rev;
      stubSince = stubAnswer.rev;
      expect(stubOps.map((op) => stubAnswer.acked.includes(op.opId)), label).toEqual(realOps.map((op) => realAnswer.acked.includes(op.opId)));
      expect(sorted(stubAnswer.notes), label).toEqual(same(realAnswer.notes));
      expect([...(stubAnswer.gone.notes ?? [])].sort(), label).toEqual([...(realAnswer.gone.notes ?? [])].sort());
    } else {
      const realAnswer = await realPost(sam, { since: sam.since, ops: ops('real') });
      sam.since = realAnswer.rev;
      const put = step.puts[0]!;
      expect(stub.putNote({ user: stub.other.id, id: put.id, fields: fill(put.fields, 'stub') }), label).toBe(realAnswer.acked.length === 1);
    }

    // What each person sees on a new device.
    const realAlex = await realPost(alex, { since: 0, ops: [] });
    const stubAlex = await stubPost({ since: 0, ops: [] });
    expect(sorted(stubAlex.notes), label).toEqual(same(realAlex.notes));
    const realSam = await realPost(sam, { since: 0, ops: [] });
    const stubSam = [...stub.notes.keys()].flatMap((id) => stub.noteFor({ user: stub.other.id, id }) ?? []);
    expect(sorted(stubSam), label).toEqual(same(realSam.notes));
  }

  // The steps reach each rule: the two people see notes, and each kind of answer came.
  expect(stub.noteFor({ user: stub.me.id, id: 'a' })).toMatchObject({ title: 'Short again', body: 'B'.repeat(15_999) });
  expect(stub.noteFor({ user: stub.other.id, id: 'b' })).toMatchObject({ title: 'Sam after the undo', color: 'blue', pinned: true, archived: true });
  expect(stub.noteFor({ user: stub.me.id, id: 'b' })).toMatchObject({ pinned: false, archived: true });
});
