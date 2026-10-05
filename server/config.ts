import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  webDir: string;
  /** Public address, with no slash at the end. null if not set. */
  publicOrigin: string | null;
  maxUsers: number;
  vapidSubject: string;
  backupDir: string | null;
  /** true: the route POST /api/test/reset exists. For automated tests only. */
  testReset: boolean;
  version: string;
}

/** The folder that holds server/, shared/, and package.json. */
export const ROOT = path.resolve(import.meta.dirname, '..');

function readVersion(): string {
  // The copy on the phone can be without package.json. The server must start in that case too.
  try {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function integer(input: { value: string | undefined; fallback: number; name: string }): number {
  if (input.value === undefined || input.value === '') return input.fallback;
  const n = Number(input.value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${input.name} must be a whole number, got "${input.value}"`);
  return n;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const publicOrigin = env.PUBLIC_ORIGIN ? env.PUBLIC_ORIGIN.replace(/\/+$/, '') : null;
  return {
    port: integer({ value: env.PORT, fallback: 5107, name: 'PORT' }),
    host: env.HOST || '127.0.0.1',
    dataDir: path.resolve(env.DATA_DIR || './data'),
    webDir: path.resolve(env.WEB_DIR || './web/dist'),
    publicOrigin,
    maxUsers: integer({ value: env.MAX_USERS, fallback: 2, name: 'MAX_USERS' }),
    // The push services refuse a token with no contact value, so there is always one.
    vapidSubject: env.VAPID_SUBJECT || publicOrigin || 'mailto:shared-tasks@localhost.invalid',
    backupDir: env.BACKUP_DIR ? path.resolve(env.BACKUP_DIR) : null,
    testReset: env.ST_TEST_RESET === '1',
    version: readVersion(),
  };
}
