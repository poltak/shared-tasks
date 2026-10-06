import { describe, expect, it } from 'vitest';
import type { PushEnv } from './env.ts';
import { createPush } from './push.svelte.ts';

function pushWith(subscribe: PushEnv['subscribe']) {
  const device: PushEnv = {
    permission: () => 'granted',
    ask: async () => 'granted',
    current: async () => null,
    subscribe,
    unsubscribe: async () => null,
  };
  return createPush({ device, post: async () => ({ data: {} as never, message: '' }), vapidKey: () => 'key' });
}

function failure({ name, message }: { name: string; message: string }): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe('enable, when the browser refuses the subscription', () => {
  it('names the missing push service of a browser that gives the permission and then fails', async () => {
    const push = pushWith(async () => {
      throw failure({ name: 'AbortError', message: 'Registration failed - push service error' });
    });
    const result = await push.enable();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('no push service');
    expect(push.enabled).toBe(false);
  });

  it('sends the person to the browser settings when the browser blocks the subscription', async () => {
    const push = pushWith(async () => {
      throw failure({ name: 'NotAllowedError', message: 'Registration failed - permission denied' });
    });
    expect((await push.enable()).message).toContain('browser settings');
  });

  it('gives a general text for each other failure', async () => {
    const push = pushWith(async () => {
      throw new Error('something else');
    });
    expect(await push.enable()).toEqual({ ok: false, message: 'Notifications could not be turned on' });
  });
});
