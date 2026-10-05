import { describe, expect, test } from 'vitest';
import type { ActionResult, ID, ListRow, Put, RepeatRule, TaskRow } from './types.ts';
import { LIMITS } from './types.ts';
import type { ActionContext } from './actions.ts';
import {
  clearCompleted,
  completeTask,
  createList,
  createTask,
  deleteList,
  deleteTask,
  indentTask,
  moveList,
  moveTask,
  moveToTop,
  renameList,
  setDate,
  setListHidden,
  setListShared,
  setListSort,
  setRepeat,
  setStar,
  uncompleteTask,
  unindentTask,
  updateTask,
} from './actions.ts';
import type { Rows } from './merge.ts';
import { applyPuts, defaultList, defaultTask, emptyRows } from './merge.ts';
import { keyBetween } from './fracindex.ts';
import { addDays, isValidDate, isValidTime } from './dates.ts';
import { nextOccurrence, validateRule } from './recurrence.ts';
import { buildListView, comparePos, isOpen, isParentOf, isResting, orderLists } from './view.ts';

/** A Tuesday. */
const TODAY = '2026-10-06';
const NOW = new Date(2026, 9, 6, 10, 0).getTime();
const ME = 'u1';
const OTHER = 'u2';
const LOCALE = 'en-GB';

const DAILY: RepeatRule = { every: 1, unit: 'day', start: '2026-10-01', end: { type: 'never' } };
const WEEKLY: RepeatRule = { every: 1, unit: 'week', weekdays: [2], start: '2026-09-01', end: { type: 'never' } };

const TASK_FIELDS = Object.keys(defaultTask('x')).filter((key) => key !== 'id').sort();
const LIST_FIELDS = Object.keys(defaultList('x')).filter((key) => key !== 'id').sort();

function freeze<T extends object>(row: T): T {
  for (const value of Object.values(row)) if (typeof value === 'object' && value !== null) freeze(value);
  return Object.freeze(row);
}

/** Rows for a test. Each new row gets the next order key, so the rows are in the order of the calls. */
function world() {
  const rows = emptyRows();
  let listPos: string | null = null;
  let taskPos: string | null = null;
  return {
    rows,
    list(id: ID, fields: Partial<ListRow> = {}): ListRow {
      if (fields.pos === undefined) listPos = keyBetween(listPos, null);
      const row = freeze({ ...defaultList(id), title: id, owner: ME, createdAt: 1000 + rows.lists.size, pos: listPos, ...fields });
      rows.lists.set(id, row);
      return row;
    },
    task(id: ID, fields: Partial<TaskRow> = {}): TaskRow {
      taskPos = keyBetween(taskPos, null);
      const row = freeze({
        ...defaultTask(id),
        listId: 'l1',
        title: id,
        pos: taskPos,
        createdAt: 2000 + rows.tasks.size,
        createdBy: ME,
        ...fields,
      });
      rows.tasks.set(id, row);
      return row;
    },
  };
}

/** Two lists. l1 has the tasks a, b, c. b has the subtasks b1 and b2. */
function standard() {
  const w = world();
  w.list('l1', { isDefault: true });
  w.list('l2');
  w.task('a');
  w.task('b');
  w.task('b1', { parentId: 'b' });
  w.task('b2', { parentId: 'b' });
  w.task('c');
  return w;
}

const copy = (rows: Rows): Rows => ({ lists: new Map(rows.lists), tasks: new Map(rows.tasks) });

type Action<I> = (ctx: ActionContext, intent: I) => ActionResult;

/**
 * Runs an action and checks the rules that each action must obey. Returns the result and the
 * rows after the puts.
 */
function act<I>(rows: Rows, action: Action<I>, intent: I, overrides: Partial<ActionContext> = {}): ActionResult & { rows: Rows } {
  const before = copy(rows);
  const result = action({ rows, now: NOW, today: TODAY, me: ME, locale: LOCALE, ...overrides }, intent);

  // The action does not change the rows that it reads.
  expect([...rows.lists.entries()]).toEqual([...before.lists.entries()]);
  expect([...rows.tasks.entries()]).toEqual([...before.tasks.entries()]);
  for (const [id, row] of before.tasks) expect(rows.tasks.get(id)).toBe(row);
  for (const [id, row] of before.lists) expect(rows.lists.get(id)).toBe(row);

  // One put and one undo put for each changed row, each with at least one field, and safe for JSON.
  expect(result.undo).toHaveLength(result.puts.length);
  expect(new Set(result.puts.map((put) => put.kind + put.id)).size).toBe(result.puts.length);
  for (const put of [...result.puts, ...result.undo]) expect(Object.keys(put.fields).length).toBeGreaterThan(0);
  expect(JSON.parse(JSON.stringify(result.puts))).toEqual(result.puts);
  expect(JSON.parse(JSON.stringify(result.undo))).toEqual(result.undo);
  if (result.puts.length === 0) expect(result.message).toBeNull();

  // A put that makes a row has all fields of the row.
  for (const put of result.puts) {
    const exists = put.kind === 'task' ? rows.tasks.has(put.id) : rows.lists.has(put.id);
    if (!exists) expect(Object.keys(put.fields).sort()).toEqual(put.kind === 'task' ? TASK_FIELDS : LIST_FIELDS);
  }

  const after = copy(rows);
  applyPuts(after, result.puts);
  // The next action in a test must not change these rows too.
  for (const row of [...after.tasks.values(), ...after.lists.values()]) freeze(row);

  // The undo brings back the start. A row that the action made is deleted.
  const undone = copy(after);
  applyPuts(undone, result.undo);
  expect(undone.tasks.size).toBe(after.tasks.size);
  expect(undone.lists.size).toBe(after.lists.size);
  for (const [id, row] of undone.tasks) {
    if (rows.tasks.has(id)) expect(row).toEqual(rows.tasks.get(id));
    else expect(row.deleted).toBe(true);
  }
  for (const [id, row] of undone.lists) {
    if (rows.lists.has(id)) expect(row).toEqual(rows.lists.get(id));
    else expect(row.deleted).toBe(true);
  }
  return { ...result, rows: after };
}

/** The open tasks of a list as the "My order" sort shows them. A subtask has two spaces before its id. */
function shown(rows: Rows, listId: ID = 'l1', today = TODAY): string[] {
  const view = buildListView({ list: rows.lists.get(listId)!, tasks: [...rows.tasks.values()], today, sort: 'my', locale: LOCALE });
  return view.groups.flatMap((group) => group.items.map((item) => (item.depth ? '  ' : '') + item.task.id));
}

function completedIds(rows: Rows, listId: ID = 'l1', today = TODAY): string[] {
  const view = buildListView({ list: rows.lists.get(listId)!, tasks: [...rows.tasks.values()], today, sort: 'my', locale: LOCALE });
  return view.completed.map((task) => task.id);
}

const task = (rows: Rows, id: ID): TaskRow => rows.tasks.get(id)!;
const list = (rows: Rows, id: ID): ListRow => rows.lists.get(id)!;
const listOrder = (rows: Rows): string[] => orderLists(rows.lists.values()).map((each) => each.id);

test('the standard rows show as expected', () => {
  const { rows } = standard();
  expect(shown(rows)).toEqual(['a', 'b', '  b1', '  b2', 'c']);
  expect(shown(rows, 'l2')).toEqual([]);
});

describe('createTask', () => {
  test('puts a new task at the top of the list', () => {
    const { rows } = standard();
    const result = act(rows, createTask, { listId: 'l1', title: 'New' });
    expect(result.message).toBeNull();
    expect(result.puts).toHaveLength(1);
    const id = result.puts[0]!.id;
    expect(shown(result.rows)).toEqual([id, 'a', 'b', '  b1', '  b2', 'c']);
    expect(task(result.rows, id)).toEqual({
      ...defaultTask(id),
      listId: 'l1',
      title: 'New',
      pos: 'Zz',
      createdAt: NOW,
      createdBy: ME,
    });
    expect(result.undo).toEqual([{ kind: 'task', id, fields: { deleted: true } }]);
  });

  test('uses the id of the intent, and makes a new id each time without it', () => {
    const { rows } = standard();
    expect(act(rows, createTask, { listId: 'l1', title: 'New', id: 'mine' }).puts[0]!.id).toBe('mine');
    const first = act(rows, createTask, { listId: 'l1', title: 'New' }).puts[0]!.id;
    const second = act(rows, createTask, { listId: 'l1', title: 'New' }).puts[0]!.id;
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('makes no task for an empty title, and trims the title', () => {
    const { rows } = standard();
    expect(act(rows, createTask, { listId: 'l1', title: '' }).puts).toEqual([]);
    expect(act(rows, createTask, { listId: 'l1', title: '   \n\t ' }).puts).toEqual([]);
    const result = act(rows, createTask, { listId: 'l1', title: '  Buy milk  ', id: 'n' });
    expect(task(result.rows, 'n').title).toBe('Buy milk');
  });

  test('cuts a title and notes that are too long', () => {
    const { rows } = standard();
    const result = act(rows, createTask, { listId: 'l1', title: 'x'.repeat(5000), notes: 'y'.repeat(20000), id: 'n' });
    expect(task(result.rows, 'n').title).toHaveLength(LIMITS.title);
    expect(task(result.rows, 'n').notes).toHaveLength(LIMITS.notes);
  });

  test('makes no task for a list that is not there, a deleted list, or an id that is in use', () => {
    const w = standard();
    w.list('gone', { deleted: true });
    expect(act(w.rows, createTask, { listId: 'nope', title: 'New' }).puts).toEqual([]);
    expect(act(w.rows, createTask, { listId: 'gone', title: 'New' }).puts).toEqual([]);
    expect(act(w.rows, createTask, { listId: 'l1', title: 'New', id: 'a' }).puts).toEqual([]);
  });

  test('the first task of an empty list', () => {
    const { rows } = standard();
    const result = act(rows, createTask, { listId: 'l2', title: 'New', id: 'n' });
    expect(shown(result.rows, 'l2')).toEqual(['n']);
    expect(task(result.rows, 'n').pos).toBe('a0');
  });

  test('after a top-level task: directly below it and its subtasks', () => {
    const { rows } = standard();
    expect(shown(act(rows, createTask, { listId: 'l1', title: 'New', id: 'n', position: { after: 'a' } }).rows)).toEqual([
      'a', 'n', 'b', '  b1', '  b2', 'c',
    ]);
    expect(shown(act(rows, createTask, { listId: 'l1', title: 'New', id: 'n', position: { after: 'b' } }).rows)).toEqual([
      'a', 'b', '  b1', '  b2', 'n', 'c',
    ]);
    expect(shown(act(rows, createTask, { listId: 'l1', title: 'New', id: 'n', position: { after: 'c' } }).rows)).toEqual([
      'a', 'b', '  b1', '  b2', 'c', 'n',
    ]);
  });

  test('after a subtask: a new subtask of the same parent', () => {
    const { rows } = standard();
    const first = act(rows, createTask, { listId: 'l1', title: 'New', id: 'n', position: { after: 'b1' } });
    expect(shown(first.rows)).toEqual(['a', 'b', '  b1', '  n', '  b2', 'c']);
    expect(task(first.rows, 'n').parentId).toBe('b');
    const last = act(rows, createTask, { listId: 'l1', title: 'New', id: 'n', position: { after: 'b2' } });
    expect(shown(last.rows)).toEqual(['a', 'b', '  b1', '  b2', '  n', 'c']);
  });

  test('after a task that is not in the list: at the top', () => {
    const w = standard();
    w.task('x', { listId: 'l2' });
    for (const after of ['x', 'nope']) {
      const result = act(w.rows, createTask, { listId: 'l1', title: 'New', id: 'n', position: { after } });
      expect(shown(result.rows)).toEqual(['n', 'a', 'b', '  b1', '  b2', 'c']);
    }
  });

  test('as the last subtask of a parent', () => {
    const { rows } = standard();
    const result = act(rows, createTask, { listId: 'l1', title: 'New', id: 'n', position: { parentId: 'b', at: 'end' } });
    expect(shown(result.rows)).toEqual(['a', 'b', '  b1', '  b2', '  n', 'c']);
    const firstChild = act(rows, createTask, { listId: 'l1', title: 'New', id: 'n', position: { parentId: 'a', at: 'end' } });
    expect(shown(firstChild.rows)).toEqual(['a', '  n', 'b', '  b1', '  b2', 'c']);
    expect(task(firstChild.rows, 'n').pos).toBe('a0');
  });

  test('makes no subtask for a parent that cannot have one', () => {
    const w = standard();
    w.task('x', { listId: 'l2' });
    w.task('done', { completed: true, completedAt: 1 });
    w.task('gone', { deleted: true });
    for (const parentId of ['b1', 'x', 'done', 'gone', 'nope']) {
      expect(act(w.rows, createTask, { listId: 'l1', title: 'New', position: { parentId, at: 'end' } }).puts).toEqual([]);
    }
  });

  test('a parent that lost its own parent can get a subtask, and lets go of the old parent', () => {
    const w = standard();
    w.task('orphan', { parentId: 'nope' });
    const result = act(w.rows, createTask, { listId: 'l1', title: 'New', id: 'n', position: { parentId: 'orphan', at: 'end' } });
    expect(task(result.rows, 'orphan').parentId).toBeNull();
    expect(shown(result.rows)).toEqual(['a', 'b', '  b1', '  b2', 'c', 'orphan', '  n']);
  });

  test('sets the optional fields', () => {
    const { rows } = standard();
    const result = act(rows, createTask, {
      listId: 'l1',
      title: 'New',
      id: 'n',
      notes: 'Details',
      due: '2026-10-09',
      time: '14:30',
      deadline: '2026-10-20',
      starred: true,
    });
    expect(task(result.rows, 'n')).toMatchObject({
      notes: 'Details',
      due: '2026-10-09',
      time: '14:30',
      deadline: '2026-10-20',
      starred: true,
      starredAt: NOW,
      repeat: null,
    });
  });

  test('a time with no date gets today, and values that are not valid are dropped', () => {
    const { rows } = standard();
    expect(task(act(rows, createTask, { listId: 'l1', title: 'New', id: 'n', time: '09:00' }).rows, 'n')).toMatchObject({
      due: TODAY,
      time: '09:00',
    });
    const bad = act(rows, createTask, { listId: 'l1', title: 'New', id: 'n', due: '2026-02-30', time: '25:00', deadline: 'soon' });
    expect(task(bad.rows, 'n')).toMatchObject({ due: null, time: null, deadline: null });
  });

  test('a repeat rule sets the date to its first date', () => {
    const { rows } = standard();
    const friday: RepeatRule = { every: 1, unit: 'week', weekdays: [5], start: TODAY, end: { type: 'never' } };
    const result = act(rows, createTask, { listId: 'l1', title: 'New', id: 'n', repeat: friday, due: '2026-12-01' });
    expect(task(result.rows, 'n')).toMatchObject({ repeat: friday, due: '2026-10-09', repeatCount: 0, hiddenUntil: null });
  });

  test('a subtask cannot repeat, and a rule that is not valid is dropped', () => {
    const { rows } = standard();
    const sub = act(rows, createTask, { listId: 'l1', title: 'New', id: 'n', repeat: DAILY, position: { parentId: 'a', at: 'end' } });
    expect(task(sub.rows, 'n').repeat).toBeNull();
    const bad = act(rows, createTask, { listId: 'l1', title: 'New', id: 'n', repeat: { ...DAILY, every: 0 } });
    expect(task(bad.rows, 'n').repeat).toBeNull();
  });

  test('between two tasks with the same key: the task after the gap gets a new key', () => {
    const w = world();
    w.list('l1');
    w.task('a', { pos: 'a0' });
    w.task('b', { pos: 'a0' });
    w.task('c', { pos: 'a1' });
    const result = act(w.rows, createTask, { listId: 'l1', title: 'New', id: 'n', position: { after: 'a' } });
    expect(shown(result.rows)).toEqual(['a', 'n', 'b', 'c']);
    expect(result.puts.map((put) => put.id)).toEqual(['n', 'b']);
    const keys = ['a', 'n', 'b', 'c'].map((id) => task(result.rows, id).pos);
    expect(new Set(keys).size).toBe(4);
    expect([...keys].sort()).toEqual(keys);
  });

  test('keys that are not from the scheme: all siblings get new keys', () => {
    const w = world();
    w.list('l1');
    w.task('a', { pos: '!' });
    w.task('b', { pos: '~~' });
    const result = act(w.rows, createTask, { listId: 'l1', title: 'New', id: 'n', position: { after: 'a' } });
    expect(shown(result.rows)).toEqual(['a', 'n', 'b']);
    expect(['a', 'n', 'b'].map((id) => task(result.rows, id).pos)).toEqual(['a0', 'a1', 'a2']);
  });

  test('300 tasks, each below the task before it, keep short keys and the order', () => {
    const w = world();
    w.list('l1');
    w.task('first');
    w.task('last');
    let rows = w.rows;
    let above = 'first';
    const expected = ['first'];
    for (let i = 0; i < 300; i++) {
      const result = act(rows, createTask, { listId: 'l1', title: 't', id: `t${i}`, position: { after: above } });
      rows = result.rows;
      above = `t${i}`;
      expected.push(above);
      const longest = Math.max(...[...rows.tasks.values()].map((each) => each.pos.length));
      if (longest > 40) throw new Error(`a key of ${longest} characters after ${i} tasks`);
    }
    expect(shown(rows)).toEqual([...expected, 'last']);
    expect(new Set([...rows.tasks.values()].map((each) => each.pos)).size).toBe(302);
  });

  test('100 tasks at the top keep short keys and the order', () => {
    const w = world();
    w.list('l1');
    const rows = w.rows;
    for (let i = 0; i < 100; i++) applyPuts(rows, createTask({ rows, now: NOW, today: TODAY, me: ME, locale: LOCALE }, { listId: 'l1', title: 't', id: `t${i}` }).puts);
    expect(shown(rows)).toEqual(Array.from({ length: 100 }, (_, i) => `t${99 - i}`));
    expect(Math.max(...[...rows.tasks.values()].map((each) => each.pos.length))).toBeLessThanOrEqual(3);
  });
});

describe('updateTask', () => {
  test('changes the title and the notes', () => {
    const { rows } = standard();
    const result = act(rows, updateTask, { id: 'a', title: 'Alpha', notes: 'More' });
    expect(result.message).toBeNull();
    expect(result.puts).toEqual([{ kind: 'task', id: 'a', fields: { title: 'Alpha', notes: 'More' } }]);
    expect(result.undo).toEqual([{ kind: 'task', id: 'a', fields: { title: 'a', notes: '' } }]);
  });

  test('an empty title keeps the old title', () => {
    const { rows } = standard();
    expect(act(rows, updateTask, { id: 'a', title: '' }).puts).toEqual([]);
    expect(act(rows, updateTask, { id: 'a', title: '   ' }).puts).toEqual([]);
    expect(act(rows, updateTask, { id: 'a', title: ' ', notes: 'More' }).puts).toEqual([
      { kind: 'task', id: 'a', fields: { notes: 'More' } },
    ]);
  });

  test('keeps the title as typed, so a space at the end stays while the person types', () => {
    const { rows } = standard();
    expect(task(act(rows, updateTask, { id: 'a', title: 'Buy ' }).rows, 'a').title).toBe('Buy ');
  });

  test('cuts text that is too long', () => {
    const { rows } = standard();
    const result = act(rows, updateTask, { id: 'a', title: 'x'.repeat(3000), notes: 'y'.repeat(9000) });
    expect(task(result.rows, 'a').title).toHaveLength(LIMITS.title);
    expect(task(result.rows, 'a').notes).toHaveLength(LIMITS.notes);
  });

  test('gives no put when no value changes', () => {
    const { rows } = standard();
    expect(act(rows, updateTask, { id: 'a', title: 'a', notes: '' }).puts).toEqual([]);
    expect(act(rows, updateTask, { id: 'a' }).puts).toEqual([]);
  });

  test('sets and removes the deadline', () => {
    const w = standard();
    w.task('d', { deadline: '2026-10-20' });
    expect(act(w.rows, updateTask, { id: 'a', deadline: '2026-10-09' }).puts).toEqual([
      { kind: 'task', id: 'a', fields: { deadline: '2026-10-09' } },
    ]);
    expect(task(act(w.rows, updateTask, { id: 'd', deadline: null }).rows, 'd').deadline).toBeNull();
    expect(act(w.rows, updateTask, { id: 'd', deadline: '2026-13-01' }).puts).toEqual([]);
  });

  test('a date or a time follows the rules of setDate', () => {
    const w = standard();
    w.task('d', { due: '2026-10-09', time: '08:00' });
    expect(task(act(w.rows, updateTask, { id: 'a', time: '09:00' }).rows, 'a')).toMatchObject({ due: TODAY, time: '09:00' });
    expect(task(act(w.rows, updateTask, { id: 'd', due: '2026-10-10' }).rows, 'd')).toMatchObject({ due: '2026-10-10', time: '08:00' });
    expect(task(act(w.rows, updateTask, { id: 'd', time: null }).rows, 'd')).toMatchObject({ due: '2026-10-09', time: null });
    expect(task(act(w.rows, updateTask, { id: 'd', due: null }).rows, 'd')).toMatchObject({ due: null, time: null });
  });

  test('gives no put for a task that is not there or is deleted', () => {
    const w = standard();
    w.task('gone', { deleted: true });
    expect(act(w.rows, updateTask, { id: 'nope', title: 'x' }).puts).toEqual([]);
    expect(act(w.rows, updateTask, { id: 'gone', title: 'x' }).puts).toEqual([]);
  });
});

describe('setDate', () => {
  test('sets the date and the time', () => {
    const { rows } = standard();
    const result = act(rows, setDate, { id: 'a', due: '2026-10-09', time: '14:30' });
    expect(result.message).toBeNull();
    expect(result.puts).toEqual([{ kind: 'task', id: 'a', fields: { due: '2026-10-09', time: '14:30' } }]);
    expect(result.undo).toEqual([{ kind: 'task', id: 'a', fields: { due: null, time: null } }]);
  });

  test('with no time in the intent, the task has no time', () => {
    const w = standard();
    w.task('d', { due: '2026-10-09', time: '08:00' });
    expect(task(act(w.rows, setDate, { id: 'd', due: '2026-10-12' }).rows, 'd')).toMatchObject({ due: '2026-10-12', time: null });
  });

  test('a time with no date sets the date to today', () => {
    const { rows } = standard();
    expect(task(act(rows, setDate, { id: 'a', due: null, time: '09:00' }).rows, 'a')).toMatchObject({ due: TODAY, time: '09:00' });
  });

  test('no date removes the date and the time', () => {
    const w = standard();
    w.task('d', { due: '2026-10-09', time: '08:00' });
    expect(act(w.rows, setDate, { id: 'd', due: null }).puts).toEqual([{ kind: 'task', id: 'd', fields: { due: null, time: null } }]);
  });

  test('a subtask can have a date', () => {
    const { rows } = standard();
    expect(task(act(rows, setDate, { id: 'b1', due: '2026-10-09' }).rows, 'b1').due).toBe('2026-10-09');
  });

  test('gives no put for a value that is not valid or a task that is not there', () => {
    const { rows } = standard();
    expect(act(rows, setDate, { id: 'a', due: '2026-02-30' }).puts).toEqual([]);
    expect(act(rows, setDate, { id: 'a', due: '2026-10-09', time: '9am' }).puts).toEqual([]);
    expect(act(rows, setDate, { id: 'nope', due: '2026-10-09' }).puts).toEqual([]);
  });

  test('a repeating task keeps its rule with a new date, and stops the repeat with no date', () => {
    const w = standard();
    w.task('r', { repeat: DAILY, due: TODAY, repeatCount: 4 });
    expect(task(act(w.rows, setDate, { id: 'r', due: '2026-10-09' }).rows, 'r')).toMatchObject({ due: '2026-10-09', repeat: DAILY, repeatCount: 4 });
    expect(task(act(w.rows, setDate, { id: 'r', due: null }).rows, 'r')).toMatchObject({ due: null, repeat: null, repeatCount: 0 });
  });

  test('a resting task comes back on its new date', () => {
    const w = standard();
    w.task('r', { repeat: DAILY, due: '2026-10-07', hiddenUntil: '2026-10-07', lastDoneDue: TODAY, lastDoneAt: 5, repeatCount: 1 });
    const later = act(w.rows, setDate, { id: 'r', due: '2026-10-12' });
    expect(task(later.rows, 'r')).toMatchObject({ due: '2026-10-12', hiddenUntil: '2026-10-12' });
    expect(isResting({ task: task(later.rows, 'r'), today: TODAY })).toBe(true);
    const now = act(w.rows, setDate, { id: 'r', due: TODAY });
    expect(isResting({ task: task(now.rows, 'r'), today: TODAY })).toBe(false);
  });
});

describe('setRepeat', () => {
  const friday: RepeatRule = { every: 1, unit: 'week', weekdays: [5], start: TODAY, end: { type: 'never' } };

  test('sets the rule and sets the date to the first date of the rule', () => {
    const { rows } = standard();
    const result = act(rows, setRepeat, { id: 'a', rule: friday });
    expect(result.message).toBeNull();
    expect(result.puts).toEqual([{ kind: 'task', id: 'a', fields: { repeat: friday, due: '2026-10-09' } }]);
    expect(result.undo).toEqual([{ kind: 'task', id: 'a', fields: { repeat: null, due: null } }]);
  });

  test('a task with subtasks can repeat', () => {
    const { rows } = standard();
    const today: RepeatRule = { ...DAILY, start: TODAY };
    expect(task(act(rows, setRepeat, { id: 'b', rule: today }).rows, 'b')).toMatchObject({ repeat: today, due: TODAY });
  });

  test('a subtask cannot repeat', () => {
    const { rows } = standard();
    expect(act(rows, setRepeat, { id: 'b1', rule: DAILY }).puts).toEqual([]);
  });

  test('a subtask that lost its parent can repeat, and lets go of the old parent', () => {
    const w = standard();
    w.task('orphan', { parentId: 'nope' });
    expect(task(act(w.rows, setRepeat, { id: 'orphan', rule: DAILY }).rows, 'orphan')).toMatchObject({ repeat: DAILY, parentId: null });
  });

  test('gives no put for a rule that is not valid or a task that is not there', () => {
    const { rows } = standard();
    expect(act(rows, setRepeat, { id: 'a', rule: { ...DAILY, every: 0 } }).puts).toEqual([]);
    expect(act(rows, setRepeat, { id: 'a', rule: { ...DAILY, start: 'x' } }).puts).toEqual([]);
    expect(act(rows, setRepeat, { id: 'nope', rule: DAILY }).puts).toEqual([]);
  });

  test('null stops the repeat and keeps the date', () => {
    const w = standard();
    w.task('r', { repeat: DAILY, due: '2026-10-09', repeatCount: 3 });
    const result = act(w.rows, setRepeat, { id: 'r', rule: null });
    expect(task(result.rows, 'r')).toMatchObject({ repeat: null, due: '2026-10-09', repeatCount: 0 });
    expect(act(w.rows, setRepeat, { id: 'a', rule: null }).puts).toEqual([]);
  });

  test('a new rule starts the count again', () => {
    const w = standard();
    w.task('r', { repeat: DAILY, due: TODAY, repeatCount: 7 });
    expect(task(act(w.rows, setRepeat, { id: 'r', rule: friday }).rows, 'r')).toMatchObject({ repeat: friday, due: '2026-10-09', repeatCount: 0 });
  });

  test('a resting task rests until the first date of the new rule', () => {
    const w = standard();
    w.task('r', { repeat: DAILY, due: '2026-10-07', hiddenUntil: '2026-10-07', lastDoneDue: TODAY, lastDoneAt: 5, repeatCount: 1 });
    expect(task(act(w.rows, setRepeat, { id: 'r', rule: friday }).rows, 'r')).toMatchObject({ due: '2026-10-09', hiddenUntil: '2026-10-09' });
  });
});

describe('completeTask', () => {
  test('a normal task', () => {
    const { rows } = standard();
    const result = act(rows, completeTask, { id: 'a' });
    expect(result.message).toBe('Task completed');
    expect(result.puts).toEqual([{ kind: 'task', id: 'a', fields: { completed: true, completedAt: NOW, completedBy: ME } }]);
    expect(result.undo).toEqual([{ kind: 'task', id: 'a', fields: { completed: false, completedAt: null, completedBy: null } }]);
    expect(shown(result.rows)).toEqual(['b', '  b1', '  b2', 'c']);
    expect(completedIds(result.rows)).toEqual(['a']);
  });

  test('a parent completes its open subtasks too', () => {
    const { rows } = standard();
    const result = act(rows, completeTask, { id: 'b' });
    expect(result.message).toBe('3 tasks completed');
    expect(result.puts.map((put) => put.id)).toEqual(['b', 'b1', 'b2']);
    for (const id of ['b', 'b1', 'b2']) expect(task(result.rows, id)).toMatchObject({ completed: true, completedAt: NOW, completedBy: ME });
    expect(shown(result.rows)).toEqual(['a', 'c']);
    expect(completedIds(result.rows).sort()).toEqual(['b', 'b1', 'b2']);
  });

  test('a subtask that is completed already keeps its values, and is not counted', () => {
    const w = standard();
    w.task('b3', { parentId: 'b', completed: true, completedAt: 77, completedBy: OTHER });
    const result = act(w.rows, completeTask, { id: 'b' });
    expect(result.message).toBe('3 tasks completed');
    expect(task(result.rows, 'b3')).toMatchObject({ completedAt: 77, completedBy: OTHER });
  });

  test('a parent with one open subtask', () => {
    const w = standard();
    w.task('c1', { parentId: 'c' });
    expect(act(w.rows, completeTask, { id: 'c' }).message).toBe('2 tasks completed');
  });

  test('a subtask alone', () => {
    const { rows } = standard();
    const result = act(rows, completeTask, { id: 'b1' });
    expect(result.message).toBe('Task completed');
    expect(shown(result.rows)).toEqual(['a', 'b', '  b2', 'c']);
    expect(task(result.rows, 'b').completed).toBe(false);
  });

  test('gives no put for a task that is completed, deleted, or not there', () => {
    const w = standard();
    w.task('done', { completed: true, completedAt: 1, completedBy: ME });
    w.task('gone', { deleted: true });
    for (const id of ['done', 'gone', 'nope']) expect(act(w.rows, completeTask, { id }).puts).toEqual([]);
  });

  test('a subtask in a different list is not a subtask of the task', () => {
    const w = standard();
    w.task('far', { parentId: 'a', listId: 'l2' });
    const result = act(w.rows, completeTask, { id: 'a' });
    expect(result.message).toBe('Task completed');
    expect(task(result.rows, 'far').completed).toBe(false);
  });

  describe('a repeating task', () => {
    test('goes to its next date and rests until then', () => {
      const w = standard();
      w.task('r', { repeat: DAILY, due: TODAY, time: '09:00' });
      const result = act(w.rows, completeTask, { id: 'r' });
      expect(result.message).toBe('Task completed. It comes back on Wed 7 Oct');
      expect(result.puts).toEqual([
        {
          kind: 'task',
          id: 'r',
          fields: { lastDoneDue: TODAY, lastDoneAt: NOW, due: '2026-10-07', hiddenUntil: '2026-10-07', repeatCount: 1 },
        },
      ]);
      const after = task(result.rows, 'r');
      expect(after).toMatchObject({ completed: false, completedAt: null, repeat: DAILY, time: '09:00' });
      expect(isResting({ task: after, today: TODAY })).toBe(true);
      expect(shown(result.rows)).not.toContain('r');
      expect(completedIds(result.rows)).toEqual(['r']);
      // On the next date the same task is open again.
      expect(shown(result.rows, 'l1', '2026-10-07')).toContain('r');
      expect(completedIds(result.rows, 'l1', '2026-10-07')).toEqual([]);
    });

    test('a date in the past: the next date is after today', () => {
      const w = standard();
      w.task('r', { repeat: DAILY, due: '2026-10-03' });
      expect(task(act(w.rows, completeTask, { id: 'r' }).rows, 'r')).toMatchObject({
        lastDoneDue: '2026-10-03',
        due: '2026-10-07',
        hiddenUntil: '2026-10-07',
      });
      w.task('w', { repeat: WEEKLY, due: '2026-09-22' });
      expect(task(act(w.rows, completeTask, { id: 'w' }).rows, 'w').due).toBe('2026-10-13');
    });

    test('a date in the future: the next date is after that date', () => {
      const w = standard();
      w.task('r', { repeat: WEEKLY, due: '2026-10-13' });
      const result = act(w.rows, completeTask, { id: 'r' });
      expect(task(result.rows, 'r')).toMatchObject({ lastDoneDue: '2026-10-13', due: '2026-10-20', hiddenUntil: '2026-10-20' });
      expect(result.message).toBe('Task completed. It comes back on Tue 20 Oct');
    });

    test('a weekly task that is due today', () => {
      const w = standard();
      w.task('r', { repeat: WEEKLY, due: TODAY });
      expect(act(w.rows, completeTask, { id: 'r' }).message).toBe('Task completed. It comes back on Tue 13 Oct');
    });

    test('the message shows the year for a date in a different year', () => {
      const w = standard();
      w.task('r', { repeat: { every: 1, unit: 'year', start: TODAY, end: { type: 'never' } }, due: TODAY });
      expect(act(w.rows, completeTask, { id: 'r' }).message).toBe('Task completed. It comes back on Wed 6 Oct 2027');
    });

    test('with no date, the next date is after today', () => {
      const w = standard();
      w.task('r', { repeat: DAILY, due: null });
      expect(task(act(w.rows, completeTask, { id: 'r' }).rows, 'r')).toMatchObject({ lastDoneDue: null, due: '2026-10-07' });
    });

    test('an end date: the last date completes the task and stops the repeat', () => {
      const w = standard();
      w.task('last', { repeat: { ...DAILY, end: { type: 'on', date: TODAY } }, due: TODAY, repeatCount: 5 });
      const result = act(w.rows, completeTask, { id: 'last' });
      expect(result.message).toBe('Task completed');
      expect(task(result.rows, 'last')).toMatchObject({ repeat: null, completed: true, completedAt: NOW, completedBy: ME, due: TODAY });
      expect(completedIds(result.rows)).toEqual(['last']);
      // It is completed for good: it does not come back on the next day.
      expect(shown(result.rows, 'l1', '2026-10-07')).not.toContain('last');
    });

    test('an end date that the next date does not pass: the task goes on', () => {
      const w = standard();
      w.task('r', { repeat: { ...DAILY, end: { type: 'on', date: '2026-10-07' } }, due: TODAY });
      const result = act(w.rows, completeTask, { id: 'r' });
      expect(task(result.rows, 'r')).toMatchObject({ completed: false, due: '2026-10-07', hiddenUntil: '2026-10-07' });
      // The next completion is the last one.
      const last = act(result.rows, completeTask, { id: 'r' }, { today: '2026-10-07' });
      expect(task(last.rows, 'r')).toMatchObject({ completed: true, repeat: null });
    });

    test('an end count: the last occurrence completes the task and stops the repeat', () => {
      const rule: RepeatRule = { ...DAILY, end: { type: 'after', count: 3 } };
      const w = standard();
      w.task('second', { repeat: rule, due: TODAY, repeatCount: 1 });
      w.task('third', { repeat: rule, due: TODAY, repeatCount: 2 });
      const goesOn = act(w.rows, completeTask, { id: 'second' });
      expect(task(goesOn.rows, 'second')).toMatchObject({ completed: false, repeatCount: 2, hiddenUntil: '2026-10-07' });
      const ends = act(w.rows, completeTask, { id: 'third' });
      expect(ends.message).toBe('Task completed');
      expect(task(ends.rows, 'third')).toMatchObject({ completed: true, repeat: null });
    });

    test('an end count of 3 gives 3 completions', () => {
      const w = standard();
      w.task('r', { repeat: { ...DAILY, end: { type: 'after', count: 3 } }, due: TODAY });
      let rows = w.rows;
      const days = [TODAY, '2026-10-07', '2026-10-08'];
      days.forEach((today, i) => {
        expect(isOpen({ task: task(rows, 'r'), today })).toBe(true);
        const result = act(rows, completeTask, { id: 'r' }, { today });
        expect(task(result.rows, 'r').completed).toBe(i === 2);
        rows = result.rows;
      });
      expect(task(rows, 'r')).toMatchObject({ completed: true, repeat: null, due: '2026-10-08' });
    });

    test('the subtasks become open again, and hide with the resting parent', () => {
      const w = standard();
      w.task('r', { repeat: DAILY, due: TODAY });
      w.task('r1', { parentId: 'r', completed: true, completedAt: 5, completedBy: OTHER });
      w.task('r2', { parentId: 'r' });
      const result = act(w.rows, completeTask, { id: 'r' });
      expect(result.message).toBe('Task completed. It comes back on Wed 7 Oct');
      expect(result.puts.map((put) => put.id)).toEqual(['r', 'r1']);
      expect(task(result.rows, 'r1')).toMatchObject({ completed: false, completedAt: null, completedBy: null });
      expect(task(result.rows, 'r2').completed).toBe(false);
      expect(shown(result.rows)).toEqual(['a', 'b', '  b1', '  b2', 'c']);
      expect(completedIds(result.rows)).toEqual(['r']);
      expect(shown(result.rows, 'l1', '2026-10-07')).toEqual(['a', 'b', '  b1', '  b2', 'c', 'r', '  r1', '  r2']);
    });

    test('the last occurrence of a parent completes its subtasks', () => {
      const w = standard();
      w.task('r', { repeat: { ...DAILY, end: { type: 'on', date: TODAY } }, due: TODAY });
      w.task('r1', { parentId: 'r' });
      w.task('r2', { parentId: 'r' });
      const result = act(w.rows, completeTask, { id: 'r' });
      expect(result.message).toBe('3 tasks completed');
      for (const id of ['r', 'r1', 'r2']) expect(task(result.rows, id).completed).toBe(true);
    });

    test('a resting task cannot be completed again before its date', () => {
      const w = standard();
      w.task('r', { repeat: DAILY, due: TODAY });
      const first = act(w.rows, completeTask, { id: 'r' });
      expect(act(first.rows, completeTask, { id: 'r' }).puts).toEqual([]);
      const second = act(first.rows, completeTask, { id: 'r' }, { today: '2026-10-07', now: NOW + 86_400_000 });
      expect(task(second.rows, 'r')).toMatchObject({
        lastDoneDue: '2026-10-07',
        lastDoneAt: NOW + 86_400_000,
        due: '2026-10-08',
        hiddenUntil: '2026-10-08',
        repeatCount: 2,
      });
    });
  });
});

describe('uncompleteTask', () => {
  test('a completed task becomes open and goes to the top of its siblings', () => {
    const w = standard();
    w.task('done', { completed: true, completedAt: 5, completedBy: OTHER });
    const result = act(w.rows, uncompleteTask, { id: 'done' });
    expect(result.message).toBe('Task marked uncompleted');
    expect(task(result.rows, 'done')).toMatchObject({ completed: false, completedAt: null, completedBy: null });
    expect(shown(result.rows)).toEqual(['done', 'a', 'b', '  b1', '  b2', 'c']);
    expect(completedIds(result.rows)).toEqual([]);
  });

  test('a task that is at the top already keeps its key', () => {
    const w = world();
    w.list('l1');
    w.task('done', { completed: true, completedAt: 5, completedBy: ME });
    w.task('a');
    const result = act(w.rows, uncompleteTask, { id: 'done' });
    expect(result.puts).toEqual([{ kind: 'task', id: 'done', fields: { completed: false, completedAt: null, completedBy: null } }]);
    const alone = world();
    alone.list('l1');
    alone.task('only', { completed: true, completedAt: 5, completedBy: ME });
    expect(Object.keys(act(alone.rows, uncompleteTask, { id: 'only' }).puts[0]!.fields)).not.toContain('pos');
  });

  test('complete and then uncomplete gives the task back at the top', () => {
    const { rows } = standard();
    const done = act(rows, completeTask, { id: 'c' });
    const back = act(done.rows, uncompleteTask, { id: 'c' });
    expect(shown(back.rows)).toEqual(['c', 'a', 'b', '  b1', '  b2']);
  });

  test('the subtasks of a parent stay completed', () => {
    const { rows } = standard();
    const done = act(rows, completeTask, { id: 'b' });
    const back = act(done.rows, uncompleteTask, { id: 'b' });
    expect(back.message).toBe('Task marked uncompleted');
    expect(back.puts.map((put) => put.id)).toEqual(['b']);
    expect(shown(back.rows)).toEqual(['b', 'a', 'c']);
    expect(completedIds(back.rows).sort()).toEqual(['b1', 'b2']);
  });

  test('a subtask of an open parent goes back below its parent, at the top', () => {
    const w = standard();
    w.task('b3', { parentId: 'b', completed: true, completedAt: 5, completedBy: ME });
    const result = act(w.rows, uncompleteTask, { id: 'b3' });
    expect(shown(result.rows)).toEqual(['a', 'b', '  b3', '  b1', '  b2', 'c']);
    expect(task(result.rows, 'b3').parentId).toBe('b');
  });

  test('a subtask of a completed parent shows as a top-level task at the top', () => {
    const { rows } = standard();
    const done = act(rows, completeTask, { id: 'b' });
    const back = act(done.rows, uncompleteTask, { id: 'b2' });
    expect(shown(back.rows)).toEqual(['b2', 'a', 'c']);
    // When the parent opens later, the subtask is below it again.
    const parentBack = act(back.rows, uncompleteTask, { id: 'b' });
    expect(shown(parentBack.rows)).toEqual(['b', '  b2', 'a', 'c']);
  });

  test('a resting task goes back to the date that was completed', () => {
    const w = standard();
    const start = w.task('r', { repeat: DAILY, due: '2026-10-03', repeatCount: 2 });
    const done = act(w.rows, completeTask, { id: 'r' });
    const back = act(done.rows, uncompleteTask, { id: 'r' });
    expect(back.message).toBe('Task marked uncompleted');
    expect(back.puts).toEqual([
      { kind: 'task', id: 'r', fields: { due: '2026-10-03', hiddenUntil: null, lastDoneAt: null, lastDoneDue: null, repeatCount: 2 } },
    ]);
    expect(task(back.rows, 'r')).toEqual(start);
    expect(shown(back.rows)).toEqual(['a', 'b', '  b1', '  b2', 'c', 'r']);
  });

  test('the count of a resting task does not go below zero', () => {
    const w = standard();
    w.task('r', { repeat: DAILY, due: '2026-10-07', hiddenUntil: '2026-10-07', lastDoneDue: TODAY, lastDoneAt: 5, repeatCount: 0 });
    expect(task(act(w.rows, uncompleteTask, { id: 'r' }).rows, 'r')).toMatchObject({ repeatCount: 0, due: TODAY });
  });

  test('gives no put for an open task, a deleted task, or a task that is not there', () => {
    const w = standard();
    w.task('gone', { deleted: true, completed: true });
    // The rest of this task is over: its date is today.
    w.task('back', { repeat: DAILY, due: TODAY, hiddenUntil: TODAY, lastDoneDue: '2026-10-05', lastDoneAt: 5, repeatCount: 1 });
    for (const id of ['a', 'gone', 'nope', 'back']) expect(act(w.rows, uncompleteTask, { id }).puts).toEqual([]);
  });
});

describe('deleteTask', () => {
  test('a task with no subtasks', () => {
    const { rows } = standard();
    const result = act(rows, deleteTask, { id: 'a' });
    expect(result.message).toBe('Task deleted');
    expect(result.puts).toEqual([{ kind: 'task', id: 'a', fields: { deleted: true } }]);
    expect(shown(result.rows)).toEqual(['b', '  b1', '  b2', 'c']);
  });

  test('a task and its subtasks', () => {
    const w = standard();
    w.task('b3', { parentId: 'b', completed: true, completedAt: 5, completedBy: ME });
    const result = act(w.rows, deleteTask, { id: 'b' });
    expect(result.message).toBe('4 tasks deleted');
    expect(result.puts.map((put) => put.id)).toEqual(['b', 'b1', 'b2', 'b3']);
    expect(shown(result.rows)).toEqual(['a', 'c']);
    expect(completedIds(result.rows)).toEqual([]);
  });

  test('a parent with two subtasks gives the message for 3 tasks', () => {
    const { rows } = standard();
    expect(act(rows, deleteTask, { id: 'b' }).message).toBe('3 tasks deleted');
  });

  test('a subtask alone', () => {
    const { rows } = standard();
    const result = act(rows, deleteTask, { id: 'b1' });
    expect(result.message).toBe('Task deleted');
    expect(shown(result.rows)).toEqual(['a', 'b', '  b2', 'c']);
  });

  test('an open subtask of a completed parent stays, because it shows as its own task', () => {
    const { rows } = standard();
    const done = act(rows, completeTask, { id: 'b' });
    const open = act(done.rows, uncompleteTask, { id: 'b2' });
    const result = act(open.rows, deleteTask, { id: 'b' });
    expect(result.message).toBe('2 tasks deleted');
    expect(result.puts.map((put) => put.id)).toEqual(['b', 'b1']);
    expect(shown(result.rows)).toEqual(['b2', 'a', 'c']);
  });

  test('the undo has all fields, so it works after the device dropped the rows', () => {
    const { rows } = standard();
    const result = act(rows, deleteTask, { id: 'b' });
    for (const put of result.undo) expect(Object.keys(put.fields).sort()).toEqual(TASK_FIELDS);
    const dropped = copy(result.rows);
    for (const id of ['b', 'b1', 'b2']) dropped.tasks.delete(id);
    applyPuts(dropped, result.undo);
    expect(dropped.tasks).toEqual(rows.tasks);
  });

  test('gives no put for a task that is deleted or not there', () => {
    const w = standard();
    w.task('gone', { deleted: true });
    expect(act(w.rows, deleteTask, { id: 'gone' }).puts).toEqual([]);
    expect(act(w.rows, deleteTask, { id: 'nope' }).puts).toEqual([]);
  });
});

describe('moveTask', () => {
  /** l1 has a, b (b1, b2), c, d. l2 has x (x1) and y. */
  function board() {
    const w = standard();
    w.task('d');
    w.task('x', { listId: 'l2' });
    w.task('x1', { listId: 'l2', parentId: 'x' });
    w.task('y', { listId: 'l2' });
    return w;
  }

  describe('a new place in the same list', () => {
    test('before a sibling', () => {
      const { rows } = board();
      const result = act(rows, moveTask, { id: 'd', listId: 'l1', parentId: null, beforeId: 'a' });
      expect(result.message).toBeNull();
      expect(result.puts.map((put) => put.id)).toEqual(['d']);
      expect(Object.keys(result.puts[0]!.fields)).toEqual(['pos']);
      expect(shown(result.rows)).toEqual(['d', 'a', 'b', '  b1', '  b2', 'c']);
      expect(shown(act(rows, moveTask, { id: 'd', beforeId: 'c' }).rows)).toEqual(['a', 'b', '  b1', '  b2', 'd', 'c']);
    });

    test('after a sibling', () => {
      const { rows } = board();
      expect(shown(act(rows, moveTask, { id: 'a', afterId: 'c' }).rows)).toEqual(['b', '  b1', '  b2', 'c', 'a', 'd']);
      expect(shown(act(rows, moveTask, { id: 'd', afterId: 'a' }).rows)).toEqual(['a', 'd', 'b', '  b1', '  b2', 'c']);
    });

    test('to the end, with no neighbour', () => {
      const { rows } = board();
      expect(shown(act(rows, moveTask, { id: 'a' }).rows)).toEqual(['b', '  b1', '  b2', 'c', 'd', 'a']);
    });

    test('a parent keeps its subtasks', () => {
      const { rows } = board();
      const result = act(rows, moveTask, { id: 'b', afterId: 'd' });
      expect(result.puts.map((put) => put.id)).toEqual(['b']);
      expect(shown(result.rows)).toEqual(['a', 'c', 'd', 'b', '  b1', '  b2']);
    });

    test('a subtask among its siblings', () => {
      const { rows } = board();
      expect(shown(act(rows, moveTask, { id: 'b2', parentId: 'b', beforeId: 'b1' }).rows)).toEqual(['a', 'b', '  b2', '  b1', 'c', 'd']);
      expect(shown(act(rows, moveTask, { id: 'b1', parentId: 'b', afterId: 'b2' }).rows)).toEqual(['a', 'b', '  b2', '  b1', 'c', 'd']);
      expect(shown(act(rows, moveTask, { id: 'b1', parentId: 'b' }).rows)).toEqual(['a', 'b', '  b2', '  b1', 'c', 'd']);
    });

    test('with no parent in the intent, a subtask keeps its parent', () => {
      const { rows } = board();
      expect(shown(act(rows, moveTask, { id: 'b2', beforeId: 'b1' }).rows)).toEqual(['a', 'b', '  b2', '  b1', 'c', 'd']);
      expect(shown(act(rows, moveTask, { id: 'b1', afterId: 'b2' }).rows)).toEqual(['a', 'b', '  b2', '  b1', 'c', 'd']);
      expect(shown(act(rows, moveTask, { id: 'b1' }).rows)).toEqual(['a', 'b', '  b2', '  b1', 'c', 'd']);
      expect(act(rows, moveTask, { id: 'b2' }).puts).toEqual([]);
      // null makes a top-level task.
      expect(shown(act(rows, moveTask, { id: 'b1', parentId: null }).rows)).toEqual(['a', 'b', '  b2', 'c', 'd', 'b1']);
    });

    test('the same place gives no puts', () => {
      const { rows } = board();
      const same = [
        { id: 'a', beforeId: 'b' },
        { id: 'b', afterId: 'a' },
        { id: 'b', beforeId: 'c' },
        { id: 'd' },
        { id: 'd', afterId: 'c' },
        { id: 'b1', parentId: 'b', beforeId: 'b2' },
        { id: 'b2', parentId: 'b' },
        { id: 'b2', parentId: 'b', afterId: 'b1' },
        { id: 'b1', parentId: 'b', afterId: 'b' },
        { id: 'a', listId: 'l1', parentId: null, beforeId: 'b', afterId: null },
      ];
      for (const intent of same) expect(act(rows, moveTask, intent).puts, JSON.stringify(intent)).toEqual([]);
    });

    test('with the two neighbours, as a drag gives them', () => {
      const { rows } = board();
      expect(shown(act(rows, moveTask, { id: 'd', parentId: null, afterId: 'a', beforeId: 'b' }).rows)).toEqual([
        'a', 'd', 'b', '  b1', '  b2', 'c',
      ]);
      // A neighbour that is not a sibling is ignored when the other one is.
      expect(shown(act(rows, moveTask, { id: 'd', parentId: null, afterId: 'a', beforeId: 'b1' }).rows)).toEqual([
        'a', 'd', 'b', '  b1', '  b2', 'c',
      ]);
    });

    test('at the top level, after a subtask is after its parent and all subtasks of that parent', () => {
      const { rows } = board();
      expect(shown(act(rows, moveTask, { id: 'a', parentId: null, afterId: 'b1' }).rows)).toEqual(['b', '  b1', '  b2', 'a', 'c', 'd']);
    });

    test('completed tasks keep their place among the keys', () => {
      const w = world();
      w.list('l1');
      w.task('a');
      w.task('done', { completed: true, completedAt: 5, completedBy: ME });
      w.task('b');
      w.task('c');
      const result = act(w.rows, moveTask, { id: 'c', afterId: 'a' });
      expect(shown(result.rows)).toEqual(['a', 'c', 'b']);
      const back = act(result.rows, uncompleteTask, { id: 'done' });
      expect(shown(back.rows)).toEqual(['done', 'a', 'c', 'b']);
    });

    test('between two tasks with the same key', () => {
      const w = world();
      w.list('l1');
      w.task('a', { pos: 'a0' });
      w.task('b', { pos: 'a0' });
      w.task('c', { pos: 'a0' });
      w.task('d', { pos: 'a1' });
      const result = act(w.rows, moveTask, { id: 'd', afterId: 'a' });
      expect(shown(result.rows)).toEqual(['a', 'd', 'b', 'c']);
      // The key of d is free after the equal keys, so d keeps it and the two tasks after the gap move.
      expect(result.puts.map((put) => put.id).sort()).toEqual(['b', 'c']);
      const keys = ['a', 'd', 'b', 'c'].map((id) => task(result.rows, id).pos);
      expect(new Set(keys).size).toBe(4);
      expect(shown(act(w.rows, moveTask, { id: 'a', afterId: 'b' }).rows)).toEqual(['b', 'a', 'c', 'd']);
    });
  });

  describe('to a different list', () => {
    test('a task goes to the end of the other list', () => {
      const { rows } = board();
      const result = act(rows, moveTask, { id: 'a', listId: 'l2' });
      expect(result.message).toBeNull();
      expect(shown(result.rows)).toEqual(['b', '  b1', '  b2', 'c', 'd']);
      expect(shown(result.rows, 'l2')).toEqual(['x', '  x1', 'y', 'a']);
      expect(task(result.rows, 'a')).toMatchObject({ listId: 'l2', parentId: null });
    });

    test('the subtasks go with the task', () => {
      const { rows } = board();
      const result = act(rows, moveTask, { id: 'b', listId: 'l2', beforeId: 'y' });
      expect(result.puts.map((put) => put.id)).toEqual(['b', 'b1', 'b2']);
      expect(shown(result.rows)).toEqual(['a', 'c', 'd']);
      expect(shown(result.rows, 'l2')).toEqual(['x', '  x1', 'b', '  b1', '  b2', 'y']);
      expect(task(result.rows, 'b1')).toMatchObject({ listId: 'l2', parentId: 'b', pos: task(rows, 'b1').pos });
    });

    test('completed subtasks go with the task too', () => {
      const w = board();
      w.task('b3', { parentId: 'b', completed: true, completedAt: 5, completedBy: ME });
      const result = act(w.rows, moveTask, { id: 'b', listId: 'l2' });
      expect(task(result.rows, 'b3')).toMatchObject({ listId: 'l2', parentId: 'b', completed: true });
      expect(completedIds(result.rows)).toEqual([]);
      expect(completedIds(result.rows, 'l2')).toEqual(['b3']);
    });

    test('to an empty list, and to the first place', () => {
      const w = board();
      w.list('l3');
      expect(shown(act(w.rows, moveTask, { id: 'b', listId: 'l3' }).rows, 'l3')).toEqual(['b', '  b1', '  b2']);
      expect(shown(act(w.rows, moveTask, { id: 'a', listId: 'l2', beforeId: 'x' }).rows, 'l2')).toEqual(['a', 'x', '  x1', 'y']);
    });

    test('a subtask alone becomes a top-level task there', () => {
      const { rows } = board();
      const result = act(rows, moveTask, { id: 'b1', listId: 'l2', afterId: 'x' });
      expect(shown(result.rows)).toEqual(['a', 'b', '  b2', 'c', 'd']);
      expect(shown(result.rows, 'l2')).toEqual(['x', '  x1', 'b1', 'y']);
      expect(task(result.rows, 'b1').parentId).toBeNull();
    });

    test('as a subtask of a task there, with its own subtasks after it', () => {
      const { rows } = board();
      const result = act(rows, moveTask, { id: 'b', listId: 'l2', parentId: 'x' });
      expect(shown(result.rows)).toEqual(['a', 'c', 'd']);
      expect(shown(result.rows, 'l2')).toEqual(['x', '  x1', '  b', '  b1', '  b2', 'y']);
    });
  });

  describe('to make a subtask', () => {
    test('at the end of the subtasks of the parent', () => {
      const { rows } = board();
      const result = act(rows, moveTask, { id: 'c', parentId: 'b' });
      expect(shown(result.rows)).toEqual(['a', 'b', '  b1', '  b2', '  c', 'd']);
      expect(task(result.rows, 'c')).toMatchObject({ parentId: 'b', listId: 'l1' });
    });

    test('at a place among the subtasks', () => {
      const { rows } = board();
      expect(shown(act(rows, moveTask, { id: 'c', parentId: 'b', beforeId: 'b1' }).rows)).toEqual(['a', 'b', '  c', '  b1', '  b2', 'd']);
      expect(shown(act(rows, moveTask, { id: 'c', parentId: 'b', afterId: 'b1' }).rows)).toEqual(['a', 'b', '  b1', '  c', '  b2', 'd']);
      expect(shown(act(rows, moveTask, { id: 'c', parentId: 'b', beforeId: 'b2' }).rows)).toEqual(['a', 'b', '  b1', '  c', '  b2', 'd']);
    });

    test('after the parent row itself is the first subtask', () => {
      const { rows } = board();
      expect(shown(act(rows, moveTask, { id: 'c', parentId: 'b', afterId: 'b' }).rows)).toEqual(['a', 'b', '  c', '  b1', '  b2', 'd']);
      expect(shown(act(rows, moveTask, { id: 'c', parentId: 'a', afterId: 'a' }).rows)).toEqual(['a', '  c', 'b', '  b1', '  b2', 'd']);
    });

    test('the first subtask of a task with no subtasks', () => {
      const { rows } = board();
      expect(shown(act(rows, moveTask, { id: 'd', parentId: 'a' }).rows)).toEqual(['a', '  d', 'b', '  b1', '  b2', 'c']);
    });

    test('a subtask goes to a different parent', () => {
      const { rows } = board();
      expect(shown(act(rows, moveTask, { id: 'b1', parentId: 'a' }).rows)).toEqual(['a', '  b1', 'b', '  b2', 'c', 'd']);
    });

    test('a parent dropped below a different task: its subtasks follow as siblings', () => {
      const w = board();
      w.task('c1', { parentId: 'c' });
      const end = act(w.rows, moveTask, { id: 'b', parentId: 'c' });
      expect(end.puts.map((put) => put.id)).toEqual(['b', 'b1', 'b2']);
      expect(shown(end.rows)).toEqual(['a', 'c', '  c1', '  b', '  b1', '  b2', 'd']);
      for (const id of ['b', 'b1', 'b2']) expect(task(end.rows, id).parentId).toBe('c');
      const first = act(w.rows, moveTask, { id: 'b', parentId: 'c', beforeId: 'c1' });
      expect(shown(first.rows)).toEqual(['a', 'c', '  b', '  b1', '  b2', '  c1', 'd']);
    });

    test('a parent that lost its own parent lets go of the old parent', () => {
      const w = board();
      w.task('orphan', { parentId: 'nope' });
      const result = act(w.rows, moveTask, { id: 'a', parentId: 'orphan' });
      expect(task(result.rows, 'orphan').parentId).toBeNull();
      expect(shown(result.rows)).toEqual(['b', '  b1', '  b2', 'c', 'd', 'orphan', '  a']);
    });
  });

  describe('a move that is not permitted gives no puts', () => {
    test.each([
      ['a task that is not there', { id: 'nope', listId: 'l1' }],
      ['a deleted task', { id: 'gone', listId: 'l1' }],
      ['a list that is not there', { id: 'a', listId: 'nope' }],
      ['a deleted list', { id: 'a', listId: 'dead' }],
      ['a task as its own parent', { id: 'a', parentId: 'a' }],
      ['a parent below its own subtask', { id: 'b', parentId: 'b1' }],
      ['a subtask as a parent', { id: 'a', parentId: 'b1' }],
      ['a parent that is not there', { id: 'a', parentId: 'nope' }],
      ['a deleted parent', { id: 'a', parentId: 'gone' }],
      ['a parent in a different list than the target', { id: 'a', listId: 'l1', parentId: 'x' }],
      ['a parent in the old list when the target is a different list', { id: 'a', listId: 'l2', parentId: 'b' }],
      ['a completed parent', { id: 'a', parentId: 'done' }],
      ['a resting parent', { id: 'a', parentId: 'resting' }],
      ['a repeating task below a parent', { id: 'rep', parentId: 'a' }],
      ['before a task that is not a sibling', { id: 'a', beforeId: 'b1' }],
      ['before a task of a different list', { id: 'a', beforeId: 'x' }],
      ['after a task that is not there', { id: 'a', afterId: 'nope' }],
      ['among subtasks, after a top-level task', { id: 'a', parentId: 'b', afterId: 'c' }],
      ['before itself', { id: 'a', beforeId: 'a' }],
      ['after itself', { id: 'a', afterId: 'a' }],
      ['a parent after its own subtask at the top level', { id: 'b', afterId: 'b1' }],
    ])('%s', (_name, intent) => {
      const w = board();
      w.list('dead', { deleted: true });
      w.task('gone', { deleted: true });
      w.task('done', { completed: true, completedAt: 5, completedBy: ME });
      w.task('resting', { repeat: DAILY, due: '2026-10-07', hiddenUntil: '2026-10-07', lastDoneDue: TODAY, lastDoneAt: 5, repeatCount: 1 });
      w.task('rep', { repeat: DAILY, due: TODAY });
      const result = act(w.rows, moveTask, intent);
      expect(result).toMatchObject({ puts: [], undo: [], message: null });
    });
  });

  test('a repeating task can move between lists and places', () => {
    const w = board();
    w.task('rep', { repeat: DAILY, due: TODAY });
    expect(shown(act(w.rows, moveTask, { id: 'rep', beforeId: 'a' }).rows)[0]).toBe('rep');
    expect(shown(act(w.rows, moveTask, { id: 'rep', listId: 'l2' }).rows, 'l2')).toEqual(['x', '  x1', 'y', 'rep']);
  });

  test('a task that shows at the top level because its parent is gone becomes a real top-level task', () => {
    const w = board();
    w.task('orphan', { parentId: 'nope' });
    const result = act(w.rows, moveTask, { id: 'orphan', beforeId: 'a' });
    expect(task(result.rows, 'orphan').parentId).toBeNull();
    expect(shown(result.rows)[0]).toBe('orphan');
  });
});

describe('indentTask', () => {
  test('the task becomes the last subtask of the task above it', () => {
    const { rows } = standard();
    const result = act(rows, indentTask, { id: 'c' });
    expect(result.message).toBeNull();
    expect(shown(result.rows)).toEqual(['a', 'b', '  b1', '  b2', '  c']);
    expect(shown(act(rows, indentTask, { id: 'b' }).rows)).toEqual(['a', '  b', '  b1', '  b2', 'c']);
  });

  test('a task with subtasks: the subtasks follow as siblings', () => {
    const { rows } = standard();
    const result = act(rows, indentTask, { id: 'b' });
    for (const id of ['b', 'b1', 'b2']) expect(task(result.rows, id).parentId).toBe('a');
  });

  test('the task above is the open top-level task above it on the screen', () => {
    const w = world();
    w.list('l1');
    w.task('a');
    w.task('done', { completed: true, completedAt: 5, completedBy: ME });
    w.task('resting', { repeat: DAILY, due: '2026-10-07', hiddenUntil: '2026-10-07', lastDoneAt: 5, repeatCount: 1 });
    w.task('b');
    expect(shown(act(w.rows, indentTask, { id: 'b' }).rows)).toEqual(['a', '  b']);
  });

  test('not possible for the first task, a subtask, a repeating task, or a completed task', () => {
    const w = standard();
    w.task('rep', { repeat: DAILY, due: TODAY });
    w.task('done', { completed: true, completedAt: 5, completedBy: ME });
    for (const id of ['a', 'b1', 'b2', 'rep', 'done', 'nope']) expect(act(w.rows, indentTask, { id }).puts).toEqual([]);
  });

  test('the first open task cannot indent below a completed task', () => {
    const w = world();
    w.list('l1');
    w.task('done', { completed: true, completedAt: 5, completedBy: ME });
    w.task('a');
    expect(act(w.rows, indentTask, { id: 'a' }).puts).toEqual([]);
  });
});

describe('unindentTask', () => {
  test('the subtask becomes a top-level task directly after its old parent', () => {
    const { rows } = standard();
    const result = act(rows, unindentTask, { id: 'b1' });
    expect(result.message).toBeNull();
    expect(shown(result.rows)).toEqual(['a', 'b', '  b2', 'b1', 'c']);
    expect(task(result.rows, 'b1').parentId).toBeNull();
    expect(shown(act(rows, unindentTask, { id: 'b2' }).rows)).toEqual(['a', 'b', '  b1', 'b2', 'c']);
  });

  test('indent and then unindent of the last task gives the same order', () => {
    const { rows } = standard();
    const indented = act(rows, indentTask, { id: 'c' });
    expect(shown(act(indented.rows, unindentTask, { id: 'c' }).rows)).toEqual(['a', 'b', '  b1', '  b2', 'c']);
  });

  test('not possible for a top-level task', () => {
    const w = standard();
    w.task('orphan', { parentId: 'nope' });
    for (const id of ['a', 'b', 'orphan', 'nope']) expect(act(w.rows, unindentTask, { id }).puts).toEqual([]);
  });
});

describe('moveToTop', () => {
  test('a top-level task goes to the first position', () => {
    const { rows } = standard();
    const result = act(rows, moveToTop, { id: 'c' });
    expect(result.message).toBeNull();
    expect(shown(result.rows)).toEqual(['c', 'a', 'b', '  b1', '  b2']);
    expect(shown(act(rows, moveToTop, { id: 'b' }).rows)).toEqual(['b', '  b1', '  b2', 'a', 'c']);
  });

  test('a subtask goes to the first position among the subtasks of its parent', () => {
    const { rows } = standard();
    const result = act(rows, moveToTop, { id: 'b2' });
    expect(shown(result.rows)).toEqual(['a', 'b', '  b2', '  b1', 'c']);
    expect(task(result.rows, 'b2').parentId).toBe('b');
  });

  test('gives no put for a task that is first already', () => {
    const w = world();
    w.list('l1');
    w.task('done', { completed: true, completedAt: 5, completedBy: ME });
    w.task('a');
    w.task('a1', { parentId: 'a' });
    w.task('b');
    for (const id of ['a', 'a1', 'nope']) expect(act(w.rows, moveToTop, { id }).puts).toEqual([]);
    expect(shown(act(w.rows, moveToTop, { id: 'b' }).rows)).toEqual(['b', 'a', '  a1']);
  });
});

describe('setStar', () => {
  test('sets the star and its time', () => {
    const { rows } = standard();
    const result = act(rows, setStar, { id: 'a', starred: true });
    expect(result.message).toBeNull();
    expect(result.puts).toEqual([{ kind: 'task', id: 'a', fields: { starred: true, starredAt: NOW } }]);
    expect(result.undo).toEqual([{ kind: 'task', id: 'a', fields: { starred: false, starredAt: null } }]);
  });

  test('removes the star and its time', () => {
    const w = standard();
    w.task('s', { starred: true, starredAt: 5 });
    expect(act(w.rows, setStar, { id: 's', starred: false }).puts).toEqual([
      { kind: 'task', id: 's', fields: { starred: false, starredAt: null } },
    ]);
  });

  test('gives no put when the star has the value already, so the time of the star stays', () => {
    const w = standard();
    w.task('s', { starred: true, starredAt: 5 });
    expect(act(w.rows, setStar, { id: 's', starred: true }).puts).toEqual([]);
    expect(act(w.rows, setStar, { id: 'a', starred: false }).puts).toEqual([]);
    expect(act(w.rows, setStar, { id: 'nope', starred: true }).puts).toEqual([]);
  });
});

describe('createList', () => {
  test('makes a list at the end of the list order', () => {
    const { rows } = standard();
    const result = act(rows, createList, { title: '  Work  ' });
    expect(result.message).toBeNull();
    expect(result.puts).toHaveLength(1);
    const id = result.puts[0]!.id;
    expect(list(result.rows, id)).toEqual({ ...defaultList(id), title: 'Work', owner: ME, createdAt: NOW, pos: 'a2' });
    expect(listOrder(result.rows)).toEqual(['l1', 'l2', id]);
    expect(result.undo).toEqual([{ kind: 'list', id, fields: { deleted: true } }]);
  });

  test('uses the id of the intent', () => {
    const { rows } = standard();
    expect(act(rows, createList, { title: 'Work', id: 'mine' }).puts[0]!.id).toBe('mine');
  });

  test('makes no list for an empty title or an id that is in use', () => {
    const { rows } = standard();
    expect(act(rows, createList, { title: '' }).puts).toEqual([]);
    expect(act(rows, createList, { title: '   ' }).puts).toEqual([]);
    expect(act(rows, createList, { title: 'Work', id: 'l1' }).puts).toEqual([]);
  });

  test('the first list', () => {
    const result = act(emptyRows(), createList, { title: 'Work', id: 'n' });
    expect(list(result.rows, 'n').pos).toBe('a0');
  });

  test('lists with no key get keys, so the new list is the last one', () => {
    const w = world();
    w.list('mine', { pos: 'a0' });
    // Lists that the other person shared have no key for this person.
    w.list('shared2', { pos: null, owner: OTHER, shared: true, createdAt: 50 });
    w.list('shared1', { pos: null, owner: OTHER, shared: true, createdAt: 40 });
    expect(listOrder(w.rows)).toEqual(['mine', 'shared1', 'shared2']);
    const result = act(w.rows, createList, { title: 'Work', id: 'n' });
    expect(listOrder(result.rows)).toEqual(['mine', 'shared1', 'shared2', 'n']);
    expect(result.puts.map((put) => [put.id, Object.keys(put.fields).length])).toEqual([['n', LIST_FIELDS.length], ['shared1', 1], ['shared2', 1]]);
    expect(['mine', 'shared1', 'shared2', 'n'].map((id) => list(result.rows, id).pos)).toEqual(['a0', 'a1', 'a2', 'a3']);
  });

  test('a deleted list has no place in the order', () => {
    const w = standard();
    w.list('dead', { deleted: true });
    expect(list(act(w.rows, createList, { title: 'Work', id: 'n' }).rows, 'n').pos).toBe('a2');
  });
});

describe('list fields', () => {
  test('renameList trims the title, and an empty title keeps the old one', () => {
    const { rows } = standard();
    const result = act(rows, renameList, { id: 'l2', title: '  Home ' });
    expect(result.message).toBeNull();
    expect(result.puts).toEqual([{ kind: 'list', id: 'l2', fields: { title: 'Home' } }]);
    expect(result.undo).toEqual([{ kind: 'list', id: 'l2', fields: { title: 'l2' } }]);
    expect(act(rows, renameList, { id: 'l2', title: '  ' }).puts).toEqual([]);
    expect(act(rows, renameList, { id: 'l2', title: 'l2' }).puts).toEqual([]);
    expect(act(rows, renameList, { id: 'nope', title: 'x' }).puts).toEqual([]);
    expect(list(act(rows, renameList, { id: 'l2', title: 'x'.repeat(3000) }).rows, 'l2').title).toHaveLength(LIMITS.listTitle);
  });

  test('a person who is not the owner can rename a shared list', () => {
    const w = standard();
    w.list('theirs', { owner: OTHER, shared: true });
    expect(act(w.rows, renameList, { id: 'theirs', title: 'Ours' }).puts).toHaveLength(1);
  });

  test('setListSort', () => {
    const { rows } = standard();
    for (const sort of ['date', 'deadline', 'starred', 'title'] as const) {
      expect(act(rows, setListSort, { id: 'l1', sort }).puts).toEqual([{ kind: 'list', id: 'l1', fields: { sort } }]);
    }
    expect(act(rows, setListSort, { id: 'l1', sort: 'my' }).puts).toEqual([]);
    expect(act(rows, setListSort, { id: 'l1', sort: 'random' as 'my' }).puts).toEqual([]);
    expect(act(rows, setListSort, { id: 'nope', sort: 'date' }).puts).toEqual([]);
  });

  test('setListHidden', () => {
    const { rows } = standard();
    const result = act(rows, setListHidden, { id: 'l2', hidden: true });
    expect(result.puts).toEqual([{ kind: 'list', id: 'l2', fields: { hidden: true } }]);
    expect(act(result.rows, setListHidden, { id: 'l2', hidden: false }).puts).toEqual([{ kind: 'list', id: 'l2', fields: { hidden: false } }]);
    expect(act(rows, setListHidden, { id: 'l2', hidden: false }).puts).toEqual([]);
  });

  test('setListShared is for the owner only', () => {
    const w = standard();
    w.list('theirs', { owner: OTHER, shared: true });
    const result = act(w.rows, setListShared, { id: 'l2', shared: true });
    expect(result.message).toBeNull();
    expect(result.puts).toEqual([{ kind: 'list', id: 'l2', fields: { shared: true } }]);
    expect(act(result.rows, setListShared, { id: 'l2', shared: false }).puts).toHaveLength(1);
    expect(act(w.rows, setListShared, { id: 'theirs', shared: false }).puts).toEqual([]);
    expect(act(w.rows, setListShared, { id: 'theirs', shared: false }, { me: OTHER }).puts).toHaveLength(1);
  });
});

describe('moveList', () => {
  function lists() {
    const w = world();
    for (const id of ['l1', 'l2', 'l3', 'l4']) w.list(id);
    return w;
  }

  test('before a list, after a list, to the first place, and to the end', () => {
    const { rows } = lists();
    const result = act(rows, moveList, { id: 'l4', beforeId: 'l2' });
    expect(result.message).toBeNull();
    expect(result.puts.map((put) => put.id)).toEqual(['l4']);
    expect(listOrder(result.rows)).toEqual(['l1', 'l4', 'l2', 'l3']);
    expect(listOrder(act(rows, moveList, { id: 'l1', afterId: 'l3' }).rows)).toEqual(['l2', 'l3', 'l1', 'l4']);
    expect(listOrder(act(rows, moveList, { id: 'l3', toFirst: true }).rows)).toEqual(['l3', 'l1', 'l2', 'l4']);
    expect(listOrder(act(rows, moveList, { id: 'l1' }).rows)).toEqual(['l2', 'l3', 'l4', 'l1']);
    expect(listOrder(act(rows, moveList, { id: 'l1', afterId: 'l4' }).rows)).toEqual(['l2', 'l3', 'l4', 'l1']);
  });

  test('one step to the left and to the right', () => {
    const { rows } = lists();
    expect(listOrder(act(rows, moveList, { id: 'l3', beforeId: 'l2' }).rows)).toEqual(['l1', 'l3', 'l2', 'l4']);
    expect(listOrder(act(rows, moveList, { id: 'l2', afterId: 'l3' }).rows)).toEqual(['l1', 'l3', 'l2', 'l4']);
  });

  test('the same place gives no puts', () => {
    const { rows } = lists();
    const same = [
      { id: 'l1', toFirst: true },
      { id: 'l1', beforeId: 'l2' },
      { id: 'l2', afterId: 'l1' },
      { id: 'l4' },
      { id: 'l4', afterId: 'l3' },
    ];
    for (const intent of same) expect(act(rows, moveList, intent).puts, JSON.stringify(intent)).toEqual([]);
  });

  test('gives no put for a list or a neighbour that is not there', () => {
    const w = lists();
    w.list('dead', { deleted: true });
    for (const intent of [{ id: 'nope', toFirst: true }, { id: 'dead', toFirst: true }, { id: 'l1', beforeId: 'nope' }, { id: 'l1', afterId: 'dead' }, { id: 'l1', beforeId: 'l1' }]) {
      expect(act(w.rows, moveList, intent).puts).toEqual([]);
    }
  });

  test('lists with no key', () => {
    const w = world();
    w.list('mine', { pos: 'a0' });
    w.list('s1', { pos: null, createdAt: 10 });
    w.list('s2', { pos: null, createdAt: 20 });
    w.list('s3', { pos: null, createdAt: 30 });
    expect(listOrder(w.rows)).toEqual(['mine', 's1', 's2', 's3']);
    // To the first place: only the moved list needs a key.
    const first = act(w.rows, moveList, { id: 's3', toFirst: true });
    expect(listOrder(first.rows)).toEqual(['s3', 'mine', 's1', 's2']);
    expect(first.puts.map((put) => put.id)).toEqual(['s3']);
    // Between two lists with no key: the lists before the place get keys too.
    const middle = act(w.rows, moveList, { id: 'mine', afterId: 's1' });
    expect(listOrder(middle.rows)).toEqual(['s1', 'mine', 's2', 's3']);
    const swap = act(w.rows, moveList, { id: 's3', beforeId: 's2' });
    expect(listOrder(swap.rows)).toEqual(['mine', 's1', 's3', 's2']);
    expect(list(swap.rows, 's2').pos).toBeNull();
    const end = act(w.rows, moveList, { id: 'mine' });
    expect(listOrder(end.rows)).toEqual(['s1', 's2', 's3', 'mine']);
  });

  test('two lists with the same key', () => {
    const w = world();
    w.list('a', { pos: 'a0', createdAt: 1 });
    w.list('b', { pos: 'a0', createdAt: 2 });
    w.list('c', { pos: 'a1', createdAt: 3 });
    const result = act(w.rows, moveList, { id: 'c', afterId: 'a' });
    expect(listOrder(result.rows)).toEqual(['a', 'c', 'b']);
  });
});

describe('deleteList', () => {
  test('sets deleted, and the undo has all fields', () => {
    const { rows } = standard();
    const result = act(rows, deleteList, { id: 'l2' });
    expect(result.message).toBe('List deleted');
    expect(result.puts).toEqual([{ kind: 'list', id: 'l2', fields: { deleted: true } }]);
    expect(Object.keys(result.undo[0]!.fields).sort()).toEqual(LIST_FIELDS);
    expect(listOrder(result.rows)).toEqual(['l1']);
  });

  test('not for the default list, a list of the other person, or a list that is not there', () => {
    const w = standard();
    w.list('theirs', { owner: OTHER, shared: true });
    w.list('dead', { deleted: true });
    for (const id of ['l1', 'theirs', 'dead', 'nope']) expect(act(w.rows, deleteList, { id })).toMatchObject({ puts: [], message: null });
  });
});

describe('clearCompleted', () => {
  test('deletes each completed task of the list, and no other task', () => {
    const w = standard();
    for (const id of ['d1', 'd2', 'd3', 'd4']) w.task(id, { completed: true, completedAt: 5, completedBy: ME });
    w.task('d5', { parentId: 'b', completed: true, completedAt: 5, completedBy: ME });
    w.task('resting', { repeat: DAILY, due: '2026-10-07', hiddenUntil: '2026-10-07', lastDoneAt: 5, repeatCount: 1 });
    w.task('other', { listId: 'l2', completed: true, completedAt: 5, completedBy: ME });
    w.task('gone', { completed: true, deleted: true });
    const result = act(w.rows, clearCompleted, { listId: 'l1' });
    expect(result.message).toBe('5 completed tasks deleted');
    expect(result.puts.map((put) => put.id).sort()).toEqual(['d1', 'd2', 'd3', 'd4', 'd5']);
    expect(completedIds(result.rows)).toEqual(['resting']);
    expect(completedIds(result.rows, 'l2')).toEqual(['other']);
    expect(shown(result.rows)).toEqual(['a', 'b', '  b1', '  b2', 'c']);
    for (const put of result.undo) expect(Object.keys(put.fields).sort()).toEqual(TASK_FIELDS);
  });

  test('one task', () => {
    const w = standard();
    w.task('d1', { completed: true, completedAt: 5, completedBy: ME });
    expect(act(w.rows, clearCompleted, { listId: 'l1' }).message).toBe('1 completed task deleted');
  });

  test('gives no put and no message when the list has no completed task', () => {
    const { rows } = standard();
    expect(act(rows, clearCompleted, { listId: 'l1' })).toMatchObject({ puts: [], undo: [], message: null });
    expect(act(rows, clearCompleted, { listId: 'nope' })).toMatchObject({ puts: [], undo: [], message: null });
  });
});

describe('many random actions', () => {
  function random(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  test.each([11, 12, 13])('seed %i: each action obeys the rules, and the rows stay in a good state', (seed) => {
    const next = random(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
    const w = standard();
    w.list('l3', { pos: null });
    let rows = w.rows;
    let made = 0;
    let today = TODAY;
    const anyTask = (): ID => (next() < 0.03 ? 'nope' : pick([...rows.tasks.keys()]));
    const anyList = (): ID => (next() < 0.03 ? 'nope' : pick([...rows.lists.keys()]));
    const maybe = <T>(value: T): T | undefined => (next() < 0.5 ? value : undefined);
    const rules: RepeatRule[] = [
      DAILY,
      WEEKLY,
      { ...DAILY, end: { type: 'after', count: 2 } },
      { ...DAILY, end: { type: 'on', date: '2026-10-09' } },
    ];

    const steps: (() => ActionResult & { rows: Rows })[] = [
      () => act(rows, createTask, { listId: anyList(), title: `t${made}`, id: `t${made++}`, position: pick([{ at: 'top' as const }, { after: anyTask() }, { parentId: anyTask(), at: 'end' as const }]), repeat: maybe(pick(rules)), starred: next() < 0.2 }, { today }),
      () => act(rows, updateTask, { id: anyTask(), title: pick(['x', '', 'yy']), due: pick([undefined, null, '2026-10-08']), time: pick([undefined, null, '09:00']) }, { today }),
      () => act(rows, setDate, { id: anyTask(), due: pick([null, '2026-10-05', '2026-10-09']), time: pick([null, '10:30']) }, { today }),
      () => act(rows, setRepeat, { id: anyTask(), rule: pick([null, ...rules]) }, { today }),
      () => act(rows, completeTask, { id: anyTask() }, { today }),
      () => act(rows, completeTask, { id: anyTask() }, { today }),
      () => act(rows, uncompleteTask, { id: anyTask() }, { today }),
      () => act(rows, deleteTask, { id: anyTask() }, { today }),
      () => act(rows, moveTask, { id: anyTask(), listId: maybe(anyList()), parentId: pick([undefined, null, anyTask()]), beforeId: maybe(anyTask()), afterId: maybe(anyTask()) }, { today }),
      () => act(rows, moveTask, { id: anyTask(), listId: anyList() }, { today }),
      () => act(rows, indentTask, { id: anyTask() }, { today }),
      () => act(rows, unindentTask, { id: anyTask() }, { today }),
      () => act(rows, moveToTop, { id: anyTask() }, { today }),
      () => act(rows, setStar, { id: anyTask(), starred: next() < 0.5 }, { today }),
      () => act(rows, createList, { title: 'list', id: `list${made++}` }, { today }),
      () => act(rows, moveList, { id: anyList(), beforeId: maybe(anyList()), afterId: maybe(anyList()), toFirst: next() < 0.2 }, { today }),
      () => act(rows, clearCompleted, { listId: anyList() }, { today }),
    ];

    let changed = 0;
    for (let i = 0; i < 1500; i++) {
      if (i % 200 === 199) today = today < '2026-10-12' ? `2026-10-${String(+today.slice(8) + 1).padStart(2, '0')}` : today;
      const result = pick(steps)();
      if (result.puts.length) changed++;
      rows = result.rows;

      for (const each of rows.tasks.values()) {
        if (each.deleted) continue;
        const parent = each.parentId === null ? undefined : rows.tasks.get(each.parentId);
        // A subtask on the screen never repeats, and each task is in a list that is there.
        if (isParentOf(parent, each) && each.repeat) throw new Error(`step ${i}: the subtask ${each.id} repeats`);
        if (!rows.lists.has(each.listId)) throw new Error(`step ${i}: ${each.id} is in no list`);
        if (each.title.trim() === '') throw new Error(`step ${i}: ${each.id} has no title`);
        if (each.time !== null && each.due === null) throw new Error(`step ${i}: ${each.id} has a time and no date`);
        if (each.repeat !== null && each.due === null) throw new Error(`step ${i}: ${each.id} repeats and has no date`);
      }
    }
    expect(changed).toBeGreaterThan(300);

    // Each task that is not deleted shows one time, or is hidden below a resting parent.
    for (const each of rows.lists.values()) {
      const view = buildListView({ list: each, tasks: [...rows.tasks.values()], today, sort: 'my', locale: LOCALE });
      const ids = [...view.groups.flatMap((group) => group.items.map((item) => item.task.id)), ...view.completed.map((t) => t.id)];
      expect(new Set(ids).size).toBe(ids.length);
      const hidden = [...rows.tasks.values()].filter((t) => {
        const parent = t.parentId === null ? undefined : rows.tasks.get(t.parentId);
        return !t.deleted && t.listId === each.id && isOpen({ task: t, today }) && isParentOf(parent, t) && isResting({ task: parent, today });
      });
      const live = [...rows.tasks.values()].filter((t) => !t.deleted && t.listId === each.id);
      expect(ids.length + hidden.length).toBe(live.length);
    }
  });
});

// ---- Review tests ----

/** A random number source with a seed, so a failure can be made again. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The field checks of server/sync.ts, in a short form. The server refuses the full op if one
 * field fails, and the device then loses the change. So no action can give such a field.
 */
function expectServerAccepts(put: Put): void {
  const id = (v: unknown): boolean => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
  const stamp = (v: unknown): boolean => typeof v === 'number' && v >= 0 && v <= 8.64e15;
  const orNull = (check: (v: unknown) => boolean) => (v: unknown): boolean => v === null || check(v);
  const bool = (v: unknown): boolean => typeof v === 'boolean';
  const text = (max: number) => (v: unknown): boolean => typeof v === 'string' && v.length <= max && (v as unknown as { isWellFormed(): boolean }).isWellFormed();
  const pos = (v: unknown): boolean => typeof v === 'string' && v.length <= 1024;
  const checks: Record<string, (v: unknown) => boolean> =
    put.kind === 'task'
      ? {
          listId: id,
          parentId: orNull(id),
          title: text(LIMITS.title),
          notes: text(LIMITS.notes),
          pos,
          due: orNull(isValidDate),
          time: orNull(isValidTime),
          deadline: orNull(isValidDate),
          repeat: orNull(validateRule),
          repeatCount: (v) => Number.isInteger(v) && (v as number) >= 0,
          hiddenUntil: orNull(isValidDate),
          lastDoneAt: orNull(stamp),
          lastDoneDue: orNull(isValidDate),
          completed: bool,
          completedAt: orNull(stamp),
          completedBy: orNull(id),
          deleted: bool,
          starred: bool,
          starredAt: orNull(stamp),
          createdAt: stamp,
          createdBy: id,
        }
      : {
          title: text(LIMITS.listTitle),
          shared: bool,
          deleted: bool,
          pos: orNull(pos),
          sort: (v) => ['my', 'date', 'deadline', 'starred', 'title'].includes(v as string),
          hidden: bool,
          owner: id,
          isDefault: bool,
          createdAt: stamp,
        };
  expect(id(put.id), `id ${put.id}`).toBe(true);
  for (const [name, value] of Object.entries(put.fields)) {
    const check = checks[name];
    if (!check) throw new Error(`the ${put.kind} put has the unknown field ${name}`);
    if (!check(value)) throw new Error(`the server refuses ${put.kind}.${name} = ${JSON.stringify(value)}`);
  }
}

describe('text that is cut at the limit', () => {
  const wellFormed = (text: string): boolean => (text as unknown as { isWellFormed(): boolean }).isWellFormed();

  test('an emoji at the limit is not cut in two', () => {
    const { rows } = standard();
    // An emoji is two code units. The first one is the last unit that the limit permits.
    const title = 'x'.repeat(LIMITS.title - 1) + '😀 and more';
    const created = act(rows, createTask, { listId: 'l1', title, id: 'n', notes: 'y'.repeat(LIMITS.notes - 1) + '😀' });
    expect(task(created.rows, 'n').title).toBe('x'.repeat(LIMITS.title - 1));
    expect(task(created.rows, 'n').notes).toBe('y'.repeat(LIMITS.notes - 1));

    const updated = act(rows, updateTask, { id: 'a', title, notes: '😀'.repeat(LIMITS.notes) });
    expect(task(updated.rows, 'a').title).toBe('x'.repeat(LIMITS.title - 1));
    expect(task(updated.rows, 'a').notes).toBe('😀'.repeat(LIMITS.notes / 2));
    expect(wellFormed(task(updated.rows, 'a').notes)).toBe(true);

    const listTitle = '🇻🇳'.repeat(LIMITS.listTitle);
    const madeList = act(rows, createList, { title: 'z'.repeat(LIMITS.listTitle - 1) + '😀', id: 'n' });
    expect(list(madeList.rows, 'n').title).toBe('z'.repeat(LIMITS.listTitle - 1));
    const renamed = act(rows, renameList, { id: 'l1', title: 'q' + listTitle });
    expect(list(renamed.rows, 'l1').title).toHaveLength(LIMITS.listTitle - 1);
    expect(wellFormed(list(renamed.rows, 'l1').title)).toBe(true);
    for (const result of [created, updated, madeList, renamed]) result.puts.forEach(expectServerAccepts);
  });

  test('an emoji that ends at the limit stays, and shorter text is not changed', () => {
    const { rows } = standard();
    const title = 'x'.repeat(LIMITS.title - 2) + '😀';
    expect(task(act(rows, createTask, { listId: 'l1', title, id: 'n' }).rows, 'n').title).toBe(title);
    expect(task(act(rows, updateTask, { id: 'a', title: 'Fix 🚲 today' }).rows, 'a').title).toBe('Fix 🚲 today');
    // A lone half that the person pasted is not the work of the cut, and stays.
    expect(task(act(rows, updateTask, { id: 'a', notes: 'a\ud83d' }).rows, 'a').notes).toBe('a\ud83d');
  });
});

describe('moveList with the two neighbours', () => {
  test('uses the list after it, and the list before it only if the first is not a list', () => {
    const w = world();
    for (const id of ['l1', 'l2', 'l3', 'l4']) w.list(id);
    expect(listOrder(act(w.rows, moveList, { id: 'l1', beforeId: 'l4', afterId: 'l3' }).rows)).toEqual(['l2', 'l3', 'l1', 'l4']);
    expect(listOrder(act(w.rows, moveList, { id: 'l1', beforeId: 'nope', afterId: 'l3' }).rows)).toEqual(['l2', 'l3', 'l1', 'l4']);
    expect(listOrder(act(w.rows, moveList, { id: 'l1', beforeId: 'l1', afterId: 'l4' }).rows)).toEqual(['l2', 'l3', 'l4', 'l1']);
    expect(listOrder(act(w.rows, moveList, { id: 'l4', beforeId: null, afterId: 'l1' }).rows)).toEqual(['l1', 'l4', 'l2', 'l3']);
    expect(act(w.rows, moveList, { id: 'l1', beforeId: 'nope', afterId: 'nope' }).puts).toEqual([]);
    expect(act(w.rows, moveList, { id: 'l1', beforeId: 'nope', afterId: 'l1' }).puts).toEqual([]);
    // The first place wins over the neighbours.
    expect(listOrder(act(w.rows, moveList, { id: 'l3', toFirst: true, afterId: 'l4' }).rows)).toEqual(['l3', 'l1', 'l2', 'l4']);
  });
});

describe('a repeating task through many days', () => {
  /** Completes the task on each of its dates until it stops, and gives the dates that were completed. */
  function completeOnEachDate(rows: Rows, id: ID, limit = 50): { rows: Rows; dates: string[]; messages: (string | null)[] } {
    const dates: string[] = [];
    const messages: (string | null)[] = [];
    while (task(rows, id).repeat && dates.length < limit) {
      const today = task(rows, id).due!;
      dates.push(today);
      const result = act(rows, completeTask, { id }, { today });
      result.puts.forEach(expectServerAccepts);
      messages.push(result.message);
      rows = result.rows;
      // The task rests until its next date, and is open on that date.
      const row = task(rows, id);
      if (row.repeat) {
        expect(isResting({ task: row, today })).toBe(true);
        expect(isResting({ task: row, today: addDays(row.due!, -1) })).toBe(row.due! > addDays(today, 1));
        expect(isOpen({ task: row, today: row.due! })).toBe(true);
        expect(row.repeatCount).toBe(dates.length);
        expect(row.lastDoneDue).toBe(today);
      }
    }
    return { rows, dates, messages };
  }

  test('an end count of 5 gives 5 completions, then the task is a normal completed task', () => {
    const w = standard();
    w.task('r', { repeat: { every: 1, unit: 'week', weekdays: [2, 4], start: TODAY, end: { type: 'after', count: 5 } }, due: TODAY });
    const { rows, dates, messages } = completeOnEachDate(w.rows, 'r');
    expect(dates).toEqual(['2026-10-06', '2026-10-08', '2026-10-13', '2026-10-15', '2026-10-20']);
    expect(messages.slice(0, 4).every((message) => message!.startsWith('Task completed. It comes back on '))).toBe(true);
    expect(messages[4]).toBe('Task completed');
    expect(task(rows, 'r')).toMatchObject({ completed: true, repeat: null, hiddenUntil: null, due: '2026-10-20' });
    expect(completedIds(rows, 'l1', '2030-01-01')).toEqual(['r']);
  });

  test('an end date: the end date itself is the last date', () => {
    const w = standard();
    w.task('r', { repeat: { every: 1, unit: 'month', monthMode: 'day', monthDay: 31, start: '2026-10-31', end: { type: 'on', date: '2027-02-28' } }, due: '2026-10-31' });
    const { rows, dates } = completeOnEachDate(w.rows, 'r');
    expect(dates).toEqual(['2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28']);
    expect(task(rows, 'r')).toMatchObject({ completed: true, repeat: null, due: '2027-02-28' });
  });

  test('every 2 weeks with three weekdays across the change of the year', () => {
    const w = standard();
    w.task('r', { repeat: { every: 2, unit: 'week', weekdays: [1, 3, 0], start: '2026-12-07', end: { type: 'on', date: '2027-01-20' } }, due: '2026-12-07' });
    const { dates } = completeOnEachDate(w.rows, 'r');
    expect(dates).toEqual([
      '2026-12-07',
      '2026-12-09',
      '2026-12-13',
      '2026-12-21',
      '2026-12-23',
      '2026-12-27',
      '2027-01-04',
      '2027-01-06',
      '2027-01-10',
      '2027-01-18',
      '2027-01-20',
    ]);
  });

  test('the last Friday of each month, completed some days late each time', () => {
    const w = standard();
    w.task('r', { repeat: { every: 1, unit: 'month', monthMode: 'weekday', ordinal: -1, weekday: 5, start: '2026-10-01', end: { type: 'never' } }, due: '2026-10-30' });
    let rows = w.rows;
    const dues: string[] = [];
    for (let i = 0; i < 5; i++) {
      const due = task(rows, 'r').due!;
      dues.push(due);
      // Three days late is still before the next date.
      rows = act(rows, completeTask, { id: 'r' }, { today: addDays(due, 3) }).rows;
    }
    expect(dues).toEqual(['2026-10-30', '2026-11-27', '2026-12-25', '2027-01-29', '2027-02-26']);
  });

  test.each([
    ['daily, 400 days late', { every: 1, unit: 'day', start: '2025-01-01', end: { type: 'never' } }, '2025-09-01', '2026-10-07'],
    ['every 3 days, 400 days late', { every: 3, unit: 'day', start: '2025-09-01', end: { type: 'never' } }, '2025-09-01', '2026-10-08'],
    ['weekly on Tuesday, due today', { every: 1, unit: 'week', weekdays: [2], start: '2025-01-07', end: { type: 'never' } }, TODAY, '2026-10-13'],
    ['weekly on Tuesday, a year late', { every: 1, unit: 'week', weekdays: [2], start: '2025-01-07', end: { type: 'never' } }, '2025-10-07', '2026-10-13'],
    // The week of today is week 91 from the start, so it is not a week of the rule.
    ['every 2 weeks, many periods late', { every: 2, unit: 'week', weekdays: [1, 5], start: '2025-01-06', end: { type: 'never' } }, '2025-01-06', '2026-10-12'],
    ['every 2 weeks, in a week of the rule', { every: 2, unit: 'week', weekdays: [1, 5], start: '2025-01-13', end: { type: 'never' } }, '2025-01-13', '2026-10-09'],
    ['monthly on day 31, 14 months late', { every: 1, unit: 'month', monthMode: 'day', monthDay: 31, start: '2025-01-31', end: { type: 'never' } }, '2025-08-31', '2026-10-31'],
    ['every 5 months, late', { every: 5, unit: 'month', monthMode: 'day', monthDay: 15, start: '2024-01-15', end: { type: 'never' } }, '2024-06-15', '2026-12-15'],
    ['yearly on 29 February, late', { every: 1, unit: 'year', start: '2024-02-29', end: { type: 'never' } }, '2024-02-29', '2027-02-28'],
    ['yearly, due in the future', { every: 1, unit: 'year', start: '2020-12-25', end: { type: 'never' } }, '2026-12-25', '2027-12-25'],
  ] as [string, RepeatRule, string, string][])('%s: one completion goes to the first date after today', (_name, repeat, due, expected) => {
    const w = standard();
    w.task('r', { repeat, due, repeatCount: 7 });
    const result = act(w.rows, completeTask, { id: 'r' });
    result.puts.forEach(expectServerAccepts);
    const row = task(result.rows, 'r');
    expect(row).toMatchObject({ due: expected, hiddenUntil: expected, lastDoneDue: due, lastDoneAt: NOW, repeatCount: 8, completed: false });
    // The next date is after today and after the old date, and no date of the rule is between.
    expect(expected > TODAY && expected > due).toBe(true);
    expect(nextOccurrence({ rule: repeat, after: due > TODAY ? due : TODAY })).toBe(expected);
    // Uncomplete brings back the date that was completed, and the count.
    const back = act(result.rows, uncompleteTask, { id: 'r' });
    expect(back.message).toBe('Task marked uncompleted');
    expect(task(back.rows, 'r')).toEqual(task(w.rows, 'r'));
  });

  test('a task that is late by many periods with an end date in the past: it stops', () => {
    const w = standard();
    w.task('r', { repeat: { every: 1, unit: 'week', weekdays: [2], start: '2026-01-06', end: { type: 'on', date: '2026-06-30' } }, due: '2026-03-03' });
    const result = act(w.rows, completeTask, { id: 'r' });
    expect(result.message).toBe('Task completed');
    expect(task(result.rows, 'r')).toMatchObject({ completed: true, repeat: null, due: '2026-03-03', repeatCount: 0 });
    // Uncomplete does not bring the rule back. The undo does.
    expect(task(act(result.rows, uncompleteTask, { id: 'r' }).rows, 'r')).toMatchObject({ completed: false, repeat: null });
  });

  test('a resting task: uncomplete after three completions, after a change of the date, and with subtasks', () => {
    const w = standard();
    w.task('r', { repeat: DAILY, due: '2026-10-04' });
    w.task('r1', { parentId: 'r', completed: true, completedAt: 5, completedBy: ME });
    w.task('r2', { parentId: 'r' });
    let rows = w.rows;
    for (const today of ['2026-10-04', '2026-10-05', TODAY]) rows = act(rows, completeTask, { id: 'r' }, { today }).rows;
    expect(task(rows, 'r')).toMatchObject({ due: '2026-10-07', hiddenUntil: '2026-10-07', lastDoneDue: TODAY, repeatCount: 3 });
    // The subtasks are open and hidden while the parent rests.
    expect(task(rows, 'r1').completed).toBe(false);
    expect(shown(rows)).toEqual(['a', 'b', '  b1', '  b2', 'c']);

    const back = act(rows, uncompleteTask, { id: 'r' });
    expect(task(back.rows, 'r')).toMatchObject({ due: TODAY, hiddenUntil: null, lastDoneAt: null, lastDoneDue: null, repeatCount: 2, repeat: DAILY });
    expect(back.puts).toHaveLength(1);
    expect(shown(back.rows)).toEqual(['a', 'b', '  b1', '  b2', 'c', 'r', '  r1', '  r2']);

    // The person gives the resting task a later date, and then makes it open again.
    const later = act(rows, setDate, { id: 'r', due: '2026-10-20' });
    expect(task(later.rows, 'r')).toMatchObject({ due: '2026-10-20', hiddenUntil: '2026-10-20' });
    expect(isResting({ task: task(later.rows, 'r'), today: '2026-10-19' })).toBe(true);
    expect(task(act(later.rows, uncompleteTask, { id: 'r' }).rows, 'r')).toMatchObject({ due: TODAY, hiddenUntil: null, repeatCount: 2 });

    // On the next date the task is open, and uncomplete does nothing then.
    expect(act(rows, uncompleteTask, { id: 'r' }, { today: '2026-10-07' }).puts).toEqual([]);
    expect(act(rows, completeTask, { id: 'r' }, { today: '2026-10-07' }).puts).toHaveLength(1);
  });

  test('the undo of each completion in a row of completions gives the rows from before, step by step', () => {
    const w = standard();
    w.task('r', { repeat: { ...DAILY, end: { type: 'after', count: 3 } }, due: TODAY });
    w.task('r1', { parentId: 'r' });
    const states = [w.rows];
    const undos: Put[][] = [];
    let today = TODAY;
    for (let i = 0; i < 3; i++) {
      const sub = act(states.at(-1)!, completeTask, { id: 'r1' }, { today });
      const result = act(sub.rows, completeTask, { id: 'r' }, { today });
      undos.push([...result.undo, ...sub.undo]);
      states.push(result.rows);
      today = addDays(today, 1);
    }
    // The third completion is the last one: the parent and its subtask are completed.
    expect(task(states[3]!, 'r')).toMatchObject({ completed: true, repeat: null });
    expect(task(states[3]!, 'r1').completed).toBe(true);
    let rows = states[3]!;
    for (let i = 2; i >= 0; i--) {
      const undone = copy(rows);
      applyPuts(undone, undos[i]!);
      expect([...undone.tasks.values()]).toEqual([...states[i]!.tasks.values()]);
      rows = undone;
    }
  });
});

describe('moveTask with strange inputs', () => {
  /** l1 has a, b (b1, b2), c. l2 has x (x1). */
  function board() {
    const w = standard();
    w.task('x', { listId: 'l2' });
    w.task('x1', { listId: 'l2', parentId: 'x' });
    return w;
  }

  test.each([
    ['below its own subtask, with a different list as the target', { id: 'b', listId: 'l2', parentId: 'b1' }],
    ['below itself in a different list', { id: 'a', listId: 'l2', parentId: 'a' }],
    ['a subtask of a different list as the parent', { id: 'a', listId: 'l2', parentId: 'x1' }],
    ['a subtask below its sibling', { id: 'b1', parentId: 'b2' }],
    ['a task with an empty id', { id: '', listId: 'l1' }],
    ['a parent with an empty id', { id: 'a', parentId: '' }],
    ['a list with an empty id', { id: 'a', listId: '' }],
    ['before a subtask of the task, at the top level', { id: 'b', parentId: null, beforeId: 'b2' }],
    ['among the subtasks of a parent, before a subtask of a different parent', { id: 'a', listId: 'l2', parentId: 'x', beforeId: 'b1' }],
    ['after a task of the old list, with a different list as the target', { id: 'a', listId: 'l2', afterId: 'c' }],
  ])('%s gives no puts', (_name, intent) => {
    expect(act(board().rows, moveTask, intent)).toMatchObject({ puts: [], undo: [], message: null });
  });

  test('a subtask that names its own parent as the row before it becomes the first subtask', () => {
    const result = act(board().rows, moveTask, { id: 'b2', afterId: 'b' });
    expect(shown(result.rows)).toEqual(['a', 'b', '  b2', '  b1', 'c']);
    expect(result.puts).toEqual([{ kind: 'task', id: 'b2', fields: { pos: expect.any(String) } }]);
  });

  test('null for the two neighbours is the end, as no neighbour is', () => {
    const { rows } = board();
    expect(shown(act(rows, moveTask, { id: 'a', beforeId: null, afterId: null }).rows)).toEqual(['b', '  b1', '  b2', 'c', 'a']);
    expect(shown(act(rows, moveTask, { id: 'a', parentId: 'b', beforeId: null, afterId: null }).rows)).toEqual(['b', '  b1', '  b2', '  a', 'c']);
  });

  test('a deleted subtask does not go with its parent, and a completed one does', () => {
    const w = board();
    w.task('b3', { parentId: 'b', deleted: true });
    w.task('b4', { parentId: 'b', completed: true, completedAt: 5, completedBy: ME });
    const result = act(w.rows, moveTask, { id: 'b', listId: 'l2' });
    expect(result.puts.map((put) => put.id).sort()).toEqual(['b', 'b1', 'b2', 'b4']);
    expect(task(result.rows, 'b3').listId).toBe('l1');
    expect(shown(result.rows, 'l2')).toEqual(['x', '  x1', 'b', '  b1', '  b2']);
    expect(completedIds(result.rows, 'l2')).toEqual(['b4']);
  });

  test('a task with subtasks to a list where each key is not from the scheme: all rows there get new keys', () => {
    const w = board();
    for (const id of ['x', 'x1']) w.rows.tasks.set(id, { ...w.rows.tasks.get(id)!, pos: 'not a key' });
    w.task('y', { listId: 'l2', pos: '' });
    const result = act(w.rows, moveTask, { id: 'b', listId: 'l2', beforeId: 'x' });
    expect(shown(result.rows, 'l2')).toEqual(['y', 'b', '  b1', '  b2', 'x', '  x1']);
    result.puts.forEach(expectServerAccepts);
    for (const id of ['x', 'y', 'b']) expect(() => keyBetween(task(result.rows, id).pos, null)).not.toThrow();
  });

  test('a move back and forth between two lists gives the start again on the screen', () => {
    let { rows } = board();
    rows = act(rows, moveTask, { id: 'b', listId: 'l2', beforeId: 'x' }).rows;
    expect(shown(rows, 'l2')).toEqual(['b', '  b1', '  b2', 'x', '  x1']);
    rows = act(rows, moveTask, { id: 'b', listId: 'l1', afterId: 'a' }).rows;
    expect(shown(rows)).toEqual(['a', 'b', '  b1', '  b2', 'c']);
    expect(shown(rows, 'l2')).toEqual(['x', '  x1']);
  });
});

describe('a move as a drag gives it', () => {
  type Row = { id: ID; depth: number };

  function screen(rows: Rows, listId: ID): Row[] {
    const view = buildListView({ list: rows.lists.get(listId)!, tasks: [...rows.tasks.values()], today: TODAY, sort: 'my', locale: LOCALE });
    return view.groups.flatMap((group) => group.items.map((item) => ({ id: item.task.id, depth: item.depth })));
  }

  /** The parent and the neighbours for a drop at `index` with `depth`, as web/src/dnd/place.ts finds them. */
  function family(rows: Row[], index: number, depth: number): { parentId: ID | null; beforeId: ID | null; afterId: ID | null } {
    let parentId: ID | null = null;
    let afterId: ID | null = null;
    for (let i = index - 1; i >= 0; i--) {
      const row = rows[i]!;
      if (row.depth < depth) {
        parentId = row.id;
        break;
      }
      if (row.depth === depth && afterId === null) {
        afterId = row.id;
        if (depth === 0) break;
      }
    }
    const next = rows[index];
    return { parentId, afterId, beforeId: next && next.depth === depth ? next.id : null };
  }

  test.each([21, 22, 23, 24])('seed %i: after each drop the screen shows the block at the place of the drop', (seed) => {
    const next = seeded(seed);
    const w = world();
    w.list('l1', { isDefault: true });
    w.list('l2');
    let rows = w.rows;
    let made = 0;
    const lists = ['l1', 'l2'];
    const tick = (): number => NOW + made * 1000;
    // Rows to start with, with subtasks, completed tasks, a repeating task, and a resting task.
    for (let i = 0; i < 40; i++) {
      const listId = lists[Math.floor(next() * 2)]!;
      const tops = screen(rows, listId).filter((row) => row.depth === 0);
      const parent = tops.length && next() < 0.4 ? tops[Math.floor(next() * tops.length)]!.id : null;
      rows = act(rows, createTask, { listId, title: `t${made}`, id: `t${made++}`, position: parent ? { parentId: parent, at: 'end' } : { at: 'top' } }, { now: tick() }).rows;
    }
    for (const row of [...screen(rows, 'l1'), ...screen(rows, 'l2')]) {
      const dice = next();
      if (dice < 0.15) rows = act(rows, completeTask, { id: row.id }, { now: tick() }).rows;
      else if (dice < 0.25 && row.depth === 0) rows = act(rows, setRepeat, { id: row.id, rule: DAILY }).rows;
    }
    const firstRepeat = [...rows.tasks.values()].find((each) => each.repeat && isOpen({ task: each, today: TODAY }));
    if (firstRepeat) rows = act(rows, completeTask, { id: firstRepeat.id }).rows;

    let moves = 0;
    for (let step = 0; step < 400; step++) {
      const from = lists[Math.floor(next() * 2)]!;
      const before = screen(rows, from);
      if (before.length === 0) continue;
      const at = Math.floor(next() * before.length);
      const dragged = before[at]!;
      // The block is the row and, for a top-level row, its subtasks.
      const block = [dragged];
      if (dragged.depth === 0) for (let i = at + 1; i < before.length && before[i]!.depth === 1; i++) block.push(before[i]!);
      const blockIds = new Set(block.map((row) => row.id));
      const to = next() < 0.3 ? lists[Math.floor(next() * 2)]! : from;
      const target = screen(rows, to).filter((row) => !blockIds.has(row.id));
      const index = Math.floor(next() * (target.length + 1));
      const min = target[index]?.depth ?? 0;
      const max = index > 0 ? 1 : 0;
      if (min > max) continue;
      const depth = min + Math.floor(next() * (max - min + 1));
      const repeats = task(rows, dragged.id).repeat !== null;
      const intent = { id: dragged.id, listId: to, ...family(target, index, depth) };
      const result = act(rows, moveTask, intent);
      result.puts.forEach(expectServerAccepts);

      if (depth === 1 && repeats) {
        // A repeating task cannot become a subtask.
        expect(result.puts).toEqual([]);
        continue;
      }
      const expected = [...target.slice(0, index), ...block.map((row, i) => ({ id: row.id, depth: i === 0 ? depth : 1 })), ...target.slice(index)];
      expect(screen(result.rows, to), JSON.stringify(intent)).toEqual(expected);
      if (to !== from) expect(screen(result.rows, from)).toEqual(before.filter((row) => !blockIds.has(row.id)));
      // A row that is not in the block gets no change, or only a new key (when two keys were
      // equal). The new parent can also let go of an old parent.
      for (const put of result.puts) {
        // The completed subtasks of the task are not on the screen, and they go with the task.
        if (blockIds.has(put.id) || task(rows, put.id).parentId === dragged.id) continue;
        const changed = Object.keys(put.fields).filter((key) => key !== 'pos');
        expect(put.id === intent.parentId ? changed.filter((key) => key !== 'parentId') : changed, JSON.stringify(put)).toEqual([]);
      }
      if (result.puts.length) moves++;
      rows = result.rows;
    }
    expect(moves).toBeGreaterThan(200);
    // No key grew long, and each open subtask has an open parent in its list.
    for (const each of rows.tasks.values()) expect(each.pos.length).toBeLessThanOrEqual(40);
  });
});

describe('many tasks at one place', () => {
  test('1500 new tasks, each directly below the same task: the order is right and the keys stay short', () => {
    const w = world();
    w.list('l1');
    w.task('first');
    w.task('last');
    let rows = w.rows;
    let puts = 0;
    let largest = 0;
    for (let i = 0; i < 1500; i++) {
      const result = createTask({ rows, now: NOW, today: TODAY, me: ME, locale: LOCALE }, { listId: 'l1', title: `t${i}`, id: `t${i}`, position: { after: 'first' } });
      puts += result.puts.length;
      largest = Math.max(largest, result.puts.length);
      const after = copy(rows);
      applyPuts(after, result.puts);
      rows = after;
    }
    const ids = shown(rows);
    expect(ids).toHaveLength(1502);
    expect(ids[0]).toBe('first');
    expect(ids[1501]).toBe('last');
    // The newest task is directly below "first", so the new tasks are in the opposite order.
    for (let i = 1; i <= 1500; i++) if (ids[i] !== `t${1500 - i}`) throw new Error(`row ${i} is ${ids[i]}`);
    const keys = [...rows.tasks.values()].sort(comparePos).map((each) => each.pos);
    expect(new Set(keys).size).toBe(1502);
    expect(Math.max(...keys.map((key) => key.length))).toBeLessThanOrEqual(40);
    // Now and then all siblings get new keys. Most actions give one put.
    expect(largest).toBeLessThanOrEqual(1502);
    expect(puts / 1500).toBeLessThan(12);
  });

  test('1500 new tasks, each below the task before it, and 1500 new subtasks at the end', () => {
    const w = world();
    w.list('l1');
    w.task('first');
    w.task('last');
    let rows = w.rows;
    let above = 'first';
    for (let i = 0; i < 1500; i++) {
      const result = createTask({ rows, now: NOW, today: TODAY, me: ME, locale: LOCALE }, { listId: 'l1', title: `t${i}`, id: `t${i}`, position: { after: above } });
      const after = copy(rows);
      applyPuts(after, result.puts);
      rows = after;
      above = `t${i}`;
    }
    for (let i = 0; i < 1500; i++) {
      const result = createTask({ rows, now: NOW, today: TODAY, me: ME, locale: LOCALE }, { listId: 'l1', title: `s${i}`, id: `s${i}`, position: { parentId: 'first', at: 'end' } });
      expect(result.puts).toHaveLength(1);
      const after = copy(rows);
      applyPuts(after, result.puts);
      rows = after;
    }
    const ids = shown(rows);
    expect(ids).toHaveLength(3002);
    expect(ids.slice(0, 3)).toEqual(['first', '  s0', '  s1']);
    expect(ids.slice(1500, 1503)).toEqual(['  s1499', 't0', 't1']);
    expect(ids.slice(-2)).toEqual(['t1499', 'last']);
    expect(Math.max(...[...rows.tasks.values()].map((each) => each.pos.length))).toBeLessThanOrEqual(40);
  });
});

describe('the undo of many actions in the opposite order', () => {
  test.each([31, 32, 33])('seed %i: gives the rows of the start, and the server accepts each put', (seed) => {
    const next = seeded(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
    const w = standard();
    w.list('l3', { pos: null });
    w.task('done', { completed: true, completedAt: 5, completedBy: ME });
    w.task('done1', { parentId: 'done', completed: true, completedAt: 5, completedBy: ME });
    w.task('rep', { repeat: { ...DAILY, end: { type: 'after', count: 3 } }, due: TODAY });
    w.task('rep1', { parentId: 'rep' });
    w.task('x', { listId: 'l2' });
    const start = w.rows;
    let rows = start;
    let made = 0;
    const undos: Put[][] = [];
    const anyTask = (): ID => pick([...rows.tasks.keys()]);
    const anyList = (): ID => pick([...rows.lists.keys()]);
    const maybe = <T>(value: T): T | undefined => (next() < 0.5 ? value : undefined);
    const steps: (() => ActionResult & { rows: Rows })[] = [
      () => act(rows, createTask, { listId: anyList(), title: `n${made} 😀`, id: `n${made++}`, position: pick([{ at: 'top' as const }, { after: anyTask() }, { parentId: anyTask(), at: 'end' as const }]), repeat: maybe(DAILY), due: maybe('2026-10-09'), time: maybe('08:15') }),
      () => act(rows, updateTask, { id: anyTask(), title: pick(['x', ' y ', '']), notes: maybe('notes'), deadline: pick([undefined, null, '2026-10-20']), due: pick([undefined, null, '2026-10-08']) }),
      () => act(rows, setDate, { id: anyTask(), due: pick([null, '2026-10-05', '2026-10-09']), time: pick([null, '10:30']) }),
      () => act(rows, setRepeat, { id: anyTask(), rule: pick([null, DAILY, WEEKLY]) }),
      () => act(rows, completeTask, { id: anyTask() }),
      () => act(rows, completeTask, { id: anyTask() }),
      () => act(rows, uncompleteTask, { id: anyTask() }),
      () => act(rows, deleteTask, { id: anyTask() }),
      () => act(rows, moveTask, { id: anyTask(), listId: maybe(anyList()), parentId: pick([undefined, null, anyTask()]), beforeId: maybe(anyTask()), afterId: maybe(anyTask()) }),
      () => act(rows, indentTask, { id: anyTask() }),
      () => act(rows, unindentTask, { id: anyTask() }),
      () => act(rows, moveToTop, { id: anyTask() }),
      () => act(rows, setStar, { id: anyTask(), starred: next() < 0.5 }),
      () => act(rows, createList, { title: 'list', id: `list${made++}` }),
      () => act(rows, renameList, { id: anyList(), title: pick(['', 'New name']) }),
      () => act(rows, setListSort, { id: anyList(), sort: pick(['my', 'date', 'title'] as const) }),
      () => act(rows, setListHidden, { id: anyList(), hidden: next() < 0.5 }),
      () => act(rows, setListShared, { id: anyList(), shared: next() < 0.5 }),
      () => act(rows, moveList, { id: anyList(), beforeId: maybe(anyList()), afterId: maybe(anyList()), toFirst: next() < 0.2 }),
      () => act(rows, deleteList, { id: anyList() }),
      () => act(rows, clearCompleted, { listId: anyList() }),
    ];
    for (let i = 0; i < 600; i++) {
      const result = pick(steps)();
      [...result.puts, ...result.undo].forEach(expectServerAccepts);
      if (result.puts.length) undos.push(result.undo);
      rows = result.rows;
    }
    expect(undos.length).toBeGreaterThan(150);
    const back = copy(rows);
    for (const undo of undos.reverse()) applyPuts(back, undo);
    for (const [id, row] of start.tasks) expect(back.tasks.get(id), id).toEqual(row);
    for (const [id, row] of start.lists) expect(back.lists.get(id), id).toEqual(row);
    // Each row that an action made is deleted again.
    for (const [id, row] of back.tasks) if (!start.tasks.has(id)) expect(row.deleted, id).toBe(true);
    for (const [id, row] of back.lists) if (!start.lists.has(id)) expect(row.deleted, id).toBe(true);
  });
});

describe('each action with ids that are not there', () => {
  test('gives no puts and does not throw', () => {
    const empty = emptyRows();
    const { rows } = standard();
    for (const state of [empty, rows]) {
      const results = [
        act(state, createTask, { listId: 'nope', title: 'x' }),
        act(state, updateTask, { id: 'nope', title: 'x' }),
        act(state, setDate, { id: 'nope', due: TODAY }),
        act(state, setRepeat, { id: 'nope', rule: DAILY }),
        act(state, completeTask, { id: 'nope' }),
        act(state, uncompleteTask, { id: 'nope' }),
        act(state, deleteTask, { id: 'nope' }),
        act(state, moveTask, { id: 'nope' }),
        act(state, indentTask, { id: 'nope' }),
        act(state, unindentTask, { id: 'nope' }),
        act(state, moveToTop, { id: 'nope' }),
        act(state, setStar, { id: 'nope', starred: true }),
        act(state, renameList, { id: 'nope', title: 'x' }),
        act(state, setListSort, { id: 'nope', sort: 'date' }),
        act(state, setListHidden, { id: 'nope', hidden: true }),
        act(state, setListShared, { id: 'nope', shared: true }),
        act(state, moveList, { id: 'nope', toFirst: true }),
        act(state, deleteList, { id: 'nope' }),
        act(state, clearCompleted, { listId: 'nope' }),
      ];
      for (const result of results) expect(result).toMatchObject({ puts: [], undo: [], message: null });
    }
  });
});

describe('setRepeat from a dialog that the person opens again', () => {
  const weekly: RepeatRule = { every: 1, unit: 'week', weekdays: [1, 3, 5], start: '2026-06-01', end: { type: 'after', count: 30 } };

  test('the same rule again changes nothing: the date and the count stay', () => {
    const w = standard();
    w.task('r', { repeat: weekly, due: '2026-10-09', repeatCount: 12 });
    w.task('resting', { repeat: weekly, due: '2026-10-07', hiddenUntil: '2026-10-07', lastDoneDue: '2026-10-05', lastDoneAt: 5, repeatCount: 4 });
    for (const id of ['r', 'resting']) {
      expect(act(w.rows, setRepeat, { id, rule: weekly }).puts).toEqual([]);
      expect(act(w.rows, setRepeat, { id, rule: structuredClone(weekly) }).puts).toEqual([]);
      // A dialog makes the rule new each time: the keys have a different order, a field with no
      // value is there, and the weekdays are in the order of the clicks.
      const again = { end: { count: 30, type: 'after' }, monthDay: undefined, weekdays: [5, 1, 3], start: '2026-06-01', unit: 'week', every: 1 } as RepeatRule;
      expect(act(w.rows, setRepeat, { id, rule: again }).puts).toEqual([]);
    }
  });

  test('a different rule with its start in the past: the date is the first date of the rule from today, not the old start', () => {
    const w = standard();
    w.task('r', { repeat: weekly, due: '2026-10-09', repeatCount: 12 });
    // Only the end is different. The first date of the rule is 1 June.
    const longer: RepeatRule = { ...weekly, end: { type: 'never' } };
    expect(task(act(w.rows, setRepeat, { id: 'r', rule: longer }).rows, 'r')).toMatchObject({ repeat: longer, due: '2026-10-07', repeatCount: 0 });
    // Today is a date of the rule: Tuesday.
    const tuesdays: RepeatRule = { ...weekly, weekdays: [2] };
    expect(task(act(w.rows, setRepeat, { id: 'r', rule: tuesdays }).rows, 'r').due).toBe(TODAY);
    const monthly: RepeatRule = { every: 1, unit: 'month', monthMode: 'day', monthDay: 31, start: '2025-01-31', end: { type: 'never' } };
    expect(task(act(w.rows, setRepeat, { id: 'a', rule: monthly }).rows, 'a').due).toBe('2026-10-31');
    const everyTwoWeeks: RepeatRule = { every: 2, unit: 'week', weekdays: [1], start: '2025-01-06', end: { type: 'never' } };
    // The weeks still count from the start of the rule: this week is not a week of the rule.
    expect(task(act(w.rows, setRepeat, { id: 'a', rule: everyTwoWeeks }).rows, 'a').due).toBe('2026-10-12');
  });

  test('a rule that starts today or later: the first date of the rule, as SPEC.md says', () => {
    const { rows } = standard();
    const later: RepeatRule = { every: 1, unit: 'week', weekdays: [1], start: '2026-11-18', end: { type: 'never' } };
    expect(task(act(rows, setRepeat, { id: 'a', rule: later }).rows, 'a').due).toBe('2026-11-23');
    expect(task(act(rows, setRepeat, { id: 'a', rule: { ...DAILY, start: TODAY } }).rows, 'a').due).toBe(TODAY);
    expect(task(act(rows, createTask, { listId: 'l1', title: 'n', id: 'n', repeat: later }).rows, 'n').due).toBe('2026-11-23');
  });

  test('a new task with a rule that has its start in the past gets the first date from today', () => {
    const { rows } = standard();
    const result = act(rows, createTask, { listId: 'l1', title: 'n', id: 'n', repeat: weekly, due: '2026-06-01' });
    expect(task(result.rows, 'n')).toMatchObject({ repeat: weekly, due: '2026-10-07', repeatCount: 0 });
  });

  test('a resting task with a different rule rests until the first date from today, or is open if that is today', () => {
    const w = standard();
    w.task('r', { repeat: weekly, due: '2026-10-07', hiddenUntil: '2026-10-07', lastDoneDue: '2026-10-05', lastDoneAt: 5, repeatCount: 4 });
    const fridays = act(w.rows, setRepeat, { id: 'r', rule: { ...weekly, weekdays: [5] } });
    expect(task(fridays.rows, 'r')).toMatchObject({ due: '2026-10-09', hiddenUntil: '2026-10-09', repeatCount: 0 });
    const tuesdays = act(w.rows, setRepeat, { id: 'r', rule: { ...weekly, weekdays: [2] } });
    expect(task(tuesdays.rows, 'r')).toMatchObject({ due: TODAY, hiddenUntil: TODAY });
    expect(isOpen({ task: task(tuesdays.rows, 'r'), today: TODAY })).toBe(true);
  });
});
