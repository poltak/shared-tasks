import type { ID, ListRow, NoteRow, Op, TaskRow } from '../../../shared/types.ts';

/** All that a device keeps for one account. */
export interface Snapshot {
  lists: ListRow[];
  tasks: TaskRow[];
  notes: NoteRow[];
  outbox: Op[];
  /** `since`, `clientId`, `clock`, `offset`, `syncedAt`, `me`, `notesSynced`. */
  meta: Record<string, unknown>;
}

/** The changes of one tick. An adapter writes them in one transaction. */
export interface WriteBatch {
  /** true: all lists, tasks, and notes go away first, because the server sent a full set of rows. */
  clear: boolean;
  lists: ListRow[];
  listsGone: ID[];
  tasks: TaskRow[];
  tasksGone: ID[];
  notes: NoteRow[];
  notesGone: ID[];
  ops: Op[];
  opsGone: ID[];
  meta: Record<string, unknown>;
}

/** The local database of one account. */
export interface Storage {
  /** Reads everything in one transaction. */
  load(): Promise<Snapshot>;
  write(batch: WriteBatch): Promise<void>;
  close(): void;
}

export interface StorageFactory {
  open(userId: ID): Promise<Storage>;
  /** Deletes the database of the account. */
  remove(userId: ID): Promise<void>;
}

/** The part of localStorage that the data layer uses. */
export interface KeyValue {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface MemoryStorage extends StorageFactory {
  /** The ids of the accounts that have a database. */
  accounts(): ID[];
  /** What a start of the device would read, or null if the account has no database. */
  peek(userId: ID): Snapshot | null;
  /** The number of write transactions. */
  writes(): number;
}

interface MemoryDb {
  lists: Map<ID, ListRow>;
  tasks: Map<ID, TaskRow>;
  notes: Map<ID, NoteRow>;
  outbox: Map<ID, Op>;
  meta: Map<string, unknown>;
}

/**
 * Storage that lives as long as the object. It is for tests, and for a browser that gives no
 * IndexedDB (the app then works until the page closes).
 */
export function memoryStorage(): MemoryStorage {
  const dbs = new Map<ID, MemoryDb>();
  let writes = 0;

  // A real database gives new objects for each read. The copy keeps a device that starts again
  // from the objects of the device before it.
  const read = (db: MemoryDb): Snapshot =>
    structuredClone({
      lists: [...db.lists.values()],
      tasks: [...db.tasks.values()],
      notes: [...db.notes.values()],
      outbox: [...db.outbox.values()],
      meta: Object.fromEntries(db.meta),
    });

  return {
    async open(userId) {
      let db = dbs.get(userId);
      if (!db) {
        db = { lists: new Map(), tasks: new Map(), notes: new Map(), outbox: new Map(), meta: new Map() };
        dbs.set(userId, db);
      }
      const { lists, tasks, notes, outbox, meta } = db;
      return {
        load: async () => read(db),
        async write(batch) {
          writes += 1;
          if (batch.clear) {
            lists.clear();
            tasks.clear();
            notes.clear();
          }
          for (const row of batch.lists) lists.set(row.id, row);
          for (const id of batch.listsGone) lists.delete(id);
          for (const row of batch.tasks) tasks.set(row.id, row);
          for (const id of batch.tasksGone) tasks.delete(id);
          for (const row of batch.notes) notes.set(row.id, row);
          for (const id of batch.notesGone) notes.delete(id);
          for (const op of batch.ops) outbox.set(op.opId, op);
          for (const id of batch.opsGone) outbox.delete(id);
          for (const [key, value] of Object.entries(batch.meta)) meta.set(key, value);
        },
        close: () => undefined,
      };
    },
    async remove(userId) {
      dbs.delete(userId);
    },
    accounts: () => [...dbs.keys()],
    peek: (userId) => {
      const db = dbs.get(userId);
      return db ? read(db) : null;
    },
    writes: () => writes,
  };
}

/** Key-value storage in memory, for tests and for a browser that refuses localStorage. */
export function memoryKeyValue(): KeyValue {
  const values = new Map<string, string>();
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => void values.set(key, value),
    remove: (key) => void values.delete(key),
  };
}
