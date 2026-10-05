import type { ID } from '../../../shared/types.ts';

export interface ServiceWorkerOptions {
  /**
   * A new version of the app is installed and waits. `apply` changes to it and reloads the page.
   * This can come more than one time, if a newer version arrives while one waits.
   */
  onUpdateReady: (apply: () => void) => void;
  /** The person clicked the notification of this task while the app was open. */
  onOpenTask?: (taskId: ID) => void;
}

const UPDATE_CHECK_MS = 60 * 60 * 1000;

/** Registers the service worker of a production build. In the dev server there is no worker. */
export function registerServiceWorker({ onUpdateReady, onOpenTask }: ServiceWorkerOptions): void {
  // Not there on a page without HTTPS, and in a private window of Firefox.
  if (!('serviceWorker' in navigator)) return;
  const container = navigator.serviceWorker;

  if (!import.meta.env.PROD) {
    // A worker from a production build that ran on this address would answer with its old files.
    void container.getRegistrations().then((all) => all.forEach((registration) => registration.unregister()));
    return;
  }

  container.addEventListener('message', (event) => {
    const data = event.data as { type?: unknown; taskId?: unknown } | null;
    if (data?.type === 'openTask' && typeof data.taskId === 'string') onOpenTask?.(data.taskId);
  });

  const start = async () => {
    const registration = await container.register('/sw.js');

    const apply = () => {
      const waiting = registration.waiting;
      // No worker waits if a different tab made the change already. Then no controller change comes.
      if (!waiting) return location.reload();
      container.addEventListener('controllerchange', () => location.reload(), { once: true });
      waiting.postMessage({ type: 'skipWaiting' });
    };

    let offered: ServiceWorker | null = null;
    const offer = () => {
      const waiting = registration.waiting;
      // With no controller, this is the first install and not an update: the page has the newest files.
      if (!waiting || waiting === offered || !container.controller) return;
      offered = waiting;
      onUpdateReady(apply);
    };
    // A worker that installs becomes the waiting worker of the registration.
    const watch = (worker: ServiceWorker | null) => worker?.addEventListener('statechange', offer);

    // A worker can wait from an earlier visit, or the browser can be in the middle of an install.
    offer();
    watch(registration.installing);
    registration.addEventListener('updatefound', () => watch(registration.installing));

    // The browser looks for a new worker only when a page loads. An installed app can stay open for days.
    let checkedAt = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || Date.now() - checkedAt < UPDATE_CHECK_MS) return;
      checkedAt = Date.now();
      // Offline, the check fails. The next one tries again.
      registration.update().catch(() => {});
    });
  };

  // The first install downloads all files. It starts after the page load, so the first screen has the network to itself.
  const run = () => void start().catch((error) => console.warn('Service worker registration failed', error));
  if (document.readyState === 'complete') run();
  else addEventListener('load', run, { once: true });
}
