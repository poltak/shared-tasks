import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { App } from './app.ts';
import type { Db } from './db.ts';
import { HttpError, invalid, str } from './http.ts';
import { makeDefaultList } from './sync.ts';
import { LIMITS } from '../shared/types.ts';
import type { ID, MeResponse, User } from '../shared/types.ts';

const COOKIE = 'st_session';
const SESSION_MS = 400 * 86_400_000;
const RENEW_AFTER_MS = 86_400_000;
const SCRYPT = { N: 16384, r: 8, p: 1 };
/** A longer password gives no more safety, and its hash costs time. */
const PASSWORD_MAX = 1024;
const LOCK_AFTER = 5;

// ---------------------------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------------------------

export interface PasswordHash {
  hash: Buffer;
  salt: Buffer;
}

export function hashPassword(password: string, salt: Buffer = randomBytes(16)): Promise<PasswordHash> {
  // Two keyboards can give different code points for the same visible text. NFKC makes them equal.
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, 32, SCRYPT, (error, hash) => (error ? reject(error) : resolve({ hash, salt })));
  });
}

export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const { hash } = await hashPassword(password, stored.salt);
  return hash.length === stored.hash.length && timingSafeEqual(hash, stored.hash);
}

// The check of an unknown name must take as long as the check of a known name.
const NO_ACCOUNT: PasswordHash = { hash: Buffer.alloc(32), salt: Buffer.alloc(16) };

export function cleanPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < LIMITS.passwordMin) {
    throw invalid(`The password must have at least ${LIMITS.passwordMin} characters`);
  }
  if (value.length > PASSWORD_MAX) throw invalid(`The password can have ${PASSWORD_MAX} characters at most`);
  return value;
}

// ---------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------

export function cleanName(value: unknown): string {
  if (typeof value !== 'string') throw invalid('The name must be text');
  const name = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  const length = [...name].length;
  if (length < 1 || length > LIMITS.name || /\p{Cc}/u.test(name)) {
    throw invalid(`The name must have 1 to ${LIMITS.name} characters`);
  }
  return name;
}

/** Two names with the same key are the same name: "Alex", "alex", and " ALEX ". */
export function nameKey(name: string): string {
  return name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function listUsers(db: Db): User[] {
  return db.q('SELECT id, name FROM users ORDER BY created_at, rowid').all() as unknown as User[];
}

function countUsers(db: Db): number {
  return (db.q('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

function nameTaken(input: { db: Db; name: string; except?: ID }): boolean {
  const row = input.db.q('SELECT id FROM users WHERE name_key = ?').get(nameKey(input.name)) as { id: ID } | undefined;
  return row !== undefined && row.id !== input.except;
}

/** Makes an account from a password hash, with its default list. `maxUsers` closes the sign-up. */
export function insertUser(input: { db: Db; name: string; password: PasswordHash; now: number; maxUsers?: number }): User {
  const { db, name, password, now } = input;
  return db.tx(() => {
    if (input.maxUsers !== undefined && countUsers(db) >= input.maxUsers) {
      throw new HttpError(403, 'closed', 'Sign-up is closed');
    }
    if (nameTaken({ db, name })) throw new HttpError(409, 'conflict', 'This name is in use');
    const user: User = { id: randomUUID(), name };
    db.q('INSERT INTO users (id, name, name_key, pw_hash, pw_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      user.id,
      name,
      nameKey(name),
      password.hash,
      password.salt,
      now,
    );
    makeDefaultList({ db, userId: user.id, now });
    return user;
  });
}

/** Makes an account from a name and a password. Throws 'invalid', 'conflict', or 'closed'. */
export async function createUser(input: { db: Db; name: unknown; password: unknown; now: number; maxUsers?: number }): Promise<User> {
  const name = cleanName(input.name);
  const password = await hashPassword(cleanPassword(input.password));
  return insertUser({ db: input.db, name, password, now: input.now, maxUsers: input.maxUsers });
}

/** Sets a new password. Ends each session of the account, but not the session `keep`. */
export async function setPassword(input: { db: Db; userId: ID; password: unknown; keep?: Uint8Array }): Promise<void> {
  const { db } = input;
  const { hash, salt } = await hashPassword(cleanPassword(input.password));
  db.tx(() => {
    db.q('UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?').run(hash, salt, input.userId);
    db.q('DELETE FROM sessions WHERE user_id = ? AND hash != ?').run(input.userId, input.keep ?? new Uint8Array(0));
  });
}

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

export interface Session {
  /** SHA-256 of the token. The database key of the session. */
  hash: Buffer;
  /** Text form of the hash, to name the session in memory. */
  key: string;
  user: User;
  renewedAt: number;
}

const sha256 = (text: string): Buffer => createHash('sha256').update(text).digest();

function readToken(req: IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

export function cookieHeader(input: { token: string | null; secure: boolean }): string {
  const parts = [
    `${COOKIE}=${input.token ?? ''}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${input.token === null ? 0 : SESSION_MS / 1000}`,
  ];
  if (input.secure) parts.push('Secure');
  return parts.join('; ');
}

/** Starts a session. Returns the token for the cookie. */
export function startSession(input: { db: Db; userId: ID; now: number }): string {
  const token = randomBytes(32).toString('base64url');
  input.db
    .q('INSERT INTO sessions (hash, user_id, created_at, renewed_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(token), input.userId, input.now, input.now, input.now + SESSION_MS);
  return token;
}

export function findSession(input: { db: Db; req: IncomingMessage; now: number }): Session | null {
  const token = readToken(input.req);
  if (!token || token.length > 128) return null;
  const hash = sha256(token);
  const row = input.db
    .q(
      `SELECT s.hash, s.user_id, s.renewed_at, s.expires_at, u.name
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ?`,
    )
    .get(hash) as { hash: Uint8Array; user_id: ID; renewed_at: number; expires_at: number; name: string } | undefined;
  if (!row || !timingSafeEqual(hash, row.hash)) return null;
  if (row.expires_at <= input.now) {
    input.db.q('DELETE FROM sessions WHERE hash = ?').run(hash);
    return null;
  }
  return { hash, key: hash.toString('hex'), user: { id: row.user_id, name: row.name }, renewedAt: row.renewed_at };
}

/** Gives the session 400 more days if its last renewal is more than one day in the past. */
export function renewSession(input: { db: Db; session: Session; now: number; req: IncomingMessage; res: ServerResponse; secure: boolean }): void {
  const { session, now } = input;
  if (now - session.renewedAt <= RENEW_AFTER_MS) return;
  input.db.q('UPDATE sessions SET renewed_at = ?, expires_at = ? WHERE hash = ?').run(now, now + SESSION_MS, session.hash);
  // The cookie in the browser gets the new end date too.
  input.res.setHeader('Set-Cookie', cookieHeader({ token: readToken(input.req), secure: input.secure }));
}

export function cleanSessions(input: { db: Db; now: number }): void {
  input.db.q('DELETE FROM sessions WHERE expires_at <= ?').run(input.now);
}

// ---------------------------------------------------------------------------------------------
// The limit on wrong passwords
// ---------------------------------------------------------------------------------------------

export interface LoginGuard {
  /** Counts one try for the key. Throws 'rate_limited' while the key is locked. */
  begin(key: string, now: number): void;
  /** The try was good: the count starts again. */
  ok(key: string): void;
}

export function createLoginGuard(lockMs: number): LoginGuard {
  const entries = new Map<string, { tries: number; until: number }>();
  return {
    begin(key, now) {
      let entry = entries.get(key);
      if (entry && entry.until > now) {
        const seconds = Math.ceil((entry.until - now) / 1000);
        throw new HttpError(429, 'rate_limited', `Too many wrong passwords. Try again in ${seconds} seconds`);
      }
      if (!entry || entry.until !== 0) {
        if (entries.size > 10_000) {
          for (const [k, e] of entries) if (e.until <= now) entries.delete(k);
        }
        entry = { tries: 0, until: 0 };
        entries.set(key, entry);
      }
      // The lock starts with try 5 and not after it, so tries that run at the same time cannot
      // get more than 5 guesses. A good try 5 removes the lock again.
      entry.tries += 1;
      if (entry.tries >= LOCK_AFTER) entry.until = now + lockMs;
    },
    ok(key) {
      entries.delete(key);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

export function meResponse(app: App, me: User | null): MeResponse {
  return {
    me,
    // A visitor with no session does not learn the names of the accounts.
    users: me ? listUsers(app.db) : [],
    canRegister: countUsers(app.db) < app.config.maxUsers,
    vapidPublicKey: app.vapid.publicKey,
    version: app.config.version,
  };
}

export function addAuthRoutes(app: App): void {
  const { db, router, config, now } = app;
  const secure = config.publicOrigin?.startsWith('https') ?? false;
  const guard = createLoginGuard(app.loginLockMs);

  const signIn = (res: ServerResponse, userId: ID): void => {
    res.setHeader('Set-Cookie', cookieHeader({ token: startSession({ db, userId, now: now() }), secure }));
  };

  router.add('GET', '/api/me', ({ req }) => meResponse(app, findSession({ db, req, now: now() })?.user ?? null));

  router.add('POST', '/api/register', async ({ res, body }) => {
    const name = cleanName(body.name);
    const password = cleanPassword(body.password);
    // These two checks run again with the insert. Here they save the cost of the hash.
    if (countUsers(db) >= config.maxUsers) throw new HttpError(403, 'closed', 'Sign-up is closed');
    if (nameTaken({ db, name })) throw new HttpError(409, 'conflict', 'This name is in use');
    const user = insertUser({ db, name, password: await hashPassword(password), now: now(), maxUsers: config.maxUsers });
    signIn(res, user.id);
    return meResponse(app, user);
  });

  router.add('POST', '/api/login', async ({ res, body }) => {
    const name = str(body, 'name');
    const password = str(body, 'password');
    const wrong = new HttpError(401, 'unauthorized', 'The name or the password is wrong');
    if (name.length > 4 * LIMITS.name || password.length > PASSWORD_MAX) throw wrong;
    const key = nameKey(name);
    guard.begin(key, now());
    const row = db.q('SELECT id, name, pw_hash, pw_salt FROM users WHERE name_key = ?').get(key) as
      | { id: ID; name: string; pw_hash: Uint8Array; pw_salt: Uint8Array }
      | undefined;
    const stored = row ? { hash: Buffer.from(row.pw_hash), salt: Buffer.from(row.pw_salt) } : NO_ACCOUNT;
    if (!(await verifyPassword(password, stored)) || !row) throw wrong;
    guard.ok(key);
    signIn(res, row.id);
    return meResponse(app, { id: row.id, name: row.name });
  });

  router.add('POST', '/api/logout', ({ req, res }) => {
    const session = findSession({ db, req, now: now() });
    if (session) {
      // The push subscriptions of the session go with it, so this device gets no more notifications.
      db.q('DELETE FROM sessions WHERE hash = ?').run(session.hash);
      app.events.close((stream) => stream.sessionKey === session.key);
    }
    res.setHeader('Set-Cookie', cookieHeader({ token: null, secure }));
    return { ok: true };
  });

  router.add('POST', '/api/password', async ({ req, body }) => {
    const session = app.auth(req);
    const current = str(body, 'current');
    cleanPassword(body.next);
    // A person who took a signed-in device must not be able to guess the password without limit.
    const key = `password:${session.user.id}`;
    guard.begin(key, now());
    const row = db.q('SELECT pw_hash, pw_salt FROM users WHERE id = ?').get(session.user.id) as {
      pw_hash: Uint8Array;
      pw_salt: Uint8Array;
    };
    const stored = { hash: Buffer.from(row.pw_hash), salt: Buffer.from(row.pw_salt) };
    if (current.length > PASSWORD_MAX || !(await verifyPassword(current, stored))) {
      throw new HttpError(403, 'forbidden', 'The current password is wrong');
    }
    guard.ok(key);
    await setPassword({ db, userId: session.user.id, password: body.next, keep: session.hash });
    app.events.close((stream) => stream.userId === session.user.id && stream.sessionKey !== session.key);
    return { ok: true };
  });

  router.add('POST', '/api/profile', ({ req, body }) => {
    const session = app.auth(req);
    const name = cleanName(body.name);
    db.tx(() => {
      if (nameTaken({ db, name, except: session.user.id })) throw new HttpError(409, 'conflict', 'This name is in use');
      db.q('UPDATE users SET name = ?, name_key = ? WHERE id = ?').run(name, nameKey(name), session.user.id);
    });
    return meResponse(app, { id: session.user.id, name });
  });
}
