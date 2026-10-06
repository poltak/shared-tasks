// The state of the phone layout that more than one of its parts reads or sets.

import { flushSync } from 'svelte';
import type { ID } from '../../../shared/types.ts';
import type { MenuItem } from '../ui/index.ts';

/** The id of the star tab. A list id is a UUID, so the two cannot be equal. */
export const STARRED = 'starred';

export const phone = $state<{
  /** The tab on the screen: a list id, or STARRED. */
  tab: string;
  /** The task of the open detail screen. */
  detailId: ID | null;
  addOpen: boolean;
}>({ tab: STARRED, detailId: null, addOpen: false });

export function openTask(id: ID): void {
  phone.detailId = id;
}

/** The title field of the add sheet. The sheet sets it. */
export const addField: { input: HTMLInputElement | null } = { input: null };

export function openAdd(): void {
  phone.addOpen = true;
  // iOS shows the keyboard only if the field gets the focus in the handler of the tap. So the
  // sheet goes on the screen now, and not in the next microtask.
  flushSync();
  addField.input?.focus({ preventScroll: true });
}

// ---- The one menu of the layout ----

export interface MenuRequest {
  items: MenuItem[];
  /** The heading of the bottom sheet. */
  title?: string;
  run: (itemId: string) => void;
}

// The request stays after the close: the sheet shows it while it goes away, and the Menu part
// calls the entry after the close.
let request = $state.raw<MenuRequest | null>(null);
let menuOpen = $state(false);

export const menu = {
  get request(): MenuRequest | null {
    return request;
  },
  get open(): boolean {
    return menuOpen;
  },
  set open(value: boolean) {
    menuOpen = value;
  },
};

export function openMenu(next: MenuRequest): void {
  request = next;
  menuOpen = true;
}

export function closeMenu(): void {
  menuOpen = false;
}

export function runMenu(itemId: string): void {
  request?.run(itemId);
}

/** How far each page was scrolled when its content went away. The content comes back at that place. */
export const scrollMemory = new Map<string, number>();
