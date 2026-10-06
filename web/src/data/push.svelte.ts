import type { PushEnv } from './env.ts';

/** The result of a notification command, with a text for the person. */
export interface PushResult {
  ok: boolean;
  message: string;
}

export interface PushStore {
  /** false: this browser cannot show notifications (on an iPhone: add the app to the Home Screen first). */
  readonly supported: boolean;
  readonly permission: NotificationPermission;
  /** true: this device has a subscription and the server has it. */
  readonly enabled: boolean;
  enable(): Promise<PushResult>;
  disable(): Promise<PushResult>;
  /** Sends a test notification to each device of the person. */
  test(): Promise<PushResult>;
}

export interface PushInput {
  device: PushEnv | null;
  /** POST to the server. `message` is the error text for a person, or '' if the request was ok. */
  post<T>(path: string, body: unknown): Promise<{ data: T | null; message: string }>;
  /** The key of the server from /api/me. '' while the device did not reach the server. */
  vapidKey: () => string;
}

const fail = (message: string): PushResult => ({ ok: false, message });

/**
 * The text for a subscription that the browser refused. A Chromium browser with no connection to
 * the push service of Google (some builds remove it) gives the permission and then fails here,
 * so the text must not send the person to the permission settings.
 */
function subscribeFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const text = error instanceof Error ? error.message : '';
  if (name === 'NotAllowedError') return 'Notifications are blocked. Permit them for this app in the browser settings';
  if (name === 'AbortError' || /push service/i.test(text)) {
    return 'This browser has no push service, so it cannot get notifications. Chrome, Edge, Firefox, and Safari have one';
  }
  return 'Notifications could not be turned on';
}

export function createPush({ device, post, vapidKey }: PushInput): PushStore & {
  /** Reads the state of the device again and sends its subscription to the server. */
  refresh(): Promise<void>;
} {
  let permission = $state<NotificationPermission>('default');
  let enabled = $state(false);

  return {
    supported: device !== null,
    get permission() {
      return permission;
    },
    get enabled() {
      return enabled;
    },

    async refresh() {
      if (!device) return;
      try {
        permission = device.permission();
        const subscription = permission === 'granted' ? await device.current() : null;
        enabled = subscription !== null;
        // A sign-out removes the subscriptions of the session on the server, so each start sends it again.
        if (subscription) await post('/api/push/subscribe', subscription);
      } catch {
        enabled = false;
      }
    },

    async enable() {
      if (!device) return fail('This browser cannot show notifications');
      try {
        permission = await device.ask();
        if (permission === 'denied') return fail('Notifications are blocked. Permit them for this app in the browser settings');
        if (permission !== 'granted') return fail('Notifications are not permitted');
        const key = vapidKey();
        if (!key) return fail('No connection to the server. Try again later');
        const subscription = await device.subscribe(key);
        const reply = await post('/api/push/subscribe', subscription);
        if (reply.data === null) return fail(reply.message);
        enabled = true;
        return { ok: true, message: 'Notifications are on' };
      } catch (error) {
        return fail(subscribeFailure(error));
      }
    },

    async disable() {
      if (!device) return fail('This browser cannot show notifications');
      try {
        const endpoint = await device.unsubscribe();
        enabled = false;
        // With no answer the server keeps the subscription until the push service refuses it.
        if (endpoint) await post('/api/push/unsubscribe', { endpoint });
        return { ok: true, message: 'Notifications are off' };
      } catch {
        return fail('Notifications could not be turned off');
      }
    },

    async test() {
      const reply = await post<{ sent: number; failed: number }>('/api/push/test', {});
      if (reply.data === null) return fail(reply.message);
      if (reply.data.sent > 0) return { ok: true, message: 'Test notification sent' };
      return fail(reply.data.failed > 0 ? 'The notification could not be sent' : 'No device has notifications turned on');
    },
  };
}
