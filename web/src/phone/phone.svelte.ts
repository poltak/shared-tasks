// The state of the phone layout that more than one of its parts reads or sets.

import { flushSync } from 'svelte';
import { newId } from '../../../shared/ids.ts';
import type { ID } from '../../../shared/types.ts';
import type { MenuItem } from '../ui/index.ts';

/** The id of the star tab. A list id is a UUID, so the two cannot be equal. */
export const STARRED = 'starred';
/** The id of the Notes tab. It is also the value of `prefs.lastTab` for that tab. */
export const NOTES = 'notes';

/** The note of the open editor screen. */
export interface OpenNote {
  id: ID;
  /** The note has no row yet. It gets one at the first key. */
  isNew: boolean;
}

export const phone = $state<{
  /** The tab on the screen: a list id, STARRED, or NOTES. */
  tab: string;
  /** The task of the open detail screen. */
  detailId: ID | null;
  addOpen: boolean;
  note: OpenNote | null;
  /** The Notes page shows the archive. */
  archive: boolean;
  /** The text of the search field of the Notes page. */
  query: string;
}>({ tab: STARRED, detailId: null, addOpen: false, note: null, archive: false, query: '' });

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

// ---- Notes ----

type NotesParts = typeof import('../notes/index.ts');

// The notes parts are one download for the phone and the wide layout (SPEC section 8, "Notes").
let parts = $state.raw<NotesParts | null>(null);
let loading: Promise<NotesParts | null> | null = null;

export const notes = {
  /** The parts of web/src/notes/, or null until the download is done. Reactive. */
  get parts(): NotesParts | null {
    return parts;
  },
};

/** Starts the download of the notes parts. More than one call does no harm. null: it failed. */
export function loadNotes(): Promise<NotesParts | null> {
  loading ??= import('../notes/index.ts').then(
    (loaded) => (parts = loaded),
    () => {
      // The next call tries again.
      loading = null;
      return null;
    },
  );
  return loading;
}

/** The editor of the note screen. The screen sets it. */
export const noteEditor: { part: { focus: (field?: 'title' | 'body') => void; finish: () => void } | null } = { part: null };

export function openNote(id: ID): void {
  phone.note = { id, isNew: false };
}

/**
 * Closes the note screen. The close rules of the editor run now, and not at the end of the
 * slide: an emptied note must not show as an "Empty note" card while the screen goes away.
 */
export function closeNote(): void {
  noteEditor.part?.finish();
  phone.note = null;
}

/** The add button of the Notes tab. A new note always goes to the notes, not to the archive. */
export function newNote(): void {
  if (!parts) return;
  phone.archive = false;
  phone.note = { id: newId(), isNew: true };
  // As for the add sheet: iOS shows the keyboard only for a focus in the handler of the tap.
  flushSync();
  noteEditor.part?.focus('body');
}

// ---- The one menu of the layout ----

export interface MenuRequest {
  items: MenuItem[];
  /** The heading of the bottom sheet. */
  title?: string;
  /** The accessible name, when it is not the heading. */
  label?: string;
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
