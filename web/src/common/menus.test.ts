// The menu builders against a real data layer, with the dialogs and the printer replaced.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListRow } from '../../../shared/types.ts';
import type { MenuItem } from '../ui/index.ts';

vi.mock('../data/index.ts', async () => (await import('./testkit.ts')).layer);
vi.mock('./dialogs.svelte.ts', () => ({ pickDate: vi.fn(), pickDeadline: vi.fn(), promptText: vi.fn(), confirmDialog: vi.fn() }));
vi.mock('./print.ts', () => ({ printList: vi.fn() }));

const { layer, makeList, makeTask, MY_LIST, SAM_LIST, titles } = await import('./testkit.ts');
const dialogs = vi.mocked(await import('./dialogs.svelte.ts'));
const { printList } = vi.mocked(await import('./print.ts'));
const { listMenuItems, runListMenuItem, runStarredMenuItem, runTaskMenuItem, sortMenuItems, starredMenuItems, taskMenuItems } = await import('./menus.ts');

const ids = (items: MenuItem[]): string[] => items.map((item) => item.id);
const labels = (items: MenuItem[]): string[] => items.map((item) => item.label);
const find = (items: MenuItem[], id: string): MenuItem => items.find((item) => item.id === id)!;
const sam = (): ListRow => layer.getList(SAM_LIST.id)!;
const hooks = { addSubtask: vi.fn(), afterDelete: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('task menu', () => {
  it('has the entries of the SPEC in order, then each list, then "New list"', () => {
    const list = makeList('Menu order');
    makeTask({ listId: list.id });
    const task = makeTask({ listId: list.id });
    const items = taskMenuItems({ task, layout: 'wide' });
    const lists = layer.listsOrdered();
    expect(labels(items)).toEqual(['Move to top', 'Add deadline', 'Add a subtask', 'Indent', 'Delete', ...lists.map((each) => each.title), 'New list']);
    expect(ids(items)).toEqual(['top', 'deadline', 'subtask', 'indent', 'delete', ...lists.map((each) => `list:${each.id}`), 'new-list']);
    // One line before the lists and one before "New list".
    expect(items.filter((item) => item.separatorBefore).map((item) => item.id)).toEqual([`list:${lists[0]!.id}`, 'new-list']);
    expect(items.filter((item) => item.checked).map((item) => item.id)).toEqual([`list:${list.id}`]);
    expect(items.filter((item) => item.disabled)).toEqual([]);
    expect(taskMenuItems({ task, layout: 'phone' })).toEqual(items);
  });

  it('has no "Indent" for the first task, and "Move to top" is disabled there', () => {
    const list = makeList();
    const first = makeTask({ listId: list.id });
    makeTask({ listId: list.id });
    const items = taskMenuItems({ task: first, layout: 'wide' });
    expect(ids(items).slice(0, 4)).toEqual(['top', 'deadline', 'subtask', 'delete']);
    expect(find(items, 'top').disabled).toBe(true);
  });

  it('shows "Unindent" for a subtask, and no "Add a subtask" and no "Indent"', () => {
    const list = makeList();
    const parent = makeTask({ listId: list.id });
    makeTask({ listId: list.id, parentId: parent.id });
    const subtask = makeTask({ listId: list.id, parentId: parent.id });
    const items = taskMenuItems({ task: subtask, layout: 'wide' });
    expect(ids(items).slice(0, 4)).toEqual(['top', 'deadline', 'unindent', 'delete']);
    expect(find(items, 'top').disabled).toBe(false);
    // The parent keeps "Add a subtask". It is the first task, so it has no "Indent".
    expect(ids(taskMenuItems({ task: layer.getTask(parent.id)!, layout: 'wide' })).slice(0, 4)).toEqual(['top', 'deadline', 'subtask', 'delete']);
  });

  it('has no "Indent" for a repeating task, but it can get a subtask and a deadline', () => {
    const list = makeList();
    makeTask({ listId: list.id });
    const task = makeTask({
      listId: list.id,
      fields: { repeat: { every: 1, unit: 'day', start: layer.store.today, end: { type: 'never' } } },
    });
    expect(task.repeat).not.toBeNull();
    expect(ids(taskMenuItems({ task, layout: 'wide' })).slice(0, 4)).toEqual(['top', 'deadline', 'subtask', 'delete']);
  });

  it('reads "Change deadline" for a task with a deadline', () => {
    const list = makeList();
    const task = makeTask({ listId: list.id, fields: { deadline: '2026-10-20' } });
    expect(find(taskMenuItems({ task, layout: 'wide' }), 'deadline').label).toBe('Change deadline');
  });

  it('runs the entries', async () => {
    const list = makeList();
    const a = makeTask({ listId: list.id, title: 'a' });
    const b = makeTask({ listId: list.id, title: 'b' });
    const c = makeTask({ listId: list.id, title: 'c' });

    await runTaskMenuItem({ task: c, itemId: 'top', hooks });
    expect(titles(list.id)).toEqual(['c', 'a', 'b']);

    await runTaskMenuItem({ task: layer.getTask(b.id)!, itemId: 'indent', hooks });
    expect(layer.getTask(b.id)!.parentId).toBe(a.id);
    await runTaskMenuItem({ task: layer.getTask(b.id)!, itemId: 'unindent', hooks });
    expect(layer.getTask(b.id)!.parentId).toBeNull();

    await runTaskMenuItem({ task: a, itemId: 'subtask', hooks });
    expect(hooks.addSubtask).toHaveBeenCalledWith(a);

    dialogs.pickDeadline.mockResolvedValueOnce({ deadline: '2026-11-02' });
    await runTaskMenuItem({ task: a, itemId: 'deadline', hooks });
    expect(dialogs.pickDeadline).toHaveBeenCalledWith({ value: null });
    expect(layer.getTask(a.id)!.deadline).toBe('2026-11-02');

    expect(hooks.afterDelete).not.toHaveBeenCalled();
    await runTaskMenuItem({ task: a, itemId: 'delete', hooks });
    expect(layer.getTask(a.id)).toBeUndefined();
    expect(hooks.afterDelete).toHaveBeenCalledWith(a);
    expect(layer.toast.current?.message).toBe('Task deleted');
  });

  it('moves the task to the top of the chosen list, and does nothing for its own list', async () => {
    const from = makeList();
    const to = makeList();
    makeTask({ listId: to.id, title: 'old 1' });
    makeTask({ listId: to.id, title: 'old 2' });
    const parent = makeTask({ listId: from.id, title: 'parent' });
    makeTask({ listId: from.id, title: 'child', parentId: parent.id });
    const single = makeTask({ listId: from.id, title: 'single' });

    await runTaskMenuItem({ task: single, itemId: `list:${from.id}`, hooks });
    expect(titles(from.id)).toEqual(['parent', 'child', 'single']);

    await runTaskMenuItem({ task: single, itemId: `list:${to.id}`, hooks });
    expect(titles(to.id)).toEqual(['single', 'old 1', 'old 2']);
    // The subtasks go with their parent.
    await runTaskMenuItem({ task: parent, itemId: `list:${to.id}`, hooks });
    expect(titles(to.id)).toEqual(['parent', 'child', 'single', 'old 1', 'old 2']);
    expect(titles(from.id)).toEqual([]);
  });

  it('"New list" asks for a name, makes the list, and moves the task there', async () => {
    const list = makeList();
    const task = makeTask({ listId: list.id, title: 'to a new list' });
    dialogs.promptText.mockResolvedValueOnce('Fresh list');
    await runTaskMenuItem({ task, itemId: 'new-list', hooks });
    const made = layer.listsOrdered().at(-1)!;
    expect(made.title).toBe('Fresh list');
    expect(titles(made.id)).toEqual(['to a new list']);
    expect(titles(list.id)).toEqual([]);
  });
});

describe('list menu', () => {
  const SORT_LABELS = ['My order', 'Date', 'Deadline', 'Starred recently', 'Title'];

  it('has the entries of the SPEC in order on a wide window', () => {
    const list = makeList('Groceries');
    const items = listMenuItems({ list, layout: 'wide' });
    expect(labels(items)).toEqual([
      ...SORT_LABELS,
      'Rename list',
      'Share with Sam',
      'Delete list',
      'Move list to first position',
      'Print list',
      'Delete all completed tasks',
    ]);
    expect(ids(items)).toEqual(['sort:my', 'sort:date', 'sort:deadline', 'sort:starred', 'sort:title', 'rename', 'share', 'delete', 'first', 'print', 'clear']);
    expect(items[0]!.sectionLabel).toBe('Sort by');
    expect(items.filter((item) => item.separatorBefore).map((item) => item.id)).toEqual(['rename', 'print']);
    expect(items.filter((item) => item.checked).map((item) => item.id)).toEqual(['sort:my']);
    // Each sort entry has a place for the check mark.
    expect(items.slice(0, 5).every((item) => item.checked !== undefined)).toBe(true);
    // A new list has no completed tasks.
    expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(['clear']);
  });

  it('has "Move list left" and "Move list right" in place of "Print list" on a phone', () => {
    const list = makeList();
    const items = listMenuItems({ list, layout: 'phone' });
    expect(labels(items).slice(5)).toEqual([
      'Rename list',
      'Share with Sam',
      'Delete list',
      'Move list to first position',
      'Move list left',
      'Move list right',
      'Delete all completed tasks',
    ]);
    expect(items.filter((item) => item.separatorBefore).map((item) => item.id)).toEqual(['rename', 'left']);
    // The newest list is the last one.
    expect(find(items, 'left').disabled).toBe(false);
    expect(find(items, 'right').disabled).toBe(true);
    const first = listMenuItems({ list: layer.listsOrdered()[0]!, layout: 'phone' });
    expect(find(first, 'left').disabled).toBe(true);
    expect(find(first, 'right').disabled).toBe(false);
    expect(find(first, 'first').disabled).toBe(true);
  });

  it('disables "Delete list" on the default list, with the reason', () => {
    const items = listMenuItems({ list: layer.getList(MY_LIST)!, layout: 'wide' });
    expect(find(items, 'delete')).toMatchObject({ disabled: true, hint: "The default list can't be deleted" });
    expect(find(items, 'share')).toMatchObject({ label: 'Share with Sam' });
    expect(find(items, 'share').disabled).toBeUndefined();
  });

  it('shows "Shared by NAME" and no delete to a person who is not the owner', () => {
    const items = listMenuItems({ list: sam(), layout: 'wide' });
    expect(find(items, 'share')).toMatchObject({ label: 'Shared by Sam', disabled: true });
    expect(find(items, 'delete')).toMatchObject({ label: 'Delete list', disabled: true, hint: 'Only Sam can delete this list' });
    expect(find(items, 'rename').disabled).toBeUndefined();
    expect(labels(items)).toHaveLength(11);
  });

  it('shows "Stop sharing" to the owner of a shared list, and lets the owner delete it', () => {
    const list = makeList();
    layer.actions.setListShared({ id: list.id, shared: true });
    const items = listMenuItems({ list: layer.getList(list.id)!, layout: 'wide' });
    expect(find(items, 'share')).toEqual({ id: 'share', label: 'Stop sharing' });
    expect(find(items, 'delete')).toEqual({ id: 'delete', label: 'Delete list' });
  });

  it('enables "Delete all completed tasks" only when the list has completed tasks', () => {
    const list = makeList();
    const task = makeTask({ listId: list.id });
    expect(find(listMenuItems({ list, layout: 'wide' }), 'clear').disabled).toBe(true);
    layer.actions.completeTask({ id: task.id });
    expect(find(listMenuItems({ list, layout: 'wide' }), 'clear').disabled).toBe(false);
  });

  it('puts the check mark on the active sort, and the sort entries alone have no heading', () => {
    const list = makeList();
    layer.actions.setListSort({ id: list.id, sort: 'deadline' });
    const now = layer.getList(list.id)!;
    expect(listMenuItems({ list: now, layout: 'wide' }).filter((item) => item.checked).map((item) => item.id)).toEqual(['sort:deadline']);
    const alone = sortMenuItems({ list: now });
    expect(labels(alone)).toEqual(SORT_LABELS);
    expect(alone.every((item) => item.sectionLabel === undefined && item.separatorBefore === undefined)).toBe(true);
  });

  it('runs the sort, the moves, and the print entry', async () => {
    const a = makeList('run a');
    const b = makeList('run b');
    const order = (): string[] => layer.listsOrdered().map((list) => list.title);

    await runListMenuItem({ list: a, itemId: 'sort:title' });
    expect(layer.getList(a.id)!.sort).toBe('title');

    const before = order();
    await runListMenuItem({ list: b, itemId: 'left' });
    expect(order().slice(-2)).toEqual(['run b', 'run a']);
    await runListMenuItem({ list: b, itemId: 'right' });
    expect(order()).toEqual(before);
    // At the edge the entry does nothing.
    await runListMenuItem({ list: b, itemId: 'right' });
    expect(order()).toEqual(before);

    await runListMenuItem({ list: b, itemId: 'first' });
    expect(order()[0]).toBe('run b');

    await runListMenuItem({ list: a, itemId: 'print' });
    expect(printList).toHaveBeenCalledWith(a.id);
    const print = vi.fn();
    await runListMenuItem({ list: a, itemId: 'print', hooks: { print } });
    expect(print).toHaveBeenCalledWith(a);
    expect(printList).toHaveBeenCalledTimes(1);
  });

  it('runs the entries that ask first', async () => {
    const list = makeList('Old name');
    const task = makeTask({ listId: list.id });
    layer.actions.completeTask({ id: task.id });

    dialogs.promptText.mockResolvedValueOnce('New name');
    await runListMenuItem({ list, itemId: 'rename' });
    expect(dialogs.promptText).toHaveBeenCalledWith(expect.objectContaining({ title: 'Rename list', value: 'Old name' }));
    expect(layer.getList(list.id)!.title).toBe('New name');

    dialogs.confirmDialog.mockResolvedValueOnce(true);
    await runListMenuItem({ list: layer.getList(list.id)!, itemId: 'share' });
    expect(layer.getList(list.id)!.shared).toBe(true);

    dialogs.confirmDialog.mockResolvedValueOnce(true);
    await runListMenuItem({ list: layer.getList(list.id)!, itemId: 'clear' });
    expect(layer.listView(list.id).completed).toEqual([]);

    // The list is empty now, so "Delete list" does not ask.
    dialogs.confirmDialog.mockClear();
    await runListMenuItem({ list: layer.getList(list.id)!, itemId: 'delete' });
    expect(dialogs.confirmDialog).not.toHaveBeenCalled();
    expect(layer.getList(list.id)).toBeUndefined();
  });
});

describe('starred view menu', () => {
  it('has "Date" and "Recently starred" below "Sort by", and sets the sort', () => {
    layer.prefs.starredSort = 'date';
    const items = starredMenuItems();
    expect(labels(items)).toEqual(['Date', 'Recently starred']);
    expect(ids(items)).toEqual(['sort:date', 'sort:starred']);
    expect(items[0]!.sectionLabel).toBe('Sort by');
    expect(items.map((item) => item.checked)).toEqual([true, false]);

    runStarredMenuItem('sort:starred');
    expect(layer.prefs.starredSort).toBe('starred');
    expect(starredMenuItems().map((item) => item.checked)).toEqual([false, true]);
    runStarredMenuItem('other');
    expect(layer.prefs.starredSort).toBe('starred');
  });
});
