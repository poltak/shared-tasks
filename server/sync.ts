import { randomUUID } from 'node:crypto';
import type { Db } from './db.ts';
import { invalid } from './http.ts';
import { timeZoneOf } from './scheduler.ts';
import * as hlc from '../shared/hlc.ts';
import { LIMITS, NOTE_COLORS } from '../shared/types.ts';
import type { HLC, ID, ListRow, NoteColor, NoteRow, RepeatRule, SortMode, SyncResponse, TaskRow } from '../shared/types.ts';

// ---------------------------------------------------------------------------------------------
// Field checks. A check gives the value in the form that the database stores, or BAD.
// ---------------------------------------------------------------------------------------------

type Value = string | number | null;
/** A table row as the database stores it. */
type Raw = Record<string, Value>;

const BAD = Symbol('bad');
type Check = (value: unknown) => Value | typeof BAD;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SORTS: readonly string[] = ['my', 'date', 'deadline', 'starred', 'title'] satisfies SortMode[];
const UNITS: readonly string[] = ['day', 'week', 'month', 'year'] satisfies RepeatRule['unit'][];
const COLORS: readonly string[] = NOTE_COLORS;
const POS_MAX = 1024;
/** The largest time value of a JavaScript date. Larger numbers are not safe as a database integer. */
const STAMP_MAX = 8.64e15;

export function isId(value: unknown): value is ID {
  return typeof value === 'string' && ID_RE.test(value);
}

function isDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function isInt(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

/** Cuts the text to the limit. Half of a character pair at the end would be invalid text, so it goes too. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

function cleanRule(value: unknown): RepeatRule | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  if (!isInt(r.every, 1, LIMITS.repeatEvery) || !UNITS.includes(r.unit as string) || !isDate(r.start)) return null;
  // The keys are set in one fixed order, so two equal rules give the same JSON text.
  const rule: RepeatRule = { every: r.every, unit: r.unit as RepeatRule['unit'], start: r.start, end: { type: 'never' } };
  if (r.weekdays !== undefined) {
    if (!Array.isArray(r.weekdays) || r.weekdays.length > 7 || !r.weekdays.every((d) => isInt(d, 0, 6))) return null;
    rule.weekdays = r.weekdays as number[];
  }
  if (r.monthMode !== undefined) {
    if (r.monthMode !== 'day' && r.monthMode !== 'weekday') return null;
    rule.monthMode = r.monthMode;
  }
  if (r.monthDay !== undefined) {
    if (r.monthDay !== -1 && !isInt(r.monthDay, 1, 31)) return null;
    rule.monthDay = r.monthDay as number;
  }
  if (r.ordinal !== undefined) {
    if (r.ordinal !== -1 && !isInt(r.ordinal, 1, 4)) return null;
    rule.ordinal = r.ordinal as number;
  }
  if (r.weekday !== undefined) {
    if (!isInt(r.weekday, 0, 6)) return null;
    rule.weekday = r.weekday;
  }
  const end = r.end as Record<string, unknown> | null | undefined;
  if (typeof end !== 'object' || end === null) return null;
  if (end.type === 'on' && isDate(end.date)) rule.end = { type: 'on', date: end.date };
  else if (end.type === 'after' && isInt(end.count, 1, 100_000)) rule.end = { type: 'after', count: end.count };
  else if (end.type !== 'never') return null;
  return rule;
}

const bool: Check = (v) => (typeof v === 'boolean' ? Number(v) : BAD);
const text = (max: number): Check => (v) => (typeof v === 'string' ? cut(v, max) : BAD);
const nullable = (check: Check): Check => (v) => (v === null ? null : check(v));
const id: Check = (v) => (isId(v) ? v : BAD);
const date: Check = (v) => (isDate(v) ? v : BAD);
const time: Check = (v) => (typeof v === 'string' && TIME_RE.test(v) ? v : BAD);
const stamp: Check = (v) => (typeof v === 'number' && v >= 0 && v <= STAMP_MAX ? Math.round(v) : BAD);
const count: Check = (v) => (isInt(v, 0, 1e9) ? v : BAD);
const posKey: Check = (v) => (typeof v === 'string' && v.length <= POS_MAX ? v : BAD);
const sortMode: Check = (v) => (typeof v === 'string' && SORTS.includes(v) ? v : BAD);
const noteColor: Check = (v) => (typeof v === 'string' && COLORS.includes(v) ? v : BAD);
const repeat: Check = (v) => {
  const rule = cleanRule(v);
  return rule ? JSON.stringify(rule) : BAD;
};

// ---------------------------------------------------------------------------------------------
// The three kinds of row. Each has a table of shared fields and a table of per-person fields.
// ---------------------------------------------------------------------------------------------

interface Field {
  col: string;
  check: Check;
}

interface Kind {
  name: 'list' | 'task' | 'note';
  /** Fields that all people share: field name to column. */
  shared: Map<string, Field>;
  /** Fields with a separate value for each person. */
  user: Map<string, Field>;
  /** Fields that the server sets when it makes the row. A value from a client is only checked. */
  fixed: Map<string, Check>;
  select: string;
  insert: string;
  update: string;
  userSelect: string;
  userWrite: string;
  userDefaults: Raw;
  /** Column of the per-person table that holds the row id. */
  key: string;
}

function makeKind(input: {
  name: Kind['name'];
  table: string;
  userTable: string;
  key: string;
  shared: Record<string, Field>;
  user: Record<string, Field>;
  fixed: Record<string, Check>;
  fixedCols: string[];
  userDefaults: Raw;
}): Kind {
  const cols = [...Object.values(input.shared).map((f) => f.col), ...input.fixedCols, 'rev', 'ts', 'at'];
  const userCols = [input.key, 'user_id', ...Object.values(input.user).map((f) => f.col), 'rev', 'ts', 'lost_rev'];
  return {
    name: input.name,
    shared: new Map(Object.entries(input.shared)),
    user: new Map(Object.entries(input.user)),
    fixed: new Map(Object.entries(input.fixed)),
    select: `SELECT * FROM ${input.table} WHERE id = ?`,
    insert: `INSERT INTO ${input.table} (id, ${cols.join(', ')}) VALUES ($id, ${cols.map((c) => '$' + c).join(', ')})`,
    update: `UPDATE ${input.table} SET ${cols.map((c) => `${c} = $${c}`).join(', ')} WHERE id = $id`,
    userSelect: `SELECT * FROM ${input.userTable} WHERE ${input.key} = ? AND user_id = ?`,
    userWrite: `INSERT OR REPLACE INTO ${input.userTable} (${userCols.join(', ')}) VALUES (${userCols.map((c) => '$' + c).join(', ')})`,
    userDefaults: { ...input.userDefaults, rev: 0, ts: '{}', lost_rev: 0 },
    key: input.key,
  };
}

const f = (col: string, check: Check): Field => ({ col, check });

const LIST = makeKind({
  name: 'list',
  table: 'lists',
  userTable: 'list_user',
  key: 'list_id',
  shared: {
    title: f('title', text(LIMITS.listTitle)),
    shared: f('shared', bool),
    deleted: f('deleted', bool),
  },
  user: {
    pos: f('pos', nullable(posKey)),
    sort: f('sort', sortMode),
    hidden: f('hidden', bool),
  },
  fixed: { owner: id, isDefault: bool, createdAt: stamp },
  fixedCols: ['owner', 'is_default', 'created_at'],
  userDefaults: { pos: null, sort: 'my', hidden: 0 },
});

const TASK = makeKind({
  name: 'task',
  table: 'tasks',
  userTable: 'task_user',
  key: 'task_id',
  shared: {
    listId: f('list_id', id),
    parentId: f('parent_id', nullable(id)),
    title: f('title', text(LIMITS.title)),
    notes: f('notes', text(LIMITS.notes)),
    pos: f('pos', posKey),
    due: f('due', nullable(date)),
    time: f('time', nullable(time)),
    deadline: f('deadline', nullable(date)),
    repeat: f('repeat', nullable(repeat)),
    repeatCount: f('repeat_count', count),
    hiddenUntil: f('hidden_until', nullable(date)),
    lastDoneAt: f('last_done_at', nullable(stamp)),
    lastDoneDue: f('last_done_due', nullable(date)),
    completed: f('completed', bool),
    completedAt: f('completed_at', nullable(stamp)),
    completedBy: f('completed_by', nullable(id)),
    deleted: f('deleted', bool),
  },
  user: {
    starred: f('starred', bool),
    starredAt: f('starred_at', nullable(stamp)),
  },
  fixed: { createdAt: stamp, createdBy: id },
  fixedCols: ['created_at', 'created_by'],
  userDefaults: { starred: 0, starred_at: null },
});

const NOTE = makeKind({
  name: 'note',
  table: 'notes',
  userTable: 'note_user',
  key: 'note_id',
  shared: {
    title: f('title', text(LIMITS.noteTitle)),
    body: f('body', text(LIMITS.noteBody)),
    color: f('color', noteColor),
    shared: f('shared', bool),
    editedAt: f('edited_at', stamp),
    editedBy: f('edited_by', nullable(id)),
    deleted: f('deleted', bool),
  },
  user: {
    pinned: f('pinned', bool),
    archived: f('archived', bool),
  },
  fixed: { owner: id, createdAt: stamp },
  fixedCols: ['owner', 'created_at'],
  userDefaults: { pinned: 0, archived: 0 },
});

const KINDS = new Map<unknown, Kind>([
  ['list', LIST],
  ['task', TASK],
  ['note', NOTE],
]);

/** The shared fields of a note that only the owner changes. */
const OWNER_ONLY: ReadonlySet<string> = new Set(['shared', 'deleted']);

interface FieldValue {
  name: string;
  col: string;
  value: Value;
}

interface Parsed {
  shared: FieldValue[];
  user: FieldValue[];
  createdAt: number | null;
  isDefault: boolean;
}

/** Checks the fields of an op. null if a known field has a wrong value. Unknown fields are ignored. */
function parseFields(kind: Kind, fields: unknown): Parsed | null {
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return null;
  const parsed: Parsed = { shared: [], user: [], createdAt: null, isDefault: false };
  for (const [name, raw] of Object.entries(fields)) {
    const field = kind.shared.get(name) ?? kind.user.get(name);
    if (field) {
      const value = field.check(raw);
      if (value === BAD) return null;
      (kind.shared.has(name) ? parsed.shared : parsed.user).push({ name, col: field.col, value });
      continue;
    }
    const check = kind.fixed.get(name);
    if (!check) continue;
    const value = check(raw);
    if (value === BAD) return null;
    if (name === 'createdAt') parsed.createdAt = value as number;
    if (name === 'isDefault') parsed.isDefault = value === 1;
  }
  return parsed;
}

// ---------------------------------------------------------------------------------------------
// Applying ops
// ---------------------------------------------------------------------------------------------

/** The smallest timestamp. A value that the server wrote has it, so each change from a client wins. */
export const SERVER_TS: HLC = '0'.repeat(18);

/** The server replaces a timestamp that is farther in the future than this. */
const FUTURE_LIMIT_MS = 60_000;
const COUNTER_MAX = 36 ** 3 - 1;

const LOST_LIST = `INSERT INTO list_user (list_id, user_id, lost_rev) VALUES (?, ?, ?)
  ON CONFLICT(list_id, user_id) DO UPDATE SET lost_rev = excluded.lost_rev`;
const LOST_TASK = `INSERT INTO task_user (task_id, user_id, lost_rev) VALUES (?, ?, ?)
  ON CONFLICT(task_id, user_id) DO UPDATE SET lost_rev = excluded.lost_rev`;
const LOST_NOTE = `INSERT INTO note_user (note_id, user_id, lost_rev) VALUES (?, ?, ?)
  ON CONFLICT(note_id, user_id) DO UPDATE SET lost_rev = excluded.lost_rev`;
// Only the tasks that the request did not change: a changed task gets its mark by itself.
const LOST_TASKS_OF_LIST = `INSERT INTO task_user (task_id, user_id, lost_rev)
  SELECT id, ?, ? FROM tasks WHERE list_id = ? AND deleted = 0 AND rev <= ?
  ON CONFLICT(task_id, user_id) DO UPDATE SET lost_rev = excluded.lost_rev`;

export interface ApplyResult {
  acked: ID[];
  rejected: ID[];
  /**
   * The rows where the device can hold a state that the server does not have: the row of a rejected
   * op, a row where a newer value of a different device stays, and a row that the person cannot see.
   * The caller sends their true state.
   */
  stale: { kind: Kind['name']; id: ID }[];
  /** The revision counter after the ops. */
  rev: number;
  /** The people whose devices must sync. null if no row changed. */
  poke: ID[] | 'all' | null;
}

/**
 * Merges ops into the database as one person. Call it in a transaction.
 * `trusted` is for rows that the server makes itself: the op can then make a default list.
 */
export function applyOps(input: {
  db: Db;
  userId: ID;
  ops: readonly unknown[];
  now: number;
  trusted?: boolean;
  onError?: (error: unknown) => void;
}): ApplyResult {
  const { db, userId, now } = input;
  const startRev = Number(db.getMeta('rev') ?? 0);
  let rev = startRev;
  // One op gives one new revision at most, also if it changes more than one table.
  let opRev = 0;
  const nextRev = (): number => (opRev ||= ++rev);
  // Set by an op: the row of the server is not the row that the device has after its own put.
  let differs = false;

  const poke = new Set<ID>();
  let pokeAll = false;

  // What a person could see at the start of the request, for each row that the request changes.
  // null: the row did not exist. The 'gone' marks are made from these at the end. So a row that a
  // person can see only between two ops of one request gives no mark, and its id stays private.
  const listsBefore = new Map<ID, Raw | null>();
  const tasksBefore = new Map<ID, { listId: ID; deleted: Value } | null>();
  const tasksNow = new Map<ID, { listId: ID; deleted: Value }>();
  const notesBefore = new Map<ID, Raw | null>();

  // The list rows that this request read. A request with many tasks of one list reads the list one time.
  const lists = new Map<ID, Raw | null>();
  const getList = (listId: ID): Raw | null => {
    let row = lists.get(listId);
    if (row === undefined) {
      row = (db.q(LIST.select).get(listId) as Raw | undefined) ?? null;
      lists.set(listId, row);
    }
    return row;
  };

  const canSee = (list: Raw): boolean => list.owner === userId || list.shared === 1;
  /** A list or a note changed: the people who can see it must sync. */
  const touch = (row: Raw): void => {
    if (row.shared === 1) pokeAll = true;
    else poke.add(row.owner as ID);
  };

  /** Writes the newer fields into the row. 0: nothing. 1: only timestamps changed. 2: a value changed. */
  function merge(row: Raw, values: FieldValue[], ts: HLC): 0 | 1 | 2 {
    if (values.length === 0) return 0;
    const stamps = JSON.parse(row.ts as string) as Record<string, HLC>;
    let result: 0 | 1 | 2 = 0;
    for (const { name, col, value } of values) {
      if (!(ts > (stamps[name] ?? ''))) {
        // The newer value of a different device stays, but the device of this op shows its own value.
        if (row[col] !== value) differs = true;
        continue;
      }
      stamps[name] = ts;
      if (row[col] !== value) {
        row[col] = value;
        result = 2;
      } else if (result === 0) {
        result = 1;
      }
    }
    if (result) row.ts = JSON.stringify(stamps);
    return result;
  }

  function mergeUserPart(kind: Kind, rowId: ID, values: FieldValue[], ts: HLC): void {
    if (values.length === 0) return;
    const row = (db.q(kind.userSelect).get(rowId, userId) as Raw | undefined) ?? {
      ...kind.userDefaults,
      [kind.key]: rowId,
      user_id: userId,
    };
    const result = merge(row, values, ts);
    if (result === 0) return;
    if (result === 2) {
      row.rev = nextRev();
      poke.add(userId);
    }
    db.q(kind.userWrite).run(row);
  }

  function applyList(listId: ID, parsed: Parsed, ts: HLC): boolean {
    let row = getList(listId);
    if (!row) {
      // A put that makes a list has all fields. A put with no title is a change of a list that
      // the server deleted a long time ago, and that list must not come back.
      if (!parsed.shared.some((v) => v.name === 'title')) return false;
      row = {
        id: listId,
        title: '',
        shared: 0,
        deleted: 0,
        owner: userId,
        is_default: input.trusted && parsed.isDefault ? 1 : 0,
        created_at: parsed.createdAt ?? now,
        rev: nextRev(),
        ts: '{}',
        at: now,
      };
      merge(row, parsed.shared, ts);
      db.q(LIST.insert).run(row);
      lists.set(listId, row);
      if (!listsBefore.has(listId)) listsBefore.set(listId, null);
      touch(row);
    } else {
      const current = row;
      const mine = current.owner === userId;
      if (!mine && current.shared !== 1) return false;
      let values = parsed.shared;
      if (!mine) {
        // Only the owner changes 'shared' and 'deleted'. A value equal to the stored one is no change.
        if (values.some((v) => v.name !== 'title' && v.value !== current[v.col])) return false;
        values = values.filter((v) => v.name === 'title');
      }
      if (current.is_default === 1 && values.some((v) => v.name === 'deleted' && v.value === 1)) return false;

      const before: Raw = { owner: current.owner!, shared: current.shared!, deleted: current.deleted! };
      const result = merge(current, values, ts);
      if (result === 2) {
        current.rev = nextRev();
        current.at = now;
      }
      if (result) db.q(LIST.update).run(current);
      if (result === 2) {
        if (before.shared === 1) pokeAll = true;
        touch(current);
        if ((current.shared !== before.shared || current.deleted !== before.deleted) && !listsBefore.has(listId)) {
          listsBefore.set(listId, before);
        }
      }
    }
    mergeUserPart(LIST, listId, parsed.user, ts);
    // The person sees no deleted list, so the device must drop its row.
    if (row.deleted !== 0) differs = true;
    return true;
  }

  function applyTask(taskId: ID, parsed: Parsed, ts: HLC): boolean {
    const target = parsed.shared.find((v) => v.name === 'listId')?.value as ID | undefined;
    const row = db.q(TASK.select).get(taskId) as Raw | undefined;
    let home: Raw;
    let state: Raw;
    if (!row) {
      // A put that makes a task has all fields. A put with no title is a change of a task that
      // the server removed, and that task must not come back as an empty row.
      if (target === undefined || !parsed.shared.some((v) => v.name === 'title')) return false;
      const list = getList(target);
      if (!list || !canSee(list)) return false;
      const made: Raw = {
        id: taskId,
        list_id: target,
        parent_id: null,
        title: '',
        notes: '',
        pos: 'a0',
        due: null,
        time: null,
        deadline: null,
        repeat: null,
        repeat_count: 0,
        hidden_until: null,
        last_done_at: null,
        last_done_due: null,
        completed: 0,
        completed_at: null,
        completed_by: null,
        deleted: 0,
        created_at: parsed.createdAt ?? now,
        created_by: userId,
        rev: nextRev(),
        ts: '{}',
        at: now,
      };
      merge(made, parsed.shared, ts);
      db.q(TASK.insert).run(made);
      if (!tasksBefore.has(taskId)) tasksBefore.set(taskId, null);
      touch(list);
      home = list;
      state = made;
    } else {
      const from = getList(row.list_id as ID);
      if (!from || !canSee(from)) return false;
      let to = from;
      if (target !== undefined && target !== row.list_id) {
        const list = getList(target);
        if (!list || !canSee(list)) return false;
        to = list;
      }
      const wasDeleted = row.deleted as number;
      const result = merge(row, parsed.shared, ts);
      if (result === 2) {
        row.rev = nextRev();
        row.at = now;
      }
      if (result) db.q(TASK.update).run(row);
      // The move is not done if a newer move of a different device is in the row already.
      home = row.list_id === from.id ? from : to;
      state = row;
      if (result === 2) {
        touch(from);
        touch(home);
        if (!tasksBefore.has(taskId)) tasksBefore.set(taskId, { listId: from.id as ID, deleted: wasDeleted });
      }
    }
    tasksNow.set(taskId, { listId: state.list_id as ID, deleted: state.deleted! });
    mergeUserPart(TASK, taskId, parsed.user, ts);
    // The person sees no deleted task and no task of a deleted list, so the device must drop its row.
    if (state.deleted !== 0 || home.deleted !== 0) differs = true;
    return true;
  }

  function applyNote(noteId: ID, parsed: Parsed, ts: HLC): boolean {
    let row = (db.q(NOTE.select).get(noteId) as Raw | undefined) ?? null;
    if (!row) {
      // Only the put that makes a note has createdAt. A title can be empty and each typed key
      // sends the title, so no text field can mark a new note. A put with no createdAt is a change
      // of a note that the server removed, and that note must not come back as an empty row.
      if (parsed.createdAt === null) return false;
      // The keys are exactly the columns: node:sqlite refuses a named value that the SQL does not have.
      row = {
        id: noteId,
        title: '',
        body: '',
        color: 'default',
        shared: 0,
        edited_at: parsed.createdAt,
        edited_by: null,
        deleted: 0,
        owner: userId,
        created_at: parsed.createdAt,
        rev: nextRev(),
        ts: '{}',
        at: now,
      };
      merge(row, parsed.shared, ts);
      db.q(NOTE.insert).run(row);
      if (!notesBefore.has(noteId)) notesBefore.set(noteId, null);
      touch(row);
    } else {
      const current = row;
      const mine = current.owner === userId;
      if (!mine && current.shared !== 1) return false;
      let values = parsed.shared;
      if (!mine) {
        // Only the owner changes 'shared' and 'deleted'. A value equal to the stored one is no change.
        if (values.some((v) => OWNER_ONLY.has(v.name) && v.value !== current[v.col])) return false;
        values = values.filter((v) => !OWNER_ONLY.has(v.name));
      }
      const before: Raw = { owner: current.owner!, shared: current.shared!, deleted: current.deleted! };
      const result = merge(current, values, ts);
      if (result === 2) {
        current.rev = nextRev();
        current.at = now;
      }
      if (result) db.q(NOTE.update).run(current);
      if (result === 2) {
        // The end of a share must reach the person who loses the note.
        if (before.shared === 1) pokeAll = true;
        touch(current);
        if ((current.shared !== before.shared || current.deleted !== before.deleted) && !notesBefore.has(noteId)) {
          notesBefore.set(noteId, before);
        }
      }
    }
    mergeUserPart(NOTE, noteId, parsed.user, ts);
    // The person sees no deleted note, so the device must drop its row.
    if (row.deleted !== 0) differs = true;
    return true;
  }

  const sees = (row: Raw | null, user: ID): boolean =>
    row !== null && row.deleted === 0 && (row.owner === user || row.shared === 1);

  /** Writes a 'gone' mark for each row that a person could see before the request and cannot see after it. */
  function markLost(): void {
    const users = (db.q('SELECT id FROM users').all() as { id: ID }[]).map((u) => u.id);
    const listAtStart = (listId: ID): Raw | null => (listsBefore.has(listId) ? (listsBefore.get(listId) ?? null) : getList(listId));

    for (const [taskId, before] of tasksBefore) {
      // No person saw a task that did not exist or was deleted.
      if (!before || before.deleted !== 0) continue;
      const row =
        tasksNow.get(taskId) ??
        (db.q('SELECT list_id AS listId, deleted FROM tasks WHERE id = ?').get(taskId) as { listId: ID; deleted: Value } | undefined);
      if (!row) continue;
      // The usual change: the task stays where it is, and no list changed who can see it.
      if (listsBefore.size === 0 && row.listId === before.listId && row.deleted === 0) continue;
      const from = listAtStart(before.listId);
      const to = row.deleted === 0 ? getList(row.listId) : null;
      for (const user of users) {
        if (sees(from, user) && !sees(to, user)) db.q(LOST_TASK).run(taskId, user, rev);
      }
    }

    for (const [listId, before] of listsBefore) {
      const list = getList(listId);
      if (!list || (before && before.shared === list.shared && before.deleted === list.deleted)) continue;
      for (const user of users) {
        if (!sees(before, user) || sees(list, user)) continue;
        db.q(LOST_LIST).run(listId, user, rev);
        db.q(LOST_TASKS_OF_LIST).run(user, rev, listId, startRev);
      }
      // Each device must get the tasks of the list again, or drop them. The time of the tasks
      // stays, so this does not move the cleanup of the deleted tasks of the list.
      if (before) db.q('UPDATE tasks SET rev = ? WHERE list_id = ?').run(rev, listId);
    }

    // A note has no child rows, so only the note itself gets a mark.
    for (const [noteId, before] of notesBefore) {
      // No person saw a note that did not exist.
      if (!before) continue;
      const note = db.q('SELECT owner, shared, deleted FROM notes WHERE id = ?').get(noteId) as Raw | undefined;
      if (!note || (before.shared === note.shared && before.deleted === note.deleted)) continue;
      for (const user of users) {
        if (sees(before, user) && !sees(note, user)) db.q(LOST_NOTE).run(noteId, user, rev);
      }
    }
  }

  // First the frame of each op is checked, in the order of the request.
  interface Entry {
    opId: string;
    kind: Kind | null;
    rowId: ID | null;
    /** null: the op is not valid. */
    run: (() => boolean) | null;
    ok: boolean;
    /** The device needs the true state of the row. */
    stale: boolean;
  }
  const entries: Entry[] = [];
  input.ops.forEach((op, index) => {
    if (typeof op !== 'object' || op === null) return;
    const { opId, kind: kindName, id, ts, fields } = op as Record<string, unknown>;
    // An op with no usable id cannot be named in the answer, so it gets no answer.
    if (typeof opId !== 'string') return;
    const kind = KINDS.get(kindName) ?? null;
    const rowId = isId(id) ? id : null;
    const entry: Entry = { opId, kind, rowId, run: null, ok: false, stale: true };
    entries.push(entry);
    if (!kind || !rowId || !isId(opId) || !hlc.isValid(ts)) return;
    const parsed = parseFields(kind, fields);
    if (!parsed) return;
    // A clock that runs ahead would win each merge for a long time. The op gets the server time,
    // with a high counter, so it wins over the values of this moment as a new change must.
    // The last op of the request gets the highest counter, so the order of such ops stays.
    const clock = hlc.decode(ts);
    const stamp =
      clock.ms > now + FUTURE_LIMIT_MS
        ? hlc.encode({ ms: now, counter: Math.max(0, COUNTER_MAX - (input.ops.length - 1 - index)), node: clock.node })
        : ts;
    const apply = kind === LIST ? applyList : kind === TASK ? applyTask : applyNote;
    entry.run = () => apply(rowId, parsed, stamp);
  });

  // Then the lists, then the tasks, then the notes. A device merges its puts for one row into one
  // op, so the op that moves a task into a new list can come before the op that makes the list.
  for (const kind of [LIST, TASK, NOTE]) {
    for (const entry of entries) {
      if (entry.kind !== kind || !entry.run) continue;
      const revBefore = rev;
      opRev = 0;
      differs = false;
      db.q('SAVEPOINT op').run();
      try {
        entry.ok = entry.run();
        entry.stale = !entry.ok || differs;
        db.q('RELEASE op').run();
      } catch (error) {
        // A defect in one op must not stop the other ops of the request.
        db.q('ROLLBACK TO op').run();
        db.q('RELEASE op').run();
        lists.clear();
        tasksNow.delete(entry.rowId!);
        rev = revBefore;
        (input.onError ?? console.error)(error);
      }
    }
  }
  if (listsBefore.size + tasksBefore.size + notesBefore.size > 0) markLost();

  const acked: ID[] = [];
  const rejected: ID[] = [];
  const stale: ApplyResult['stale'] = [];
  for (const entry of entries) {
    (entry.ok ? acked : rejected).push(entry.opId);
    if (entry.stale && entry.kind && entry.rowId) stale.push({ kind: entry.kind.name, id: entry.rowId });
  }

  if (rev !== startRev) db.setMeta('rev', String(rev));
  return { acked, rejected, stale, rev, poke: pokeAll ? 'all' : poke.size ? [...poke] : null };
}

/** Makes the default list of a new account. Returns its id. */
export function makeDefaultList(input: { db: Db; userId: ID; now: number }): ID {
  const listId = randomUUID();
  applyOps({
    ...input,
    trusted: true,
    ops: [
      {
        opId: randomUUID(),
        ts: SERVER_TS,
        kind: 'list',
        id: listId,
        // The position puts the default list before each list that the person makes later.
        fields: { title: 'My Tasks', isDefault: true, createdAt: input.now, pos: 'a0' },
      },
    ],
  });
  return listId;
}

// ---------------------------------------------------------------------------------------------
// Reading rows for one person
// ---------------------------------------------------------------------------------------------

const VISIBLE_LIST = `l.deleted = 0 AND (l.owner = $user OR l.shared = 1)`;

const LISTS = `SELECT l.id, l.title, l.owner, l.shared, l.is_default, l.created_at, l.deleted, lu.pos, lu.sort, lu.hidden
  FROM lists l LEFT JOIN list_user lu ON lu.list_id = l.id AND lu.user_id = $user
  WHERE ${VISIBLE_LIST}`;
const LISTS_SINCE = `${LISTS} AND (l.rev > $since OR lu.rev > $since)`;
const LIST_ONE = `${LISTS} AND l.id = $id`;

const TASKS = `SELECT t.id, t.list_id, t.parent_id, t.title, t.notes, t.pos, t.due, t.time, t.deadline, t.repeat,
    t.repeat_count, t.hidden_until, t.last_done_at, t.last_done_due, t.completed, t.completed_at, t.completed_by,
    t.created_at, t.created_by, t.deleted, tu.starred, tu.starred_at
  FROM tasks t JOIN lists l ON l.id = t.list_id
  LEFT JOIN task_user tu ON tu.task_id = t.id AND tu.user_id = $user
  WHERE t.deleted = 0 AND ${VISIBLE_LIST}`;
// The two inner queries each use an index, so the cost follows the number of changed rows.
const TASKS_SINCE = `${TASKS} AND t.id IN (
    SELECT id FROM tasks WHERE rev > $since
    UNION ALL SELECT task_id FROM task_user WHERE user_id = $user AND rev > $since)`;
const TASK_ONE = `${TASKS} AND t.id = $id`;

const GONE_LISTS = `SELECT lu.list_id AS id FROM list_user lu
  WHERE lu.user_id = $user AND lu.lost_rev > $since
    AND NOT EXISTS (SELECT 1 FROM lists l WHERE l.id = lu.list_id AND ${VISIBLE_LIST})`;
const GONE_TASKS = `SELECT tu.task_id AS id FROM task_user tu
  WHERE tu.user_id = $user AND tu.lost_rev > $since
    AND NOT EXISTS (SELECT 1 FROM tasks t JOIN lists l ON l.id = t.list_id
      WHERE t.id = tu.task_id AND t.deleted = 0 AND ${VISIBLE_LIST})`;

const VISIBLE_NOTE = `n.deleted = 0 AND (n.owner = $user OR n.shared = 1)`;

const NOTES = `SELECT n.id, n.title, n.body, n.color, n.shared, n.edited_at, n.edited_by, n.deleted, n.owner, n.created_at,
    nu.pinned, nu.archived
  FROM notes n LEFT JOIN note_user nu ON nu.note_id = n.id AND nu.user_id = $user
  WHERE ${VISIBLE_NOTE}`;
// The two inner queries each use an index, so the cost follows the number of changed rows.
const NOTES_SINCE = `${NOTES} AND n.id IN (
    SELECT id FROM notes WHERE rev > $since
    UNION ALL SELECT note_id FROM note_user WHERE user_id = $user AND rev > $since)`;
const NOTE_ONE = `${NOTES} AND n.id = $id`;
const GONE_NOTES = `SELECT nu.note_id AS id FROM note_user nu
  WHERE nu.user_id = $user AND nu.lost_rev > $since
    AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.id = nu.note_id AND ${VISIBLE_NOTE})`;

function listOut(r: Raw): ListRow {
  return {
    id: r.id as ID,
    title: r.title as string,
    owner: r.owner as ID,
    shared: r.shared === 1,
    isDefault: r.is_default === 1,
    createdAt: r.created_at as number,
    deleted: r.deleted === 1,
    pos: r.pos as string | null,
    sort: (r.sort ?? 'my') as SortMode,
    hidden: r.hidden === 1,
  };
}

function taskOut(r: Raw): TaskRow {
  return {
    id: r.id as ID,
    listId: r.list_id as ID,
    parentId: r.parent_id as ID | null,
    title: r.title as string,
    notes: r.notes as string,
    pos: r.pos as string,
    due: r.due as string | null,
    time: r.time as string | null,
    deadline: r.deadline as string | null,
    repeat: r.repeat === null ? null : (JSON.parse(r.repeat as string) as RepeatRule),
    repeatCount: r.repeat_count as number,
    hiddenUntil: r.hidden_until as string | null,
    lastDoneAt: r.last_done_at as number | null,
    lastDoneDue: r.last_done_due as string | null,
    completed: r.completed === 1,
    completedAt: r.completed_at as number | null,
    completedBy: r.completed_by as ID | null,
    createdAt: r.created_at as number,
    createdBy: r.created_by as ID,
    deleted: r.deleted === 1,
    starred: r.starred === 1,
    starredAt: (r.starred_at ?? null) as number | null,
  };
}

function noteOut(r: Raw): NoteRow {
  return {
    id: r.id as ID,
    title: r.title as string,
    body: r.body as string,
    color: r.color as NoteColor,
    shared: r.shared === 1,
    editedAt: r.edited_at as number,
    editedBy: r.edited_by as ID | null,
    deleted: r.deleted === 1,
    owner: r.owner as ID,
    createdAt: r.created_at as number,
    pinned: r.pinned === 1,
    archived: r.archived === 1,
  };
}

// ---------------------------------------------------------------------------------------------
// The sync request
// ---------------------------------------------------------------------------------------------

export interface ParsedSyncRequest {
  clientId: ID;
  since: number;
  ops: unknown[];
  /** null if the request has no valid time zone. */
  tz: string | null;
}

/** Checks the frame of a sync request. The ops are checked one by one later. */
export function parseSyncRequest(body: Record<string, unknown>): ParsedSyncRequest {
  const { clientId, since, ops, tz } = body;
  if (!isId(clientId)) throw invalid('"clientId" is not a valid id');
  if (!Number.isSafeInteger(since) || (since as number) < 0) throw invalid('"since" must be a whole number, 0 or more');
  if (!Array.isArray(ops)) throw invalid('"ops" must be a list');
  return { clientId, since: since as number, ops, tz: timeZoneOf(tz) };
}

export interface SyncResult {
  response: SyncResponse;
  /** The people whose devices must sync now. null if no row changed. */
  poke: ID[] | 'all' | null;
}

export function runSync(input: {
  db: Db;
  userId: ID;
  request: Pick<ParsedSyncRequest, 'since' | 'ops'>;
  now: number;
  onError?: (error: unknown) => void;
}): SyncResult {
  const { db, userId, now } = input;
  const { since, ops } = input.request;
  return db.tx(() => {
    const applied = applyOps({ db, userId, ops, now, onError: input.onError });
    const rev = applied.rev;
    // The device cannot learn from 'gone' about rows that the cleanup removed. A revision that is
    // higher than the counter comes from a different database. In the two cases the device starts again.
    const reset = since > 0 && (since < Number(db.getMeta('pruned_rev') ?? 0) || since > rev);
    const full = reset || since === 0;

    const user = userId;
    /** The rows and the gone ids of one kind for this person, and a way to add the true state of one row. */
    const part = <T extends { id: ID }>(sql: { all: string; changed: string; one: string; gone: string; out: (r: Raw) => T }) => {
      const rows = ((full ? db.q(sql.all).all({ user }) : db.q(sql.changed).all({ user, since })) as Raw[]).map(sql.out);
      const gone: ID[] = full ? [] : (db.q(sql.gone).all({ user, since }) as { id: ID }[]).map((r) => r.id);
      let done: Set<ID> | null = null;
      const send = (id: ID): void => {
        done ??= new Set([...rows.map((r) => r.id), ...gone]);
        if (done.has(id)) return;
        done.add(id);
        const row = db.q(sql.one).get({ user, id }) as Raw | undefined;
        if (row) rows.push(sql.out(row));
        else gone.push(id);
      };
      return { rows, gone, send };
    };
    const parts = {
      list: part({ all: LISTS, changed: LISTS_SINCE, one: LIST_ONE, gone: GONE_LISTS, out: listOut }),
      task: part({ all: TASKS, changed: TASKS_SINCE, one: TASK_ONE, gone: GONE_TASKS, out: taskOut }),
      note: part({ all: NOTES, changed: NOTES_SINCE, one: NOTE_ONE, gone: GONE_NOTES, out: noteOut }),
    };
    // The device applied each of its ops already. Where that is not the state of the server, the
    // device gets the true row, or the id in 'gone', also if the row has no new revision.
    for (const { kind, id } of applied.stale) parts[kind].send(id);

    return {
      response: {
        rev,
        reset,
        lists: parts.list.rows,
        tasks: parts.task.rows,
        notes: parts.note.rows,
        gone: { lists: parts.list.gone, tasks: parts.task.gone, notes: parts.note.gone },
        acked: applied.acked,
        rejected: applied.rejected,
        now,
      },
      poke: applied.poke,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Start on a database copy
// ---------------------------------------------------------------------------------------------

/** More revisions than a server makes between a database copy and the day when the copy is put back. */
const COPY_REV_JUMP = 1_000_000_000;

/**
 * A database copy that was put back is older than the rows of the devices. The revision of a
 * device can then be a number that this database gives to a different change later, and the
 * device would miss changes with no sign. So the counter jumps far ahead, and each device gets
 * 'reset' at its next sync. Returns true if the database was a copy.
 */
export function adoptCopy(db: Db): boolean {
  return db.tx(() => {
    if (db.getMeta('copy') === null) return false;
    const rev = Number(db.getMeta('rev') ?? 0) + COPY_REV_JUMP;
    db.setMeta('rev', String(rev));
    db.setMeta('pruned_rev', String(rev));
    db.q("DELETE FROM meta WHERE key = 'copy'").run();
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// Cleanup of old deleted rows
// ---------------------------------------------------------------------------------------------

const TOMBSTONE_MAX_AGE_MS = 180 * 86_400_000;

/**
 * Removes the deleted rows that are older than 180 days, and the tasks of removed lists.
 * Returns the number of removed rows.
 */
export function pruneTombstones(input: { db: Db; now: number }): number {
  const { db } = input;
  const before = input.now - TOMBSTONE_MAX_AGE_MS;
  return db.tx(() => {
    const old = (text: string): ID[] => (db.q(text).all(before) as { id: ID }[]).map((r) => r.id);
    const oldLists = old('SELECT id FROM lists WHERE deleted = 1 AND at < ?');
    const oldTasks = old('SELECT id FROM tasks WHERE deleted = 1 AND at < ?');
    const oldNotes = old('SELECT id FROM notes WHERE deleted = 1 AND at < ?');
    for (const listId of oldLists) {
      for (const r of db.q('SELECT id FROM tasks WHERE list_id = ?').all(listId) as { id: ID }[]) oldTasks.push(r.id);
    }
    // The 'gone' marks go away with the rows. A device that did not sync after the newest of them
    // can no longer learn that the rows are gone, so the sync tells it to start again.
    let pruned = Number(db.getMeta('pruned_rev') ?? 0);
    const raise = (row: unknown): void => {
      pruned = Math.max(pruned, (row as { lost: number | null }).lost ?? 0);
    };
    for (const taskId of oldTasks) {
      raise(db.q('SELECT MAX(lost_rev) AS lost FROM task_user WHERE task_id = ?').get(taskId));
      db.q('DELETE FROM task_user WHERE task_id = ?').run(taskId);
      db.q('DELETE FROM tasks WHERE id = ?').run(taskId);
    }
    for (const listId of oldLists) {
      raise(db.q('SELECT MAX(lost_rev) AS lost FROM list_user WHERE list_id = ?').get(listId));
      db.q('DELETE FROM list_user WHERE list_id = ?').run(listId);
      db.q('DELETE FROM lists WHERE id = ?').run(listId);
    }
    for (const noteId of oldNotes) {
      raise(db.q('SELECT MAX(lost_rev) AS lost FROM note_user WHERE note_id = ?').get(noteId));
      db.q('DELETE FROM note_user WHERE note_id = ?').run(noteId);
      db.q('DELETE FROM notes WHERE id = ?').run(noteId);
    }
    const count = oldLists.length + oldTasks.length + oldNotes.length;
    if (count > 0) db.setMeta('pruned_rev', String(pruned));
    return count;
  });
}
