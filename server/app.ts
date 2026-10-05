import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { addAuthRoutes, cleanSessions, findSession, renewSession } from './auth.ts';
import type { Session } from './auth.ts';
import { runBackup } from './backup.ts';
import type { Config } from './config.ts';
import { dbPath, openDb } from './db.ts';
import type { Db } from './db.ts';
import { createEvents } from './events.ts';
import type { Events } from './events.ts';
import { createRouter, HttpError, invalid, str } from './http.ts';
import type { Router } from './http.ts';
import { makeVapidKeys, parseSubscription, sendPush } from './push.ts';
import type { VapidKeys } from './push.ts';
import { cleanNotifLog, createScheduler } from './scheduler.ts';
import type { PushSubscription, Scheduler, SendFn } from './scheduler.ts';
import { readSeedAccounts, resetAndSeed } from './seed.ts';
import type { SeedAccount } from './seed.ts';
import { createStatic } from './static.ts';
import { adoptCopy, isId, parseSyncRequest, pruneTombstones, runSync } from './sync.ts';
import type { PushMessage } from '../shared/types.ts';

/** What the routes share. */
export interface App {
  config: Config;
  db: Db;
  now: () => number;
  router: Router;
  events: Events;
  vapid: VapidKeys;
  send: SendFn;
  loginLockMs: number;
  /** The session of a request. Throws 'unauthorized' if the request has none. */
  auth(req: IncomingMessage): Session;
  logError(error: unknown, req?: IncomingMessage): void;
}

export interface ServerOptions {
  config: Config;
  /** The clock of the server. A test gives its own. */
  now?: () => number;
  /** Sends one push message. A test gives its own, so no request goes to a push service. */
  send?: SendFn;
  /** How long a name is refused after 5 wrong passwords. Default: 30 seconds. */
  loginLockMs?: number;
  /** false: no scheduler and no daily jobs. A test calls `scheduler.tick()` and `maintain()` itself. */
  timers?: boolean;
  /** Gets the start line. Default: console.log. */
  log?: (line: string) => void;
}

export interface RunningServer {
  /** For example 'http://127.0.0.1:5107'. */
  url: string;
  port: number;
  app: App;
  scheduler: Scheduler;
  /** The jobs that run one time each day: the cleanup and the database copy. */
  maintain(): void;
  close(): Promise<void>;
}

const MAX_SUBSCRIPTIONS = 20;
const HOUR_MS = 3_600_000;

function addRoutes(app: App): void {
  const { db, router, config, events, now } = app;
  const secure = config.publicOrigin?.startsWith('https') ?? false;

  router.add('GET', '/api/health', () => ({ ok: true, version: config.version }));

  router.add('POST', '/api/sync', ({ req, res, body }) => {
    const session = app.auth(req);
    const request = parseSyncRequest(body);
    const time = now();
    const result = db.tx(() => {
      if (request.tz) db.q('UPDATE users SET tz = $tz WHERE id = $id AND tz IS NOT $tz').run({ tz: request.tz, id: session.user.id });
      renewSession({ db, session, now: time, req, res, secure });
      return runSync({ db, userId: session.user.id, request, now: time, onError: app.logError });
    });
    if (result.poke) {
      events.poke({ users: result.poke, rev: result.response.rev, except: { userId: session.user.id, clientId: request.clientId } });
    }
    return result.response;
  });

  // The query value 'client' is optional: the clientId of the device. The device then gets no poke
  // for a change that it made itself.
  router.add('GET', '/api/events', ({ req, res, url }) => {
    const session = app.auth(req);
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' }).end();
      return undefined;
    }
    const client = url.searchParams.get('client');
    events.open({
      req,
      res,
      userId: session.user.id,
      sessionKey: session.key,
      clientId: isId(client) ? client : null,
      rev: Number(db.getMeta('rev') ?? 0),
    });
    return undefined;
  });

  router.add('POST', '/api/push/subscribe', ({ req, body }) => {
    const session = app.auth(req);
    const subscription = parseSubscription(body);
    if (!subscription) throw invalid('The push subscription is not valid');
    db.tx(() => {
      // A device sends its subscription again at each start. The first time stays, because the
      // scheduler does not send a notification that is older than the subscription.
      db.q(
        `INSERT INTO push_subs (endpoint, user_id, session_hash, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           created_at = CASE WHEN user_id = excluded.user_id THEN created_at ELSE excluded.created_at END,
           user_id = excluded.user_id, session_hash = excluded.session_hash,
           p256dh = excluded.p256dh, auth = excluded.auth`,
      ).run(subscription.endpoint, session.user.id, session.hash, subscription.p256dh, subscription.auth, now());
      db.q(
        `DELETE FROM push_subs WHERE user_id = $user AND endpoint NOT IN
           (SELECT endpoint FROM push_subs WHERE user_id = $user ORDER BY created_at DESC LIMIT ${MAX_SUBSCRIPTIONS})`,
      ).run({ user: session.user.id });
    });
    return { ok: true };
  });

  router.add('POST', '/api/push/unsubscribe', ({ req, body }) => {
    const session = app.auth(req);
    db.q('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').run(str(body, 'endpoint'), session.user.id);
    return { ok: true };
  });

  router.add('POST', '/api/push/test', async ({ req }) => {
    const session = app.auth(req);
    const subscriptions = db
      .q('SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?')
      .all(session.user.id) as unknown as PushSubscription[];
    const message: PushMessage = {
      title: 'Shared Tasks',
      body: 'Notifications work on this device',
      taskId: null,
      listId: null,
      tag: 'test',
    };
    const results = await Promise.all(subscriptions.map((subscription) => app.send({ subscription, message })));
    let sent = 0;
    results.forEach((result, i) => {
      if (result.status >= 200 && result.status < 300) sent += 1;
      if (result.status === 404 || result.status === 410) {
        db.q('DELETE FROM push_subs WHERE endpoint = ?').run(subscriptions[i]!.endpoint);
      }
    });
    return { sent, failed: results.length - sent };
  });

  if (config.testReset) {
    // The password hashes are slow to make and are the same each time, so they are made one time.
    let accounts: Promise<SeedAccount[]> | null = null;
    router.add('POST', '/api/test/reset', async () => {
      accounts ??= readSeedAccounts();
      resetAndSeed({ db, accounts: await accounts, now: now() });
      events.close();
      return { ok: true };
    });
  }
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { config } = options;
  const now = options.now ?? Date.now;
  const db = openDb(dbPath(config.dataDir));
  if (adoptCopy(db)) (options.log ?? console.log)('The database is a copy that was put back. Each device starts again from its rows.');

  const logError = (error: unknown, req?: IncomingMessage): void => {
    // Only the method and the path: a body, a cookie, or a query can hold a secret.
    const where = req ? ` ${req.method} ${(req.url ?? '').split('?')[0]}` : '';
    console.error(`${new Date().toISOString()} error${where}`, error);
  };

  let vapid: VapidKeys;
  const storedKeys = db.getMeta('vapid');
  if (storedKeys) {
    vapid = JSON.parse(storedKeys) as VapidKeys;
  } else {
    vapid = makeVapidKeys();
    db.setMeta('vapid', JSON.stringify(vapid));
  }

  const send: SendFn =
    options.send ??
    (async (input) => {
      const result = await sendPush({ ...input, keys: vapid, subject: config.vapidSubject });
      const gone = result.status === 404 || result.status === 410;
      if (!gone && (result.status < 200 || result.status >= 300)) {
        // The path of an endpoint is a secret of the device, so the log gets the host only.
        logError(new Error(`Push service ${new URL(input.subscription.endpoint).host} answered ${result.status}`));
      }
      return result;
    });

  const events = createEvents();
  const router = createRouter({ publicOrigin: config.publicOrigin, onError: logError });
  const app: App = {
    config,
    db,
    now,
    router,
    events,
    vapid,
    send,
    loginLockMs: options.loginLockMs ?? 30_000,
    auth(req) {
      const session = findSession({ db, req, now: now() });
      if (!session) throw new HttpError(401, 'unauthorized', 'Sign in first');
      return session;
    },
    logError,
  };
  addAuthRoutes(app);
  addRoutes(app);

  const files = createStatic(config.webDir);
  const scheduler = createScheduler({ db, now, send, onError: logError });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', files.csp());
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://localhost');
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Bad request');
        return;
      }
      if (await router.handle(req, res, url)) return;
      await files.serve(req, res, url.pathname);
    } catch (error) {
      logError(error, req);
      if (res.headersSent) res.destroy();
      else res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Internal error');
    }
  }

  const server = createServer((req, res) => void handle(req, res));
  // A proxy in front of the server keeps idle connections for some time. If the server closed them
  // earlier, a request on such a connection would fail.
  server.keepAliveTimeout = 120_000;

  let lastDaily = '';
  function maintain(): void {
    try {
      const time = now();
      const today = new Date(time).toDateString();
      if (today !== lastDaily) {
        lastDaily = today;
        pruneTombstones({ db, now: time });
        cleanSessions({ db, now: time });
        cleanNotifLog({ db, now: time });
      }
      if (config.backupDir) runBackup({ db, dir: config.backupDir, now: time });
    } catch (error) {
      logError(error);
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  }).catch((error: unknown) => {
    db.close();
    events.stop();
    throw error;
  });
  // An error of the listener after the start (for example no free file handle for a new
  // connection) must not stop the server.
  server.on('error', (error) => logError(error));

  let maintainTimer: ReturnType<typeof setInterval> | null = null;
  if (options.timers !== false) {
    scheduler.start();
    maintain();
    // Each hour, so the copy of a new day comes soon after midnight.
    maintainTimer = setInterval(maintain, HOUR_MS);
    maintainTimer.unref();
  }

  const { port } = server.address() as AddressInfo;
  const url = `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${port}`;
  (options.log ?? console.log)(`Shared Tasks ${config.version} listens on ${url}`);

  let closed: Promise<void> | null = null;
  return {
    url,
    port,
    app,
    scheduler,
    maintain,
    close() {
      closed ??= new Promise<void>((resolve) => {
        scheduler.stop();
        if (maintainTimer) clearInterval(maintainTimer);
        events.stop();
        server.close(() => {
          db.close();
          resolve();
        });
        // A browser keeps idle connections open. They must not hold the stop.
        server.closeAllConnections();
      });
      return closed;
    },
  };
}
