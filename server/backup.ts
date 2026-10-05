import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from './db.ts';

const NAME_RE = /^shared-tasks-\d{4}-\d{2}-\d{2}\.db$/;

/** The local day of the server, 'YYYY-MM-DD'. */
function dayOf(ms: number): string {
  const d = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/**
 * Writes the copy of the day to the folder, if the folder does not have it, and keeps the newest
 * `keep` copies. Returns the path of the new copy, or null if the copy of the day exists.
 */
export function runBackup(input: { db: Db; dir: string; now: number; keep?: number }): string | null {
  const { db, dir } = input;
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `shared-tasks-${dayOf(input.now)}.db`);
  if (existsSync(target)) return null;

  // VACUUM INTO gives a complete and compact copy while the server continues to work. It refuses
  // to write over a file. A copy under its final name must be complete, so the name comes last.
  const partial = `${target}.partial`;
  rmSync(partial, { force: true });
  db.q('VACUUM INTO ?').run(partial);
  // The mark tells a server that starts on this file that the file is a copy that was put back
  // (see adoptCopy). The devices then start again from its rows.
  const copy = new DatabaseSync(partial);
  try {
    copy.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('copy', '1')");
  } finally {
    copy.close();
  }
  renameSync(partial, target);

  const copies = readdirSync(dir).filter((name) => NAME_RE.test(name)).sort();
  for (const name of copies.slice(0, Math.max(0, copies.length - (input.keep ?? 30)))) {
    rmSync(path.join(dir, name), { force: true });
  }
  return target;
}
