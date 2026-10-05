// The service worker: keeps the built files for offline use and shows the notifications.
// Plain JavaScript with no imports, because the browser loads this file as it is.

// scripts/postbuild.ts replaces these two values. Without a build, the worker keeps no files
// and each request goes to the network.
const VERSION = '__VERSION__';
const FILES = /* __FILES__ */ [];

const PREFIX = 'shared-tasks-';
const CACHE = PREFIX + VERSION;
const known = new Set(FILES);

async function keepFiles() {
  // A file under /assets/ has a hash in its name, so a copy from the HTTP cache is correct.
  // Each other file can be old there, so the server must confirm it.
  const requests = FILES.map((file) => new Request(file, { cache: file.startsWith('/assets/') ? 'default' : 'no-cache' }));
  const cache = await caches.open(CACHE);
  await cache.addAll(requests);
}

async function takeOver() {
  for (const name of await caches.keys()) {
    if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
  }
  // Without this, a page that loaded before the first install stays without the worker until its next load.
  await self.clients.claim();
}

async function fromCache({ file, request }) {
  const cache = await caches.open(CACHE);
  return (await cache.match(file)) || fetch(request);
}

async function openTask(taskId) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const open = windows.find((client) => client.focused) || windows[0];
  if (!open) return self.clients.openWindow(taskId ? `/?task=${encodeURIComponent(taskId)}` : '/');
  if (taskId) open.postMessage({ type: 'openTask', taskId });
  return open.focus();
}

self.addEventListener('install', (event) => event.waitUntil(keepFiles()));

self.addEventListener('activate', (event) => event.waitUntil(takeOver()));

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  // The app is one page: each address that is not a file shows index.html.
  const file = known.has(url.pathname) ? url.pathname : request.mode === 'navigate' ? '/index.html' : null;
  // With no answer from here, the browser does the request itself. That is faster than a fetch from the worker.
  if (file) event.respondWith(fromCache({ file, request }));
});

// The page sends this when the person selects "Reload" for a new version.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('push', (event) => {
  // iOS removes the push permission of an app that gets a push and shows nothing.
  // So a message that cannot be read still gives a notification.
  let message = { title: 'Shared Tasks', body: 'Open the app to see your tasks' };
  try {
    const sent = event.data.json();
    if (typeof sent.title === 'string' && sent.title) message = sent;
  } catch {}
  event.waitUntil(
    self.registration.showNotification(message.title, {
      body: message.body,
      tag: message.tag || '',
      // A notification that replaces one with the same tag makes no sound without this.
      // The browser refuses 'renotify' with an empty tag.
      renotify: Boolean(message.tag),
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      data: { taskId: message.taskId || null, listId: message.listId || null },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(openTask((event.notification.data || {}).taskId));
});
