// The flows that the wide layout and the phone layout share: a dialog, then the actions of the
// data layer. A row object never changes, so each flow reads the row again after a dialog: the
// other person can change or delete it while the dialog is open.

import { addDays } from '../../../shared/dates.ts';
import { LIMITS } from '../../../shared/types.ts';
import type { ID, ListRow, TaskRow } from '../../../shared/types.ts';
import { comparePos, isParentOf } from '../../../shared/view.ts';
import { actions, getList, getTask, listView, otherUser, session, store, toast } from '../data/index.ts';
import type { DateValue } from '../ui/index.ts';
import { confirmDialog, pickDate, pickDeadline, promptText } from './dialogs.svelte.ts';

/** true for a task that shows below a parent. Such a task cannot repeat and cannot get subtasks. */
export function isSubtask(task: TaskRow): boolean {
  return task.parentId !== null && isParentOf(getTask(task.parentId), task);
}

/** The name of the person who owns the list. */
export function ownerName(list: ListRow): string {
  return session.users.find((user) => user.id === list.owner)?.name ?? 'the owner';
}

export function isOwner(list: ListRow): boolean {
  return list.owner === session.me?.id;
}

/** The number of tasks in the list: open, completed, and resting. */
export function taskCount(listId: ID): number {
  const view = listView(listId);
  return view.groups.reduce((sum, group) => sum + group.items.length, 0) + view.completed.length;
}

/** The number of tasks that "Delete all completed tasks" deletes. A resting task stays. */
export function completedCount(listId: ID): number {
  return listView(listId).completed.reduce((sum, task) => sum + (task.completed ? 1 : 0), 0);
}

// ---- Dates ----

/**
 * Sets the date, the time, and the rule of a task with as few actions as possible, because each
 * action is one Undo step. The rule goes first: it sets the date too, so a new rule with the
 * old time is one step.
 */
export function applyDate(task: TaskRow, value: DateValue): void {
  const id = task.id;
  if (value.repeat !== null || task.repeat !== null) actions.setRepeat({ id, rule: value.repeat });
  actions.setDate({ id, due: value.date, time: value.time });
}

/** Opens the date picker for the task. true: the person chose "Done". */
export async function editDate(task: TaskRow): Promise<boolean> {
  const value = await pickDate({
    value: { date: task.due, time: task.time, repeat: task.repeat },
    allowRepeat: !isSubtask(task),
  });
  const now = getTask(task.id);
  if (!value || !now) return false;
  applyDate(now, value);
  return true;
}

/** Opens the deadline picker for the task. true: the person chose "Done". */
export async function editDeadline(task: TaskRow): Promise<boolean> {
  const result = await pickDeadline({ value: task.deadline });
  if (!result || !getTask(task.id)) return false;
  actions.updateTask({ id: task.id, deadline: result.deadline });
  return true;
}

/** Removes the date and the time. A task with no date cannot repeat, so the rule goes too. */
export function clearDate(task: TaskRow): void {
  actions.setDate({ id: task.id, due: null });
}

export function clearDeadline(task: TaskRow): void {
  actions.updateTask({ id: task.id, deadline: null });
}

/** The date becomes today. The time stays. */
export function setToday(task: TaskRow): void {
  actions.setDate({ id: task.id, due: store.today, time: task.time });
}

/** The date becomes tomorrow. The time stays. */
export function setTomorrow(task: TaskRow): void {
  actions.setDate({ id: task.id, due: addDays(store.today, 1), time: task.time });
}

/** Asks, then removes the rule. The task keeps its date. true: the rule is gone. */
export async function stopRepeat(task: TaskRow): Promise<boolean> {
  if (!task.repeat) return false;
  const yes = await confirmDialog({
    title: 'Stop repeating?',
    message: 'The task keeps its date. It does not come back after you complete it.',
    confirmLabel: 'Stop repeating',
  });
  if (!yes || !getTask(task.id)) return false;
  return actions.setRepeat({ id: task.id, rule: null }).puts.length > 0;
}

// ---- Tasks and lists ----

/**
 * Moves the task to the top of a different list, where a new task goes too. A subtask becomes
 * a top-level task there. The subtasks of the task go with it.
 */
export function moveToList(task: TaskRow, listId: ID): boolean {
  if (task.listId === listId) return false;
  let first: TaskRow | null = null;
  for (const group of listView(listId).groups) {
    for (const { task: other } of group.items) {
      if (other.parentId === null && (!first || comparePos(other, first) < 0)) first = other;
    }
  }
  return actions.moveTask({ id: task.id, listId, parentId: null, beforeId: first?.id ?? null }).puts.length > 0;
}

function askListName(input: { title: string; value?: string }): Promise<string | null> {
  return promptText({ ...input, placeholder: 'Enter name', confirmLabel: 'Done', maxlength: LIMITS.listTitle });
}

/** Asks for a name and makes the list. Gives the id of the new list, or null. */
export async function createListFlow(): Promise<ID | null> {
  const title = await askListName({ title: 'Create new list' });
  if (title === null) return null;
  return actions.createList({ title }).puts[0]?.id ?? null;
}

/** Asks for a name, makes the list, and moves the task there. Gives the id of the new list, or null. */
export async function newListAndMove(task: TaskRow): Promise<ID | null> {
  const listId = await createListFlow();
  const now = getTask(task.id);
  if (listId !== null && now) moveToList(now, listId);
  return listId;
}

/** true: the list has a new name. */
export async function renameListFlow(list: ListRow): Promise<boolean> {
  const title = await askListName({ title: 'Rename list', value: list.title });
  if (title === null || !getList(list.id)) return false;
  return actions.renameList({ id: list.id, title }).puts.length > 0;
}

/** Deletes the list. A list with tasks asks first. true: the list is deleted. */
export async function deleteListFlow(list: ListRow): Promise<boolean> {
  if (!store.can('deleteList', { id: list.id })) return false;
  const count = taskCount(list.id);
  if (count > 0) {
    const yes = await confirmDialog({
      title: 'Delete this list?',
      message: count === 1 ? 'Its 1 task is deleted too.' : `Its ${count} tasks are deleted too.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!yes) return false;
  }
  return actions.deleteList({ id: list.id }).puts.length > 0;
}

/** Asks, then deletes the completed tasks of the list. true: tasks are deleted. */
export async function clearCompletedFlow(list: ListRow): Promise<boolean> {
  const count = completedCount(list.id);
  if (count === 0) return false;
  const yes = await confirmDialog({
    title: 'Delete all completed tasks?',
    message: count === 1 ? `1 completed task is deleted from "${list.title}".` : `${count} completed tasks are deleted from "${list.title}".`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!yes) return false;
  return actions.clearCompleted({ listId: list.id }).puts.length > 0;
}

/**
 * Starts or stops the sharing of a list. Only the owner can do it. The start asks first, with
 * the name of the other person. true: the sharing changed.
 */
export async function shareListFlow(list: ListRow): Promise<boolean> {
  if (!isOwner(list)) return false;
  if (list.shared) {
    if (actions.setListShared({ id: list.id, shared: false }).puts.length === 0) return false;
    toast.show({ message: `Stopped sharing "${list.title}"`, undoable: true });
    return true;
  }
  const other = otherUser();
  if (!other) {
    toast.show({ message: 'No other person has an account yet' });
    return false;
  }
  const yes = await confirmDialog({
    title: `Share "${list.title}" with ${other.name}?`,
    message: `${other.name} can see and change all tasks in this list.`,
    confirmLabel: 'Share',
  });
  if (!yes || !getList(list.id)) return false;
  if (actions.setListShared({ id: list.id, shared: true }).puts.length === 0) return false;
  toast.show({ message: `Shared "${list.title}" with ${other.name}`, undoable: true });
  return true;
}
