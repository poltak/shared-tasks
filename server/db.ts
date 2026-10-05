import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// Each entry moves the schema one version up. PRAGMA user_version holds the number of entries
// that the database has already. Add new entries at the end and never change an old one.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    pw_hash BLOB NOT NULL,
    pw_salt BLOB NOT NULL,
    tz TEXT,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE sessions (
    hash BLOB PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    renewed_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX sessions_user ON sessions(user_id);

  -- rev: the revision of the last change. ts: JSON, field name to the timestamp of its value.
  -- at: server time of the last change, for the cleanup of old deleted rows.
  CREATE TABLE lists (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    owner TEXT NOT NULL,
    shared INTEGER NOT NULL,
    is_default INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL,
    rev INTEGER NOT NULL,
    ts TEXT NOT NULL,
    at INTEGER NOT NULL
  ) STRICT;

  -- The fields of a list that each person has a separate value for.
  -- lost_rev: the revision at which this person stopped seeing the row. It gives the 'gone' ids
  -- of a sync, and only for a person who did see the row.
  CREATE TABLE list_user (
    list_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    pos TEXT,
    sort TEXT NOT NULL DEFAULT 'my',
    hidden INTEGER NOT NULL DEFAULT 0,
    rev INTEGER NOT NULL DEFAULT 0,
    ts TEXT NOT NULL DEFAULT '{}',
    lost_rev INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (list_id, user_id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX list_user_lost ON list_user(user_id, lost_rev);

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    list_id TEXT NOT NULL,
    parent_id TEXT,
    title TEXT NOT NULL,
    notes TEXT NOT NULL,
    pos TEXT NOT NULL,
    due TEXT,
    time TEXT,
    deadline TEXT,
    repeat TEXT,
    repeat_count INTEGER NOT NULL,
    hidden_until TEXT,
    last_done_at INTEGER,
    last_done_due TEXT,
    completed INTEGER NOT NULL,
    completed_at INTEGER,
    completed_by TEXT,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    deleted INTEGER NOT NULL,
    rev INTEGER NOT NULL,
    ts TEXT NOT NULL,
    at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX tasks_rev ON tasks(rev);
  CREATE INDEX tasks_list ON tasks(list_id);
  CREATE INDEX tasks_due ON tasks(due) WHERE due IS NOT NULL;
  CREATE INDEX tasks_deadline ON tasks(deadline) WHERE deadline IS NOT NULL;

  CREATE TABLE task_user (
    task_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    starred INTEGER NOT NULL DEFAULT 0,
    starred_at INTEGER,
    rev INTEGER NOT NULL DEFAULT 0,
    ts TEXT NOT NULL DEFAULT '{}',
    lost_rev INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (task_id, user_id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX task_user_rev ON task_user(user_id, rev);
  CREATE INDEX task_user_lost ON task_user(user_id, lost_rev);

  CREATE TABLE push_subs (
    endpoint TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_hash BLOB NOT NULL REFERENCES sessions(hash) ON DELETE CASCADE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX push_subs_user ON push_subs(user_id);
  CREATE INDEX push_subs_session ON push_subs(session_hash);

  -- One row for each notification that was sent. at_key is the local date and time of the notification.
  CREATE TABLE notif_log (
    task_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    at_key TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, user_id, kind, at_key)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT, WITHOUT ROWID;
  `,
];

export interface Db {
  sql: DatabaseSync;
  /** Gives the prepared statement for a SQL text. Each text is prepared one time. */
  q(text: string): StatementSync;
  /** Runs fn in one transaction. A call in a transaction joins that transaction. */
  tx<T>(fn: () => T): T;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  close(): void;
}

export function dbPath(dataDir: string): string {
  return path.join(dataDir, 'shared-tasks.db');
}

export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const sql = new DatabaseSync(file);
  sql.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);

  const version = (sql.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version > MIGRATIONS.length) {
    sql.close();
    throw new Error(`The database has schema version ${version}. This server knows only ${MIGRATIONS.length}`);
  }
  for (let v = version; v < MIGRATIONS.length; v++) {
    sql.exec('BEGIN IMMEDIATE');
    try {
      sql.exec(MIGRATIONS[v]!);
      sql.exec(`PRAGMA user_version = ${v + 1}`);
      sql.exec('COMMIT');
    } catch (error) {
      sql.exec('ROLLBACK');
      sql.close();
      throw error;
    }
  }

  const statements = new Map<string, StatementSync>();
  const q = (text: string): StatementSync => {
    let statement = statements.get(text);
    if (!statement) {
      statement = sql.prepare(text);
      statements.set(text, statement);
    }
    return statement;
  };

  let open = true;
  let inTx = false;
  const tx = <T>(fn: () => T): T => {
    if (inTx) return fn();
    sql.exec('BEGIN IMMEDIATE');
    inTx = true;
    try {
      const result = fn();
      sql.exec('COMMIT');
      return result;
    } catch (error) {
      sql.exec('ROLLBACK');
      throw error;
    } finally {
      inTx = false;
    }
  };

  return {
    sql,
    q,
    tx,
    getMeta(key) {
      const row = q('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
      return row ? row.value : null;
    },
    setMeta(key, value) {
      q('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    },
    close() {
      if (!open) return;
      open = false;
      statements.clear();
      sql.close();
    },
  };
}
