import { createECDH } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { encryptPayload } from './push.ts';
import { cleanNotifLog, localStamp, timeZoneOf } from './scheduler.ts';
import type { SendFn } from './scheduler.ts';
import { makeKit, startTestServer } from './testkit.ts';
import type { Kit, Person, TestServer } from './testkit.ts';
import type { ID, PushMessage, TaskFields } from '../shared/types.ts';

// The tests run on 2026-10-06. On that day Berlin is 2 hours ahead of UTC and New York is 4 hours behind.
const TODAY = '2026-10-06';
const TOMORROW = '2026-10-07';
/** A moment of the test day, given as UTC. */
const utc = (hour: number, minute = 0, second = 0): number => Date.UTC(2026, 9, 6, hour, minute, second);

interface World {
  server: TestServer;
  kit: Kit;
  alex: Person;
  sam: Person;
  /** The default list of Alex, the default list of Sam, and a list that Alex shares. */
  home: ID;
  samHome: ID;
  groceries: ID;
  /** Each message that the server sent, with the device that got it. */
  sent: { device: string; message: PushMessage }[];
  /** The answer of the push service for each device. Default: 201. */
  status: Record<string, number>;
  /** Moves the clock, runs the scheduler one time, and gives the messages of this run as 'device: title | body'. */
  at(ms: number): Promise<string[]>;
  subscribe(person: Person, device: string): Promise<void>;
  addTask(fields: TaskFields, person?: Person): Promise<ID>;
  restart(): Promise<void>;
}

// Each server of a test, also if the test failed before its world was complete.
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

/** A server with two people. Alex is in Berlin, Sam is in New York. Each has one device with notifications. */
async function makeWorld(input: { start?: number; subscribe?: boolean } = {}): Promise<World> {
  let clock = input.start ?? utc(5);
  const sent: World['sent'] = [];
  const status: Record<string, number> = {};
  const send: SendFn = async ({ subscription, message }) => {
    const device = subscription.endpoint.split('/').pop()!;
    const code = status[device] ?? 201;
    if (code >= 200 && code < 300) sent.push({ device, message });
    return { status: code };
  };
  const options = { now: () => clock, send };
  let server = await startTestServer({ name: 'scheduler', options });
  stops.push(() => server.stop());
  const kit = makeKit(server, () => clock);
  const alex = await kit.register('Alex');
  const sam = await kit.register('Sam');
  sam.tz = 'America/New_York';
  const groceries = kit.list({ title: 'Groceries', shared: true });
  const home = (await alex.sync([groceries])).lists.find((l) => l.isDefault)!.id;
  const samHome = (await sam.sync()).lists.find((l) => l.isDefault)!.id;

  const world: World = {
    server,
    kit,
    alex,
    sam,
    home,
    samHome,
    groceries: groceries.id,
    sent,
    status,
    async at(ms) {
      clock = ms;
      const before = sent.length;
      const count = await world.server.scheduler.tick();
      const fresh = sent.slice(before);
      expect(count).toBeLessThanOrEqual(fresh.length);
      return fresh.map((s) => `${s.device}: ${s.message.title} | ${s.message.body}`).sort();
    },
    async subscribe(person, device) {
      const ecdh = createECDH('prime256v1');
      ecdh.generateKeys();
      const reply = await person.call('/api/push/subscribe', {
        endpoint: `https://push.example.net/send/${device}`,
        keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') },
      });
      expect(reply.status).toBe(200);
    },
    async addTask(fields, person = alex) {
      const task = kit.task({ listId: home, title: 'Task', ...fields });
      expect((await person.sync([task])).rejected).toEqual([]);
      return task.id;
    },
    async restart() {
      await world.server.stop({ keep: true });
      server = await startTestServer({ name: 'scheduler', dir: server.dir, options });
      world.server = server;
    },
  };
  if (input.subscribe !== false) {
    await world.subscribe(alex, 'alex-phone');
    await world.subscribe(sam, 'sam-phone');
  }
  return world;
}

describe('the time of a notification', () => {
  test('a task with a date and a time: at that time', async () => {
    const world = await makeWorld();
    const id = await world.addTask({ title: 'Call the dentist', due: TODAY, time: '09:30' });
    expect(await world.at(utc(7, 29, 59))).toEqual([]);
    expect(await world.at(utc(7, 30, 0))).toEqual(['alex-phone: Call the dentist | My Tasks, 09:30']);
    expect(world.sent[0]!.message).toEqual({
      title: 'Call the dentist',
      body: 'My Tasks, 09:30',
      taskId: id,
      listId: world.home,
      tag: `due-${id}`,
    });
    // One notification only.
    expect(await world.at(utc(7, 30, 20))).toEqual([]);
    expect(await world.at(utc(7, 31))).toEqual([]);
    expect(await world.at(utc(15))).toEqual([]);
  });

  test('a task with a date and no time: at 09:00', async () => {
    const world = await makeWorld();
    await world.addTask({ title: 'Pay the bill', due: TODAY });
    await world.addTask({ title: 'For tomorrow', due: TOMORROW });
    expect(await world.at(utc(6, 59, 40))).toEqual([]);
    expect(await world.at(utc(7, 0, 0))).toEqual(['alex-phone: Pay the bill | My Tasks']);
    expect(await world.at(utc(7, 0, 20))).toEqual([]);
    expect(await world.at(utc(7, 0) + 86_400_000)).toEqual(['alex-phone: For tomorrow | My Tasks']);
  });

  test('a task with a deadline: at 09:00 on that day, and separate from the date', async () => {
    const world = await makeWorld();
    const id = await world.addTask({ title: 'Send the documents', deadline: TODAY });
    await world.addTask({ title: 'Both', due: TODAY, time: '10:15', deadline: TODAY });
    expect(await world.at(utc(6, 59))).toEqual([]);
    expect(await world.at(utc(7, 0))).toEqual(['alex-phone: Both | Deadline today', 'alex-phone: Send the documents | Deadline today']);
    expect(world.sent.find((s) => s.message.taskId === id)!.message.tag).toBe(`deadline-${id}`);
    expect(await world.at(utc(8, 14))).toEqual([]);
    expect(await world.at(utc(8, 15))).toEqual(['alex-phone: Both | My Tasks, 10:15']);
    expect(await world.at(utc(8, 16))).toEqual([]);
  });

  test('each person gets it in the time zone of that person', async () => {
    const world = await makeWorld();
    await world.addTask({ listId: world.groceries, title: 'Milk', due: TODAY });
    await world.addTask({ listId: world.groceries, title: 'Evening', due: TODAY, time: '21:30' });
    // 09:00 in Berlin is 07:00 UTC. 09:00 in New York is 13:00 UTC.
    expect(await world.at(utc(6, 59))).toEqual([]);
    expect(await world.at(utc(7, 0))).toEqual(['alex-phone: Milk | Groceries']);
    expect(await world.at(utc(12, 59))).toEqual([]);
    expect(await world.at(utc(13, 0))).toEqual(['sam-phone: Milk | Groceries']);
    // 21:30 in Berlin is 19:30 UTC. 21:30 in New York is 01:30 UTC on the next day.
    expect(await world.at(utc(19, 29))).toEqual([]);
    expect(await world.at(utc(19, 30))).toEqual(['alex-phone: Evening | Groceries, 21:30']);
    expect(await world.at(utc(25, 29))).toEqual([]);
    expect(await world.at(utc(25, 30))).toEqual(['sam-phone: Evening | Groceries, 21:30']);
  });

  test('a private list: only the owner. A shared list: each person', async () => {
    const world = await makeWorld();
    await world.addTask({ title: 'Private of Alex', due: TODAY });
    await world.addTask({ listId: world.samHome, title: 'Private of Sam', due: TODAY }, world.sam);
    await world.addTask({ listId: world.groceries, title: 'For the two', due: TODAY }, world.sam);
    expect(await world.at(utc(7))).toEqual(['alex-phone: For the two | Groceries', 'alex-phone: Private of Alex | My Tasks']);
    expect(await world.at(utc(13))).toEqual(['sam-phone: For the two | Groceries', 'sam-phone: Private of Sam | My Tasks']);
  });

  test('each device of a person gets the notification', async () => {
    const world = await makeWorld();
    const laptop = await world.kit.login('Alex');
    await world.subscribe(laptop, 'alex-laptop');
    await world.addTask({ title: 'Two devices', due: TODAY });
    expect(await world.at(utc(7))).toEqual(['alex-laptop: Two devices | My Tasks', 'alex-phone: Two devices | My Tasks']);
    expect(await world.at(utc(7, 1))).toEqual([]);
  });
});

describe('no notification', () => {
  test('for a completed, deleted, or resting task, and for a task in a deleted list', async () => {
    const world = await makeWorld();
    const { kit, alex } = world;
    const repeat = { every: 1, unit: 'day', start: '2026-10-05', end: { type: 'never' } } as const;
    const doomed = kit.list({ title: 'Doomed' });
    await alex.sync([doomed]);
    await world.addTask({ title: 'Completed', due: TODAY, deadline: TODAY, completed: true, completedAt: utc(5) });
    await world.addTask({ title: 'Deleted', due: TODAY, deadline: TODAY, deleted: true });
    // The task was done for today already. It rests until its next date.
    await world.addTask({ title: 'Resting', due: TOMORROW, hiddenUntil: TOMORROW, deadline: TODAY, repeat, repeatCount: 1 });
    await world.addTask({ listId: doomed.id, title: 'In a deleted list', due: TODAY, deadline: TODAY });
    await world.addTask({ title: 'Repeats and is open', due: TODAY, repeat });
    await world.addTask({ title: 'Open', due: TODAY });
    await alex.sync([{ kind: 'list', id: doomed.id, fields: { deleted: true } }]);

    expect(await world.at(utc(7))).toEqual(['alex-phone: Open | My Tasks', 'alex-phone: Repeats and is open | My Tasks']);
    expect(await world.at(utc(12))).toEqual([]);
    // On the next day the resting task is open again and rings.
    expect(await world.at(utc(7) + 86_400_000)).toEqual(['alex-phone: Resting | My Tasks']);
  });

  test('that is more than 12 hours late', async () => {
    const late = await makeWorld();
    await late.addTask({ title: 'Morning', due: TODAY });
    await late.addTask({ title: 'With a time', due: TODAY, time: '09:10' });
    // The server did not run from 07:00 to 21:01 in Berlin.
    expect(await late.at(utc(19, 1))).toEqual(['alex-phone: With a time | My Tasks, 09:10']);
    expect(await late.at(utc(19, 11))).toEqual([]);
    expect(await late.at(utc(30))).toEqual([]);

    const inTime = await makeWorld();
    await inTime.addTask({ title: 'Morning', due: TODAY });
    expect(await inTime.at(utc(19, 0))).toEqual(['alex-phone: Morning | My Tasks']);
  });

  test('a second time after a restart of the server', async () => {
    const world = await makeWorld();
    await world.addTask({ title: 'Before the restart', due: TODAY });
    await world.addTask({ title: 'After the restart', due: TODAY, time: '11:00' });
    expect(await world.at(utc(7))).toEqual(['alex-phone: Before the restart | My Tasks']);

    await world.restart();
    expect(await world.at(utc(7, 0, 20))).toEqual([]);
    expect(await world.at(utc(8))).toEqual([]);
    expect(await world.at(utc(9))).toEqual(['alex-phone: After the restart | My Tasks, 11:00']);
    await world.restart();
    expect(await world.at(utc(9, 1))).toEqual([]);
  });

  test('for a task that gets its date after the time of the notification', async () => {
    const world = await makeWorld({ start: utc(8) });
    // It is 10:00 in Berlin. 09:00 is over, and a task for today must not ring at once.
    const id = await world.addTask({ title: 'Made at ten', due: TODAY });
    const done = await world.addTask({ title: 'Done early', due: TODAY, time: '10:01', completed: true });
    expect(await world.at(utc(8, 0, 20))).toEqual([]);
    // The task becomes open again after its time: no notification.
    await world.at(utc(8, 2));
    await world.alex.sync([{ kind: 'task', id: done, fields: { completed: false } }]);
    expect(await world.at(utc(8, 2, 20))).toEqual([]);
    // A new time that is still to come gives a notification.
    await world.alex.sync([{ kind: 'task', id, fields: { time: '10:30' } }]);
    expect(await world.at(utc(8, 29))).toEqual([]);
    expect(await world.at(utc(8, 30))).toEqual(['alex-phone: Made at ten | My Tasks, 10:30']);
  });

  test('to a device that subscribed after the time of the notification', async () => {
    const world = await makeWorld({ subscribe: false });
    await world.addTask({ title: 'Morning', due: TODAY });
    await world.addTask({ title: 'Noon', due: TODAY, time: '12:00' });
    expect(await world.at(utc(7))).toEqual([]);
    await world.at(utc(7, 30));
    await world.subscribe(world.alex, 'alex-phone');
    expect(await world.at(utc(7, 31))).toEqual([]);
    expect(await world.at(utc(10))).toEqual(['alex-phone: Noon | My Tasks, 12:00']);
  });

  test('to a person who got the list after the time of the notification', async () => {
    const world = await makeWorld();
    const list = world.kit.list({ title: 'Trip' });
    await world.alex.sync([list]);
    await world.addTask({ listId: list.id, title: 'Pack', due: TODAY, time: '09:00' });
    expect(await world.at(utc(7))).toEqual(['alex-phone: Pack | Trip, 09:00']);
    // Alex shares the list at 15:30 in Berlin, which is 09:30 in New York.
    await world.at(utc(13, 30));
    await world.alex.sync([{ kind: 'list', id: list.id, fields: { shared: true } }]);
    expect(await world.at(utc(13, 31))).toEqual([]);
  });
});

describe('the push service', () => {
  test('a subscription that the service does not know any more is deleted', async () => {
    const world = await makeWorld();
    const laptop = await world.kit.login('Alex');
    await world.subscribe(laptop, 'alex-laptop');
    const tablet = await world.kit.login('Alex');
    await world.subscribe(tablet, 'alex-tablet');
    world.status['alex-laptop'] = 410;
    world.status['alex-tablet'] = 404;
    await world.addTask({ title: 'First', due: TODAY });
    await world.addTask({ title: 'Second', due: TODAY });
    expect(await world.at(utc(7))).toEqual(['alex-phone: First | My Tasks', 'alex-phone: Second | My Tasks']);
    const left = world.server.app.db.q('SELECT endpoint FROM push_subs WHERE user_id = ?').all(world.alex.user.id);
    expect(left).toEqual([{ endpoint: 'https://push.example.net/send/alex-phone' }]);

    // The only device of Sam is gone. 15:00 in New York is 19:00 UTC.
    world.status['sam-phone'] = 410;
    await world.addTask({ listId: world.groceries, title: 'Shared', due: TODAY, time: '15:00' });
    expect(await world.at(utc(13))).toEqual(['alex-phone: Shared | Groceries, 15:00']);
    expect(await world.at(utc(19))).toEqual([]);
    expect(world.server.app.db.q('SELECT 1 FROM push_subs WHERE user_id = ?').get(world.sam.user.id)).toBeUndefined();
    // A new subscription of Sam does not get the old notification.
    delete world.status['sam-phone'];
    await world.subscribe(world.sam, 'sam-phone');
    expect(await world.at(utc(19, 1))).toEqual([]);
  });

  test('after an error of the service, the next tick tries again', async () => {
    const world = await makeWorld();
    await world.addTask({ title: 'Try again', due: TODAY });
    world.status['alex-phone'] = 500;
    expect(await world.at(utc(7))).toEqual([]);
    world.status['alex-phone'] = 0;
    expect(await world.at(utc(7, 0, 20))).toEqual([]);
    world.status['alex-phone'] = 429;
    expect(await world.at(utc(7, 0, 40))).toEqual([]);
    delete world.status['alex-phone'];
    expect(await world.at(utc(7, 1))).toEqual(['alex-phone: Try again | My Tasks']);
    expect(await world.at(utc(7, 1, 20))).toEqual([]);
  });

  test('after a refusal that would come again, there is no second try', async () => {
    const world = await makeWorld();
    await world.addTask({ title: 'Refused', due: TODAY });
    world.status['alex-phone'] = 403;
    expect(await world.at(utc(7))).toEqual([]);
    delete world.status['alex-phone'];
    expect(await world.at(utc(7, 0, 20))).toEqual([]);
    // The subscription stays: the refusal was for the message.
    expect(world.server.app.db.q('SELECT COUNT(*) AS n FROM push_subs').get()).toEqual({ n: 2 });
  });

  test('the message has a short title, and a text for a task with no title', async () => {
    const world = await makeWorld();
    await world.addTask({ title: 'Long '.repeat(100), due: TODAY });
    await world.addTask({ title: '   ', due: TODAY, time: '09:00' });
    await world.at(utc(7));
    expect(world.sent.map((s) => s.message.title).sort()).toEqual(['Long '.repeat(100).slice(0, 120), 'Task']);
  });

  test('the longest title and list name go into one push message', async () => {
    const world = await makeWorld();
    // These characters take the most bytes in the JSON text of a message.
    const list = world.kit.list({ title: '\u0001'.repeat(1024) }, 'l'.repeat(64));
    await world.alex.sync([list]);
    const task = world.kit.task({ listId: list.id, title: '\u0001'.repeat(1024), due: TODAY, time: '09:00', deadline: TODAY }, 't'.repeat(64));
    await world.alex.sync([task]);
    await world.at(utc(7));
    expect(world.sent).toHaveLength(2);
    const p256dh = createECDH('prime256v1').generateKeys().toString('base64url');
    const auth = Buffer.alloc(16, 7).toString('base64url');
    for (const { message } of world.sent) {
      expect(message.title).toHaveLength(120);
      expect(message.body.length).toBeLessThanOrEqual(87);
      // encryptPayload throws if the text does not go into one message.
      expect(encryptPayload({ payload: JSON.stringify(message), p256dh, auth }).length).toBeLessThan(4096);
    }
  });

  test('a new date gives a new notification', async () => {
    const world = await makeWorld();
    const id = await world.addTask({ title: 'Moved', due: TODAY });
    expect(await world.at(utc(7))).toEqual(['alex-phone: Moved | My Tasks']);
    await world.alex.sync([{ kind: 'task', id, fields: { due: TOMORROW } }]);
    expect(await world.at(utc(8))).toEqual([]);
    expect(await world.at(utc(7) + 86_400_000)).toEqual(['alex-phone: Moved | My Tasks']);
  });
});

describe('midnight, daylight saving time, and no time zone', () => {
  test('a time near midnight uses the local day of the person', async () => {
    // 19:00 UTC is 21:00 in Berlin and 15:00 in New York.
    const world = await makeWorld({ start: utc(19) });
    await world.addTask({ listId: world.groceries, title: 'Last minute', due: TODAY, time: '23:59' });
    await world.addTask({ listId: world.groceries, title: 'First minute', due: TOMORROW, time: '00:00' });
    await world.addTask({ listId: world.groceries, title: 'No time', due: TOMORROW });
    // Midnight in Berlin is 22:00 UTC.
    expect(await world.at(utc(21, 58, 40))).toEqual([]);
    expect(await world.at(utc(21, 59, 0))).toEqual(['alex-phone: Last minute | Groceries, 23:59']);
    expect(await world.at(utc(21, 59, 40))).toEqual([]);
    expect(await world.at(utc(22, 0, 0))).toEqual(['alex-phone: First minute | Groceries, 00:00']);
    expect(await world.at(utc(22, 0, 20))).toEqual([]);
    // Midnight in New York is 04:00 UTC on the next day.
    expect(await world.at(utc(27, 58))).toEqual([]);
    expect(await world.at(utc(27, 59))).toEqual(['sam-phone: Last minute | Groceries, 23:59']);
    expect(await world.at(utc(28, 0))).toEqual(['sam-phone: First minute | Groceries, 00:00']);
    expect(await world.at(utc(28, 1))).toEqual([]);
    // 09:00 on the next day in Berlin, and then in New York.
    expect(await world.at(utc(31, 0))).toEqual(['alex-phone: No time | Groceries']);
    expect(await world.at(utc(37, 0))).toEqual(['sam-phone: No time | Groceries']);
  });

  test('a notification of the evening that the server missed goes out after midnight, and an old one does not', async () => {
    const world = await makeWorld({ start: utc(5) });
    await world.addTask({ title: 'Evening', due: TODAY, time: '23:30' });
    await world.addTask({ title: 'Morning', due: TODAY, time: '09:00' });
    // The server did not run from 07:00 in Berlin to 00:10 on the next day.
    expect(await world.at(utc(22, 10))).toEqual(['alex-phone: Evening | My Tasks, 23:30']);
    expect(await world.at(utc(22, 11))).toEqual([]);
  });

  test('the day when the clocks go forward in New York', async () => {
    // 2026-03-08: 02:00 becomes 03:00. Before: 5 hours behind UTC. After: 4 hours.
    const day = (hour: number, minute = 0): number => Date.UTC(2026, 2, 8, hour, minute);
    const world = await makeWorld({ start: day(-10) });
    const add = (fields: TaskFields) => world.addTask({ listId: world.samHome, ...fields }, world.sam);
    await add({ title: 'Before the change', due: '2026-03-08', time: '01:30' });
    // This time does not exist on that day. The notification comes when the clocks are past it.
    await add({ title: 'In the missing hour', due: '2026-03-08', time: '02:30' });
    await add({ title: 'No time', due: '2026-03-08' });
    await add({ title: 'Deadline', deadline: '2026-03-08' });
    await add({ title: 'Next day', due: '2026-03-09' });

    expect(await world.at(day(6, 29))).toEqual([]);
    expect(await world.at(day(6, 30))).toEqual(['sam-phone: Before the change | My Tasks, 01:30']);
    expect(await world.at(day(6, 59))).toEqual([]);
    expect(await world.at(day(7, 0))).toEqual(['sam-phone: In the missing hour | My Tasks, 02:30']);
    expect(await world.at(day(7, 30))).toEqual([]);
    // 09:00 in summer time is 13:00 UTC, not 14:00.
    expect(await world.at(day(12, 59))).toEqual([]);
    expect(await world.at(day(13, 0))).toEqual(['sam-phone: Deadline | Deadline today', 'sam-phone: No time | My Tasks']);
    expect(await world.at(day(14, 0))).toEqual([]);
    expect(await world.at(day(36, 59))).toEqual([]);
    expect(await world.at(day(37, 0))).toEqual(['sam-phone: Next day | My Tasks']);
  });

  test('the day when the clocks go back in New York', async () => {
    // 2026-11-01: 02:00 becomes 01:00. Before: 4 hours behind UTC. After: 5 hours.
    const day = (hour: number, minute = 0): number => Date.UTC(2026, 10, 1, hour, minute);
    const world = await makeWorld({ start: day(-10) });
    const add = (fields: TaskFields) => world.addTask({ listId: world.samHome, ...fields }, world.sam);
    // 01:30 comes two times on that day. One notification only, at the first one.
    await add({ title: 'In the double hour', due: '2026-11-01', time: '01:30' });
    await add({ title: 'No time', due: '2026-11-01' });
    await add({ title: 'Evening', due: '2026-11-01', time: '23:00' });

    expect(await world.at(day(5, 29))).toEqual([]);
    expect(await world.at(day(5, 30))).toEqual(['sam-phone: In the double hour | My Tasks, 01:30']);
    expect(await world.at(day(6, 0))).toEqual([]);
    expect(await world.at(day(6, 30))).toEqual([]);
    expect(await world.at(day(6, 31))).toEqual([]);
    // 09:00 in winter time is 14:00 UTC, not 13:00.
    expect(await world.at(day(13, 0))).toEqual([]);
    expect(await world.at(day(13, 59))).toEqual([]);
    expect(await world.at(day(14, 0))).toEqual(['sam-phone: No time | My Tasks']);
    // 23:00 in winter time is 04:00 UTC on the next day.
    expect(await world.at(day(27, 0))).toEqual([]);
    expect(await world.at(day(28, 0))).toEqual(['sam-phone: Evening | My Tasks, 23:00']);
    expect(await world.at(day(28, 1))).toEqual([]);
  });

  test('a person with no known time zone gets the times in UTC', async () => {
    const world = await makeWorld({ start: utc(1) });
    // The device of Alex never sent a valid time zone.
    world.server.app.db.q('UPDATE users SET tz = NULL WHERE id = ?').run(world.alex.user.id);
    world.alex.tz = 'Not/AZone';
    await world.addTask({ title: 'Morning', due: TODAY });
    await world.addTask({ title: 'With a time', due: TODAY, time: '16:45' });
    await world.addTask({ title: 'Late', due: TODAY, time: '23:59' });
    expect(world.server.app.db.q('SELECT tz FROM users WHERE id = ?').get(world.alex.user.id)).toEqual({ tz: null });

    // 09:00 in Berlin, the zone of the other tests, and each full hour before 09:00 UTC: nothing.
    for (let hour = 2; hour < 9; hour++) expect(await world.at(utc(hour))).toEqual([]);
    expect(await world.at(utc(8, 59, 40))).toEqual([]);
    expect(await world.at(utc(9, 0))).toEqual(['alex-phone: Morning | My Tasks']);
    expect(await world.at(utc(16, 44))).toEqual([]);
    expect(await world.at(utc(16, 45))).toEqual(['alex-phone: With a time | My Tasks, 16:45']);
    expect(await world.at(utc(23, 58))).toEqual([]);
    expect(await world.at(utc(23, 59))).toEqual(['alex-phone: Late | My Tasks, 23:59']);
    expect(await world.at(utc(24, 0))).toEqual([]);
  });
});

describe('time zones', () => {
  test('localStamp gives the wall clock of a moment in a time zone', () => {
    expect(localStamp(utc(7, 30), 'Europe/Berlin')).toBe('2026-10-06T09:30');
    expect(localStamp(utc(7, 30), 'America/New_York')).toBe('2026-10-06T03:30');
    expect(localStamp(utc(7, 30), 'Asia/Kolkata')).toBe('2026-10-06T13:00');
    expect(localStamp(utc(7, 30), 'UTC')).toBe('2026-10-06T07:30');
    // A different day on the two sides of the date line.
    expect(localStamp(utc(11), 'Pacific/Auckland')).toBe('2026-10-07T00:00');
    expect(localStamp(utc(3), 'America/Los_Angeles')).toBe('2026-10-05T20:00');
    // Midnight is hour 00, not hour 24.
    expect(localStamp(utc(22, 5), 'Europe/Berlin')).toBe('2026-10-07T00:05');
    // Winter time.
    expect(localStamp(Date.UTC(2026, 0, 15, 12, 0), 'Europe/Berlin')).toBe('2026-01-15T13:00');
    expect(localStamp(Date.UTC(2026, 0, 15, 12, 0), 'America/New_York')).toBe('2026-01-15T07:00');
  });

  test('timeZoneOf accepts only a time zone and gives its standard name', () => {
    expect(timeZoneOf('Europe/Berlin')).toBe('Europe/Berlin');
    expect(timeZoneOf('europe/berlin')).toBe('Europe/Berlin');
    expect(timeZoneOf('UTC')).toBe('UTC');
    for (const bad of ['Mars/Olympus', '', 'x'.repeat(100), 5, null, undefined, {}]) expect(timeZoneOf(bad)).toBeNull();
  });

  test('the record of sent notifications is cleaned after 30 days', async () => {
    const world = await makeWorld();
    await world.addTask({ title: 'Old', due: TODAY });
    await world.at(utc(7));
    const { db } = world.server.app;
    const count = (): number => (db.q('SELECT COUNT(*) AS n FROM notif_log').get() as { n: number }).n;
    expect(count()).toBe(1);
    cleanNotifLog({ db, now: utc(7) + 29 * 86_400_000 });
    expect(count()).toBe(1);
    cleanNotifLog({ db, now: utc(7) + 31 * 86_400_000 });
    expect(count()).toBe(0);
  });
});
