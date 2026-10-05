import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { registerServiceWorker } from './register.ts';

class FakeWorker extends EventTarget {
  state = 'installing';
  postMessage = vi.fn();
  become(state: string) {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  update = vi.fn(async () => {});
  unregister = vi.fn(async () => true);
  /** A new worker starts to install, as after the browser finds a changed sw.js. */
  find() {
    const worker = new FakeWorker();
    this.installing = worker;
    this.dispatchEvent(new Event('updatefound'));
    return worker;
  }
  finish(worker: FakeWorker) {
    this.installing = null;
    this.waiting = worker;
    worker.become('installed');
  }
}

class FakeContainer extends EventTarget {
  controller: object | null = {};
  registration = new FakeRegistration();
  register = vi.fn(async () => this.registration);
  getRegistrations = vi.fn(async () => [this.registration]);
}

let container: FakeContainer;
let page: EventTarget & { readyState: string; visibilityState: string };
let reload: ReturnType<typeof vi.fn>;
const onUpdateReady = vi.fn<(apply: () => void) => void>();
const onOpenTask = vi.fn<(taskId: string) => void>();
/** Lets the promise of register() and the code after it run. */
const settle = () => new Promise((resolve) => setTimeout(resolve));

async function start() {
  registerServiceWorker({ onUpdateReady, onOpenTask });
  await settle();
  return container.registration;
}

beforeEach(() => {
  container = new FakeContainer();
  page = Object.assign(new EventTarget(), { readyState: 'complete', visibilityState: 'visible' });
  reload = vi.fn();
  const windowEvents = new EventTarget();
  vi.stubGlobal('navigator', { serviceWorker: container });
  vi.stubGlobal('document', page);
  vi.stubGlobal('location', { reload });
  vi.stubGlobal('addEventListener', windowEvents.addEventListener.bind(windowEvents));
  vi.stubGlobal('dispatchEvent', windowEvents.dispatchEvent.bind(windowEvents));
  vi.stubEnv('PROD', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.clearAllMocks();
});

test('a production build registers /sw.js', async () => {
  await start();
  expect(container.register).toHaveBeenCalledExactlyOnceWith('/sw.js');
});

test('the registration waits for the page load', async () => {
  page.readyState = 'loading';
  await start();
  expect(container.register).not.toHaveBeenCalled();
  dispatchEvent(new Event('load'));
  await settle();
  expect(container.register).toHaveBeenCalledOnce();
});

test('the dev server registers no worker and removes one that is left over', async () => {
  vi.stubEnv('PROD', false);
  const registration = await start();
  expect(container.register).not.toHaveBeenCalled();
  expect(registration.unregister).toHaveBeenCalledOnce();
});

test('a browser with no service workers does nothing', () => {
  vi.stubGlobal('navigator', {});
  expect(() => registerServiceWorker({ onUpdateReady })).not.toThrow();
});

test('the first install is not an update', async () => {
  container.controller = null;
  const registration = await start();
  registration.finish(registration.find());
  expect(onUpdateReady).not.toHaveBeenCalled();
});

test('a new worker that waits is offered one time, and apply changes to it and reloads', async () => {
  const registration = await start();
  const worker = registration.find();
  expect(onUpdateReady).not.toHaveBeenCalled();
  registration.finish(worker);
  worker.become('installed');
  expect(onUpdateReady).toHaveBeenCalledOnce();

  onUpdateReady.mock.calls[0]![0]();
  expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'skipWaiting' });
  expect(reload).not.toHaveBeenCalled();
  container.dispatchEvent(new Event('controllerchange'));
  expect(reload).toHaveBeenCalledOnce();
});

test('a controller change that the page did not ask for does not reload it', async () => {
  const registration = await start();
  registration.finish(registration.find());
  container.dispatchEvent(new Event('controllerchange'));
  expect(reload).not.toHaveBeenCalled();
});

test('a worker that waits from an earlier visit is offered at the start', async () => {
  container.registration.waiting = new FakeWorker();
  await start();
  expect(onUpdateReady).toHaveBeenCalledOnce();
});

test('a worker that is in the middle of its install at the start is offered when it is ready', async () => {
  const worker = new FakeWorker();
  container.registration.installing = worker;
  const registration = await start();
  registration.finish(worker);
  expect(onUpdateReady).toHaveBeenCalledOnce();
});

test('a newer worker is offered again', async () => {
  const registration = await start();
  registration.finish(registration.find());
  registration.finish(registration.find());
  expect(onUpdateReady).toHaveBeenCalledTimes(2);
});

test('apply reloads at once when a different tab made the change already', async () => {
  const registration = await start();
  const worker = registration.find();
  registration.finish(worker);
  registration.waiting = null;
  onUpdateReady.mock.calls[0]![0]();
  expect(worker.postMessage).not.toHaveBeenCalled();
  expect(reload).toHaveBeenCalledOnce();
});

test('an openTask message from the worker gives the task id', async () => {
  await start();
  container.dispatchEvent(new MessageEvent('message', { data: { type: 'openTask', taskId: 't1' } }));
  container.dispatchEvent(new MessageEvent('message', { data: { type: 'other', taskId: 't2' } }));
  container.dispatchEvent(new MessageEvent('message', { data: { type: 'openTask', taskId: 5 } }));
  container.dispatchEvent(new MessageEvent('message', { data: null }));
  expect(onOpenTask.mock.calls).toEqual([['t1']]);
});

test('an app that stays open looks for a new version when it shows again, one time each hour', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const registration = await start();
  const show = () => page.dispatchEvent(new Event('visibilitychange'));
  vi.advanceTimersByTime(59 * 60 * 1000);
  show();
  expect(registration.update).not.toHaveBeenCalled();
  vi.advanceTimersByTime(60 * 1000);
  page.visibilityState = 'hidden';
  show();
  expect(registration.update).not.toHaveBeenCalled();
  page.visibilityState = 'visible';
  show();
  show();
  expect(registration.update).toHaveBeenCalledOnce();
});
