// The local database on IndexedDB. Node.js has no IndexedDB, so the tests use a small stand-in
// with the rules that the upgrade depends on: `oldVersion`, a store that is there already,
// 'versionchange', and 'blocked'.
import { describe, expect, it } from 'vitest';
import { defaultList, defaultNote, defaultTask } from '../../../shared/merge.ts';
import type { ListRow, NoteRow, Op, TaskRow } from '../../../shared/types.ts';
import { idbStorage } from './idb.ts';
import type { WriteBatch } from './storage.ts';

type Handler = ((event: Record<string, unknown>) => void) | null;

interface StoreData {
  keyPath: string;
  rows: Map<unknown, unknown>;
}

interface DbData {
  version: number;
  stores: Map<string, StoreData>;
  open: Set<FakeDb>;
}

const later = (run: () => void): void => void setTimeout(run, 0);

class FakeRequest {
  result: unknown = undefined;
  error: DOMException | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onblocked: Handler = null;
  onupgradeneeded: Handler = null;
}

class FakeTransaction {
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  error: DOMException | null = null;
  private data: DbData;
  private mode: string;

  constructor(data: DbData, names: readonly string[], mode: string) {
    this.data = data;
    this.mode = mode;
    for (const name of names) if (!data.stores.has(name)) throw new DOMException(`No store ${name}`, 'NotFoundError');
    later(() => this.oncomplete?.({}));
  }

  objectStore(name: string) {
    const store = this.data.stores.get(name)!;
    const write = (): void => {
      if (this.mode !== 'readwrite') throw new DOMException('Read only', 'ReadOnlyError');
    };
    return {
      getAll: () => Object.assign(new FakeRequest(), { result: [...store.rows.values()].map((row) => structuredClone(row)) }),
      put: (row: Record<string, unknown>) => (write(), store.rows.set(row[store.keyPath], structuredClone(row))),
      delete: (key: unknown) => (write(), store.rows.delete(key)),
      clear: () => (write(), store.rows.clear()),
    };
  }
}

class FakeDb {
  closed = false;
  upgrading = false;
  onversionchange: Handler = null;
  private data: DbData;
  private onClose: () => void;

  constructor(data: DbData, onClose: () => void) {
    this.data = data;
    this.onClose = onClose;
  }

  get storeNames(): string[] {
    return [...this.data.stores.keys()].sort();
  }

  createObjectStore(name: string, options: { keyPath: string }): void {
    if (!this.upgrading) throw new DOMException('Not in an upgrade', 'InvalidStateError');
    if (this.data.stores.has(name)) throw new DOMException(`The store ${name} is there`, 'ConstraintError');
    this.data.stores.set(name, { keyPath: options.keyPath, rows: new Map() });
  }

  transaction(names: readonly string[], mode = 'readonly'): FakeTransaction {
    if (this.closed) throw new DOMException('The connection is closed', 'InvalidStateError');
    return new FakeTransaction(this.data, names, mode);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.data.open.delete(this);
    this.onClose();
  }
}

/** An IndexedDB with no transactions that fail, for one page. */
function fakeIndexedDB() {
  const dbs = new Map<string, DbData>();
  const waiting = new Set<() => void>();
  const changed = (): void => waiting.forEach((run) => run());

  /** Tells the open connections about a new version, and waits until each one is closed. */
  async function takeOver(data: DbData, request: FakeRequest, newVersion: number | null): Promise<void> {
    for (const db of data.open) db.onversionchange?.({ oldVersion: data.version, newVersion });
    if (data.open.size === 0) return;
    request.onblocked?.({ oldVersion: data.version, newVersion });
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (data.open.size > 0) return;
        waiting.delete(check);
        resolve();
      };
      waiting.add(check);
    });
  }

  function open(name: string, version: number): FakeRequest {
    const request = new FakeRequest();
    later(async () => {
      const data = dbs.get(name) ?? { version: 0, stores: new Map(), open: new Set() };
      dbs.set(name, data);
      if (version < data.version) {
        request.error = new DOMException('The database is newer', 'VersionError');
        request.onerror?.({});
        return;
      }
      const db = new FakeDb(data, changed);
      if (version > data.version) {
        await takeOver(data, request, version);
        const oldVersion = data.version;
        const stores = new Map(data.stores);
        data.version = version;
        db.upgrading = true;
        request.result = db;
        try {
          request.onupgradeneeded?.({ oldVersion, newVersion: version });
        } catch (error) {
          // The browser aborts the upgrade: the version and the stores stay as they were.
          data.version = oldVersion;
          data.stores = stores;
          request.error = error instanceof DOMException ? error : new DOMException(String(error), 'AbortError');
          request.onerror?.({});
          return;
        } finally {
          db.upgrading = false;
        }
      }
      data.open.add(db);
      request.result = db;
      request.onsuccess?.({});
    });
    return request;
  }

  function deleteDatabase(name: string): FakeRequest {
    const request = new FakeRequest();
    later(async () => {
      const data = dbs.get(name);
      if (data) await takeOver(data, request, null);
      dbs.delete(name);
      request.onsuccess?.({});
    });
    return request;
  }

  /** Opens a connection as the code from before notes did: version 1, with the four stores of that time. */
  function openVersion1(name: string): Promise<FakeDb> {
    return new Promise((resolve) => {
      const request = open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result as FakeDb;
        db.createObjectStore('lists', { keyPath: 'id' });
        db.createObjectStore('tasks', { keyPath: 'id' });
        db.createObjectStore('outbox', { keyPath: 'opId' });
        db.createObjectStore('meta', { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result as FakeDb);
    });
  }

  return {
    factory: { open, deleteDatabase } as unknown as IDBFactory,
    dbs,
    openVersion1,
    /** The open connections of a database, as the browser would count them. */
    connections: (name: string): FakeDb[] => [...(dbs.get(name)?.open ?? [])],
  };
}

const list: ListRow = { ...defaultList('list-1'), title: 'My Tasks', owner: 'user-1', isDefault: true };
const task: TaskRow = { ...defaultTask('task-1'), listId: 'list-1', title: 'Buy milk', createdBy: 'user-1' };
const note: NoteRow = { ...defaultNote('note-1'), title: 'Trip', body: 'Tickets', owner: 'user-1', createdAt: 5, editedAt: 5 };
const op: Op = { kind: 'task', id: 'task-1', fields: { title: 'Buy milk' }, opId: 'op-1', ts: '0000000000000-000' };

const batch = (fields: Partial<WriteBatch>): WriteBatch => ({
  clear: false,
  lists: [],
  listsGone: [],
  tasks: [],
  tasksGone: [],
  notes: [],
  notesGone: [],
  ops: [],
  opsGone: [],
  meta: {},
  ...fields,
});

describe('idbStorage', () => {
  it('makes the five stores in a new database, and gives back what it wrote', async () => {
    const idb = fakeIndexedDB();
    const storage = await idbStorage(() => idb.factory).open('user-1');
    expect(idb.dbs.get('st-user-1')!.version).toBe(2);
    expect(idb.connections('st-user-1')[0]!.storeNames).toEqual(['lists', 'meta', 'notes', 'outbox', 'tasks']);
    expect(await storage.load()).toEqual({ lists: [], tasks: [], notes: [], outbox: [], meta: {} });

    await storage.write(batch({ lists: [list], tasks: [task], notes: [note], ops: [op], meta: { since: 4, notesSynced: true } }));
    expect(await storage.load()).toEqual({ lists: [list], tasks: [task], notes: [note], outbox: [op], meta: { since: 4, notesSynced: true } });

    await storage.write(batch({ notesGone: [note.id], tasksGone: [task.id], opsGone: [op.opId] }));
    expect(await storage.load()).toMatchObject({ lists: [list], tasks: [], notes: [], outbox: [] });
  });

  it('clears the notes with the lists and the tasks, and keeps the outbox and the meta', async () => {
    const idb = fakeIndexedDB();
    const storage = await idbStorage(() => idb.factory).open('user-1');
    await storage.write(batch({ lists: [list], tasks: [task], notes: [note], ops: [op], meta: { since: 4 } }));
    const kept: NoteRow = { ...note, id: 'note-2' };
    await storage.write(batch({ clear: true, notes: [kept] }));
    expect(await storage.load()).toEqual({ lists: [], tasks: [], notes: [kept], outbox: [op], meta: { since: 4 } });
  });

  it('upgrades a database of version 1: the rows, the outbox, and the meta stay, and the notes store comes', async () => {
    const idb = fakeIndexedDB();
    const old = await idb.openVersion1('st-user-1');
    const data = idb.dbs.get('st-user-1')!;
    data.stores.get('lists')!.rows.set(list.id, list);
    data.stores.get('tasks')!.rows.set(task.id, task);
    data.stores.get('outbox')!.rows.set(op.opId, op);
    data.stores.get('meta')!.rows.set('since', { key: 'since', value: 9 });
    // The tab of the code from before closes its connection at 'versionchange'.
    old.onversionchange = () => old.close();

    const storage = await idbStorage(() => idb.factory).open('user-1');
    expect(old.closed).toBe(true);
    expect(data.version).toBe(2);
    expect(idb.connections('st-user-1')[0]!.storeNames).toEqual(['lists', 'meta', 'notes', 'outbox', 'tasks']);
    // No notesSynced: the first sync gets all rows one time.
    expect(await storage.load()).toEqual({ lists: [list], tasks: [task], notes: [], outbox: [op], meta: { since: 9 } });
    await storage.write(batch({ notes: [note] }));
    expect((await storage.load()).notes).toEqual([note]);

    // A second start opens version 2 with no upgrade.
    storage.close();
    const again = await idbStorage(() => idb.factory).open('user-1');
    expect((await again.load()).notes).toEqual([note]);
  });

  it('waits for a tab with the code from before that does not let go of the database', async () => {
    const idb = fakeIndexedDB();
    const old = await idb.openVersion1('st-user-1');
    // The browser froze that tab, so it does not answer 'versionchange' now.
    let opened = false;
    let failed = false;
    const opening = idbStorage(() => idb.factory)
      .open('user-1')
      .then(
        (storage) => ((opened = true), storage),
        () => void (failed = true),
      );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([opened, failed]).toEqual([false, false]);

    old.close();
    const storage = await opening;
    expect(opened).toBe(true);
    expect((await storage!.load()).notes).toEqual([]);
  });

  it('lets go of the database at versionchange, so a different tab can delete it at sign-out', async () => {
    const idb = fakeIndexedDB();
    const factory = idbStorage(() => idb.factory);
    const storage = await factory.open('user-1');
    await storage.write(batch({ notes: [note] }));
    await factory.remove('user-1');
    expect(idb.dbs.has('st-user-1')).toBe(false);
    expect(idb.connections('st-user-1')).toEqual([]);
    // A new start makes a new database.
    expect((await (await factory.open('user-1')).load()).notes).toEqual([]);
  });

  it('fails for a database of a newer version, so the start goes on without it', async () => {
    const idb = fakeIndexedDB();
    idb.dbs.set('st-user-1', { version: 3, stores: new Map(), open: new Set() });
    await expect(idbStorage(() => idb.factory).open('user-1')).rejects.toMatchObject({ name: 'VersionError' });
  });
});
