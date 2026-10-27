import type { ID, ListRow, NoteRow, Op, TaskRow } from '../../../shared/types.ts';
import type { Snapshot, Storage, StorageFactory, WriteBatch } from './storage.ts';

const STORES = ['lists', 'tasks', 'notes', 'outbox', 'meta'] as const;
/** Version 2 adds the notes. */
const VERSION = 2;

const nameOf = (userId: ID): string => `st-${userId}`;

function openDb(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      // Each version makes only its own stores: createObjectStore throws for a store that is there,
      // and the upgrade from version 1 must keep the rows and the outbox of the device.
      if (event.oldVersion < 1) {
        db.createObjectStore('lists', { keyPath: 'id' });
        db.createObjectStore('tasks', { keyPath: 'id' });
        db.createObjectStore('outbox', { keyPath: 'opId' });
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (event.oldVersion < 2) db.createObjectStore('notes', { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const db = request.result;
      // A different tab deletes the database at sign-out, or opens a newer version. An open
      // connection would block the two.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    // 'blocked': a tab with the code from before has the database open. That tab closes its
    // connection at 'versionchange', and then the upgrade goes on. A tab that the browser froze in
    // the background does it late, so the open waits, and the start decides with its own time limit.
    request.onblocked = () => undefined;
  });
}

/** Ends when the transaction is on the disk, or fails with its error. */
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('The local database refused the transaction'));
  });
}

function storageOf(db: IDBDatabase): Storage {
  return {
    async load() {
      const tx = db.transaction(STORES, 'readonly');
      // The reads are in the queue of one transaction, so they see one state.
      const [lists, tasks, notes, outbox, meta] = STORES.map((name) => tx.objectStore(name).getAll());
      await done(tx);
      const snapshot: Snapshot = {
        lists: lists!.result as ListRow[],
        tasks: tasks!.result as TaskRow[],
        notes: notes!.result as NoteRow[],
        outbox: outbox!.result as Op[],
        meta: {},
      };
      for (const { key, value } of meta!.result as { key: string; value: unknown }[]) snapshot.meta[key] = value;
      return snapshot;
    },

    write(batch: WriteBatch) {
      // 'relaxed': the write does not wait for the disk to confirm. The server has each row too,
      // and an op that is lost in a power cut is one change of some milliseconds before.
      const tx = db.transaction(STORES, 'readwrite', { durability: 'relaxed' });
      const lists = tx.objectStore('lists');
      const tasks = tx.objectStore('tasks');
      const notes = tx.objectStore('notes');
      const outbox = tx.objectStore('outbox');
      const meta = tx.objectStore('meta');
      if (batch.clear) {
        lists.clear();
        tasks.clear();
        notes.clear();
      }
      for (const row of batch.lists) lists.put(row);
      for (const id of batch.listsGone) lists.delete(id);
      for (const row of batch.tasks) tasks.put(row);
      for (const id of batch.tasksGone) tasks.delete(id);
      for (const row of batch.notes) notes.put(row);
      for (const id of batch.notesGone) notes.delete(id);
      for (const op of batch.ops) outbox.put(op);
      for (const id of batch.opsGone) outbox.delete(id);
      for (const [key, value] of Object.entries(batch.meta)) meta.put({ key, value });
      return done(tx);
    },

    close: () => db.close(),
  };
}

/** One IndexedDB database for each account, with the name 'st-' and the id of the person. */
export function idbStorage(getFactory: () => IDBFactory = () => indexedDB): StorageFactory {
  return {
    open: async (userId) => storageOf(await openDb(getFactory(), nameOf(userId))),
    remove: (userId) =>
      new Promise((resolve) => {
        const request = getFactory().deleteDatabase(nameOf(userId));
        // 'blocked': a different tab has the database open. The delete runs when that tab closes
        // its connection, and a new open waits for it. So the sign-out does not wait here.
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
      }),
  };
}
