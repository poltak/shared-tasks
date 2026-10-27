import { untrack } from 'svelte';
import type { ID, StarredSort } from '../../../shared/types.ts';
import type { Env, Theme } from './env.ts';

/** The settings of this device. Set a field to change it: the new value is saved at once. */
export interface Prefs {
  theme: Theme;
  starredSort: StarredSort;
  /**
   * true for a list whose "Completed" part is open. The object cannot be changed in place:
   * `prefs.completedOpen = { ...prefs.completedOpen, [listId]: true }`.
   */
  completedOpen: Readonly<Record<ID, boolean>>;
  /** A list id, 'starred', or 'notes'. null before the person selects a tab. */
  lastTab: string | null;
  sidebarOpen: boolean;
}

/** web/index.html reads `theme` from this key before the first paint. */
export const PREFS_KEY = 'st.prefs';

function read(text: string | null): Prefs {
  const prefs: Prefs = { theme: 'system', starredSort: 'date', completedOpen: {}, lastTab: null, sidebarOpen: true };
  let saved: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(text ?? '{}');
    if (typeof value === 'object' && value !== null) saved = value as Record<string, unknown>;
  } catch {
    // Text that is not JSON gives the defaults.
  }
  if (saved.theme === 'light' || saved.theme === 'dark') prefs.theme = saved.theme;
  if (saved.starredSort === 'starred') prefs.starredSort = 'starred';
  if (typeof saved.lastTab === 'string') prefs.lastTab = saved.lastTab;
  if (typeof saved.sidebarOpen === 'boolean') prefs.sidebarOpen = saved.sidebarOpen;
  if (typeof saved.completedOpen === 'object' && saved.completedOpen !== null) {
    const open: Record<ID, boolean> = {};
    for (const [id, value] of Object.entries(saved.completedOpen)) if (value === true) open[id] = true;
    prefs.completedOpen = open;
  }
  return prefs;
}

export function createPrefs(env: Pick<Env, 'kv' | 'setTheme'>): Prefs {
  const saved = read(env.kv.get(PREFS_KEY));
  let theme = $state(saved.theme);
  let starredSort = $state(saved.starredSort);
  // A frozen object: a change in place would not reach the screen or the disk, so it throws.
  let completedOpen = $state.raw(Object.freeze(saved.completedOpen));
  let lastTab = $state(saved.lastTab);
  let sidebarOpen = $state(saved.sidebarOpen);

  // A setter can run in an effect. The effect must not depend on the other settings.
  const save = (): void =>
    untrack(() => env.kv.set(PREFS_KEY, JSON.stringify({ theme, starredSort, completedOpen, lastTab, sidebarOpen })));

  return {
    get theme() {
      return theme;
    },
    set theme(value) {
      theme = value;
      env.setTheme(value);
      save();
    },
    get starredSort() {
      return starredSort;
    },
    set starredSort(value) {
      starredSort = value;
      save();
    },
    get completedOpen() {
      return completedOpen;
    },
    set completedOpen(value) {
      const open: Record<ID, boolean> = {};
      // Only the open lists are kept, so the object does not grow with each list that the person closes.
      for (const [id, isOpen] of Object.entries(value)) if (isOpen) open[id] = true;
      completedOpen = Object.freeze(open);
      save();
    },
    get lastTab() {
      return lastTab;
    },
    set lastTab(value) {
      lastTab = value;
      save();
    },
    get sidebarOpen() {
      return sidebarOpen;
    },
    set sidebarOpen(value) {
      sidebarOpen = value;
      save();
    },
  };
}
