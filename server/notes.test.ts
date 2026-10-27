// Notes on the server: a kind of row with its own owner, its own sharing, and two per-person
// fields. A note is not part of a list, so its visibility comes only from its own row.
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { insertUser } from './auth.ts';
import { ROOT } from './config.ts';
import { openDb } from './db.ts';
import type { Db } from './db.ts';
import { pruneTombstones, runSync } from './sync.ts';
import { makeKit, startTestServer } from './testkit.ts';
import type { Kit, Person, TestServer } from './testkit.ts';
import * as hlc from '../shared/hlc.ts';
import { LIMITS, NOTE_COLORS } from '../shared/types.ts';
import type { ID, NoteFields, NoteRow, Op, Put, SyncResponse, User } from '../shared/types.ts';

const DAY = 86_400_000;

let server: TestServer;
let kit: Kit;
let alex: Person;
let sam: Person;
let kim: Person;
// The clock of the server and of the timestamps. The cleanup test moves it, so it runs last.
let clock = Date.now();

beforeAll(async () => {
  server = await startTestServer({ name: 'notes', env: { MAX_USERS: '3' }, options: { now: () => clock } });
  kit = makeKit(server, () => clock);
  alex = await kit.register('Alex');
  sam = await kit.register('Sam');
  kim = await kit.register('Kim');
});
afterAll(() => server.stop());

const setNote = (id: ID, fields: NoteFields): Put => ({ kind: 'note', id, fields });
const nothing = (r: SyncResponse): boolean =>
  r.lists.length + r.tasks.length + r.notes.length + r.gone.lists.length + r.gone.tasks.length + r.gone.notes.length === 0;
const noteIn = (r: SyncResponse, id: ID): NoteRow | undefined => r.notes.find((n) => n.id === id);
/** All rows of a new device of the person. */
const fresh = async (name: string): Promise<SyncResponse> => (await kit.login(name)).sync();
const count = (sql: string, values: string[] = []): number => (server.app.db.q(sql).get(...values) as { n: number }).n;

/** Brings each person to the newest revision, so the next sync of a person shows only what a test did. */
async function settle(): Promise<void> {
  for (const person of [alex, sam, kim]) await person.sync();
}

/** Makes a note of Alex, or of a different owner. Returns its id. */
async function makeNote(input: { shared: boolean; owner?: Person; fields?: NoteFields }): Promise<ID> {
  const put = kit.note({ title: 'A note', body: 'Some text', shared: input.shared, ...input.fields });
  const reply = await (input.owner ?? alex).sync([put]);
  expect(reply.rejected).toEqual([]);
  await settle();
  return put.id;
}

describe('rows', () => {
  test('a put with createdAt makes a note, also with an empty title. The server sets the owner', async () => {
    const put = kit.note({ title: '', body: 'Only a body', owner: sam.user.id, createdAt: 1234 });
    const reply = await alex.sync([put]);
    expect(reply.acked).toHaveLength(1);
    expect(reply.rejected).toEqual([]);
    expect(reply.notes).toEqual([
      {
        id: put.id,
        title: '',
        body: 'Only a body',
        color: 'default',
        shared: false,
        // With no editedAt in the put, the note was last edited when it was made.
        editedAt: 1234,
        editedBy: null,
        deleted: false,
        // The owner is the person of the session.
        owner: alex.user.id,
        createdAt: 1234,
        pinned: false,
        archived: false,
      },
    ]);
    // The answer has exactly the keys of NoteRow, so a device can compare rows as a whole.
    expect(Object.keys(reply.notes[0]!).sort()).toEqual(
      ['id', 'title', 'body', 'color', 'shared', 'editedAt', 'editedBy', 'deleted', 'owner', 'createdAt', 'pinned', 'archived'].sort(),
    );

    // A put with only createdAt makes a note with the defaults.
    const empty = kit.note({});
    expect((await alex.sync([empty])).notes).toEqual([
      expect.objectContaining({ id: empty.id, title: '', body: '', color: 'default', editedAt: clock, editedBy: null }),
    ]);
  });

  test('all fields of a note come back as they were sent', async () => {
    const fields: NoteFields = {
      title: 'Groceries',
      body: 'Milk\nEggs\n\n  Bread  ',
      color: 'darkblue',
      shared: true,
      editedAt: 1_790_000_000_000,
      editedBy: sam.user.id,
      deleted: false,
      createdAt: 1_780_000_000_000,
      pinned: true,
      archived: true,
    };
    const put = kit.note(fields);
    const reply = await alex.sync([put]);
    expect(reply.notes).toEqual([{ id: put.id, ...fields, owner: alex.user.id }]);
    // The per-person fields are the values of Alex only.
    expect((await sam.sync()).notes).toEqual([{ id: put.id, ...fields, owner: alex.user.id, pinned: false, archived: false }]);
  });

  test('a put with no createdAt for a note that is not there is rejected and makes no row', async () => {
    const ids = ['late-note-1', 'late-note-2', 'late-note-3'];
    const reply = await alex.sync([
      // A typed key that arrives after the server removed the note.
      setNote(ids[0]!, { title: 'Typed after the note was removed' }),
      setNote(ids[1]!, { pinned: true, archived: false }),
      // Each field but createdAt.
      setNote(ids[2]!, {
        title: '',
        body: 'x',
        color: 'red',
        shared: false,
        editedAt: clock,
        editedBy: alex.user.id,
        deleted: false,
        owner: alex.user.id,
        pinned: false,
        archived: false,
      }),
    ]);
    expect(reply.acked).toEqual([]);
    expect(reply.rejected).toHaveLength(3);
    expect(reply.notes).toEqual([]);
    expect([...reply.gone.notes].sort()).toEqual(ids);
    expect(count("SELECT COUNT(*) AS n FROM notes WHERE id LIKE 'late-note-%'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM note_user WHERE note_id LIKE 'late-note-%'")).toBe(0);
  });

  test('a note op with the id of a task makes no note and does not change the task', async () => {
    const list = kit.list({ title: 'A list' });
    const task = kit.task({ listId: list.id, title: 'A task' });
    await alex.sync([list, task]);
    const reply = await alex.sync([setNote(task.id, { title: 'Not a task title', deleted: true })]);
    expect(reply.rejected).toHaveLength(1);
    expect(reply.gone).toEqual({ lists: [], tasks: [], notes: [task.id] });
    expect(server.app.db.q('SELECT title, deleted FROM tasks WHERE id = ?').get(task.id)).toEqual({ title: 'A task', deleted: 0 });
  });

  test('the fixed fields do not change after the note is made', async () => {
    const id = await makeNote({ shared: true });
    const was = noteIn(await fresh('Alex'), id);
    const rev = alex.since;
    // The ops are valid, and they change nothing. So no row gets a new revision.
    const reply = await sam.sync([setNote(id, { owner: sam.user.id }), setNote(id, { createdAt: 1 })]);
    expect(reply.acked).toHaveLength(2);
    expect(reply.rev).toBe(rev);
    expect((await alex.sync([setNote(id, { owner: sam.user.id, createdAt: 1 })])).rev).toBe(rev);
    expect(noteIn(await fresh('Alex'), id)).toEqual(was);
  });
});

describe('merge', () => {
  test.each(['Alex first', 'Sam first'])('each field of a note merges by itself (%s)', async (order) => {
    const id = await makeNote({ shared: true });
    // Later than the timestamps of the new rows, and less than one minute ahead of the server.
    const t = clock;
    const fromAlex = kit.op(setNote(id, { title: 'Title from Alex', editedAt: t + 2000, editedBy: alex.user.id }), kit.at(t + 2000, 'alex00'));
    const fromSam = kit.op(
      setNote(id, { title: 'Title from Sam', body: 'Body from Sam', color: 'teal', editedAt: t + 1000, editedBy: sam.user.id }),
      kit.at(t + 1000, 'sam000'),
    );
    if (order === 'Alex first') {
      await alex.sync([fromAlex]);
      await sam.sync([fromSam]);
    } else {
      await sam.sync([fromSam]);
      await alex.sync([fromAlex]);
    }
    // The newer value of each field stays. A text is one value: there is no merge inside it.
    expect(noteIn(await fresh('Kim'), id)).toMatchObject({
      title: 'Title from Alex',
      body: 'Body from Sam',
      color: 'teal',
      editedAt: t + 2000,
      editedBy: alex.user.id,
    });
  });

  test('an op that loses against a newer value gets the true note back, with no new revision', async () => {
    const id = await makeNote({ shared: true });
    await alex.sync([kit.op(setNote(id, { title: 'Newer' }), kit.at(clock + 20_000, 'laptop'))]);
    await sam.sync();
    const rev = sam.since;
    const reply = await sam.sync([kit.op(setNote(id, { title: 'Older' }), kit.at(clock + 5_000, 'phone0'))]);
    expect(reply.acked).toHaveLength(1);
    expect(reply.rev).toBe(rev);
    expect(reply.notes.map((n) => [n.id, n.title])).toEqual([[id, 'Newer']]);
    expect(nothing(await alex.sync())).toBe(true);
  });

  test('an op that arrives two times changes nothing the second time', async () => {
    const id = await makeNote({ shared: true });
    const op = kit.op(setNote(id, { body: 'Sent two times', pinned: true }));
    const first = await alex.sync([op]);
    expect(first.notes).toHaveLength(1);
    const second = await alex.sync([op]);
    expect(second.acked).toEqual([op.opId]);
    expect(second.rev).toBe(first.rev);
    expect(nothing(second)).toBe(true);
    expect((await sam.sync()).notes).toHaveLength(1);
    await alex.sync([op]);
    expect(nothing(await sam.sync())).toBe(true);
  });
});

describe('per-person fields', () => {
  test('pinned and archived have a separate value for each person', async () => {
    const id = await makeNote({ shared: true });
    const phone = await kit.login('Alex');
    await phone.sync();

    const pin = await alex.sync([setNote(id, { pinned: true })]);
    expect(pin.notes).toEqual([expect.objectContaining({ id, pinned: true, archived: false })]);
    // The shared part did not change, so the other people get nothing.
    expect(nothing(await sam.sync())).toBe(true);
    expect(nothing(await kim.sync())).toBe(true);
    // The other device of Alex gets the value.
    expect((await phone.sync()).notes).toEqual([expect.objectContaining({ id, pinned: true, archived: false })]);

    const archive = await sam.sync([setNote(id, { archived: true, pinned: false })]);
    expect(archive.notes).toEqual([expect.objectContaining({ id, pinned: false, archived: true })]);
    expect(nothing(await alex.sync())).toBe(true);
    expect(nothing(await phone.sync())).toBe(true);

    expect(noteIn(await fresh('Alex'), id)).toMatchObject({ pinned: true, archived: false });
    expect(noteIn(await fresh('Sam'), id)).toMatchObject({ pinned: false, archived: true });
    expect(noteIn(await fresh('Kim'), id)).toMatchObject({ pinned: false, archived: false });
  });

  test('a shared change and a per-person change in one op each go to the right people', async () => {
    const id = await makeNote({ shared: true });
    await alex.sync([setNote(id, { title: 'New title', pinned: true })]);
    const forSam = await sam.sync();
    expect(forSam.notes).toEqual([expect.objectContaining({ id, title: 'New title', pinned: false })]);
  });
});

describe('visibility', () => {
  test('a private note never reaches the other people, not as a row and not as an id', async () => {
    const id = await makeNote({ shared: false, fields: { title: 'Hidden plans', body: 'Hidden text' } });
    const brief = kit.note({ title: 'Hidden and brief' });
    const seen: SyncResponse[] = [await fresh('Sam')];
    const step = async (...puts: Put[]): Promise<void> => {
      expect((await alex.sync(puts)).rejected).toEqual([]);
      seen.push(await sam.sync(), await kim.sync());
    };

    await step(setNote(id, { title: 'Hidden plans, changed', pinned: true }));
    await step(setNote(id, { color: 'red', archived: true }));
    await step(setNote(id, { deleted: true }));
    await step(setNote(id, { deleted: false }));
    await step(brief, setNote(brief.id, { deleted: true }));
    seen.push(await fresh('Sam'), await fresh('Kim'));

    for (const reply of seen) {
      const text = JSON.stringify(reply);
      for (const secret of [id, brief.id, 'Hidden']) expect(text).not.toContain(secret);
    }
    // Each sync of the other people between the steps is empty.
    expect(seen.slice(1, -2).every(nothing)).toBe(true);
  });

  test('share: the note arrives. Stop sharing: its id is gone for the others, and no text goes out', async () => {
    const id = await makeNote({ shared: false, fields: { title: 'Surprise party', body: 'Cake and balloons' } });
    await alex.sync([setNote(id, { pinned: true })]);
    await settle();

    const share = await alex.sync([setNote(id, { shared: true })]);
    expect(share.notes).toEqual([expect.objectContaining({ id, shared: true, pinned: true })]);
    for (const person of [sam, kim]) {
      const reply = await person.sync();
      expect(reply.notes).toEqual([
        expect.objectContaining({ id, shared: true, owner: alex.user.id, title: 'Surprise party', pinned: false, archived: false }),
      ]);
      expect(reply.gone).toEqual({ lists: [], tasks: [], notes: [] });
    }
    // Sam pins it for himself and adds to the body.
    await sam.sync([setNote(id, { pinned: true, body: 'Cake, balloons, and music' })]);
    await settle();

    const stop = await alex.sync([setNote(id, { shared: false })]);
    // The owner keeps the note. The server sends it again with the new state.
    expect(stop.gone.notes).toEqual([]);
    expect(stop.notes).toEqual([expect.objectContaining({ id, shared: false, body: 'Cake, balloons, and music', pinned: true })]);
    for (const person of [sam, kim]) {
      const reply = await person.sync();
      expect(reply.notes).toEqual([]);
      expect(reply.gone).toEqual({ lists: [], tasks: [], notes: [id] });
      expect(nothing(await person.sync())).toBe(true);
    }

    // After the end of the share, a change of the owner stays with the owner.
    await alex.sync([setNote(id, { title: 'Surprise party for Sam' })]);
    expect(nothing(await sam.sync())).toBe(true);
    // A late change of Sam is refused, and gives back only the id.
    const late = await sam.sync([setNote(id, { body: 'Typed after the end of the share', archived: true })]);
    expect(late.rejected).toHaveLength(1);
    expect(late.gone.notes).toEqual([id]);
    expect(JSON.stringify(late)).not.toContain('Surprise');
    expect(JSON.stringify(await fresh('Sam'))).not.toContain(id);
    expect(nothing(await alex.sync())).toBe(true);

    // A new share: Sam gets the note again, with his own pin.
    await alex.sync([setNote(id, { shared: true })]);
    const again = await sam.sync();
    expect(again.notes).toEqual([expect.objectContaining({ id, title: 'Surprise party for Sam', pinned: true, archived: false })]);
    expect(again.gone.notes).toEqual([]);
  });

  test('a device that was away for the full time of a share gets the id in gone and no row', async () => {
    const id = await makeNote({ shared: false, fields: { title: 'Shared for a moment' } });
    await alex.sync([setNote(id, { shared: true })]);
    await alex.sync([setNote(id, { shared: false })]);
    const reply = await sam.sync();
    expect(reply.notes).toEqual([]);
    expect(reply.gone.notes).toEqual([id]);
    expect(JSON.stringify(reply)).not.toContain('Shared for a moment');
  });

  test('a note that is shared and private again in one request gives the other people nothing', async () => {
    const id = await makeNote({ shared: false });
    await alex.sync([setNote(id, { shared: true }), setNote(id, { shared: false })]);
    expect(nothing(await sam.sync())).toBe(true);
    expect(nothing(await kim.sync())).toBe(true);
  });

  test('a note that is made and deleted in one request: the other people get nothing, the device gets the id', async () => {
    const made = kit.note({ title: 'Made and deleted', shared: true });
    const reply = await alex.sync([made, setNote(made.id, { deleted: true })]);
    expect(reply.acked).toHaveLength(2);
    expect(reply.notes).toEqual([]);
    expect(reply.gone.notes).toEqual([made.id]);
    // The same in one op: the device merged the delete into the put that makes the note.
    const merged = kit.note({ title: 'Made deleted', shared: true, deleted: true });
    expect((await alex.sync([merged])).gone.notes).toEqual([merged.id]);
    expect(nothing(await sam.sync())).toBe(true);
  });

  test('delete by the owner: the id is gone for each person who saw the note, also on the other device of the owner', async () => {
    const id = await makeNote({ shared: true, fields: { title: 'Soon deleted' } });
    const phone = await kit.login('Alex');
    await phone.sync();
    const away = await kit.login('Sam');
    await away.sync();

    const reply = await alex.sync([setNote(id, { deleted: true })]);
    expect(reply.acked).toHaveLength(1);
    // The device that deleted the note gets the id at once.
    expect(reply.notes).toEqual([]);
    expect(reply.gone).toEqual({ lists: [], tasks: [], notes: [id] });
    for (const device of [phone, sam, kim]) {
      const got = await device.sync();
      expect(got.notes).toEqual([]);
      expect(got.gone).toEqual({ lists: [], tasks: [], notes: [id] });
    }
    // A first sync does not show the deleted note.
    expect(noteIn(await fresh('Alex'), id)).toBeUndefined();
    expect(noteIn(await fresh('Sam'), id)).toBeUndefined();

    // A device of Sam that did not sync after the delete changes the title. The op is valid, and
    // the note stays deleted.
    const late = await away.sync([setNote(id, { title: 'Changed while it was deleted' })]);
    expect(late.acked).toHaveLength(1);
    expect(late.notes).toEqual([]);
    expect(late.gone.notes).toEqual([id]);
    expect(nothing(await alex.sync())).toBe(true);
    expect(server.app.db.q('SELECT title, deleted FROM notes WHERE id = ?').get(id)).toEqual({ title: 'Changed while it was deleted', deleted: 1 });
  });

  test('delete of a private note: only the devices of the owner get the id', async () => {
    const id = await makeNote({ shared: false, owner: sam });
    const laptop = await kit.login('Sam');
    await laptop.sync();
    const reply = await sam.sync([setNote(id, { deleted: true })]);
    expect(reply.gone.notes).toEqual([id]);
    expect((await laptop.sync()).gone.notes).toEqual([id]);
    expect(nothing(await alex.sync())).toBe(true);
    expect(nothing(await kim.sync())).toBe(true);
  });

  test('the undo of a delete sends each field, and brings the note back for each person', async () => {
    const id = await makeNote({ shared: true, fields: { title: 'Back again', body: 'With its body', color: 'purple' } });
    await alex.sync([setNote(id, { pinned: true })]);
    await sam.sync([setNote(id, { archived: true })]);
    await settle();
    const phone = await kit.login('Alex');
    await phone.sync();
    const old = noteIn(await fresh('Alex'), id)!;
    await alex.sync([setNote(id, { deleted: true })]);
    await settle();
    await phone.sync();

    // The undo puts back each field from before the delete, createdAt too.
    const { id: _id, ...fields } = old;
    const undo = await alex.sync([setNote(id, { ...fields, deleted: false })]);
    expect(undo.rejected).toEqual([]);
    expect(undo.notes).toEqual([old]);
    expect(undo.gone.notes).toEqual([]);
    expect((await phone.sync()).notes).toEqual([old]);
    // Sam gets the note back with his own values.
    const back = await sam.sync();
    expect(back.notes).toEqual([{ ...old, pinned: false, archived: true }]);
    expect(back.gone.notes).toEqual([]);
    expect(noteIn(await fresh('Kim'), id)).toEqual({ ...old, pinned: false, archived: false });
  });
});

describe('permissions', () => {
  test('each person can make a note, and is its owner', async () => {
    for (const person of [alex, sam, kim]) {
      const put = kit.note({ title: `Note of ${person.user.name}`, owner: alex.user.id });
      const reply = await person.sync([put]);
      expect(reply.rejected).toEqual([]);
      expect(noteIn(reply, put.id)).toMatchObject({ owner: person.user.id });
    }
  });

  test('title, body, color, editedAt, editedBy of a shared note: each person who can see it', async () => {
    const id = await makeNote({ shared: true });
    const fields: NoteFields = { title: 'Edited by Sam', body: 'Body by Sam', color: 'brown', editedAt: clock, editedBy: sam.user.id };
    const reply = await sam.sync([setNote(id, fields)]);
    expect(reply.rejected).toEqual([]);
    expect(reply.notes).toEqual([expect.objectContaining({ id, ...fields, owner: alex.user.id })]);
    expect((await alex.sync()).notes).toEqual([expect.objectContaining({ id, ...fields })]);
  });

  test('shared and deleted of a note: the owner only', async () => {
    const id = await makeNote({ shared: true, fields: { title: 'Owned by Alex' } });
    const attempts: (Put | Op)[] = [
      setNote(id, { shared: false }),
      setNote(id, { deleted: true }),
      setNote(id, { title: 'Also not', shared: false }),
      setNote(id, { body: 'Also not', deleted: true }),
      setNote(id, { pinned: true, deleted: true }),
      kit.op(setNote(id, { deleted: true }), kit.at(clock + 10 * DAY)),
    ];
    for (const attempt of attempts) {
      const reply = await sam.sync([attempt]);
      expect(reply.acked).toEqual([]);
      expect(reply.rejected).toHaveLength(1);
      // The true note comes back, so the device of Sam drops its change.
      expect(reply.notes).toEqual([
        expect.objectContaining({ id, title: 'Owned by Alex', body: 'Some text', shared: true, deleted: false, pinned: false }),
      ]);
    }
    expect(nothing(await alex.sync())).toBe(true);
    expect(count('SELECT COUNT(*) AS n FROM note_user WHERE note_id = ? AND user_id = ?', [id, sam.user.id])).toBe(0);
  });

  test('in an op of a different person, a value of shared or deleted equal to the stored value is no change', async () => {
    const id = await makeNote({ shared: true });
    const t = clock;
    const same = await sam.sync([kit.op(setNote(id, { title: 'Good', shared: true, deleted: false }), kit.at(t + 5000, 'sam000'))]);
    expect(same.rejected).toEqual([]);
    expect(same.notes).toEqual([expect.objectContaining({ id, title: 'Good', shared: true, deleted: false })]);
    // The equal values did not take the timestamp of Sam, so an older change of the owner still applies.
    const stop = await alex.sync([kit.op(setNote(id, { shared: false }), kit.at(t + 1000, 'alex00'))]);
    expect(stop.rejected).toEqual([]);
    expect(stop.notes).toEqual([expect.objectContaining({ id, title: 'Good', shared: false })]);
    expect((await sam.sync()).gone.notes).toEqual([id]);
    expect((await alex.sync([setNote(id, { deleted: true })])).rejected).toEqual([]);
  });

  test('pinned and archived: each person who can see the note, for that person only', async () => {
    const shared = await makeNote({ shared: true });
    const secret = await makeNote({ shared: false });
    const ok = await sam.sync([setNote(shared, { pinned: true, archived: true })]);
    expect(ok.rejected).toEqual([]);
    expect(ok.notes).toEqual([expect.objectContaining({ id: shared, pinned: true, archived: true })]);
    expect(nothing(await alex.sync())).toBe(true);

    const no = await sam.sync([setNote(secret, { pinned: true }), setNote(secret, { archived: true })]);
    expect(no.rejected).toHaveLength(2);
    expect(no.notes).toEqual([]);
    expect(no.gone.notes).toEqual([secret]);
    expect(count('SELECT COUNT(*) AS n FROM note_user WHERE note_id = ? AND user_id = ?', [secret, sam.user.id])).toBe(0);
    expect(nothing(await alex.sync())).toBe(true);
  });
});

describe('values', () => {
  test('each color of NOTE_COLORS is valid, and a different color is not', async () => {
    const puts = NOTE_COLORS.map((color) => kit.note({ title: `Color ${color}`, color }));
    const reply = await alex.sync(puts);
    expect(reply.rejected).toEqual([]);
    expect(puts.map((p) => noteIn(reply, p.id)?.color)).toEqual([...NOTE_COLORS]);

    // A put that makes a note with a wrong value makes no row.
    const bad = [
      kit.note({ title: 'Unknown color', color: 'neon' as never }),
      kit.note({ title: 'Color in capitals', color: 'Red' as never }),
      kit.note({ title: 'Body as a number', body: 7 as never }),
      kit.note({ title: 'Pin as text', pinned: 'yes' as never }),
      kit.note({ title: 'Wrong time', createdAt: 'now' as never }),
    ];
    const tried = await alex.sync(bad);
    expect(tried.acked).toEqual([]);
    expect(tried.rejected).toHaveLength(bad.length);
    expect([...tried.gone.notes].sort()).toEqual(bad.map((p) => p.id).sort());
    for (const put of bad) expect(count('SELECT COUNT(*) AS n FROM notes WHERE id = ?', [put.id])).toBe(0);

    // On a note that is there: the op is rejected, and the device gets the true note back.
    const id = puts[1]!.id;
    const before = noteIn(await fresh('Alex'), id);
    const change = await alex.sync([setNote(id, { title: 'Must not apply', color: 'neon' as never })]);
    expect(change.rejected).toHaveLength(1);
    expect(change.notes).toEqual([before]);
  });

  test('text that is too long is cut', async () => {
    const long = kit.note({ title: 'T'.repeat(LIMITS.noteTitle + 500), body: 'B'.repeat(LIMITS.noteBody + 500) });
    const emoji = kit.note({ title: 'x'.repeat(LIMITS.noteTitle - 1) + '🍉', body: 'y'.repeat(LIMITS.noteBody - 1) + '🍉' });
    const reply = await alex.sync([long, emoji]);
    expect(reply.rejected).toEqual([]);
    expect(noteIn(reply, long.id)).toMatchObject({ title: 'T'.repeat(LIMITS.noteTitle), body: 'B'.repeat(LIMITS.noteBody) });
    // The cut does not leave half of a character.
    expect(noteIn(reply, emoji.id)).toMatchObject({ title: 'x'.repeat(LIMITS.noteTitle - 1), body: 'y'.repeat(LIMITS.noteBody - 1) });
  });
});

describe('since', () => {
  test('a first sync gets all visible notes and no gone ids', async () => {
    const shared = await makeNote({ shared: true });
    const ofSam = await makeNote({ shared: false, owner: sam });
    const secret = await makeNote({ shared: false });
    const deleted = await makeNote({ shared: true });
    const unshared = await makeNote({ shared: true });
    await alex.sync([setNote(deleted, { deleted: true }), setNote(unshared, { shared: false })]);

    const device = await kit.login('Sam');
    const reply = await device.sync();
    expect(reply.reset).toBe(false);
    expect(reply.gone).toEqual({ lists: [], tasks: [], notes: [] });
    const ids = reply.notes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining([shared, ofSam]));
    for (const id of [secret, deleted, unshared]) expect(ids).not.toContain(id);
    // The answer has each note that Sam can see, and no other.
    const visible = server.app.db.q('SELECT id FROM notes WHERE deleted = 0 AND (owner = ? OR shared = 1)').all(sam.user.id) as { id: ID }[];
    expect([...ids].sort()).toEqual(visible.map((r) => r.id).sort());
    expect(reply.rev).toBe(alex.since);
    expect(nothing(await device.sync())).toBe(true);
  });

  test('a sync after a revision gets only the notes that changed after it', async () => {
    const ids = [await makeNote({ shared: true }), await makeNote({ shared: true }), await makeNote({ shared: false })] as [ID, ID, ID];
    const phone = await kit.login('Alex');
    expect((await phone.sync()).notes.length).toBeGreaterThan(3);

    await alex.sync([setNote(ids[0], { body: 'Changed' })]);
    expect((await phone.sync()).notes.map((n) => [n.id, n.body])).toEqual([[ids[0], 'Changed']]);
    expect((await sam.sync()).notes.map((n) => [n.id, n.body])).toEqual([[ids[0], 'Changed']]);
    // A per-person change reaches only the devices of that person.
    await alex.sync([setNote(ids[2], { archived: true })]);
    expect((await phone.sync()).notes.map((n) => [n.id, n.archived])).toEqual([[ids[2], true]]);
    expect(nothing(await sam.sync())).toBe(true);
    // A change of Sam reaches Alex one time.
    await sam.sync([setNote(ids[1], { color: 'gray' })]);
    expect((await phone.sync()).notes.map((n) => [n.id, n.color])).toEqual([[ids[1], 'gray']]);
    expect(nothing(await phone.sync())).toBe(true);
  });
});

interface MemoryWorld {
  db: Db;
  alexId: ID;
  samId: ID;
  /** One sync of the person with these puts, one second after the sync before. */
  send(userId: ID, puts: Put[]): ReturnType<typeof runSync>;
  time(): number;
}

/** A database in memory with two accounts, for the tests that look at one function. */
function memoryWorld(): MemoryWorld {
  const db = openDb(':memory:');
  const password = { hash: Buffer.alloc(32), salt: Buffer.alloc(16) };
  const start = Date.UTC(2026, 9, 6, 8);
  const [first, second] = ['Alex', 'Sam'].map((name, i) => insertUser({ db, name, password, now: start + i })) as [User, User];
  let time = start + 1000;
  return {
    db,
    alexId: first.id,
    samId: second.id,
    send(userId, puts) {
      time += 1000;
      const ops = puts.map((p) => ({ ...p, opId: randomUUID(), ts: hlc.encode({ ms: time, counter: 0, node: 'unit00' }) }));
      return runSync({ db, userId, request: { since: 0, ops }, now: time });
    },
    time: () => time,
  };
}

/** A put that makes a note. */
const makePut = (id: ID, fields: NoteFields): Put => ({ kind: 'note', id, fields: { createdAt: 1, ...fields } });

describe('pokes', () => {
  test('a shared note pokes each person, a private note pokes its owner, and the end of a share pokes each person', () => {
    const { db, alexId, samId, send } = memoryWorld();
    try {
      const poke = (userId: ID, put: Put): unknown => send(userId, [put]).poke;
      expect(poke(alexId, makePut('private-note', { title: 'Private' }))).toEqual([alexId]);
      expect(poke(alexId, makePut('shared-note', { title: 'Shared', shared: true }))).toBe('all');
      expect(poke(alexId, setNote('private-note', { body: 'Changed' }))).toEqual([alexId]);
      expect(poke(samId, setNote('shared-note', { body: 'From Sam' }))).toBe('all');
      // A per-person change: only the devices of that person.
      expect(poke(samId, setNote('shared-note', { pinned: true }))).toEqual([samId]);
      expect(poke(alexId, setNote('private-note', { archived: true }))).toEqual([alexId]);
      // No change, and refused ops: no poke.
      expect(poke(alexId, setNote('private-note', { body: 'Changed' }))).toBeNull();
      expect(poke(samId, setNote('private-note', { title: 'Not permitted' }))).toBeNull();
      expect(poke(samId, setNote('shared-note', { deleted: true }))).toBeNull();
      // The person who gets the note and the person who loses it must sync.
      expect(poke(alexId, setNote('private-note', { shared: true }))).toBe('all');
      expect(poke(alexId, setNote('private-note', { shared: false }))).toBe('all');
      expect(poke(alexId, setNote('shared-note', { deleted: true }))).toBe('all');
      expect(poke(alexId, setNote('private-note', { deleted: true }))).toEqual([alexId]);
    } finally {
      db.close();
    }
  });
});

describe('the notes migration', () => {
  test('a database of version 1 gets the note tables and keeps its rows. The entry can run again', () => {
    const dir = path.join(ROOT, '.tmp', `test-notes-db-${process.pid}-${Date.now().toString(36)}`);
    const file = path.join(dir, 'shared-tasks.db');
    try {
      let db = openDb(file);
      const user = insertUser({ db, name: 'Alex', password: { hash: Buffer.alloc(32), salt: Buffer.alloc(16) }, now: 1 });
      // The database of a server from before notes.
      db.sql.exec('DROP TABLE note_user; DROP TABLE notes; PRAGMA user_version = 1;');
      db.close();

      db = openDb(file);
      const version = (): number => (db.sql.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      const names = (): string[] =>
        (db.q("SELECT name FROM sqlite_master WHERE name LIKE 'note%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
      expect(version()).toBe(2);
      expect(names()).toEqual(['note_user', 'note_user_lost', 'note_user_rev', 'notes', 'notes_rev']);
      expect(db.q('SELECT COUNT(*) AS n FROM lists WHERE owner = ?').get(user.id)).toEqual({ n: 1 });
      const op: Op = { ...makePut('note-1', { title: 'Kept' }), opId: 'op-1', ts: hlc.encode({ ms: 5, counter: 0, node: 'unit00' }) };
      const made = runSync({ db, userId: user.id, request: { since: 0, ops: [op] }, now: 5 });
      expect(made.response.notes.map((n) => n.title)).toEqual(['Kept']);

      // A way back sets the version to 1. The entry then runs again over the tables that are there.
      db.sql.exec('PRAGMA user_version = 1');
      db.close();
      db = openDb(file);
      expect(version()).toBe(2);
      expect(names()).toEqual(['note_user', 'note_user_lost', 'note_user_rev', 'notes', 'notes_rev']);
      expect(db.q('SELECT title FROM notes').all()).toEqual([{ title: 'Kept' }]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cleanup of old deleted notes', () => {
  test('pruneTombstones removes old deleted notes with their per-person rows, and pruned_rev rises to their newest gone mark', () => {
    const { db, alexId, samId, send, time } = memoryWorld();
    try {
      send(alexId, [makePut('old-shared', { shared: true }), makePut('old-private', {}), makePut('kept', { shared: true })]);
      send(samId, [setNote('old-shared', { pinned: true })]);
      const sharedDelete = send(alexId, [setNote('old-shared', { deleted: true })]);
      const privateDelete = send(alexId, [setNote('old-private', { deleted: true })]);
      // Each person who saw the note has a mark.
      expect(db.q('SELECT user_id, lost_rev FROM note_user WHERE note_id = ? ORDER BY user_id').all('old-shared')).toEqual(
        [alexId, samId].sort().map((user_id) => ({ user_id, lost_rev: sharedDelete.response.rev })),
      );

      expect(pruneTombstones({ db, now: time() + 179 * DAY })).toBe(0);
      expect(db.getMeta('pruned_rev')).toBeNull();
      expect(pruneTombstones({ db, now: time() + 181 * DAY })).toBe(2);
      expect(db.q('SELECT id FROM notes').all()).toEqual([{ id: 'kept' }]);
      expect(db.q("SELECT COUNT(*) AS n FROM note_user WHERE note_id LIKE 'old-%'").get()).toEqual({ n: 0 });
      // The newest mark of the removed notes is the delete of the private note.
      expect(Number(db.getMeta('pruned_rev'))).toBe(privateDelete.response.rev);
    } finally {
      db.close();
    }
  });

  test('a device that missed the delete of a removed note starts again, and the undo of the delete makes the note again', async () => {
    const doomed = await makeNote({ shared: true, fields: { title: 'Doomed' } });
    const kept = await makeNote({ shared: true });
    await sam.sync([setNote(doomed, { pinned: true })]);
    await settle();
    const away = await kit.login('Kim');
    await away.sync();
    const stale = away.since;

    const deleted = await alex.sync([setNote(doomed, { deleted: true })]);
    await settle();
    const current = kim.since;
    const { db } = server.app;
    const exists = (sql: string): boolean => count(sql, [doomed]) > 0;

    // After 179 days the note is still there, and a device that was away gets the id.
    clock += 179 * DAY;
    server.maintain();
    expect(exists('SELECT COUNT(*) AS n FROM notes WHERE id = ?')).toBe(true);
    const normal = (await away.call<SyncResponse>('/api/sync', { clientId: away.clientId, since: stale, ops: [], tz: 'UTC' })).data;
    expect(normal.reset).toBe(false);
    expect(normal.gone.notes).toEqual([doomed]);

    clock += 2 * DAY;
    server.maintain();
    expect(exists('SELECT COUNT(*) AS n FROM notes WHERE id = ?')).toBe(false);
    expect(exists('SELECT COUNT(*) AS n FROM note_user WHERE note_id = ?')).toBe(false);
    expect(count('SELECT COUNT(*) AS n FROM notes WHERE id = ?', [kept])).toBe(1);
    expect(Number(db.getMeta('pruned_rev'))).toBeGreaterThanOrEqual(deleted.rev);

    // The device that was away cannot learn that the note is gone. It gets all rows and 'reset'.
    away.since = stale;
    const reply = await away.sync();
    expect(reply.reset).toBe(true);
    expect(reply.gone).toEqual({ lists: [], tasks: [], notes: [] });
    expect(reply.notes.map((n) => n.id)).toContain(kept);
    expect(reply.notes.map((n) => n.id)).not.toContain(doomed);
    expect((await away.sync()).reset).toBe(false);
    // A device that did sync after the delete continues as usual.
    kim.since = current;
    const usual = await kim.sync();
    expect(usual.reset).toBe(false);
    expect(nothing(usual)).toBe(true);

    // A late change of the removed note makes nothing.
    const late = await sam.sync([setNote(doomed, { title: 'Too late' })]);
    expect(late.rejected).toHaveLength(1);
    expect(late.gone.notes).toEqual([doomed]);
    expect(exists('SELECT COUNT(*) AS n FROM notes WHERE id = ?')).toBe(false);
    // The undo of the delete has createdAt, so it makes the note again. The per-person values start again.
    const undo = await alex.sync([kit.note({ title: 'Doomed', body: 'Some text', shared: true, deleted: false, createdAt: 5 }, doomed)]);
    expect(undo.notes).toEqual([expect.objectContaining({ id: doomed, title: 'Doomed', createdAt: 5, owner: alex.user.id })]);
    expect((await sam.sync()).notes).toEqual([expect.objectContaining({ id: doomed, title: 'Doomed', pinned: false })]);
  });
});
