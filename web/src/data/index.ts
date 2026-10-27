// The only door from the UI to the data (SPEC.md, section 7).
//
// Rules for the UI:
// - Each read is reactive. Call the readers in a template, in `$derived`, or in `$effect`:
//   `const view = $derived(listView(listId))`. A change in one list runs only the readers of
//   that list.
// - A row object never changes. A row that did not change is the same object after a sync or
//   after a change of a different row, and a view keeps the items, groups, and arrays that did
//   not change. So use keyed blocks: `{#each group.items as item (item.task.id)}`.
// - `getList`, `getTask`, and `getNote` give undefined for a row that is deleted or not there.
// - A change of a note runs only the readers of notes (`getNote`, `notesView`), and a change of a
//   list or a task runs no reader of notes. A change of one note runs each reader of notes.
// - `notesView({ archived, query })` is cached for each input. It keeps the `pinned` and `others`
//   arrays, and the full view, when a change did not touch them: `{#each view.others as note (note.id)}`.
// - An action changes the rows before it returns. Its result is the ActionResult of the shared
//   logic: `puts[0].id` is the id of a new row, and no puts means that nothing happened.
//   `store.can('indentTask', { id })` tells if an action is possible, and does not do it.
// - `actions.updateNote` with only `id`, `title`, and `body` is typing, as `actions.updateTask`
//   with only `id`, `title`, and `notes` is: the sync waits until 800 ms after the last key, and a
//   burst of keys is one undo step. `actions.deleteNote({ id, discard: true })` records no undo
//   step, and the steps of that note go from the undo list.
// - `prefs.completedOpen` cannot be changed in place:
//   `prefs.completedOpen = { ...prefs.completedOpen, [listId]: true }`.
// - `toast.current.action`, if it is there, is a button of the caller (`label`, `run`).
//   `toast.current.undoable` asks for an "Undo" button that calls `undo()`.
import { browserEnv } from './env.ts';
import { createDataLayer } from './layer.svelte.ts';

export type { Theme } from './env.ts';
export type { Actions, Result, SessionStatus, SyncStatus } from './layer.svelte.ts';
export type { Prefs } from './prefs.svelte.ts';
export type { PushResult } from './push.svelte.ts';
export type { Toast, ToastAction, ToastInput } from './toast.svelte.ts';

const layer = createDataLayer(browserEnv());

export const {
  session,
  login,
  register,
  logout,
  changePassword,
  rename,
  store,
  listsOrdered,
  getList,
  getTask,
  listView,
  starredView,
  subtasksOf,
  getNote,
  notesView,
  otherUser,
  actions,
  undo,
  canUndo,
  sync,
  toast,
  prefs,
  push,
} = layer;

// The local database opens while the first screen mounts. Not in Node.js: a test of a component
// that imports this file has no browser.
if (typeof document !== 'undefined') void layer.start();

// A hot update of the development server makes a new instance. The old one must let go of its
// timers and its event stream.
import.meta.hot?.dispose(() => void layer.stop());
