// The entries of the menus (SPEC.md section 8, "Menus") and what each entry does. The two layouts
// show the same menus: a popover on a wide window and a bottom sheet on a phone.
//
// A builder reads the rows, so call it when the menu opens (or in a `$derived` while it is open).

import type { ID, ListRow, SortMode, StarredSort, TaskRow } from '../../../shared/types.ts';
import { actions, listsOrdered, otherUser, prefs, store } from '../data/index.ts';
import type { LayoutMode, MenuItem } from '../ui/index.ts';
import { printList } from './print.ts';
import {
  clearCompletedFlow,
  completedCount,
  deleteListFlow,
  editDeadline,
  isOwner,
  isSubtask,
  moveToList,
  newListAndMove,
  ownerName,
  renameListFlow,
  shareListFlow,
} from './task-ops.ts';

const SORTS: readonly { sort: SortMode; label: string }[] = [
  { sort: 'my', label: 'My order' },
  { sort: 'date', label: 'Date' },
  { sort: 'deadline', label: 'Deadline' },
  { sort: 'starred', label: 'Starred recently' },
  { sort: 'title', label: 'Title' },
];

const STARRED_SORTS: readonly { sort: StarredSort; label: string }[] = [
  { sort: 'date', label: 'Date' },
  { sort: 'starred', label: 'Recently starred' },
];

const SORT_PREFIX = 'sort:';
const LIST_PREFIX = 'list:';

// ---- Task menu ----

export interface TaskMenuHooks {
  /** Opens a new subtask row or field below the task. Only the layout can do it. */
  addSubtask: (task: TaskRow) => void;
  /** Runs after "Delete", for example to close the detail screen of the task. */
  afterDelete?: (task: TaskRow) => void;
}

/**
 * The three-dot menu and the right-click menu of an open task.
 * Ids: 'top', 'deadline', 'subtask', 'indent', 'unindent', 'delete', 'list:<id>', 'new-list'.
 */
export function taskMenuItems({ task }: { task: TaskRow; layout: LayoutMode }): MenuItem[] {
  const id = task.id;
  const items: MenuItem[] = [
    { id: 'top', label: 'Move to top', icon: 'to-top', disabled: !store.can('moveToTop', { id }) },
    { id: 'deadline', label: task.deadline ? 'Change deadline' : 'Add deadline', icon: 'target' },
  ];
  // The title is only a probe: `can` does not make the task.
  if (!isSubtask(task) && store.can('createTask', { listId: task.listId, title: '-', position: { parentId: id, at: 'end' } })) {
    items.push({ id: 'subtask', label: 'Add a subtask', icon: 'subtask' });
  }
  if (store.can('unindentTask', { id })) items.push({ id: 'unindent', label: 'Unindent', icon: 'unindent' });
  else if (store.can('indentTask', { id })) items.push({ id: 'indent', label: 'Indent', icon: 'indent' });
  items.push({ id: 'delete', label: 'Delete', icon: 'bin' });

  listsOrdered().forEach((list, index) => {
    items.push({ id: LIST_PREFIX + list.id, label: list.title, checked: list.id === task.listId, separatorBefore: index === 0 });
  });
  items.push({ id: 'new-list', label: 'New list', icon: 'list-add', separatorBefore: true });
  return items;
}

export async function runTaskMenuItem({ task, itemId, hooks }: { task: TaskRow; itemId: string; hooks: TaskMenuHooks }): Promise<void> {
  const id = task.id;
  if (itemId.startsWith(LIST_PREFIX)) {
    moveToList(task, itemId.slice(LIST_PREFIX.length));
    return;
  }
  switch (itemId) {
    case 'top':
      actions.moveToTop({ id });
      break;
    case 'deadline':
      await editDeadline(task);
      break;
    case 'subtask':
      hooks.addSubtask(task);
      break;
    case 'indent':
      actions.indentTask({ id });
      break;
    case 'unindent':
      actions.unindentTask({ id });
      break;
    case 'delete':
      if (actions.deleteTask({ id }).puts.length > 0) hooks.afterDelete?.(task);
      break;
    case 'new-list':
      await newListAndMove(task);
      break;
  }
}

// ---- List menu ----

export interface ListMenuHooks {
  /** Prints the list. Without it, `printList(list.id)` runs. */
  print?: (list: ListRow) => void;
}

/** "Sort by" alone, for the sort button of a list. Ids: 'sort:my', 'sort:date', 'sort:deadline', 'sort:starred', 'sort:title'. */
export function sortMenuItems({ list }: { list: ListRow }): MenuItem[] {
  return SORTS.map(({ sort, label }) => ({ id: SORT_PREFIX + sort, label, checked: list.sort === sort }));
}

/**
 * The three-dot menu of a list.
 * Ids: the sort ids, 'rename', 'share', 'delete', 'first', 'print' (wide), 'left' and 'right' (phone), 'clear'.
 */
export function listMenuItems({ list, layout }: { list: ListRow; layout: LayoutMode }): MenuItem[] {
  const id = list.id;
  const owner = isOwner(list);
  const other = otherUser();
  const items = sortMenuItems({ list });
  items[0] = { ...items[0]!, sectionLabel: 'Sort by' };

  items.push({ id: 'rename', label: 'Rename list', separatorBefore: true });
  if (!owner) items.push({ id: 'share', label: `Shared by ${ownerName(list)}`, disabled: true });
  else if (list.shared) items.push({ id: 'share', label: 'Stop sharing' });
  else if (other) items.push({ id: 'share', label: `Share with ${other.name}` });
  else items.push({ id: 'share', label: 'Share list', disabled: true, hint: 'No other person has an account yet' });

  const remove: MenuItem = { id: 'delete', label: 'Delete list' };
  if (list.isDefault) Object.assign(remove, { disabled: true, hint: "The default list can't be deleted" });
  else if (!owner) Object.assign(remove, { disabled: true, hint: `Only ${ownerName(list)} can delete this list` });
  items.push(remove);
  items.push({ id: 'first', label: 'Move list to first position', disabled: !store.can('moveList', { id, toFirst: true }) });

  if (layout === 'wide') {
    items.push({ id: 'print', label: 'Print list', separatorBefore: true });
  } else {
    const { before, after } = neighbours(id);
    items.push({ id: 'left', label: 'Move list left', separatorBefore: true, disabled: before === null });
    items.push({ id: 'right', label: 'Move list right', disabled: after === null });
  }
  items.push({ id: 'clear', label: 'Delete all completed tasks', disabled: completedCount(id) === 0 });
  return items;
}

/** The lists directly before and after a list, in the order of this person. */
function neighbours(id: ID): { before: ID | null; after: ID | null } {
  const lists = listsOrdered();
  const index = lists.findIndex((list) => list.id === id);
  if (index < 0) return { before: null, after: null };
  return { before: lists[index - 1]?.id ?? null, after: lists[index + 1]?.id ?? null };
}

export async function runListMenuItem({ list, itemId, hooks = {} }: { list: ListRow; itemId: string; hooks?: ListMenuHooks }): Promise<void> {
  const id = list.id;
  if (itemId.startsWith(SORT_PREFIX)) {
    actions.setListSort({ id, sort: itemId.slice(SORT_PREFIX.length) as SortMode });
    return;
  }
  switch (itemId) {
    case 'rename':
      await renameListFlow(list);
      break;
    case 'share':
      await shareListFlow(list);
      break;
    case 'delete':
      await deleteListFlow(list);
      break;
    case 'first':
      actions.moveList({ id, toFirst: true });
      break;
    case 'print':
      if (hooks.print) hooks.print(list);
      else printList(id);
      break;
    case 'left': {
      const { before } = neighbours(id);
      if (before !== null) actions.moveList({ id, beforeId: before });
      break;
    }
    case 'right': {
      const { after } = neighbours(id);
      if (after !== null) actions.moveList({ id, afterId: after });
      break;
    }
    case 'clear':
      await clearCompletedFlow(list);
      break;
  }
}

// ---- Starred view menu ----

/** Ids: 'sort:date', 'sort:starred'. */
export function starredMenuItems(): MenuItem[] {
  return STARRED_SORTS.map(({ sort, label }, index) => ({
    id: SORT_PREFIX + sort,
    label,
    checked: prefs.starredSort === sort,
    sectionLabel: index === 0 ? 'Sort by' : undefined,
  }));
}

export function runStarredMenuItem(itemId: string): void {
  const sort = STARRED_SORTS.find((each) => SORT_PREFIX + each.sort === itemId)?.sort;
  if (sort) prefs.starredSort = sort;
}
