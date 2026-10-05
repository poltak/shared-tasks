import type { ID, ListRow, Op, TaskRow } from '../../../shared/types.ts';
import type { Snapshot, Storage, StorageFactory, WriteBatch } from './storage.ts';

const STORES = ['lists', 'tasks', 'outbox', 'meta'] as const;

const nameOf = (userId: ID): string => `st-${userId}`;

function openDb(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('lists', { keyPath: 'id' });
      db.createObjectStore('tasks', { keyPath: 'id' });
      db.createObjectStore('outbox', { keyPath: 'opId' });
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    request.onsuccess = () => {
      const db = request.result;
      // A different tab deletes the database at sign-out. An open connection would block that.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('The local database is blocked'));
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
      // The four reads are in the queue of one transaction, so they see one state.
      const [lists, tasks, outbox, meta] = STORES.map((name) => tx.objectStore(name).getAll());
      await done(tx);
      const snapshot: Snapshot = {
        lists: lists!.result as ListRow[],
        tasks: tasks!.result as TaskRow[],
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
      const outbox = tx.objectStore('outbox');
      const meta = tx.objectStore('meta');
      if (batch.clear) {
        lists.clear();
        tasks.clear();
      }
      for (const row of batch.lists) lists.put(row);
      for (const id of batch.listsGone) lists.delete(id);
      for (const row of batch.tasks) tasks.put(row);
      for (const id of batch.tasksGone) tasks.delete(id);
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
