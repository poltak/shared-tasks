// The flows against a real data layer. Test doubles answer in place of the dialogs.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays } from '../../../shared/dates.ts';
import type { RepeatRule } from '../../../shared/types.ts';

vi.mock('../data/index.ts', async () => (await import('./testkit.ts')).layer);
vi.mock('./dialogs.svelte.ts', () => ({ pickDate: vi.fn(), pickDeadline: vi.fn(), promptText: vi.fn(), confirmDialog: vi.fn() }));

const { layer, makeList, makeTask, MY_LIST, SAM_LIST, titles } = await import('./testkit.ts');
const { pickDate, pickDeadline, promptText, confirmDialog } = vi.mocked(await import('./dialogs.svelte.ts'));
const ops = await import('./task-ops.ts');

const today = layer.store.today;
const daily: RepeatRule = { every: 1, unit: 'day', start: today, end: { type: 'never' } };
const weekly: RepeatRule = { every: 1, unit: 'week', weekdays: [1], start: today, end: { type: 'never' } };
const task = (id: string) => layer.getTask(id)!;

beforeEach(() => {
  vi.clearAllMocks();
  layer.toast.dismiss();
});

describe('editDate', () => {
  it('opens the picker with the values of the task, and permits a rule for a top-level task', async () => {
    const list = makeList();
    const made = makeTask({ listId: list.id, fields: { due: '2026-10-09', time: '14:30' } });
    pickDate.mockResolvedValueOnce(null);
    expect(await ops.editDate(made)).toBe(false);
    expect(pickDate).toHaveBeenCalledWith({ value: { date: '2026-10-09', time: '14:30', repeat: null }, allowRepeat: true });
    expect(task(made.id)).toBe(made);
  });

  it('does not permit a rule for a subtask', async () => {
    const list = makeList();
    const parent = makeTask({ listId: list.id });
    const subtask = makeTask({ listId: list.id, parentId: parent.id });
    pickDate.mockResolvedValueOnce(null);
    await ops.editDate(subtask);
    expect(pickDate).toHaveBeenCalledWith({ value: { date: null, time: null, repeat: null }, allowRepeat: false });
    expect(ops.isSubtask(subtask)).toBe(true);
    expect(ops.isSubtask(parent)).toBe(false);
  });

  it('sets the date and the time, and one Undo takes them back', async () => {
    const list = makeList();
    const made = makeTask({ listId: list.id });
    pickDate.mockResolvedValueOnce({ date: '2026-10-12', time: '09:15', repeat: null });
    expect(await ops.editDate(made)).toBe(true);
    expect(task(made.id)).toMatchObject({ due: '2026-10-12', time: '09:15', repeat: null });
    layer.undo();
    expect(task(made.id)).toEqual(made);
  });

  it('sets a new rule with its first date, and one Undo takes all back', async () => {
    const list = makeList();
    const made = makeTask({ listId: list.id });
    pickDate.mockResolvedValueOnce({ date: today, time: null, repeat: daily });
    await ops.editDate(made);
    expect(task(made.id)).toMatchObject({ due: today, time: null, repeat: daily });
    layer.undo();
    expect(task(made.id)).toEqual(made);
  });

  it('changes only the time of a repeating task in one step, and keeps the rule and its count', async () => {
    const list = makeList();
    const made = makeTask({ listId: list.id, fields: { repeat: daily } });
    pickDate.mockResolvedValueOnce({ date: today, time: '18:00', repeat: { ...daily } });
    await ops.editDate(made);
    expect(task(made.id)).toMatchObject({ due: today, time: '18:00', repeat: daily });
    layer.undo();
    expect(task(made.id)).toEqual(made);
  });

  it('removes the rule and keeps the date, in one step', async () => {
    const list = makeList();
    const made = makeTask({ listId: list.id, fields: { repeat: daily } });
    pickDate.mockResolvedValueOnce({ date: today, time: null, repeat: null });
    await ops.editDate(made);
    expect(task(made.id)).toMatchObject({ due: today, repeat: null });
    layer.undo();
    expect(task(made.id)).toEqual(made);
  });

  it('applies a new rule together with a new time', async () => {
    const list = makeList();
    const made = makeTask({ listId: list.id, fields: { repeat: daily } });
    const first = addDays(today, 6);
    const rule: RepeatRule = { ...weekly, start: first, weekdays: [new Date(2026, 9, 12).getDay()] };
    pickDate.mockResolvedValueOnce({ date: first, time: '07:00', repeat: rule });
    await ops.editDate(made);
    expect(task(made.id)).toMatchObject({ due: first, time: '07:00', repeat: rule });
    // The rule and the time are two actions of the data layer, so this change is two steps.
    layer.undo();
    layer.undo();
    expect(task(made.id)).toEqual(made);
  });

  it('makes no change and no Undo step when the person changes nothing', async () => {
    const list = makeList();
    const made = makeTask({ listId: list.id, fields: { repeat: daily, time: '08:00' } });
    const marker = makeTask({ listId: list.id, title: 'marker' });
    pickDate.mockResolvedValueOnce({ date: made.due, time: made.time, repeat: { ...daily } });
    expect(await ops.editDate(made)).toBe(true);
    expect(task(made.id)).toBe(made);
    // The last step is still the one that made the marker.
    layer.undo();
    expect(layer.getTask(marker.id)).toBeUndefined();
  });

  it('does nothing if the task went away while the picker was open', async () => {
    const list = makeList();
    const made = makeTask({ listId: list.id });
    pickDate.mockImplementationOnce(async () => {
      layer.actions.deleteTask({ id: made.id });
      return { date: today, time: null, repeat: null };
    });
    expect(await ops.editDate(made)).toBe(false);
    expect(layer.getTask(made.id)).toBeUndefined();
  });
});

describe('dates with no dialog', () => {
  it('sets today and tomorrow, and keeps the time', () => {
    const list = makeList();
    const made = makeTask({ listId: list.id });
    ops.setToday(made);
    expect(task(made.id)).toMatchObject({ due: today, time: null });
    ops.setTomorrow(task(made.id));
    expect(task(made.id).due).toBe(addDays(today, 1));
    const timed = makeTask({ listId: list.id, fields: { due: '2026-11-20', time: '10:00' } });
    ops.setToday(timed);
    expect(task(timed.id)).toMatchObject({ due: today, time: '10:00' });
  });

  it('clears the date with its time and its rule in one step', () => {
    const list = makeList();
    const made = makeTask({ listId: list.id, fields: { repeat: daily, time: '10:00' } });
    ops.clearDate(made);
    expect(task(made.id)).toMatchObject({ due: null, time: null, repeat: null });
    layer.undo();
    expect(task(made.id)).toEqual(made);
  });

  it('edits and clears the deadline', async () => {
    const list = makeList();
    const made = makeTask({ listId: list.id, fields: { deadline: '2026-10-20' } });
    pickDeadline.mockResolvedValueOnce({ deadline: '2026-10-25' });
    expect(await ops.editDeadline(made)).toBe(true);
    expect(pickDeadline).toHaveBeenCalledWith({ value: '2026-10-20' });
    expect(task(made.id).deadline).toBe('2026-10-25');

    pickDeadline.mockResolvedValueOnce(null);
    expect(await ops.editDeadline(task(made.id))).toBe(false);
    expect(task(made.id).deadline).toBe('2026-10-25');

    ops.clearDeadline(task(made.id));
    expect(task(made.id).deadline).toBeNull();
  });
});

describe('stopRepeat', () => {
  it('asks "Stop repeating?" and removes the rule only after a yes', async () => {
    const list = makeList();
    const made = makeTask({ listId: list.id, fields: { repeat: daily } });
    confirmDialog.mockResolvedValueOnce(false);
    expect(await ops.stopRepeat(made)).toBe(false);
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'Stop repeating?' }));
    expect(task(made.id).repeat).toEqual(daily);

    confirmDialog.mockResolvedValueOnce(true);
    expect(await ops.stopRepeat(made)).toBe(true);
    expect(task(made.id)).toMatchObject({ repeat: null, due: today });
  });

  it('does not ask for a task with no rule', async () => {
    const list = makeList();
    expect(await ops.stopRepeat(makeTask({ listId: list.id }))).toBe(false);
    expect(confirmDialog).not.toHaveBeenCalled();
  });
});

describe('list flows', () => {
  it('createListFlow asks as Google Tasks does, and gives the id of the new list', async () => {
    promptText.mockResolvedValueOnce('Holiday');
    const id = await ops.createListFlow();
    expect(promptText).toHaveBeenCalledWith(expect.objectContaining({ title: 'Create new list', placeholder: 'Enter name', confirmLabel: 'Done' }));
    expect(layer.getList(id!)).toMatchObject({ title: 'Holiday', owner: 'user-1' });
    expect(layer.listsOrdered().at(-1)!.id).toBe(id);

    const count = layer.listsOrdered().length;
    promptText.mockResolvedValueOnce(null);
    expect(await ops.createListFlow()).toBeNull();
    expect(layer.listsOrdered()).toHaveLength(count);
  });

  it('newListAndMove makes the list and moves the task with its subtasks', async () => {
    const list = makeList();
    const parent = makeTask({ listId: list.id, title: 'parent' });
    makeTask({ listId: list.id, title: 'child', parentId: parent.id });
    promptText.mockResolvedValueOnce('Target');
    const id = await ops.newListAndMove(parent);
    expect(layer.getList(id!)!.title).toBe('Target');
    expect(titles(id!)).toEqual(['parent', 'child']);
    expect(titles(list.id)).toEqual([]);

    promptText.mockResolvedValueOnce(null);
    expect(await ops.newListAndMove(task(parent.id))).toBeNull();
    expect(titles(id!)).toEqual(['parent', 'child']);
  });

  it('renameListFlow starts from the old name', async () => {
    const list = makeList('Before');
    promptText.mockResolvedValueOnce('After');
    expect(await ops.renameListFlow(list)).toBe(true);
    expect(promptText).toHaveBeenCalledWith(expect.objectContaining({ title: 'Rename list', value: 'Before', confirmLabel: 'Done' }));
    expect(layer.getList(list.id)!.title).toBe('After');
    promptText.mockResolvedValueOnce(null);
    expect(await ops.renameListFlow(layer.getList(list.id)!)).toBe(false);
    // A person who is not the owner can rename a shared list.
    promptText.mockResolvedValueOnce('Ours');
    expect(await ops.renameListFlow(layer.getList(SAM_LIST.id)!)).toBe(true);
    expect(layer.getList(SAM_LIST.id)!.title).toBe('Ours');
  });

  it('deleteListFlow deletes an empty list with no question', async () => {
    const list = makeList();
    expect(await ops.deleteListFlow(list)).toBe(true);
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(layer.getList(list.id)).toBeUndefined();
    expect(layer.toast.current).toMatchObject({ message: 'List deleted', undoable: true });
  });

  it('deleteListFlow asks with the number of tasks, open and completed', async () => {
    const list = makeList();
    const parent = makeTask({ listId: list.id });
    makeTask({ listId: list.id, parentId: parent.id });
    layer.actions.completeTask({ id: makeTask({ listId: list.id }).id });

    confirmDialog.mockResolvedValueOnce(false);
    expect(await ops.deleteListFlow(list)).toBe(false);
    expect(confirmDialog).toHaveBeenCalledWith({ title: 'Delete this list?', message: 'Its 3 tasks are deleted too.', confirmLabel: 'Delete', danger: true });
    expect(layer.getList(list.id)).toBeDefined();

    confirmDialog.mockResolvedValueOnce(true);
    expect(await ops.deleteListFlow(list)).toBe(true);
    expect(layer.getList(list.id)).toBeUndefined();

    const one = makeList();
    makeTask({ listId: one.id });
    confirmDialog.mockResolvedValueOnce(false);
    await ops.deleteListFlow(one);
    expect(confirmDialog).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'Its 1 task is deleted too.' }));
  });

  it('deleteListFlow does nothing for the default list and for a list of the other person', async () => {
    makeTask({ listId: MY_LIST });
    expect(await ops.deleteListFlow(layer.getList(MY_LIST)!)).toBe(false);
    expect(await ops.deleteListFlow(layer.getList(SAM_LIST.id)!)).toBe(false);
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(layer.getList(MY_LIST)).toBeDefined();
    expect(layer.getList(SAM_LIST.id)).toBeDefined();
  });

  it('clearCompletedFlow asks with the number of completed tasks, and a resting task stays', async () => {
    const list = makeList('Chores');
    for (let i = 0; i < 2; i++) layer.actions.completeTask({ id: makeTask({ listId: list.id }).id });
    const resting = makeTask({ listId: list.id, fields: { repeat: daily } });
    layer.actions.completeTask({ id: resting.id });
    makeTask({ listId: list.id, title: 'open' });
    expect(ops.completedCount(list.id)).toBe(2);
    expect(ops.taskCount(list.id)).toBe(4);

    confirmDialog.mockResolvedValueOnce(false);
    expect(await ops.clearCompletedFlow(list)).toBe(false);
    expect(confirmDialog).toHaveBeenCalledWith({
      title: 'Delete all completed tasks?',
      message: '2 completed tasks are deleted from "Chores".',
      confirmLabel: 'Delete',
      danger: true,
    });
    expect(layer.listView(list.id).completed).toHaveLength(3);

    confirmDialog.mockResolvedValueOnce(true);
    expect(await ops.clearCompletedFlow(list)).toBe(true);
    expect(layer.listView(list.id).completed.map((each) => each.id)).toEqual([resting.id]);
    expect(layer.toast.current).toMatchObject({ message: '2 completed tasks deleted', undoable: true });

    // Nothing to delete: no question.
    confirmDialog.mockClear();
    expect(await ops.clearCompletedFlow(list)).toBe(false);
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it('shareListFlow asks with the name of the other person before the sharing starts', async () => {
    const list = makeList('Groceries');
    confirmDialog.mockResolvedValueOnce(false);
    expect(await ops.shareListFlow(list)).toBe(false);
    expect(confirmDialog).toHaveBeenCalledWith({
      title: 'Share "Groceries" with Sam?',
      message: 'Sam can see and change all tasks in this list.',
      confirmLabel: 'Share',
    });
    expect(layer.getList(list.id)!.shared).toBe(false);

    confirmDialog.mockResolvedValueOnce(true);
    expect(await ops.shareListFlow(list)).toBe(true);
    expect(layer.getList(list.id)!.shared).toBe(true);
    expect(layer.toast.current).toMatchObject({ message: 'Shared "Groceries" with Sam', undoable: true });
  });

  it('shareListFlow stops the sharing with no question, and Undo brings it back', async () => {
    const list = makeList('Trip');
    layer.actions.setListShared({ id: list.id, shared: true });
    expect(await ops.shareListFlow(layer.getList(list.id)!)).toBe(true);
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(layer.getList(list.id)!.shared).toBe(false);
    expect(layer.toast.current).toMatchObject({ message: 'Stopped sharing "Trip"', undoable: true });
    layer.undo();
    expect(layer.getList(list.id)!.shared).toBe(true);
  });

  it('shareListFlow does nothing for a person who is not the owner', async () => {
    expect(await ops.shareListFlow(layer.getList(SAM_LIST.id)!)).toBe(false);
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(layer.getList(SAM_LIST.id)!.shared).toBe(true);
    expect(ops.isOwner(layer.getList(SAM_LIST.id)!)).toBe(false);
    expect(ops.ownerName(layer.getList(SAM_LIST.id)!)).toBe('Sam');
  });
});

describe('moveToList', () => {
  it('puts the task at the top of the other list also when that list has a different sort', () => {
    const from = makeList();
    const to = makeList();
    makeTask({ listId: to.id, title: 'b' });
    makeTask({ listId: to.id, title: 'a' });
    layer.actions.setListSort({ id: to.id, sort: 'title' });
    const moved = makeTask({ listId: from.id, title: 'z' });
    expect(ops.moveToList(moved, to.id)).toBe(true);
    layer.actions.setListSort({ id: to.id, sort: 'my' });
    expect(titles(to.id)).toEqual(['z', 'b', 'a']);
    expect(ops.moveToList(task(moved.id), to.id)).toBe(false);
  });
});
