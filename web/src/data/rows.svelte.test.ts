import { describe, expect, it } from 'vitest';
import { defaultList, defaultTask } from '../../../shared/merge.ts';
import type { ListRow, Put, StarredSort, TaskFields, TaskRow } from '../../../shared/types.ts';
import { createRowStore } from './rows.svelte.ts';
import { flushSync, reactive, watch } from './watch.svelte.ts';

const list = (id: string, fields: Partial<ListRow> = {}): ListRow => ({ ...defaultList(id), title: id, owner: 'me', pos: id, ...fields });
const task = (id: string, listId: string, fields: Partial<TaskRow> = {}): TaskRow => ({
  ...defaultTask(id),
  listId,
  title: id,
  pos: id,
  ...fields,
});
const put = (id: string, fields: TaskFields): Put => ({ kind: 'task', id, fields });

function setup() {
  let today = $state('2026-10-06');
  let sort = $state<StarredSort>('date');
  const store = createRowStore({ locale: 'en-GB', today: () => today, starredSort: () => sort });
  store.load({
    lists: [list('A'), list('B')],
    tasks: [task('a1', 'A'), task('a2', 'A'), task('a3', 'A', { completed: true, completedAt: 5 }), task('b1', 'B'), task('b2', 'B')],
  });
  return {
    store,
    setToday: (value: string) => (today = value),
    setSort: (value: StarredSort) => (sort = value),
  };
}

const titles = (store: ReturnType<typeof setup>['store'], listId: string): string[] =>
  store.listView(listId).groups.flatMap((group) => group.items.map((item) => item.task.title));

describe('view cache', () => {
  it('builds a view one time for many reads', () => {
    const { store } = setup();
    const first = store.listView('A');
    expect(store.listView('A')).toBe(first);
    expect(store.builds.list).toBe(1);
    expect(titles(store, 'A')).toEqual(['a1', 'a2']);
    expect(first.completed.map((row) => row.id)).toEqual(['a3']);
    expect(first.openCount).toBe(2);
  });

  it('does not build the view of list B again for a change in list A', () => {
    const { store } = setup();
    const viewB = store.listView('B');
    store.listView('A');
    expect(store.builds.list).toBe(2);

    store.apply([put('a1', { title: 'changed' })]);
    expect(titles(store, 'A')).toEqual(['changed', 'a2']);
    expect(store.listView('B')).toBe(viewB);
    expect(store.builds.list).toBe(3);

    for (let i = 0; i < 20; i++) store.apply([put('a2', { notes: `n${i}` })]);
    store.listView('A');
    store.listView('B');
    expect(store.builds.list).toBe(4);
  });

  it('builds the two views again when a task moves to the other list', () => {
    const { store } = setup();
    store.listView('A');
    store.listView('B');
    store.apply([put('a1', { listId: 'B', pos: 'b3' })]);
    expect(titles(store, 'A')).toEqual(['a2']);
    expect(titles(store, 'B')).toEqual(['b1', 'b2', 'a1']);
    expect(store.builds.list).toBe(4);
  });

  it('builds a view again when the date or the sort of the list changes, and not for a new list name', () => {
    const { store, setToday } = setup();
    store.apply([put('a1', { due: '2026-10-07' })]);
    const view = store.listView('A');
    store.apply([{ kind: 'list', id: 'A', fields: { title: 'New name' } }]);
    expect(store.listView('A')).toBe(view);
    expect(store.builds.list).toBe(1);

    store.apply([{ kind: 'list', id: 'A', fields: { sort: 'date' } }]);
    expect(store.listView('A').groups.map((group) => group.heading)).toEqual(['Tomorrow', 'No date']);
    expect(store.builds.list).toBe(2);

    setToday('2026-10-07');
    expect(store.listView('A').groups.map((group) => group.heading)).toEqual(['Today', 'No date']);
    expect(store.builds.list).toBe(3);
  });

  it('shows a resting task again when its date comes', () => {
    const { store, setToday } = setup();
    const rule = { every: 1, unit: 'day', start: '2026-10-01', end: { type: 'never' } } as const;
    store.apply([put('a1', { repeat: rule, due: '2026-10-07', hiddenUntil: '2026-10-07', lastDoneAt: 9 })]);
    expect(titles(store, 'A')).toEqual(['a2']);
    expect(store.listView('A').completed.map((row) => row.id)).toEqual(['a1', 'a3']);
    setToday('2026-10-07');
    expect(titles(store, 'A')).toEqual(['a1', 'a2']);
  });

  it('gives an empty view for a list that is deleted or not there', () => {
    const { store } = setup();
    expect(store.listView('nope')).toEqual({ groups: [], completed: [], openCount: 0 });
    store.apply([{ kind: 'list', id: 'A', fields: { deleted: true } }]);
    expect(store.listView('A').openCount).toBe(0);
    expect(store.getList('A')).toBeUndefined();
    expect(store.listsOrdered().map((row) => row.id)).toEqual(['B']);
    expect(store.builds.list).toBe(0);
  });
});

describe('objects that stay', () => {
  it('keeps the row objects and the view items of the tasks that did not change', () => {
    const { store } = setup();
    store.apply([put('a2', { parentId: 'a1' })]);
    const before = store.listView('A');
    const [first, second] = before.groups[0]!.items;
    expect([first!.hasChildren, second!.depth]).toEqual([true, 1]);

    store.apply([put('a2', { title: 'new' })]);
    const after = store.listView('A');
    expect(after).not.toBe(before);
    expect(after.groups[0]!.items[0]).toBe(first);
    expect(after.groups[0]!.items[1]).not.toBe(second);
    expect(after.groups[0]!.items[1]!.task.title).toBe('new');
    // The completed part did not change, so a keyed list on the screen has nothing to do.
    expect(after.completed).toBe(before.completed);
    expect(store.rows.tasks.get('a1')).toBe(first!.task);
  });

  it('keeps a group that did not change in a view with groups', () => {
    const { store } = setup();
    store.apply([{ kind: 'list', id: 'A', fields: { sort: 'date' } }, put('a1', { due: '2026-10-06' })]);
    const before = store.listView('A');
    expect(before.groups.map((group) => group.key)).toEqual(['2026-10-06', 'none']);
    store.apply([put('a2', { notes: 'changed' })]);
    const after = store.listView('A');
    expect(after.groups[0]).toBe(before.groups[0]);
    expect(after.groups[1]).not.toBe(before.groups[1]);
  });

  it('gives the same view when a change has no effect on it', () => {
    const { store } = setup();
    store.apply([put('a3', { deleted: true })]);
    const before = store.listView('A');
    // A deleted row is in no part of the view.
    store.apply([put('a3', { notes: 'x' })]);
    expect(store.listView('A')).toBe(before);
    expect(store.builds.list).toBe(2);
  });

  it('keeps the object of a row that the server sends with the same values', () => {
    const { store } = setup();
    const old = store.rows.tasks.get('a1')!;
    const view = store.listView('A');
    const changed = store.replace({
      lists: new Map([['A', { ...store.rows.lists.get('A')! }]]),
      tasks: new Map([['a1', { ...old, repeat: null }]]),
    });
    expect(changed).toEqual({ lists: [], tasks: [] });
    expect(store.rows.tasks.get('a1')).toBe(old);
    expect(store.listView('A')).toBe(view);
    expect(store.builds.list).toBe(1);
  });

  it('writes the rows of the server over the rows and removes the rows that are gone', () => {
    const { store } = setup();
    const changed = store.replace({
      lists: new Map<string, ListRow | null>([
        ['B', null],
        ['C', list('C')],
      ]),
      tasks: new Map<string, TaskRow | null>([
        ['a1', task('a1', 'A', { title: 'server' })],
        ['b1', null],
        ['b2', null],
        ['c1', task('c1', 'C')],
        ['never', null],
      ]),
    });
    expect(changed).toEqual({ lists: ['B', 'C'], tasks: ['a1', 'b1', 'b2', 'c1'] });
    expect(store.listsOrdered().map((row) => row.id)).toEqual(['A', 'C']);
    expect(titles(store, 'A')).toEqual(['server', 'a2']);
    expect(titles(store, 'C')).toEqual(['c1']);
    expect(store.rows.tasks.has('b1')).toBe(false);
  });
});

describe('local puts', () => {
  it('gives only the puts that changed a row', () => {
    const { store } = setup();
    const result = store.apply([
      put('a1', { title: 'a1' }),
      put('not-there', { title: 'late change' }),
      put('a2', { starred: true }),
      { kind: 'list', id: 'no-list', fields: { hidden: true } },
      { kind: 'list', id: 'B', fields: { hidden: true } },
      put('new', { listId: 'B', title: 'new', pos: 'b9' }),
    ]);
    expect(result.applied.map((each) => each.id)).toEqual(['a2', 'B', 'new']);
    expect(result.changed).toEqual({ lists: ['B'], tasks: ['a2', 'new'] });
    expect(store.rows.tasks.has('not-there')).toBe(false);
    expect(store.rows.lists.has('no-list')).toBe(false);
  });
});

describe.runIf(reactive)('readers (only with the compiler output for a browser)', () => {
  it('runs only the readers of the list that changed', () => {
    const { store } = setup();
    const a = watch(() => store.listView('A'));
    const b = watch(() => store.listView('B'));
    const lists = watch(() => store.listsOrdered());

    store.apply([put('a1', { title: 'x' }), put('a2', { title: 'y' })]);
    flushSync();
    expect([a.runs, b.runs, lists.runs]).toEqual([2, 1, 1]);
    expect(a.value.groups[0]!.items.map((item) => item.task.title)).toEqual(['x', 'y']);

    store.apply([{ kind: 'list', id: 'B', fields: { title: 'Bee' } }]);
    flushSync();
    expect([a.runs, b.runs, lists.runs]).toEqual([2, 2, 2]);
    expect(lists.value.map((row) => row.title)).toEqual(['A', 'Bee']);
    [a, b, lists].forEach((each) => each.stop());
  });

  it('tells the reader of one task about that task, and not about a different list', () => {
    const { store } = setup();
    const a1 = watch(() => store.getTask('a1'));
    const b1 = watch(() => store.getTask('b1'));
    store.apply([put('a1', { title: 'x' })]);
    flushSync();
    expect([a1.runs, b1.runs]).toEqual([2, 1]);
    expect(a1.value?.title).toBe('x');

    store.apply([put('a1', { deleted: true })]);
    flushSync();
    expect(a1.value).toBeUndefined();
    store.apply([put('a1', { deleted: false })]);
    flushSync();
    expect(a1.value?.id).toBe('a1');

    // The task is in a list that the person cannot see now.
    store.apply([{ kind: 'list', id: 'A', fields: { deleted: true } }]);
    flushSync();
    expect(a1.value).toBeUndefined();
    expect(b1.runs).toBe(1);
    [a1, b1].forEach((each) => each.stop());
  });

  it('tells the reader of a row that is not there when the row comes', () => {
    const { store } = setup();
    const lateTask = watch(() => store.getTask('late'));
    const lateList = watch(() => store.getList('C'));
    const lateView = watch(() => store.listView('C').openCount);
    expect([lateTask.value, lateList.value, lateView.value]).toEqual([undefined, undefined, 0]);

    store.replace({ lists: new Map([['C', list('C')]]), tasks: new Map([['late', task('late', 'C')]]) });
    flushSync();
    expect(lateTask.value?.id).toBe('late');
    expect(lateList.value?.id).toBe('C');
    expect(lateView.value).toBe(1);
    [lateTask, lateList, lateView].forEach((each) => each.stop());
  });

  it('gives the subtasks of a task in order, and follows their changes', () => {
    const { store } = setup();
    store.apply([
      put('s2', { listId: 'A', parentId: 'a1', title: 's2', pos: 'b' }),
      put('s1', { listId: 'A', parentId: 'a1', title: 's1', pos: 'a' }),
      put('s3', { listId: 'A', parentId: 'a1', title: 's3', pos: 'c', completed: true }),
    ]);
    const subtasks = watch(() => store.subtasksOf('a1').map((row) => row.id));
    expect(subtasks.value).toEqual(['s1', 's2', 's3']);
    expect(store.subtasksOf('s1')).toEqual([]);
    expect(store.subtasksOf('a2')).toEqual([]);
    expect(store.subtasksOf('nope')).toEqual([]);

    store.apply([put('s1', { deleted: true })]);
    flushSync();
    expect(subtasks.value).toEqual(['s2', 's3']);

    // An open subtask of a completed parent shows as a task of its own.
    store.apply([put('a1', { completed: true })]);
    flushSync();
    expect(subtasks.value).toEqual(['s3']);

    const runs = subtasks.runs;
    store.apply([put('b1', { title: 'other list' })]);
    flushSync();
    expect(subtasks.runs).toBe(runs);
    subtasks.stop();
  });
});

describe('starred view', () => {
  it('has the starred tasks of all lists and follows the sort', () => {
    const { store, setSort } = setup();
    store.apply([
      put('a2', { starred: true, starredAt: 10, due: '2026-10-08' }),
      put('b1', { starred: true, starredAt: 20, due: '2026-10-06' }),
    ]);
    const ids = (): string[] => store.starredView().groups.flatMap((group) => group.items.map((item) => item.task.id));
    expect(ids()).toEqual(['b1', 'a2']);
    expect(store.starredView().groups.map((group) => group.heading)).toEqual(['Today', 'Thu 8 Oct']);
    setSort('starred');
    expect(store.starredView().groups.map((group) => group.heading)).toEqual([null]);
    expect(ids()).toEqual(['b1', 'a2']);
    store.apply([put('a2', { starredAt: 30 })]);
    expect(ids()).toEqual(['a2', 'b1']);
  });

  it('is built again only for a change in a list that has a star', () => {
    const { store } = setup();
    store.apply([put('a1', { starred: true, starredAt: 1 })]);
    const first = store.starredView();
    expect(store.builds.starred).toBe(1);

    store.apply([put('b1', { title: 'no star in this list' })]);
    expect(store.starredView()).toBe(first);
    expect(store.builds.starred).toBe(1);

    store.apply([put('a2', { title: 'a list with a star' })]);
    // The view is built again, but it has the same content, so the reader gets the same object.
    expect(store.starredView()).toBe(first);
    expect(store.builds.starred).toBe(2);

    store.apply([put('b1', { starred: true, starredAt: 2 })]);
    expect(store.starredView().openCount).toBe(2);
    store.apply([put('b1', { starred: false, starredAt: null })]);
    expect(store.starredView().openCount).toBe(1);
    expect(store.builds.starred).toBe(4);

    store.apply([{ kind: 'list', id: 'A', fields: { deleted: true } }]);
    expect(store.starredView().openCount).toBe(0);
  });

  it.runIf(reactive)('runs its readers only for a change in a list that has a star', () => {
    const { store, setSort } = setup();
    store.apply([put('a1', { starred: true, starredAt: 1 })]);
    const view = watch(() => store.starredView());
    store.apply([put('b1', { title: 'no star in this list' })]);
    flushSync();
    expect(view.runs).toBe(1);
    store.apply([put('a1', { title: 'the starred task' })]);
    flushSync();
    expect(view.runs).toBe(2);
    setSort('starred');
    flushSync();
    expect(view.runs).toBe(3);
    view.stop();
  });
});

describe('load', () => {
  it('replaces all rows', () => {
    const { store } = setup();
    store.listView('A');
    store.load({ lists: [], tasks: [] });
    expect([store.listView('A').openCount, store.listsOrdered().length, store.rows.tasks.size]).toEqual([0, 0, 0]);
    store.load({ lists: [list('A')], tasks: [task('z', 'A', { starred: true })] });
    expect([store.listView('A').openCount, store.listsOrdered().length, store.rows.tasks.size]).toEqual([1, 1, 1]);
    expect(store.starredView().openCount).toBe(1);
  });

  it.runIf(reactive)('tells the readers', () => {
    const { store } = setup();
    const view = watch(() => store.listView('A').openCount);
    const lists = watch(() => store.listsOrdered().length);
    store.load({ lists: [], tasks: [] });
    flushSync();
    expect([view.value, lists.value]).toEqual([0, 0]);
    store.load({ lists: [list('A')], tasks: [task('z', 'A')] });
    flushSync();
    expect([view.value, lists.value]).toEqual([1, 1]);
    [view, lists].forEach((each) => each.stop());
  });
});
