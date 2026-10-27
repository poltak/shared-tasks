import type { ID, ListRow, NoteRow, Put, TaskRow } from './types.ts';

/** All rows that a device has. The maps change in place. A row object never changes. */
export interface Rows {
  lists: Map<ID, ListRow>;
  tasks: Map<ID, TaskRow>;
  notes: Map<ID, NoteRow>;
}

export function emptyRows(): Rows {
  return { lists: new Map(), tasks: new Map(), notes: new Map() };
}

export function defaultList(id: ID): ListRow {
  return {
    id,
    title: '',
    owner: '',
    shared: false,
    isDefault: false,
    createdAt: 0,
    deleted: false,
    pos: null,
    sort: 'my',
    hidden: false,
  };
}

export function defaultTask(id: ID): TaskRow {
  return {
    id,
    listId: '',
    parentId: null,
    title: '',
    notes: '',
    pos: 'a0',
    due: null,
    time: null,
    deadline: null,
    repeat: null,
    repeatCount: 0,
    hiddenUntil: null,
    lastDoneAt: null,
    lastDoneDue: null,
    completed: false,
    completedAt: null,
    completedBy: null,
    createdAt: 0,
    createdBy: '',
    deleted: false,
    starred: false,
    starredAt: null,
  };
}

export function defaultNote(id: ID): NoteRow {
  return {
    id,
    title: '',
    body: '',
    color: 'default',
    shared: false,
    editedAt: 0,
    editedBy: null,
    deleted: false,
    owner: '',
    createdAt: 0,
    pinned: false,
    archived: false,
  };
}

/**
 * true if two field values are equal. A repeat rule is the only value that is an object. The
 * server writes its keys in a different order than a device does, so the key order is ignored.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) => key in b && sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

function merge<Row extends { id: ID }>(map: Map<ID, Row>, base: Row, fields: object): Row {
  let next: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(fields)) {
    // JSON drops a field with the value undefined, so the server would not get it.
    if (value === undefined || key === 'id' || !(key in base)) continue;
    if (sameValue((base as Record<string, unknown>)[key], value)) continue;
    next ??= { ...base };
    next[key] = value;
  }
  const row = (next ?? base) as Row;
  if (map.get(base.id) !== row) map.set(base.id, row);
  return row;
}

/**
 * Applies a put to the rows and gives the row that is now in the map.
 * A changed row is a new object, so the screen can compare objects to see a change. A put that
 * changes no value keeps the old object.
 *
 * A row that is not there starts from the default row, but only if the put can make a row: it has
 * the title of a list, the list of a task, or the creation time of a note. Each put that makes a
 * row has these, and the server has the same rule. A different put for a row that is not there is
 * a late change to a row that the device dropped (an undo, or an op that waits in the outbox). It
 * gives null and makes no row, because that row would be an empty list, a task in no list, or an
 * empty note that never goes away.
 *
 * A note cannot use its title as the mark: each key in the editor sends the title, and it can be
 * empty.
 */
export function applyPut(rows: Rows, put: Extract<Put, { kind: 'list' }>): ListRow | null;
export function applyPut(rows: Rows, put: Extract<Put, { kind: 'task' }>): TaskRow | null;
export function applyPut(rows: Rows, put: Extract<Put, { kind: 'note' }>): NoteRow | null;
export function applyPut(rows: Rows, put: Put): ListRow | TaskRow | NoteRow | null;
export function applyPut(rows: Rows, put: Put): ListRow | TaskRow | NoteRow | null {
  if (put.kind === 'list') {
    const base = rows.lists.get(put.id) ?? (put.fields.title === undefined ? null : defaultList(put.id));
    return base && merge(rows.lists, base, put.fields);
  }
  if (put.kind === 'note') {
    const base = rows.notes.get(put.id) ?? (put.fields.createdAt === undefined ? null : defaultNote(put.id));
    return base && merge(rows.notes, base, put.fields);
  }
  const base = rows.tasks.get(put.id) ?? (put.fields.listId === undefined ? null : defaultTask(put.id));
  return base && merge(rows.tasks, base, put.fields);
}

export function applyPuts(rows: Rows, puts: readonly Put[]): void {
  for (const put of puts) applyPut(rows, put);
}
