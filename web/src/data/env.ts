import { eventStreamOver } from './events.ts';
import { idbStorage } from './idb.ts';
import { memoryKeyValue } from './storage.ts';
import type { KeyValue, StorageFactory } from './storage.ts';

export type Theme = 'system' | 'light' | 'dark';
export type Signal = 'online' | 'offline' | 'visible' | 'hidden';

export interface PokeStream {
  close(): void;
}

export interface StreamHandlers {
  onOpen(): void;
  /** The server has rows with this revision. */
  onPoke(rev: number): void;
  /** The stream ended and the caller did not close it. `status` is the HTTP status, or 0 for a network error. */
  onClose(status: number): void;
}

export interface Channel {
  post(message: unknown): void;
  close(): void;
}

export interface PushSubscriptionData {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushEnv {
  permission(): NotificationPermission;
  ask(): Promise<NotificationPermission>;
  /** The subscription of this device, or null. */
  current(): Promise<PushSubscriptionData | null>;
  /** Throws if the app has no service worker. */
  subscribe(vapidPublicKey: string): Promise<PushSubscriptionData>;
  /** Ends the subscription of this device. Gives its endpoint, or null if there was none. */
  unsubscribe(): Promise<string | null>;
}

/** All that the data layer needs from the world around it. A test gives its own. */
export interface Env {
  /** A request to the server of the app. `path` starts with '/api/'. The session cookie goes with it. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  storage: StorageFactory;
  kv: KeyValue;
  openEvents(path: string, handlers: StreamHandlers): PokeStream;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** The time of the device in milliseconds. */
  now(): number;
  locale: string;
  /** IANA time zone of the device. */
  timeZone: string;
  online(): boolean;
  visible(): boolean;
  /** Calls the listener when the network or the visibility changes. Gives a function that stops it. */
  listen(listener: (signal: Signal) => void): () => void;
  /** Messages between the tabs of this browser. null where the browser has no channel. */
  channel(input: { name: string; onMessage: (message: unknown) => void }): Channel | null;
  setTheme(theme: Theme): void;
  /** null where the browser cannot show notifications. */
  push: PushEnv | null;
}

function localKeyValue(): KeyValue {
  // A browser can refuse localStorage (a private window, a full disk). The settings then live
  // as long as the page.
  const spare = memoryKeyValue();
  return {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return spare.get(key);
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        spare.set(key, value);
      }
    },
    remove(key) {
      try {
        localStorage.removeItem(key);
      } catch {
        spare.remove(key);
      }
    },
  };
}

function browserPush(): PushEnv | null {
  if (
    typeof navigator === 'undefined' ||
    !('serviceWorker' in navigator) ||
    typeof PushManager === 'undefined' ||
    typeof Notification === 'undefined'
  ) {
    return null;
  }
  const workers = navigator.serviceWorker;

  // `workers.ready` never ends on a page with no worker (the development server), so the
  // registration is read first.
  async function manager(): Promise<PushManager | null> {
    const registration = await workers.getRegistration();
    if (!registration) return null;
    if (registration.active) return registration.pushManager;
    const ready = await Promise.race([workers.ready, new Promise<null>((resolve) => setTimeout(resolve, 5000, null))]);
    return ready?.pushManager ?? null;
  }

  const dataOf = (subscription: PushSubscription): PushSubscriptionData => {
    const { keys } = subscription.toJSON();
    return { endpoint: subscription.endpoint, keys: { p256dh: keys?.p256dh ?? '', auth: keys?.auth ?? '' } };
  };

  return {
    permission: () => Notification.permission,
    ask: () => Notification.requestPermission(),
    async current() {
      const subscription = await (await manager())?.getSubscription();
      return subscription ? dataOf(subscription) : null;
    },
    async subscribe(vapidPublicKey) {
      const push = await manager();
      if (!push) throw new Error('The app has no service worker');
      // Safari accepts the key only as bytes.
      const text = atob(vapidPublicKey.replace(/-/g, '+').replace(/_/g, '/'));
      const key = Uint8Array.from(text, (char) => char.charCodeAt(0));
      return dataOf(await push.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
    },
    async unsubscribe() {
      const subscription = await (await manager())?.getSubscription();
      if (!subscription) return null;
      await subscription.unsubscribe();
      return subscription.endpoint;
    },
  };
}

/**
 * The environment of a browser tab. Each use of a browser object is in a function, so a test in
 * Node.js can import the module that makes it.
 */
export function browserEnv(): Env {
  const hasPage = typeof document !== 'undefined';
  const io = {
    fetch: (path: string, init?: RequestInit) => fetch(path, { credentials: 'same-origin', ...init }),
    setTimeout: (run: () => void, ms: number): unknown => setTimeout(run, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  return {
    ...io,
    storage: idbStorage(),
    kv: localKeyValue(),
    openEvents: eventStreamOver(io),
    now: () => Date.now(),
    locale: (typeof navigator !== 'undefined' && navigator.language) || 'en-GB',
    // Read at each use: a person who travels changes the zone of the device while the app is open.
    get timeZone() {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    },
    online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
    visible: () => !hasPage || document.visibilityState === 'visible',

    listen(listener) {
      if (!hasPage) return () => undefined;
      const online = () => listener('online');
      const offline = () => listener('offline');
      const seen = () => listener(document.visibilityState === 'visible' ? 'visible' : 'hidden');
      // A page that the browser puts away or closes does not get 'visibilitychange' in each
      // browser. 'pagehide' is the last sure moment to save.
      const hide = () => listener('hidden');
      // The browser brought the page back from its back/forward cache.
      const show = (event: PageTransitionEvent) => event.persisted && seen();
      addEventListener('online', online);
      addEventListener('offline', offline);
      addEventListener('pagehide', hide);
      addEventListener('pageshow', show);
      document.addEventListener('visibilitychange', seen);
      return () => {
        removeEventListener('online', online);
        removeEventListener('offline', offline);
        removeEventListener('pagehide', hide);
        removeEventListener('pageshow', show);
        document.removeEventListener('visibilitychange', seen);
      };
    },

    channel({ name, onMessage }) {
      if (typeof BroadcastChannel === 'undefined') return null;
      const channel = new BroadcastChannel(name);
      channel.onmessage = (event) => onMessage(event.data);
      return { post: (message) => channel.postMessage(message), close: () => channel.close() };
    },

    setTheme(theme) {
      if (!hasPage) return;
      // web/index.html and the style sheet read this attribute. No value: the system setting applies.
      if (theme === 'system') delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = theme;
    },

    push: browserPush(),
  };
}
