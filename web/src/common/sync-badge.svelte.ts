// The small sync icon of the top bar. The data layer says 'syncing' for each request and has
// pending changes for a moment after each action. An icon that follows these values directly
// flashes, so a state shows only after it stayed for some time.

import { sync } from '../data/index.ts';

export type SyncBadge = 'offline' | 'pending' | 'error';

/** How long a state must stay before the icon shows it. */
export const BADGE_DELAY_MS: Readonly<Record<SyncBadge, number>> = { offline: 1000, error: 1000, pending: 2000 };

export interface SyncBadgeSource {
  readonly status: 'idle' | 'syncing' | 'offline' | 'error';
  readonly pending: number;
}

export interface SyncBadgeState {
  /** Reactive. null: no icon. */
  readonly current: SyncBadge | null;
  stop(): void;
}

export function createSyncBadge(source: SyncBadgeSource): SyncBadgeState {
  let shown = $state<SyncBadge | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stopEffects = $effect.root(() => {
    // A derived value tells its readers only about a new value. A change of the pending number
    // from 1 to 2 must not start the wait again.
    const wanted = $derived<SyncBadge | null>(
      source.status === 'offline' ? 'offline' : source.status === 'error' ? 'error' : source.pending > 0 ? 'pending' : null,
    );
    $effect(() => {
      const next = wanted;
      clearTimeout(timer);
      if (next === null) {
        // All changes are on the server: the icon goes away at once.
        shown = null;
        return;
      }
      // Until the new state stayed long enough, the icon keeps the old one.
      timer = setTimeout(() => (shown = next), BADGE_DELAY_MS[next]);
    });
  });

  return {
    get current() {
      return shown;
    },
    stop() {
      clearTimeout(timer);
      stopEffects();
    },
  };
}

/** `syncBadge.current` is 'offline', 'pending', 'error', or null. Read it in a template or in `$derived`. */
export const syncBadge = createSyncBadge(sync);

import.meta.hot?.dispose(() => syncBadge.stop());
