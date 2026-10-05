import type { Db } from './db.ts';
import * as hlc from '../shared/hlc.ts';
import type { HLC, ID, PushMessage } from '../shared/types.ts';

export interface PushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Sends one message to one device. `status` is the HTTP status of the push service, 0 for a network error. */
export type SendFn = (input: { subscription: PushSubscription; message: PushMessage }) => Promise<{ status: number }>;

const TICK_MS = 20_000;
const MAX_LATE_MS = 12 * 3_600_000;
const DEFAULT_TIME = '09:00';
const LOG_KEEP_MS = 30 * 86_400_000;

// ---------------------------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------------------------

const formats = new Map<string, Intl.DateTimeFormat>();

function formatFor(tz: string): Intl.DateTimeFormat {
  let format = formats.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formats.set(tz, format);
  }
  return format;
}

// A device sends the same name with each sync, and the check of a name is slow. The limit keeps
// the map small if a client sends many forms of the names.
const zones = new Map<string, string>();
const ZONES_MAX = 64;

/** The standard name of an IANA time zone. null if the value is not a time zone. */
export function timeZoneOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null;
  const known = zones.get(value);
  if (known !== undefined) return known;
  try {
    const zone = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
    if (zones.size < ZONES_MAX) zones.set(value, zone);
    return zone;
  } catch {
    return null;
  }
}

/** The wall clock of a moment in a time zone, as 'YYYY-MM-DDTHH:MM'. Such texts compare in time order. */
export function localStamp(ms: number, tz: string): string {
  const parts: Record<string, string> = {};
  for (const part of formatFor(tz).formatToParts(ms)) parts[part.type] = part.value;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

// ---------------------------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------------------------

const PEOPLE = `SELECT u.id, u.tz FROM users u WHERE EXISTS (SELECT 1 FROM push_subs p WHERE p.user_id = u.id)`;

// $first is the first local day that can still give a notification. $today is the local day of the person.
// The last condition leaves out a resting task: a repeating task that is done until its next date.
const CANDIDATES = `SELECT t.id, t.title, t.due, t.time, t.deadline, t.ts, t.list_id, l.title AS list_title, l.ts AS list_ts
  FROM tasks t JOIN lists l ON l.id = t.list_id
  WHERE (t.due BETWEEN $first AND $today OR t.deadline BETWEEN $first AND $today)
    AND t.deleted = 0 AND t.completed = 0
    AND l.deleted = 0 AND (l.owner = $user OR l.shared = 1)
    AND NOT (t.repeat IS NOT NULL AND t.hidden_until IS NOT NULL AND t.hidden_until > $today)`;

interface Candidate {
  id: ID;
  title: string;
  due: string | null;
  time: string | null;
  deadline: string | null;
  ts: string;
  list_id: ID;
  list_title: string;
  list_ts: string;
}

interface StoredSubscription extends PushSubscription {
  created_at: number;
}

/** The time of the newest of the named fields, from the timestamps of a row. 0 if the server wrote them. */
function newestChange(stamps: Record<string, HLC>, names: string[]): number {
  let ms = 0;
  for (const name of names) {
    const ts = stamps[name];
    if (ts) ms = Math.max(ms, hlc.decode(ts).ms);
  }
  return ms;
}

export interface Scheduler {
  /** Sends the notifications that are due at this moment. Returns the number of notifications. */
  tick(): Promise<number>;
  start(): void;
  stop(): void;
}

export function createScheduler(options: {
  db: Db;
  now: () => number;
  send: SendFn;
  onError?: (error: unknown) => void;
}): Scheduler {
  const { db, now, send } = options;
  const onError = options.onError ?? console.error;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let busy = false;

  async function notify(input: {
    userId: ID;
    kind: 'due' | 'deadline';
    at: string;
    task: Candidate;
    /** The devices that get this notification. */
    subscriptions: StoredSubscription[];
    /** Each device of the person. A device that the push service does not know any more is removed. */
    all: StoredSubscription[];
  }): Promise<boolean> {
    const { task, kind, subscriptions } = input;
    // The payload of a push message is small, so a long title or list name is cut.
    const list = task.list_title.trim().slice(0, 80);
    const message: PushMessage = {
      title: task.title.trim().slice(0, 120) || 'Task',
      body: kind === 'deadline' ? 'Deadline today' : task.time ? `${list}, ${task.time}` : list,
      taskId: task.id,
      listId: task.list_id,
      // The name of the kind in the tag keeps the two notifications of one task apart on the device.
      tag: `${kind}-${task.id}`,
    };
    const results = await Promise.all(
      subscriptions.map((subscription) =>
        send({ subscription, message }).catch((error: unknown) => {
          onError(error);
          return { status: 0 };
        }),
      ),
    );
    let delivered = 0;
    let again = false;
    results.forEach(({ status }, i) => {
      if (status >= 200 && status < 300) {
        delivered += 1;
      } else if (status === 404 || status === 410) {
        // The push service tells that this subscription does not exist any more.
        const { endpoint } = subscriptions[i]!;
        db.q('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint);
        const index = input.all.findIndex((s) => s.endpoint === endpoint);
        if (index >= 0) input.all.splice(index, 1);
      } else if (status === 0 || status === 429 || status >= 500) {
        // An error of the network or of the service can go away. Each other status would come again.
        again = true;
      }
    });
    // The next tick tries again only if no device got the message, so no device gets it two times.
    if (delivered === 0 && again) return false;
    db.q('INSERT OR IGNORE INTO notif_log (task_id, user_id, kind, at_key, sent_at) VALUES (?, ?, ?, ?, ?)').run(
      task.id,
      input.userId,
      kind,
      input.at,
      now(),
    );
    return delivered > 0;
  }

  async function tick(): Promise<number> {
    // A slow push service must not make two ticks send the same notification.
    if (busy) return 0;
    busy = true;
    let sent = 0;
    try {
      const nowMs = now();
      for (const person of db.q(PEOPLE).all() as { id: ID; tz: string | null }[]) {
        // A person with no known time zone gets UTC, so the result does not depend on the settings of the machine.
        const tz = person.tz ?? 'UTC';
        const nowLocal = localStamp(nowMs, tz);
        const oldest = localStamp(nowMs - MAX_LATE_MS, tz);
        const candidates = db
          .q(CANDIDATES)
          .all({ user: person.id, first: oldest.slice(0, 10), today: nowLocal.slice(0, 10) }) as unknown as Candidate[];
        if (candidates.length === 0) continue;
        const subscriptions = db
          .q('SELECT endpoint, p256dh, auth, created_at FROM push_subs WHERE user_id = ?')
          .all(person.id) as unknown as StoredSubscription[];

        for (const task of candidates) {
          for (const kind of ['due', 'deadline'] as const) {
            const day = kind === 'due' ? task.due : task.deadline;
            if (!day) continue;
            const at = `${day}T${kind === 'due' && task.time ? task.time : DEFAULT_TIME}`;
            if (at > nowLocal || at < oldest) continue;
            const logged = db
              .q('SELECT 1 FROM notif_log WHERE task_id = ? AND user_id = ? AND kind = ? AND at_key = ?')
              .get(task.id, person.id, kind, at);
            if (logged) continue;
            // A task that gets its date after the time of the notification must not ring at once.
            // The same applies to a task that became open or visible after that time.
            const since = Math.max(
              newestChange(JSON.parse(task.ts), [...(kind === 'due' ? ['due', 'time'] : ['deadline']), 'completed', 'deleted', 'hiddenUntil', 'listId']),
              newestChange(JSON.parse(task.list_ts), ['shared', 'deleted']),
            );
            if (since > 0 && localStamp(since, tz) >= at) continue;
            // A device that subscribed after the time of the notification does not get it late.
            const targets = subscriptions.filter((s) => localStamp(s.created_at, tz) < at);
            if (targets.length === 0) continue;
            if (await notify({ userId: person.id, kind, at, task, subscriptions: targets, all: subscriptions })) sent += 1;
          }
        }
      }
    } finally {
      busy = false;
    }
    return sent;
  }

  function schedule(): void {
    // Each tick starts directly after a multiple of 20 seconds, so a notification comes at the
    // start of its minute.
    const delay = TICK_MS - (Date.now() % TICK_MS) + 25;
    timer = setTimeout(() => {
      tick()
        .catch(onError)
        .finally(() => {
          if (timer !== null) schedule();
        });
    }, delay);
    timer.unref();
  }

  return {
    tick,
    start() {
      if (timer === null) schedule();
    },
    stop() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

/** Removes old records of sent notifications. A record is necessary only for 12 hours. */
export function cleanNotifLog(input: { db: Db; now: number }): void {
  input.db.q('DELETE FROM notif_log WHERE sent_at < ?').run(input.now - LOG_KEEP_MS);
}
