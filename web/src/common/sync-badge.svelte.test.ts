import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncBadgeSource } from './sync-badge.svelte.ts';

vi.mock('../data/index.ts', () => ({ sync: { status: 'idle', pending: 0 } }));

const { createSyncBadge } = await import('./sync-badge.svelte.ts');

type Source = { -readonly [Key in keyof SyncBadgeSource]: SyncBadgeSource[Key] };

function setup() {
  const source = $state<Source>({ status: 'idle', pending: 0 });
  const badge = createSyncBadge(source);
  flushSync();
  const set = (change: Partial<Source>): void => {
    Object.assign(source, change);
    flushSync();
  };
  const wait = (ms: number): void => {
    vi.advanceTimersByTime(ms);
    flushSync();
  };
  return { badge, set, wait };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('syncBadge', () => {
  it('shows nothing for the short pending time after each action, and nothing while a sync runs', () => {
    const { badge, set, wait } = setup();
    for (let i = 0; i < 20; i++) {
      set({ pending: 1 });
      wait(50);
      set({ status: 'syncing' });
      wait(120);
      set({ status: 'idle', pending: 0 });
      wait(200);
      expect(badge.current).toBeNull();
    }
    badge.stop();
  });

  it('shows "pending" only after the changes stayed unsent for more than 2 seconds', () => {
    const { badge, set, wait } = setup();
    set({ pending: 1 });
    wait(1500);
    // More changes do not start the wait again.
    set({ pending: 3 });
    wait(499);
    expect(badge.current).toBeNull();
    wait(1);
    expect(badge.current).toBe('pending');
    set({ pending: 0 });
    expect(badge.current).toBeNull();
    badge.stop();
  });

  it('shows "offline" and "error" after 1 second, and hides them at once', () => {
    const { badge, set, wait } = setup();
    set({ status: 'offline', pending: 2 });
    wait(999);
    expect(badge.current).toBeNull();
    wait(1);
    expect(badge.current).toBe('offline');
    set({ status: 'idle', pending: 0 });
    expect(badge.current).toBeNull();

    set({ status: 'error' });
    wait(1000);
    expect(badge.current).toBe('error');
    badge.stop();
  });

  it('keeps the shown state until the next state stayed long enough', () => {
    const { badge, set, wait } = setup();
    set({ status: 'offline', pending: 1 });
    wait(1000);
    expect(badge.current).toBe('offline');
    // The network is back and the changes are still on the device.
    set({ status: 'idle' });
    wait(1999);
    expect(badge.current).toBe('offline');
    wait(1);
    expect(badge.current).toBe('pending');
    // A short loss of the network does not show.
    set({ status: 'offline' });
    wait(400);
    set({ status: 'idle' });
    wait(5000);
    expect(badge.current).toBe('pending');
    badge.stop();
  });

  it('does nothing after stop()', () => {
    const { badge, set, wait } = setup();
    set({ status: 'offline' });
    badge.stop();
    wait(5000);
    expect(badge.current).toBeNull();
  });
});
