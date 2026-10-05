import type { ID } from '../../../shared/types.ts';

export interface LaunchParams {
  /** From /?task=ID: a click on a notification. */
  taskId: ID | null;
  /** From /?list=ID. */
  listId: ID | null;
  /** From /?new=1: the "New task" shortcut of the installed app. */
  newTask: boolean;
}

const KEYS = ['task', 'list', 'new'];

/** Reads what the app must open at the start. Call it one time: it removes the values from the address. */
export function readLaunchParams(): LaunchParams {
  const url = new URL(location.href);
  const params = url.searchParams;
  const result = {
    taskId: params.get('task') || null,
    listId: params.get('list') || null,
    newTask: params.get('new') === '1',
  };
  if (KEYS.some((key) => params.has(key))) {
    // Without this, a reload opens the task or the add sheet again.
    for (const key of KEYS) params.delete(key);
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  }
  return result;
}
