// Test accounts and sample rows, for development and automated tests. Never for the real server.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { hashPassword, insertUser } from './auth.ts';
import type { PasswordHash } from './auth.ts';
import { ROOT } from './config.ts';
import type { Db } from './db.ts';
import { applyOps, SERVER_TS } from './sync.ts';
import type { ID, ListFields, NoteFields, Put, TaskFields, User } from '../shared/types.ts';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export interface SeedAccount {
  name: string;
  password: PasswordHash;
}

/** Reads the test accounts of e2e/fixtures/users.json and makes their password hashes. */
export async function readSeedAccounts(): Promise<SeedAccount[]> {
  const file = path.join(ROOT, 'e2e', 'fixtures', 'users.json');
  const { users } = JSON.parse(readFileSync(file, 'utf8')) as { users: { name: string; password: string }[] };
  return Promise.all(users.map(async (u) => ({ name: u.name, password: await hashPassword(u.password) })));
}

/** The local day of the server, moved by a number of days. */
function day(now: number, offset: number): string {
  const d = new Date(now);
  d.setDate(d.getDate() + offset);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/**
 * Fills a database that has no accounts. The first account gets three lists and five notes, the
 * second account gets its default list and one note. Returns the accounts. Throws if the database
 * has an account.
 *
 * The notes, newest first. Each note was made a minute after the one below it, so the order on the
 * screen is fixed. editedAt is createdAt, and editedBy is the owner, except where noted.
 *   First account:
 *     Dinner party menu       orange   shared with the second account. Body "- [ ] Lasagne",
 *                                      "- [ ] Green salad", "- [x] Tiramisu" ("Make tasks" gives
 *                                      Lasagne and Green salad). editedBy is the second account
 *     Lake house checklist    yellow   pinned for the first account. Body "Sunscreen", "Hiking boots",
 *                                      "Rain jacket", "Board games"
 *     (no title)              green    body "Ring the plumber before Friday"
 *     Book club reading list  default  body "The Remains of the Day", "Piranesi", "The Overstory"
 *     Gift ideas for Grandma  pink     archived for the first account. Body "Silk scarf",
 *                                      "A photo book", "Orchid"
 *   Second account:
 *     Bike repair parts       blue     private. Body "Front brake pads", "Inner tube 28 inch", "Chain oil"
 */
export function seed(input: { db: Db; accounts: SeedAccount[]; now: number }): User[] {
  const { db, accounts, now } = input;
  return db.tx(() => {
    if (db.q('SELECT 1 FROM users LIMIT 1').get()) {
      throw new Error('The database has accounts. The seed is only for an empty database.');
    }
    // One millisecond between the accounts keeps their order.
    const users = accounts.map((a, i) => insertUser({ db, name: a.name, password: a.password, now: now + i }));
    const defaultList = (userId: ID): ID =>
      (db.q('SELECT id FROM lists WHERE owner = ? AND is_default = 1').get(userId) as { id: ID }).id;

    const put = (userId: ID, puts: Put[]): void => {
      // The smallest timestamp, so each change from a device wins over the seed values.
      const ops = puts.map((p) => ({ ...p, opId: randomUUID(), ts: SERVER_TS }));
      const result = applyOps({ db, userId, ops, now });
      if (result.rejected.length > 0) throw new Error('The server refused a row of the seed');
    };
    const list = (fields: ListFields): Put & { kind: 'list' } => ({
      kind: 'list',
      id: randomUUID(),
      fields: { createdAt: now, ...fields },
    });
    /** The tasks of one list or of one parent, in the order of the titles. */
    const tasks = (listId: ID, rows: TaskFields[]): Put[] =>
      rows.map((fields, i) => ({ kind: 'task', id: randomUUID(), fields: { listId, pos: `a${i}`, createdAt: now, ...fields } }));
    /** A note that was made the given number of minutes ago by this person. */
    const note = ({ userId, minutesAgo, fields }: { userId: ID; minutesAgo: number; fields: NoteFields }): Put & { kind: 'note' } => {
      const at = now - minutesAgo * MINUTE_MS;
      return {
        kind: 'note',
        id: randomUUID(),
        fields: {
          title: '',
          body: '',
          color: 'default',
          shared: false,
          pinned: false,
          archived: false,
          createdAt: at,
          editedAt: at,
          editedBy: userId,
          ...fields,
        },
      };
    };

    const [first, second] = users;
    if (first) {
      const mine = defaultList(first.id);
      const home = list({ title: 'Home', pos: 'a1' });
      const groceries = list({ title: 'Groceries', pos: 'a2', shared: true });
      const top = tasks(mine, [
        { title: 'Plan the weekend trip', notes: 'Check the train times and book a table for dinner.' },
        { title: 'Call the dentist', due: day(now, 0), time: '16:30' },
        { title: 'Pay the electricity bill', due: day(now, -3) },
        { title: 'Send the tax documents', deadline: day(now, 5) },
        { title: 'Buy a birthday present', starred: true, starredAt: now },
        { title: 'Pack for the trip' },
      ]);
      const parent = top[5]!.id;
      put(first.id, [
        home,
        groceries,
        ...top,
        ...tasks(mine, [
          { title: 'Passport', parentId: parent },
          { title: 'Phone charger', parentId: parent },
        ]),
        ...tasks(home.id, [
          {
            title: 'Water the plants',
            due: day(now, 0),
            repeat: { every: 1, unit: 'day', start: day(now, 0), end: { type: 'never' } },
          },
          ...['Fix the kitchen tap', 'Clean the windows', 'Take out the recycling'].map((title, i) => ({
            title,
            completed: true,
            completedAt: now - (i + 1) * DAY_MS,
            completedBy: first.id,
          })),
        ]),
        ...tasks(groceries.id, ['Milk', 'Bread', 'Eggs', 'Coffee', 'Apples'].map((title) => ({ title }))),
      ]);
      put(first.id, [
        note({
          userId: first.id,
          minutesAgo: 0,
          fields: {
            title: 'Dinner party menu',
            body: '- [ ] Lasagne\n- [ ] Green salad\n- [x] Tiramisu',
            color: 'orange',
            shared: second !== undefined,
            // The other person wrote last, so the note shows " by NAME" after the edit time.
            editedBy: second?.id ?? first.id,
          },
        }),
        note({
          userId: first.id,
          minutesAgo: 1,
          fields: { title: 'Lake house checklist', body: 'Sunscreen\nHiking boots\nRain jacket\nBoard games', color: 'yellow', pinned: true },
        }),
        note({ userId: first.id, minutesAgo: 2, fields: { body: 'Ring the plumber before Friday', color: 'green' } }),
        note({ userId: first.id, minutesAgo: 3, fields: { title: 'Book club reading list', body: 'The Remains of the Day\nPiranesi\nThe Overstory' } }),
        note({
          userId: first.id,
          minutesAgo: 4,
          fields: { title: 'Gift ideas for Grandma', body: 'Silk scarf\nA photo book\nOrchid', color: 'pink', archived: true },
        }),
      ]);
    }
    if (second) {
      put(second.id, [
        ...tasks(defaultList(second.id), [{ title: 'Book the car service' }, { title: 'Reply to the landlord' }]),
        note({ userId: second.id, minutesAgo: 5, fields: { title: 'Bike repair parts', body: 'Front brake pads\nInner tube 28 inch\nChain oil', color: 'blue' } }),
      ]);
    }
    return users;
  });
}

/** Deletes all accounts and rows and writes the seed again. Each device then starts from the new rows. */
export function resetAndSeed(input: { db: Db; accounts: SeedAccount[]; now: number }): User[] {
  const { db } = input;
  return db.tx(() => {
    const rev = Number(db.getMeta('rev') ?? 0) + 1;
    for (const table of ['notif_log', 'push_subs', 'sessions', 'note_user', 'notes', 'task_user', 'tasks', 'list_user', 'lists', 'users']) {
      db.sql.exec(`DELETE FROM ${table}`);
    }
    // The counter continues, and a sync with an older revision gets the answer 'reset'. A counter
    // that started again at 0 could give an old device a wrong part of the new rows.
    db.setMeta('rev', String(rev));
    db.setMeta('pruned_rev', String(rev));
    return seed(input);
  });
}
