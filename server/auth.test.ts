import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { cookieHeader, createLoginGuard, hashPassword, verifyPassword } from './auth.ts';
import { HttpError } from './http.ts';
import { makeKit, rawRequest, startTestServer } from './testkit.ts';
import type { Kit, TestServer } from './testkit.ts';
import type { ApiError, MeResponse } from '../shared/types.ts';

const DAY = 86_400_000;

let server: TestServer;
let kit: Kit;
// The clock of the server. A test moves it to pass a lock or the life of a session.
let clock = Date.now();

beforeAll(async () => {
  server = await startTestServer({ name: 'auth', options: { now: () => clock } });
  kit = makeKit(server, () => clock);
});
afterAll(() => server.stop());

const code = (reply: { data: ApiError }): string => reply.data.error.code;

describe('accounts', () => {
  test('health and me work with no session', async () => {
    const health = await kit.call({ path: '/api/health' });
    expect(health.status).toBe(200);
    expect(health.data).toEqual({ ok: true, version: '0.1.0' });

    const me = await kit.call<MeResponse>({ path: '/api/me' });
    expect(me.status).toBe(200);
    expect(me.data).toMatchObject({ me: null, users: [], canRegister: true, version: '0.1.0' });
    expect(me.data.vapidPublicKey).toMatch(/^[\w-]{87}$/);
    // A cookie that the server does not know is the same as no cookie.
    expect((await kit.call<MeResponse>({ path: '/api/me', cookie: 'st_session=nothing' })).data.me).toBeNull();
  });

  test('register makes the account, signs in, and makes the default list', async () => {
    const reply = await kit.call<MeResponse>({ path: '/api/register', body: { name: '  Alex ', password: 'password-of-alex' } });
    expect(reply.status).toBe(200);
    expect(reply.data.me).toMatchObject({ name: 'Alex' });
    expect(reply.data.users).toEqual([reply.data.me]);
    expect(reply.data.canRegister).toBe(true);

    const cookie = reply.headers.getSetCookie()[0]!;
    expect(cookie).toMatch(/^st_session=[\w-]{43}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=34560000$/);

    const alex = await kit.login('Alex');
    const me = await alex.call<MeResponse>('/api/me');
    expect(me.data.me).toEqual(reply.data.me);

    const sync = await alex.sync();
    expect(sync.lists).toHaveLength(1);
    expect(sync.lists[0]).toMatchObject({
      title: 'My Tasks',
      owner: alex.user.id,
      isDefault: true,
      shared: false,
      deleted: false,
      pos: 'a0',
      sort: 'my',
      hidden: false,
    });
    expect(sync.tasks).toEqual([]);
  });

  test('register checks the name and the password', async () => {
    const register = (body: unknown) => kit.call<ApiError>({ path: '/api/register', body });
    for (const body of [
      { name: 'Sam', password: 'short' },
      { name: 'Sam' },
      { name: '', password: 'long-enough-1' },
      { name: '   ', password: 'long-enough-1' },
      { name: 'x'.repeat(41), password: 'long-enough-1' },
      { name: 5, password: 'long-enough-1' },
    ]) {
      const reply = await register(body);
      expect([reply.status, code(reply)]).toEqual([400, 'invalid']);
    }
    // A name is unique without regard to case.
    const taken = await register({ name: 'ALEX', password: 'long-enough-1' });
    expect([taken.status, code(taken)]).toEqual([409, 'conflict']);
    // No account came from these tries.
    expect((await kit.call<MeResponse>({ path: '/api/me' })).data.canRegister).toBe(true);
  });

  test('sign-up closes at MAX_USERS accounts', async () => {
    await kit.register('Sam');
    const me = await kit.call<MeResponse>({ path: '/api/me' });
    expect(me.data.canRegister).toBe(false);
    const third = await kit.call<ApiError>({ path: '/api/register', body: { name: 'Third', password: 'long-enough-1' } });
    expect([third.status, code(third)]).toEqual([403, 'closed']);
    const sam = await kit.login('Sam');
    expect((await sam.call<MeResponse>('/api/me')).data.users.map((u) => u.name)).toEqual(['Alex', 'Sam']);
  });

  test('login accepts the right password only', async () => {
    const good = await kit.call<MeResponse>({ path: '/api/login', body: { name: 'alex', password: 'password-of-alex' } });
    expect(good.status).toBe(200);
    expect(good.data.me?.name).toBe('Alex');
    expect(good.headers.getSetCookie()[0]).toMatch(/^st_session=[\w-]{43}; HttpOnly/);

    for (const body of [
      { name: 'Alex', password: 'password-of-sam' },
      { name: 'Nobody', password: 'password-of-alex' },
    ]) {
      const bad = await kit.call<ApiError>({ path: '/api/login', body });
      expect([bad.status, code(bad)]).toEqual([401, 'unauthorized']);
      expect(bad.headers.getSetCookie()).toEqual([]);
    }
    const noText = await kit.call<ApiError>({ path: '/api/login', body: { name: 'Alex' } });
    expect([noText.status, code(noText)]).toEqual([400, 'invalid']);
  });

  test('5 wrong passwords lock the name for 30 seconds', async () => {
    const tryLogin = (password: string) => kit.call<ApiError & MeResponse>({ path: '/api/login', body: { name: 'Sam', password } });
    // A good login puts the count back to 0, so 4 wrong tries before it do not count.
    for (let i = 0; i < 4; i++) expect((await tryLogin('wrong-password')).status).toBe(401);
    expect((await tryLogin('password-of-sam')).status).toBe(200);

    for (let i = 0; i < 5; i++) expect((await tryLogin('wrong-password')).status).toBe(401);
    const locked = await tryLogin('password-of-sam');
    expect([locked.status, code(locked)]).toEqual([429, 'rate_limited']);
    // The lock is for this name only.
    expect((await kit.call({ path: '/api/login', body: { name: 'Alex', password: 'password-of-alex' } })).status).toBe(200);

    clock += 29_000;
    expect((await tryLogin('password-of-sam')).status).toBe(429);
    clock += 1_001;
    expect((await tryLogin('password-of-sam')).status).toBe(200);
  });

  test('logout ends the session', async () => {
    const alex = await kit.login('Alex');
    const other = await kit.login('Alex');
    const reply = await alex.call('/api/logout', {});
    expect(reply.data).toEqual({ ok: true });
    expect(reply.headers.getSetCookie()[0]).toBe('st_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');

    expect((await alex.call<MeResponse>('/api/me')).data.me).toBeNull();
    const sync = await alex.call<ApiError>('/api/sync', { clientId: 'c1', since: 0, ops: [], tz: 'UTC' });
    expect([sync.status, code(sync)]).toEqual([401, 'unauthorized']);
    // The session of the other device continues.
    expect((await other.call<MeResponse>('/api/me')).data.me?.name).toBe('Alex');
    // A logout with no session is not an error.
    expect((await kit.call({ path: '/api/logout', body: {} })).status).toBe(200);
  });

  test('password change needs the current password and ends the other sessions', async () => {
    const here = await kit.login('Alex');
    const there = await kit.login('Alex');

    const wrong = await here.call<ApiError>('/api/password', { current: 'not-the-password', next: 'a-new-password-1' });
    expect([wrong.status, code(wrong)]).toEqual([403, 'forbidden']);
    const short = await here.call<ApiError>('/api/password', { current: 'password-of-alex', next: 'short' });
    expect([short.status, code(short)]).toEqual([400, 'invalid']);
    const noSession = await kit.call<ApiError>({ path: '/api/password', body: { current: 'password-of-alex', next: 'a-new-password-1' } });
    expect(noSession.status).toBe(401);

    const done = await here.call('/api/password', { current: 'password-of-alex', next: 'a-new-password-1' });
    expect(done.data).toEqual({ ok: true });
    expect((await here.call<MeResponse>('/api/me')).data.me?.name).toBe('Alex');
    expect((await there.call<MeResponse>('/api/me')).data.me).toBeNull();

    expect((await kit.call({ path: '/api/login', body: { name: 'Alex', password: 'password-of-alex' } })).status).toBe(401);
    expect((await kit.call({ path: '/api/login', body: { name: 'Alex', password: 'a-new-password-1' } })).status).toBe(200);
    // The other tests sign in with the first password.
    await here.call('/api/password', { current: 'a-new-password-1', next: 'password-of-alex' });
  });

  test('profile changes the display name', async () => {
    const alex = await kit.login('Alex');
    const taken = await alex.call<ApiError>('/api/profile', { name: 'sam' });
    expect([taken.status, code(taken)]).toEqual([409, 'conflict']);
    const empty = await alex.call<ApiError>('/api/profile', { name: ' ' });
    expect(empty.status).toBe(400);

    const reply = await alex.call<MeResponse>('/api/profile', { name: 'Alexandra' });
    expect(reply.data.me).toEqual({ id: alex.user.id, name: 'Alexandra' });
    expect(reply.data.users.map((u) => u.name)).toEqual(['Alexandra', 'Sam']);
    // The sign-in uses the new name. The same name in a different case is not a conflict.
    expect((await kit.call({ path: '/api/login', body: { name: 'alexandra', password: 'password-of-alex' } })).status).toBe(200);
    expect((await alex.call<MeResponse>('/api/profile', { name: 'Alex' })).data.me?.name).toBe('Alex');
    expect((await kit.call({ path: '/api/profile', body: { name: 'X' } })).status).toBe(401);
  });
});

describe('sessions', () => {
  test('a sync renews the session after one day, and the session ends after 400 days', async () => {
    const alex = await kit.login('Alex');
    const body = { clientId: 'c1', since: 0, ops: [], tz: 'UTC' };

    clock += DAY - 60_000;
    expect((await alex.call('/api/sync', body)).headers.getSetCookie()).toEqual([]);
    clock += 120_000;
    const renewed = await alex.call('/api/sync', body);
    expect(renewed.headers.getSetCookie()).toEqual([`${alex.cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=34560000`]);
    expect((await alex.call('/api/sync', body)).headers.getSetCookie()).toEqual([]);

    // 399 days after the renewal the session lives. It would be over without the renewal.
    clock += 399 * DAY;
    expect((await alex.call<MeResponse>('/api/me')).data.me?.name).toBe('Alex');
    clock += 2 * DAY;
    expect((await alex.call<MeResponse>('/api/me')).data.me).toBeNull();
    expect((await alex.call('/api/sync', body)).status).toBe(401);
  });

  test('the cookie is Secure when the public address is https', () => {
    expect(cookieHeader({ token: 'abc', secure: true })).toBe('st_session=abc; HttpOnly; SameSite=Lax; Path=/; Max-Age=34560000; Secure');
  });

  test('passwords are scrypt hashes with a salt for each account', async () => {
    const one = await hashPassword('correct horse battery');
    const two = await hashPassword('correct horse battery');
    expect(one.hash.length).toBe(32);
    expect(one.salt.length).toBe(16);
    expect(one.salt.equals(two.salt)).toBe(false);
    expect(one.hash.equals(two.hash)).toBe(false);
    expect(await verifyPassword('correct horse battery', one)).toBe(true);
    expect(await verifyPassword('correct horse batterx', one)).toBe(false);

    const rows = server.app.db.q('SELECT pw_hash, pw_salt FROM users').all() as { pw_hash: Uint8Array; pw_salt: Uint8Array }[];
    expect(rows.every((r) => r.pw_hash.length === 32 && r.pw_salt.length === 16)).toBe(true);
    // The database has the hash of each session token, not the token.
    const alex = await kit.login('Alex');
    const token = alex.cookie.split('=')[1]!;
    const hashes = (server.app.db.q('SELECT hash FROM sessions').all() as { hash: Uint8Array }[]).map((r) => Buffer.from(r.hash));
    expect(hashes.every((h) => h.length === 32)).toBe(true);
    expect(hashes.some((h) => h.toString('base64url') === token)).toBe(false);
  });

  test('the login guard locks with try 5 and opens after the lock time', () => {
    const guard = createLoginGuard(30_000);
    for (let i = 0; i < 5; i++) guard.begin('a', 1000);
    expect(() => guard.begin('a', 1000)).toThrow(HttpError);
    expect(() => guard.begin('a', 30_999)).toThrow(HttpError);
    guard.begin('a', 31_000);
    // After a lock the count starts again.
    for (let i = 0; i < 3; i++) guard.begin('a', 31_000);
    guard.begin('b', 1000);
    guard.ok('a');
    for (let i = 0; i < 4; i++) guard.begin('a', 31_000);
  });
});

describe('requests', () => {
  test('a POST from a different origin is refused', async () => {
    const body = { name: 'Alex', password: 'password-of-alex' };
    const evil = await kit.call<ApiError>({ path: '/api/login', body, headers: { Origin: 'https://evil.example' } });
    expect([evil.status, code(evil)]).toEqual([403, 'forbidden']);
    const none = await kit.call<ApiError>({ path: '/api/login', body, headers: { Origin: 'null' } });
    expect(none.status).toBe(403);
    const same = await kit.call({ path: '/api/login', body, headers: { Origin: server.url } });
    expect(same.status).toBe(200);
  });

  test('the public address is accepted as origin, and makes the cookie Secure', async () => {
    const second = await startTestServer({ name: 'auth-public', env: { PUBLIC_ORIGIN: 'https://s22.example.ts.net:8443/' } });
    try {
      const body = { name: 'Alex', password: 'password-of-alex' };
      const reply = await makeKit(second).call({ path: '/api/register', body, headers: { Origin: 'https://s22.example.ts.net:8443' } });
      expect(reply.status).toBe(200);
      expect(reply.headers.getSetCookie()[0]).toMatch(/; Secure$/);
      const evil = await makeKit(second).call({ path: '/api/login', body, headers: { Origin: 'https://s22.example.ts.net' } });
      expect(evil.status).toBe(403);
    } finally {
      await second.stop();
    }
  });

  test('a body must be JSON with the JSON content type', async () => {
    const text = await kit.call<ApiError>({ path: '/api/login', body: '{"name":"Alex"}', headers: { 'Content-Type': 'text/plain' } });
    expect([text.status, code(text)]).toEqual([400, 'invalid']);
    const broken = await kit.call<ApiError>({ path: '/api/login', body: '{"name":' });
    expect([broken.status, code(broken)]).toEqual([400, 'invalid']);
    const list = await kit.call<ApiError>({ path: '/api/login', body: '[1,2]' });
    expect([list.status, code(list)]).toEqual([400, 'invalid']);
  });

  test('a body of more than 5 MB is refused', async () => {
    const alex = await kit.login('Alex');
    const big = JSON.stringify({ clientId: 'c1', since: 0, ops: [], tz: 'UTC', filler: 'x'.repeat(5 * 1024 * 1024) });
    const reply = await rawRequest({
      url: server.url,
      path: '/api/sync',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: alex.cookie, 'Content-Length': String(Buffer.byteLength(big)) },
      body: big,
    });
    expect(reply.status).toBe(413);
    expect(JSON.parse(reply.body.toString()).error.code).toBe('invalid');

    const small = JSON.stringify({ clientId: 'c1', since: 0, ops: [], tz: 'UTC', filler: 'x'.repeat(1024 * 1024) });
    expect((await alex.call('/api/sync', small)).status).toBe(200);
  });

  test('an unknown API route is an error in JSON, also the test route', async () => {
    const reply = await kit.call<ApiError>({ path: '/api/nothing' });
    expect([reply.status, code(reply)]).toEqual([404, 'not_found']);
    const reset = await kit.call<ApiError>({ path: '/api/test/reset', body: {} });
    expect([reset.status, code(reset)]).toEqual([404, 'not_found']);
    // The wrong method for a route is also not a route.
    expect((await kit.call({ path: '/api/sync' })).status).toBe(404);
  });

  test('a JSON answer over 1 kB is gzip when the client accepts it', async () => {
    const alex = await kit.login('Alex');
    const listId = (await alex.sync()).lists[0]!.id;
    await alex.sync(Array.from({ length: 20 }, (_, i) => kit.task({ listId, title: `Task number ${i}`, pos: `a${i}` })));
    const body = JSON.stringify({ clientId: 'c1', since: 0, ops: [], tz: 'UTC' });
    const headers = { 'Content-Type': 'application/json', Cookie: alex.cookie };

    const packed = await rawRequest({ url: server.url, path: '/api/sync', method: 'POST', headers: { ...headers, 'Accept-Encoding': 'gzip, br' }, body });
    expect(packed.headers['content-encoding']).toBe('gzip');
    expect(packed.headers.vary).toBe('Accept-Encoding');
    expect(packed.body[0]).toBe(0x1f);

    const plain = await rawRequest({ url: server.url, path: '/api/sync', method: 'POST', headers, body });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(plain.body.toString()).tasks).toHaveLength(20);
    expect(packed.body.length).toBeLessThan(plain.body.length / 2);

    // A small answer is not worth the work.
    const small = await rawRequest({ url: server.url, path: '/api/health', headers: { 'Accept-Encoding': 'gzip' } });
    expect(small.headers['content-encoding']).toBeUndefined();
  });

  test('each answer has the security headers', async () => {
    for (const path of ['/api/health', '/api/nothing', '/']) {
      const reply = await kit.call({ path });
      expect(reply.headers.get('x-content-type-options')).toBe('nosniff');
      expect(reply.headers.get('referrer-policy')).toBe('no-referrer');
      expect(reply.headers.get('x-frame-options')).toBe('DENY');
      expect(reply.headers.get('content-security-policy')).toContain("default-src 'self'");
    }
  });
});
