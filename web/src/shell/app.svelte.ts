// State that the shell and the two layouts share: which shell screens are open, and what the
// address of the page asked for at the start (a notification, a shortcut of the installed app).
import type { ID } from '../../../shared/types.ts';

export interface Launch {
  taskId: ID | null;
  listId: ID | null;
  newTask: boolean;
}

export const app = $state({
  settingsOpen: false,
  shortcutsOpen: false,
  launch: { taskId: null, listId: null, newTask: false } as Launch,
});

export function openSettings(): void {
  app.settingsOpen = true;
}

export function openShortcuts(): void {
  app.shortcutsOpen = true;
}

/** A layout calls this when it is ready. It gets the launch request one time. */
export function takeLaunch(): Launch {
  const launch = app.launch;
  app.launch = { taskId: null, listId: null, newTask: false };
  return launch;
}

/** The shell calls this at the start, and again when a notification asks for a task. */
export function setLaunch(launch: Partial<Launch>): void {
  app.launch = { taskId: null, listId: null, newTask: false, ...launch };
}

/** Closes the screens of the shell. For a sign-out, and before a notification opens a task. */
export function closeShell(): void {
  app.settingsOpen = false;
  app.shortcutsOpen = false;
}

/**
 * A new version of the app that waits. `apply` changes to it and reloads the page. null: none
 * waits. The snackbar goes away after some seconds, so Settings also offers the reload.
 */
export const update = $state<{ apply: (() => void) | null }>({ apply: null });
