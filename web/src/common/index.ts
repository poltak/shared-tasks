// The task UI that the wide layout and the phone layout share. Each name can also be imported
// from its own file.

export { default as DialogHost } from './DialogHost.svelte';
export { default as TaskChips } from './TaskChips.svelte';
export { default as CompletedMeta } from './CompletedMeta.svelte';

export {
  askMakeTasks,
  cancelDialogs,
  confirmDialog,
  pickDate,
  pickDeadline,
  pickNoteColor,
  promptText,
  type ConfirmInput,
  type DeadlineResult,
  type MakeTasksInput,
  type MakeTasksResult,
  type PickDateInput,
  type PickDeadlineInput,
  type PickNoteColorInput,
  type PromptTextInput,
} from './dialogs.svelte.ts';
export {
  applyDate,
  clearCompletedFlow,
  clearDate,
  clearDeadline,
  completedCount,
  createListFlow,
  deleteListFlow,
  editDate,
  editDeadline,
  isOwner,
  isSubtask,
  moveToList,
  newListAndMove,
  ownerName,
  renameListFlow,
  setToday,
  setTomorrow,
  shareListFlow,
  stopRepeat,
  taskCount,
} from './task-ops.ts';
export {
  listMenuItems,
  runListMenuItem,
  runStarredMenuItem,
  runTaskMenuItem,
  sortMenuItems,
  starredMenuItems,
  taskMenuItems,
  type ListMenuHooks,
  type TaskMenuHooks,
} from './menus.ts';
export { BADGE_DELAY_MS, syncBadge, type SyncBadge } from './sync-badge.svelte.ts';
export { hasMod, isMac, NOTE_SHORTCUTS, shortcutKeys, SHORTCUTS, type KeyCombo, type Shortcut } from './shortcuts.ts';
export { printList } from './print.ts';
