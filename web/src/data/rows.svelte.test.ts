import { describe, expect, it } from 'vitest';
import { defaultList, defaultNote, defaultTask } from '../../../shared/merge.ts';
import type { ListRow, NoteFields, NoteRow, Put, StarredSort, TaskFields, TaskRow } from '../../../shared/types.ts';
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
/** A note with a later createdAt for a later letter, so 'c' is before 'b' in the view. */
const note = (id: string, fields: Partial<NoteRow> = {}): NoteRow => ({
  ...defaultNote(id),
  title: id,
  owner: 'me',
  createdAt: id.charCodeAt(0),
  editedAt: id.charCodeAt(0),
  ...fields,
});
const notePut = (id: string, fields: NoteFields): Put => ({ kind: 'note', id, fields });

function setup() {
  let today = $state('2026-10-06');
  let sort = $state<StarredSort>('date');
  const store = createRowStore({ locale: 'en-GB', today: () => today, starredSort: () => sort });
  store.load({
    lists: [list('A'), list('B')],
    tasks: [task('a1', 'A'), task('a2', 'A'), task('a3', 'A', { completed: true, completedAt: 5 }), task('b1', 'B'), task('b2', 'B')],
    notes: [],
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
      notes: new Map(),
    });
    expect(changed).toEqual({ lists: [], tasks: [], notes: [] });
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
      notes: new Map(),
    });
    expect(changed).toEqual({ lists: ['B', 'C'], tasks: ['a1', 'b1', 'b2', 'c1'], notes: [] });
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
    expect(result.changed).toEqual({ lists: ['B'], tasks: ['a2', 'new'], notes: [] });
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

    store.replace({ lists: new Map([['C', list('C')]]), tasks: new Map([['late', task('late', 'C')]]), notes: new Map() });
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
    store.load({ lists: [], tasks: [], notes: [] });
    expect([store.listView('A').openCount, store.listsOrdered().length, store.rows.tasks.size]).toEqual([0, 0, 0]);
    store.load({ lists: [list('A')], tasks: [task('z', 'A', { starred: true })], notes: [] });
    expect([store.listView('A').openCount, store.listsOrdered().length, store.rows.tasks.size]).toEqual([1, 1, 1]);
    expect(store.starredView().openCount).toBe(1);
  });

  it.runIf(reactive)('tells the readers', () => {
    const { store } = setup();
    const view = watch(() => store.listView('A').openCount);
    const lists = watch(() => store.listsOrdered().length);
    store.load({ lists: [], tasks: [], notes: [] });
    flushSync();
    expect([view.value, lists.value]).toEqual([0, 0]);
    store.load({ lists: [list('A')], tasks: [task('z', 'A')], notes: [] });
    flushSync();
    expect([view.value, lists.value]).toEqual([1, 1]);
    [view, lists].forEach((each) => each.stop());
  });
});

describe('notes', () => {
  function withNotes() {
    const made = setup();
    made.store.load({
      lists: [list('A'), list('B')],
      tasks: [task('a1', 'A'), task('b1', 'B', { starred: true, starredAt: 1 })],
      notes: [
        note('a'),
        note('b', { pinned: true }),
        note('c', { body: 'Milk and eggs' }),
        note('d', { archived: true }),
        note('e', { deleted: true }),
      ],
    });
    return made;
  }
  const ids = (notes: NoteRow[]): string[] => notes.map((row) => row.id);

  it('gives a note, and undefined for a note that is deleted or not there', () => {
    const { store } = withNotes();
    expect(store.getNote('a')).toBe(store.rows.notes.get('a'));
    expect(store.getNote('e')).toBeUndefined();
    expect(store.getNote('nope')).toBeUndefined();
    store.apply([notePut('a', { deleted: true })]);
    expect(store.getNote('a')).toBeUndefined();
    store.apply([notePut('a', { deleted: false })]);
    expect(store.getNote('a')?.title).toBe('a');
  });

  it('builds the notes view and the archive, and builds each one time for many reads', () => {
    const { store } = withNotes();
    const notes = store.notesView({ archived: false, query: '' });
    expect([ids(notes.pinned), ids(notes.others)]).toEqual([['b'], ['c', 'a']]);
    const archive = store.notesView({ archived: true, query: '' });
    expect([ids(archive.pinned), ids(archive.others)]).toEqual([[], ['d']]);
    expect(store.notesView({ archived: false, query: '' })).toBe(notes);
    expect(store.notesView({ archived: true, query: '' })).toBe(archive);
    expect(store.builds.notes).toBe(2);
    expect(ids(store.notesView({ archived: false, query: 'MILK' }).others)).toEqual(['c']);
    expect(store.builds.notes).toBe(3);
  });

  it('builds a search one time for the same words, also with more spaces', () => {
    const { store } = withNotes();
    const view = store.notesView({ archived: false, query: 'milk eggs' });
    expect(ids(view.others)).toEqual(['c']);
    expect(store.notesView({ archived: false, query: '  milk   eggs ' })).toBe(view);
    expect(store.notesView({ archived: false, query: ' ' })).toBe(store.notesView({ archived: false, query: '' }));
    expect(store.builds.notes).toBe(2);
  });

  it('keeps some inputs in the cache, and builds an input again after many other inputs', () => {
    const { store } = withNotes();
    const first = store.notesView({ archived: false, query: 'a' });
    for (const query of ['b', 'c', 'd', 'e', 'f', 'g', 'h']) store.notesView({ archived: false, query });
    expect(store.notesView({ archived: false, query: 'a' })).toBe(first);
    expect(store.builds.notes).toBe(8);
    store.notesView({ archived: false, query: 'i' });
    store.notesView({ archived: false, query: 'j' });
    store.notesView({ archived: false, query: 'b' });
    expect(store.builds.notes).toBe(11);
  });

  it('builds the notes view again after a change of a note, and keeps the arrays that did not change', () => {
    const { store } = withNotes();
    const before = store.notesView({ archived: false, query: '' });
    store.apply([notePut('a', { title: 'changed' })]);
    const after = store.notesView({ archived: false, query: '' });
    expect(after).not.toBe(before);
    expect(after.pinned).toBe(before.pinned);
    expect(after.others).not.toBe(before.others);
    expect(after.others[1]!.title).toBe('changed');
    // The row objects that did not change stay, so a keyed list updates only one card.
    expect(after.others[0]).toBe(before.others[0]);
    expect(store.builds.notes).toBe(2);

    // A change of an archived note: the view is built again, but it has the same content.
    store.apply([notePut('d', { color: 'red' })]);
    expect(store.notesView({ archived: false, query: '' })).toBe(after);
    expect(store.builds.notes).toBe(3);
  });

  it('builds no notes view for a change of a list or a task, and no list view for a change of a note', () => {
    const { store } = withNotes();
    const notes = store.notesView({ archived: false, query: '' });
    store.apply([put('a1', { title: 'x' }), put('b1', { title: 'y' }), { kind: 'list', id: 'A', fields: { title: 'Aa' } }]);
    expect(store.notesView({ archived: false, query: '' })).toBe(notes);
    expect(store.builds.notes).toBe(1);

    const views = { a: store.listView('A'), starred: store.starredView(), lists: store.listsOrdered() };
    const builds = { ...store.builds };
    store.apply([notePut('a', { title: 'z' }), notePut('new', { createdAt: 900, title: 'new', owner: 'me' })]);
    store.replace({ lists: new Map(), tasks: new Map(), notes: new Map([['b', null]]) });
    expect({ a: store.listView('A'), starred: store.starredView(), lists: store.listsOrdered() }).toEqual(views);
    expect(store.listView('A')).toBe(views.a);
    expect(store.starredView()).toBe(views.starred);
    expect(store.listsOrdered()).toBe(views.lists);
    expect([store.builds.list, store.builds.starred]).toEqual([builds.list, builds.starred]);
    expect(ids(store.notesView({ archived: false, query: '' }).others)).toEqual(['new', 'c', 'a']);
  });

  it('gives only the note puts that changed a note, and makes a note only from a put with createdAt', () => {
    const { store } = withNotes();
    const result = store.apply([
      notePut('a', { title: 'a' }),
      notePut('late', { title: 'a change of a note that was dropped' }),
      notePut('b', { color: 'teal' }),
      notePut('made', { createdAt: 500, title: '', owner: 'me' }),
    ]);
    expect(result.applied.map((each) => each.id)).toEqual(['b', 'made']);
    expect(result.changed).toEqual({ lists: [], tasks: [], notes: ['b', 'made'] });
    expect(store.rows.notes.has('late')).toBe(false);
    expect(store.getNote('made')?.title).toBe('');
  });

  it('writes the notes of the server, keeps the object of a note with the same values, and removes the notes that are gone', () => {
    const { store } = withNotes();
    const a = store.rows.notes.get('a')!;
    const view = store.notesView({ archived: false, query: '' });
    const changed = store.replace({
      lists: new Map(),
      tasks: new Map(),
      notes: new Map<string, NoteRow | null>([
        ['a', Object.fromEntries(Object.entries({ ...a }).reverse()) as unknown as NoteRow],
        ['c', null],
        ['f', note('f')],
        ['never', null],
      ]),
    });
    expect(changed).toEqual({ lists: [], tasks: [], notes: ['c', 'f'] });
    expect(store.rows.notes.get('a')).toBe(a);
    expect(store.rows.notes.has('c')).toBe(false);
    const after = store.notesView({ archived: false, query: '' });
    expect(after).not.toBe(view);
    expect(ids(after.others)).toEqual(['f', 'a']);
    expect(after.others[1]).toBe(a);

    // Nothing changed: the view is not built again.
    const builds = store.builds.notes;
    store.replace({ lists: new Map(), tasks: new Map(), notes: new Map([['a', { ...a }]]) });
    expect(store.notesView({ archived: false, query: '' })).toBe(after);
    expect(store.builds.notes).toBe(builds);
  });

  it('replaces the notes at a load', () => {
    const { store } = withNotes();
    store.notesView({ archived: false, query: '' });
    store.load({ lists: [], tasks: [], notes: [] });
    expect(store.notesView({ archived: false, query: '' })).toEqual({ pinned: [], others: [] });
    expect(store.getNote('a')).toBeUndefined();
    store.load({ lists: [], tasks: [], notes: [note('z')] });
    expect(ids(store.notesView({ archived: false, query: '' }).others)).toEqual(['z']);
  });

  describe.runIf(reactive)('readers (only with the compiler output for a browser)', () => {
    it('runs the readers of notes for a change of a note, and no reader of a list or a task', () => {
      const { store } = withNotes();
      const notes = watch(() => store.notesView({ archived: false, query: '' }));
      const archive = watch(() => store.notesView({ archived: true, query: '' }));
      const one = watch(() => store.getNote('a'));
      const listA = watch(() => store.listView('A'));
      const starred = watch(() => store.starredView());
      const lists = watch(() => store.listsOrdered());
      const taskA = watch(() => store.getTask('a1'));
      const listB = watch(() => store.getList('B'));
      const missing = watch(() => store.getTask('nope'));

      store.apply([notePut('a', { title: 'new title' })]);
      flushSync();
      expect([notes.runs, archive.runs, one.runs]).toEqual([2, 2, 2]);
      expect(one.value?.title).toBe('new title');
      expect(notes.value.others.map((row) => row.title)).toEqual(['c', 'new title']);
      // The archive got the same object, so a component that shows it does nothing.
      expect(archive.value).toBe(store.notesView({ archived: true, query: '' }));

      store.replace({ lists: new Map(), tasks: new Map(), notes: new Map<string, NoteRow | null>([['f', note('f')], ['b', null]]) });
      flushSync();
      expect([notes.runs, archive.runs, one.runs]).toEqual([3, 3, 3]);
      expect([listA.runs, starred.runs, lists.runs, taskA.runs, listB.runs, missing.runs]).toEqual([1, 1, 1, 1, 1, 1]);
      [notes, archive, one, listA, starred, lists, taskA, listB, missing].forEach((each) => each.stop());
    });

    it('runs no reader of notes for a change of a list or a task', () => {
      const { store } = withNotes();
      const notes = watch(() => store.notesView({ archived: false, query: 'milk' }));
      const one = watch(() => store.getNote('a'));
      const missing = watch(() => store.getNote('nope'));
      store.apply([put('a1', { title: 'x' }), put('b1', { starred: false }), { kind: 'list', id: 'B', fields: { title: 'Bee' } }]);
      store.replace({
        lists: new Map([['C', list('C')]]),
        tasks: new Map<string, TaskRow | null>([
          ['c1', task('c1', 'C')],
          ['a1', null],
        ]),
        notes: new Map(),
      });
      flushSync();
      expect([notes.runs, one.runs, missing.runs]).toEqual([1, 1, 1]);
      [notes, one, missing].forEach((each) => each.stop());
    });

    it('tells the reader of a note that is not there when the note comes', () => {
      const { store } = withNotes();
      const late = watch(() => store.getNote('late')?.title);
      expect(late.value).toBeUndefined();
      store.replace({ lists: new Map(), tasks: new Map(), notes: new Map([['late', note('late')]]) });
      flushSync();
      expect(late.value).toBe('late');
      late.stop();
    });
  });
});
