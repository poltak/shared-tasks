import { describe, expect, test } from 'vitest';
import type { ListRow, ListView, RepeatRule, SortMode, TaskRow } from './types.ts';
import { defaultList, defaultTask } from './merge.ts';
import { buildListView, buildStarredView, comparePos, isOpen, isParentOf, isResting, orderLists } from './view.ts';

/** A Tuesday. */
const TODAY = '2026-10-06';
const LOCALE = 'en-GB';
const DAILY: RepeatRule = { every: 1, unit: 'day', start: '2026-10-01', end: { type: 'never' } };

const L1: ListRow = { ...defaultList('l1'), title: 'One', owner: 'u1', pos: 'a0' };
const L2: ListRow = { ...defaultList('l2'), title: 'Two', owner: 'u1', pos: 'a1' };

let counter = 0;
/** A task of l1. Each new task gets a later order key, so the tasks are in the order of the calls. */
function t(id: string, fields: Partial<TaskRow> = {}): TaskRow {
  counter++;
  return { ...defaultTask(id), listId: 'l1', title: id, pos: 'a' + String(counter).padStart(5, '0'), ...fields };
}

const done = (id: string, at: number, fields: Partial<TaskRow> = {}): TaskRow =>
  t(id, { completed: true, completedAt: at, completedBy: 'u1', ...fields });

const resting = (id: string, at: number, fields: Partial<TaskRow> = {}): TaskRow =>
  t(id, { repeat: DAILY, due: '2026-10-07', hiddenUntil: '2026-10-07', lastDoneDue: TODAY, lastDoneAt: at, repeatCount: 1, ...fields });

function view(tasks: TaskRow[], sort: SortMode = 'my', today = TODAY): ListView {
  return buildListView({ list: L1, tasks, today, sort, locale: LOCALE });
}

/** Each group as its heading and the ids of its tasks. A subtask has two spaces before its id. */
function groups(v: ListView): [string | null, string[]][] {
  return v.groups.map((group) => [group.heading, group.items.map((item) => (item.depth ? '  ' : '') + item.task.id)]);
}

const ids = (v: ListView): string[] => v.groups.flatMap((group) => group.items.map((item) => item.task.id));

describe('isResting and isOpen', () => {
  test('a task rests when it repeats and its hidden date is after today', () => {
    expect(isResting({ task: resting('r', 1), today: TODAY })).toBe(true);
    expect(isResting({ task: resting('r', 1), today: '2026-10-07' })).toBe(false);
    expect(isResting({ task: resting('r', 1), today: '2026-10-08' })).toBe(false);
    expect(isResting({ task: t('r', { repeat: DAILY, due: TODAY }), today: TODAY })).toBe(false);
    // With no rule, an old hidden date means nothing.
    expect(isResting({ task: t('x', { hiddenUntil: '2026-12-01' }), today: TODAY })).toBe(false);
  });

  test('a task is open when it is not deleted, not completed, and not resting', () => {
    expect(isOpen({ task: t('a'), today: TODAY })).toBe(true);
    expect(isOpen({ task: t('a', { deleted: true }), today: TODAY })).toBe(false);
    expect(isOpen({ task: done('a', 1), today: TODAY })).toBe(false);
    expect(isOpen({ task: resting('a', 1), today: TODAY })).toBe(false);
    expect(isOpen({ task: resting('a', 1), today: '2026-10-07' })).toBe(true);
  });
});

describe('isParentOf', () => {
  const child = t('c', { parentId: 'p' });
  test('true only for an open top-level task of the same list', () => {
    expect(isParentOf(t('p'), child)).toBe(true);
    expect(isParentOf(resting('p', 1), child)).toBe(true);
    expect(isParentOf(undefined, child)).toBe(false);
    expect(isParentOf(t('p', { deleted: true }), child)).toBe(false);
    expect(isParentOf(done('p', 1), child)).toBe(false);
    expect(isParentOf(t('p', { listId: 'l2' }), child)).toBe(false);
    expect(isParentOf(t('p', { parentId: 'x' }), child)).toBe(false);
  });
});

describe('comparePos and orderLists', () => {
  test('comparePos uses the plain string order, then the id', () => {
    // 'Z' is before 'a' in the order of the keys. A locale order would put it after.
    const tasks = [t('3', { pos: 'a1' }), t('2', { pos: 'a0' }), t('1', { pos: 'Zz' }), t('0', { pos: 'a0' })];
    expect(tasks.sort(comparePos).map((x) => x.id)).toEqual(['1', '0', '2', '3']);
  });

  test('orderLists: by key, then the lists with no key by time, and no deleted list', () => {
    const lists: ListRow[] = [
      { ...defaultList('none2'), pos: null, createdAt: 20 },
      { ...defaultList('b'), pos: 'a1', createdAt: 1 },
      { ...defaultList('dead'), pos: 'a0V', deleted: true },
      { ...defaultList('none1'), pos: null, createdAt: 10 },
      { ...defaultList('a'), pos: 'a0', createdAt: 99 },
      { ...defaultList('same2'), pos: 'Zz', createdAt: 5 },
      { ...defaultList('same1'), pos: 'Zz', createdAt: 5 },
    ];
    const copy = [...lists];
    expect(orderLists(lists).map((l) => l.id)).toEqual(['same1', 'same2', 'a', 'b', 'none1', 'none2']);
    expect(lists).toEqual(copy);
    expect(orderLists(new Map(lists.map((l) => [l.id, l])).values()).map((l) => l.id)).toEqual(['same1', 'same2', 'a', 'b', 'none1', 'none2']);
  });
});

describe('buildListView, sort "my"', () => {
  test('one group with no heading: tasks by key, each with its subtasks', () => {
    const tasks = [
      t('c', { pos: 'a3' }),
      t('b2', { parentId: 'b', pos: 'a1' }),
      t('a', { pos: 'a1' }),
      t('b1', { parentId: 'b', pos: 'a0' }),
      t('b', { pos: 'a2' }),
    ];
    const v = view(tasks);
    expect(groups(v)).toEqual([[null, ['a', 'b', '  b1', '  b2', 'c']]]);
    expect(v.groups[0]).toMatchObject({ key: 'all', heading: null, tone: 'normal' });
    expect(v.groups[0]!.items.map((item) => [item.task.id, item.depth, item.hasChildren])).toEqual([
      ['a', 0, false],
      ['b', 0, true],
      ['b1', 1, false],
      ['b2', 1, false],
      ['c', 0, false],
    ]);
    expect(v.openCount).toBe(5);
    expect(v.completed).toEqual([]);
  });

  test('the items hold the same row objects', () => {
    const a = t('a');
    expect(view([a]).groups[0]!.items[0]!.task).toBe(a);
  });

  test('equal keys fall back to the id', () => {
    expect(ids(view([t('y', { pos: 'a0' }), t('x', { pos: 'a0' }), t('z', { pos: 'Zz' })]))).toEqual(['z', 'x', 'y']);
  });

  test('an empty list, and a list with only completed tasks, have no groups', () => {
    expect(view([])).toEqual({ groups: [], completed: [], openCount: 0 });
    const v = view([done('a', 1)]);
    expect(v.groups).toEqual([]);
    expect(v.openCount).toBe(0);
    expect(v.completed.map((x) => x.id)).toEqual(['a']);
  });

  test('deleted tasks and tasks of other lists do not show', () => {
    const v = view([t('a'), t('gone', { deleted: true }), t('other', { listId: 'l2' }), done('gone2', 5, { deleted: true })]);
    expect(ids(v)).toEqual(['a']);
    expect(v.completed).toEqual([]);
    expect(v.openCount).toBe(1);
  });

  test('a deleted list shows nothing', () => {
    expect(buildListView({ list: { ...L1, deleted: true }, tasks: [t('a')], today: TODAY, sort: 'my', locale: LOCALE })).toEqual({
      groups: [],
      completed: [],
      openCount: 0,
    });
  });

  describe('the parent rule', () => {
    test('a subtask whose parent is deleted, completed, missing, or in a different list shows as a top-level task', () => {
      const tasks = [
        t('a'),
        t('deleted', { deleted: true }),
        t('s1', { parentId: 'deleted' }),
        done('completed', 9),
        t('s2', { parentId: 'completed' }),
        t('s3', { parentId: 'missing' }),
        t('far', { listId: 'l2' }),
        t('s4', { parentId: 'far' }),
        t('z'),
      ];
      const v = view(tasks);
      expect(groups(v)).toEqual([[null, ['a', 's1', 's2', 's3', 's4', 'z']]]);
      expect(v.groups[0]!.items.every((item) => item.depth === 0 && !item.hasChildren)).toBe(true);
      expect(v.openCount).toBe(6);
    });

    test('such a subtask has its place among the top-level tasks by its key', () => {
      expect(ids(view([t('a', { pos: 'a1' }), t('b', { pos: 'a3' }), t('orphan', { parentId: 'missing', pos: 'a2' })]))).toEqual([
        'a', 'orphan', 'b',
      ]);
    });

    test('the subtask of a resting parent is hidden, and comes back with the parent', () => {
      const tasks = [t('a'), resting('r', 5), t('r1', { parentId: 'r' }), t('r2', { parentId: 'r' })];
      const v = view(tasks);
      expect(groups(v)).toEqual([[null, ['a']]]);
      expect(v.openCount).toBe(1);
      expect(v.completed.map((x) => x.id)).toEqual(['r']);
      const next = view(tasks, 'my', '2026-10-07');
      expect(groups(next)).toEqual([[null, ['a', 'r', '  r1', '  r2']]]);
      expect(next.openCount).toBe(4);
      expect(next.completed).toEqual([]);
    });

    test('the subtask of a resting parent is hidden in each sort', () => {
      const tasks = [t('a'), resting('r', 5), t('r1', { parentId: 'r', starred: true, starredAt: 5, due: TODAY })];
      for (const sort of ['my', 'date', 'deadline', 'starred', 'title'] as const) {
        const v = view(tasks, sort);
        expect(ids(v), sort).toEqual(['a']);
        expect(v.openCount).toBe(1);
      }
    });

    test('a subtask of a subtask shows as a top-level task, so no task is lost', () => {
      const v = view([t('a'), t('b', { parentId: 'a' }), t('c', { parentId: 'b' })]);
      expect(groups(v)).toEqual([[null, ['a', '  b', 'c']]]);
    });

    test('a completed subtask of an open parent is in the completed part, and the parent has no child then', () => {
      const v = view([t('a'), done('a1', 5, { parentId: 'a' })]);
      expect(v.groups[0]!.items).toEqual([{ task: expect.objectContaining({ id: 'a' }), depth: 0, hasChildren: false }]);
      expect(v.completed.map((x) => x.id)).toEqual(['a1']);
    });
  });
});

describe('buildListView, sort "date"', () => {
  const tasks = () => [
    t('none1'),
    t('later', { due: '2026-10-09' }),
    t('past2', { due: '2026-10-05' }),
    t('today-late', { due: TODAY, time: '18:00' }),
    t('tomorrow', { due: '2026-10-07' }),
    t('today-b', { due: TODAY }),
    t('past1', { due: '2026-09-01', time: '10:00' }),
    t('today-early', { due: TODAY, time: '08:30' }),
    t('today-a', { due: TODAY, pos: 'a000001' }),
    t('next-year', { due: '2027-01-02' }),
    t('none2'),
    t('later2', { due: '2026-10-09', time: '07:00' }),
  ];

  test('groups: Past, Today, Tomorrow, each later date, No date', () => {
    const v = view(tasks(), 'date');
    expect(groups(v)).toEqual([
      ['Past', ['past1', 'past2']],
      ['Today', ['today-a', 'today-b', 'today-early', 'today-late']],
      ['Tomorrow', ['tomorrow']],
      ['Fri 9 Oct', ['later', 'later2']],
      ['Sat 2 Jan 2027', ['next-year']],
      ['No date', ['none1', 'none2']],
    ]);
    expect(v.groups.map((group) => [group.key, group.tone])).toEqual([
      ['past', 'past'],
      [TODAY, 'normal'],
      ['2026-10-07', 'normal'],
      ['2026-10-09', 'normal'],
      ['2027-01-02', 'normal'],
      ['none', 'normal'],
    ]);
    expect(v.openCount).toBe(12);
  });

  test('in a group: no time first, then by time, then by key', () => {
    const v = view([
      t('t2', { due: TODAY, time: '09:00', pos: 'a2' }),
      t('n2', { due: TODAY, pos: 'a4' }),
      t('t1', { due: TODAY, time: '09:00', pos: 'a1' }),
      t('n1', { due: TODAY, pos: 'a3' }),
      t('t0', { due: TODAY, time: '00:00', pos: 'a9' }),
    ], 'date');
    expect(groups(v)).toEqual([['Today', ['n1', 'n2', 't0', 't1', 't2']]]);
  });

  test('the past group has the oldest date first', () => {
    const v = view([t('b', { due: '2026-10-05' }), t('c', { due: '2026-10-05', time: '06:00' }), t('a', { due: '2025-12-31', time: '23:00' })], 'date');
    expect(groups(v)).toEqual([['Past', ['a', 'b', 'c']]]);
  });

  test('flat: a subtask is a normal row, in the group of its own date', () => {
    const v = view([t('p', { due: '2026-10-09' }), t('p1', { parentId: 'p', due: TODAY }), t('p2', { parentId: 'p' })], 'date');
    expect(groups(v)).toEqual([['Today', ['p1']], ['Fri 9 Oct', ['p']], ['No date', ['p2']]]);
    expect(v.groups.flatMap((group) => group.items).every((item) => item.depth === 0)).toBe(true);
    expect(v.groups[1]!.items[0]!.hasChildren).toBe(true);
    expect(v.openCount).toBe(3);
  });

  test('only the groups that have tasks', () => {
    expect(groups(view([t('a')], 'date'))).toEqual([['No date', ['a']]]);
    expect(groups(view([t('a', { due: '2026-10-07' })], 'date'))).toEqual([['Tomorrow', ['a']]]);
    expect(view([], 'date').groups).toEqual([]);
  });

  test('the groups move when the day changes', () => {
    const v = view(tasks(), 'date', '2026-10-07');
    expect(groups(v).map(([heading, items]) => [heading, items.length])).toEqual([
      ['Past', 6],
      ['Today', 1],
      ['Fri 9 Oct', 2],
      ['Sat 2 Jan 2027', 1],
      ['No date', 2],
    ]);
  });
});

describe('buildListView, sort "deadline"', () => {
  test('groups: Past, Today, Tomorrow, each later date, No deadline', () => {
    const v = view([
      t('none', { due: TODAY }),
      t('later', { deadline: '2026-10-20' }),
      t('past', { deadline: '2026-10-01' }),
      t('today2', { deadline: TODAY, due: '2026-10-01', time: '10:00' }),
      t('tomorrow', { deadline: '2026-10-07' }),
      t('today1', { deadline: TODAY, pos: 'a000001' }),
      t('sub', { parentId: 'later', deadline: '2026-10-20' }),
    ], 'deadline');
    expect(groups(v)).toEqual([
      ['Past', ['past']],
      ['Today', ['today1', 'today2']],
      ['Tomorrow', ['tomorrow']],
      ['Tue 20 Oct', ['later', 'sub']],
      ['No deadline', ['none']],
    ]);
    expect(v.groups.map((group) => [group.key, group.tone])).toEqual([
      ['past', 'past'],
      [TODAY, 'normal'],
      ['2026-10-07', 'normal'],
      ['2026-10-20', 'normal'],
      ['none', 'normal'],
    ]);
  });
});

describe('buildListView, sort "starred"', () => {
  test('starred tasks first, newest star first, then the others in "my" order', () => {
    const v = view([
      t('a'),
      t('b', { starred: true, starredAt: 100 }),
      t('b1', { parentId: 'b' }),
      t('b2', { parentId: 'b', starred: true, starredAt: 300 }),
      t('c'),
      t('d', { starred: true, starredAt: 200 }),
      t('e', { starred: true, starredAt: null }),
    ], 'starred');
    expect(groups(v)).toEqual([[null, ['b2', 'd', 'b', 'e', 'a', 'b1', 'c']]]);
    expect(v.groups[0]!.key).toBe('all');
    expect(v.groups[0]!.items.every((item) => item.depth === 0)).toBe(true);
    expect(v.groups[0]!.items.find((item) => item.task.id === 'b')!.hasChildren).toBe(true);
    expect(v.openCount).toBe(7);
  });

  test('stars of the same time keep the key order', () => {
    const v = view([t('y', { starred: true, starredAt: 5, pos: 'a2' }), t('x', { starred: true, starredAt: 5, pos: 'a1' })], 'starred');
    expect(ids(v)).toEqual(['x', 'y']);
  });
});

describe('buildListView, sort "title"', () => {
  test('text order with numbers as numbers, and no difference for case and accents', () => {
    const v = view([
      t('1', { title: 'Task 10' }),
      t('2', { title: 'task 2' }),
      t('3', { title: 'Banana' }),
      t('4', { title: 'apple' }),
      t('5', { title: 'Éclair' }),
      t('6', { title: 'eclair', pos: 'Zz' }),
      t('7', { title: 'Task 9' }),
      t('8', { title: 'cherry', parentId: '3' }),
    ], 'title');
    expect(v.groups[0]!.items.map((item) => item.task.title)).toEqual([
      'apple', 'Banana', 'cherry', 'eclair', 'Éclair', 'task 2', 'Task 9', 'Task 10',
    ]);
    expect(v.groups).toHaveLength(1);
    expect(v.groups[0]).toMatchObject({ key: 'all', heading: null, tone: 'normal' });
    expect(v.groups[0]!.items.every((item) => item.depth === 0)).toBe(true);
  });

  test('equal titles keep the key order', () => {
    expect(ids(view([t('b', { title: 'Same', pos: 'a2' }), t('a', { title: 'same', pos: 'a1' })], 'title'))).toEqual(['a', 'b']);
  });

  test('a tag that is not a locale does not throw', () => {
    expect(ids(buildListView({ list: L1, tasks: [t('b', { title: 'b' }), t('a', { title: 'a' })], today: TODAY, sort: 'title', locale: 'not a locale' }))).toEqual(['a', 'b']);
  });
});

describe('the completed part', () => {
  test('completed and resting tasks, newest first, flat, in each sort', () => {
    const tasks = [
      t('open'),
      done('old', 100),
      done('new', 300),
      resting('rest', 200),
      done('sub', 250, { parentId: 'open' }),
      done('no-time', 0, { completedAt: null }),
      done('gone', 999, { deleted: true }),
    ];
    for (const sort of ['my', 'date', 'deadline', 'starred', 'title'] as const) {
      const v = view(tasks, sort);
      expect(v.completed.map((x) => x.id), sort).toEqual(['new', 'sub', 'rest', 'old', 'no-time']);
      expect(ids(v)).toEqual(['open']);
      expect(v.openCount).toBe(1);
    }
  });

  test('a completed task uses its completion time, also when it has an older rest time', () => {
    const v = view([done('a', 500, { lastDoneAt: 900 }), done('b', 600)]);
    expect(v.completed.map((x) => x.id)).toEqual(['b', 'a']);
  });

  test('equal times fall back to the order key, then the id', () => {
    expect(view([done('b', 5), done('a', 5), done('c', 5)]).completed.map((x) => x.id)).toEqual(['b', 'a', 'c']);
    expect(view([done('b', 5, { pos: 'a1' }), done('a', 5, { pos: 'a1' }), done('c', 5, { pos: 'a0' })]).completed.map((x) => x.id)).toEqual(['c', 'a', 'b']);
  });

  test('a parent that was completed with its subtasks is before them, and they keep their order', () => {
    // The ids are in the opposite order, so an order by id would put the subtasks first.
    const tasks = [done('z-parent', 5), done('m-sub1', 5, { parentId: 'z-parent' }), done('a-sub2', 5, { parentId: 'z-parent' }), done('later', 9)];
    expect(view(tasks).completed.map((x) => x.id)).toEqual(['later', 'z-parent', 'm-sub1', 'a-sub2']);
    expect(view([...tasks].reverse()).completed.map((x) => x.id)).toEqual(['later', 'z-parent', 'm-sub1', 'a-sub2']);
  });

  test('a resting task leaves the completed part on its date', () => {
    const tasks = [resting('r', 5), done('d', 1)];
    expect(view(tasks).completed.map((x) => x.id)).toEqual(['r', 'd']);
    const next = view(tasks, 'my', '2026-10-07');
    expect(next.completed.map((x) => x.id)).toEqual(['d']);
    expect(ids(next)).toEqual(['r']);
  });
});

describe('openCount', () => {
  test('counts open tasks and open subtasks, and not the hidden, completed, or deleted ones', () => {
    const v = view([
      t('a'),
      t('a1', { parentId: 'a' }),
      t('a2', { parentId: 'a' }),
      done('a3', 5, { parentId: 'a' }),
      t('b'),
      done('c', 5),
      t('c1', { parentId: 'c' }),
      resting('r', 5),
      t('r1', { parentId: 'r' }),
      t('gone', { deleted: true }),
      t('other', { listId: 'l2' }),
    ]);
    expect(v.openCount).toBe(5);
    expect(ids(v)).toHaveLength(5);
  });

  test('is the same in each sort', () => {
    const tasks = [t('a', { due: TODAY }), t('a1', { parentId: 'a', starred: true, starredAt: 1 }), t('b', { deadline: TODAY }), done('c', 5)];
    for (const sort of ['my', 'date', 'deadline', 'starred', 'title'] as const) {
      const v = view(tasks, sort);
      expect(v.openCount).toBe(3);
      expect(ids(v).sort()).toEqual(['a', 'a1', 'b']);
    }
  });
});

describe('buildStarredView', () => {
  const lists = [L1, L2];
  const starred = (tasks: TaskRow[], sort: 'date' | 'starred', today = TODAY): ListView =>
    buildStarredView({ lists, tasks, today, sort, locale: LOCALE });
  const star = (id: string, at: number, fields: Partial<TaskRow> = {}): TaskRow => t(id, { starred: true, starredAt: at, ...fields });

  test('sort "starred": one group, newest star first, from all lists', () => {
    const v = starred([
      star('a', 100),
      star('b', 300, { listId: 'l2' }),
      t('plain'),
      star('c', 200),
      star('sub', 400, { parentId: 'a' }),
    ], 'starred');
    expect(groups(v)).toEqual([[null, ['sub', 'b', 'c', 'a']]]);
    expect(v.groups[0]).toMatchObject({ key: 'all', heading: null, tone: 'normal' });
    expect(v.openCount).toBe(4);
    expect(v.completed).toEqual([]);
    expect(v.groups[0]!.items.every((item) => item.depth === 0)).toBe(true);
    expect(v.groups[0]!.items.find((item) => item.task.id === 'a')!.hasChildren).toBe(true);
  });

  test('sort "date": the date groups', () => {
    const v = starred([
      star('none', 1),
      star('today2', 1, { due: TODAY, listId: 'l2', pos: 'a0' }),
      star('today1', 1, { due: TODAY, pos: 'a9' }),
      star('timed', 1, { due: TODAY, time: '07:00', listId: 'l2' }),
      star('past', 1, { due: '2026-10-01' }),
      star('tomorrow', 1, { due: '2026-10-07' }),
      star('later', 1, { due: '2026-11-02', listId: 'l2' }),
      t('plain', { due: TODAY }),
    ], 'date');
    expect(groups(v)).toEqual([
      ['Past', ['past']],
      // In a group, the tasks of the first list are first.
      ['Today', ['today1', 'today2', 'timed']],
      ['Tomorrow', ['tomorrow']],
      ['Mon 2 Nov', ['later']],
      ['No date', ['none']],
    ]);
    expect(v.groups[0]!.tone).toBe('past');
    expect(v.openCount).toBe(7);
  });

  test('only open tasks: not completed, resting, deleted, or hidden below a resting parent', () => {
    const v = starred([
      star('a', 1),
      done('done', 5, { starred: true, starredAt: 9 }),
      resting('rest', 5, { starred: true, starredAt: 9 }),
      star('rest1', 9, { parentId: 'rest' }),
      star('gone', 9, { deleted: true }),
    ], 'starred');
    expect(ids(v)).toEqual(['a']);
    expect(v.completed).toEqual([]);
    expect(ids(starred([resting('rest', 5, { starred: true, starredAt: 9 }), star('rest1', 8, { parentId: 'rest' })], 'starred', '2026-10-07'))).toEqual(['rest', 'rest1']);
  });

  test('only the tasks of the lists that are given and not deleted', () => {
    const tasks = [star('a', 1), star('b', 2, { listId: 'l2' }), star('c', 3, { listId: 'l3' })];
    expect(ids(starred(tasks, 'starred'))).toEqual(['b', 'a']);
    expect(ids(buildStarredView({ lists: [L1, { ...L2, deleted: true }], tasks, today: TODAY, sort: 'starred', locale: LOCALE }))).toEqual(['a']);
    expect(buildStarredView({ lists: [], tasks, today: TODAY, sort: 'date', locale: LOCALE })).toEqual({ groups: [], completed: [], openCount: 0 });
  });

  test('stars of the same time: the order of the lists, then the key', () => {
    const tasks = [star('b', 5, { listId: 'l2', pos: 'a0' }), star('a2', 5, { pos: 'a2' }), star('a1', 5, { pos: 'a1' })];
    expect(ids(starred(tasks, 'starred'))).toEqual(['a1', 'a2', 'b']);
    expect(ids(buildStarredView({ lists: [L2, L1], tasks, today: TODAY, sort: 'starred', locale: LOCALE }))).toEqual(['b', 'a1', 'a2']);
  });

  test('a starred subtask of a parent in a different list shows', () => {
    expect(ids(starred([t('p', { listId: 'l2' }), star('s', 1, { parentId: 'p' })], 'starred'))).toEqual(['s']);
  });
});

describe('inputs and speed', () => {
  function freeze<T extends object>(value: T): T {
    for (const inner of Object.values(value)) if (typeof inner === 'object' && inner !== null) freeze(inner);
    return Object.freeze(value);
  }

  test('the views do not change their inputs', () => {
    const tasks = freeze([
      t('c', { due: TODAY, starred: true, starredAt: 2 }),
      t('a', { due: '2026-10-01', deadline: TODAY }),
      t('a1', { parentId: 'a', starred: true, starredAt: 3 }),
      done('d2', 9),
      done('d1', 10),
      resting('r', 4, { starred: true }),
      t('b', { listId: 'l2', starred: true, starredAt: 1 }),
    ]);
    const lists = freeze([L2, L1]);
    const order = tasks.map((x) => x.id);
    for (const sort of ['my', 'date', 'deadline', 'starred', 'title'] as const) {
      buildListView({ list: lists[1]!, tasks, today: TODAY, sort, locale: LOCALE });
    }
    for (const sort of ['date', 'starred'] as const) buildStarredView({ lists, tasks, today: TODAY, sort, locale: LOCALE });
    expect(tasks.map((x) => x.id)).toEqual(order);
  });

  test('the same inputs give equal views', () => {
    const tasks = [t('a', { due: TODAY }), t('a1', { parentId: 'a' }), done('d', 1), t('b', { starred: true, starredAt: 1 })];
    for (const sort of ['my', 'date', 'deadline', 'starred', 'title'] as const) {
      expect(view(tasks, sort)).toEqual(view([...tasks].reverse(), sort));
    }
  });

  test('a list with 5000 tasks builds fast in each sort', () => {
    const tasks: TaskRow[] = [];
    for (let i = 0; i < 5000; i++) {
      const parent = i % 5 === 0 ? null : `t${i - (i % 5)}`;
      tasks.push(
        t(`t${i}`, {
          parentId: parent,
          title: `Task ${(i * 7919) % 5000}`,
          pos: 'a' + String((i * 104729) % 100000).padStart(5, '0'),
          due: i % 3 === 0 ? `2026-10-${String(1 + (i % 28)).padStart(2, '0')}` : null,
          time: i % 6 === 0 ? `${String(i % 24).padStart(2, '0')}:00` : null,
          deadline: i % 4 === 0 ? `2026-11-${String(1 + (i % 28)).padStart(2, '0')}` : null,
          starred: i % 7 === 0,
          starredAt: i % 7 === 0 ? i : null,
          completed: i % 11 === 0,
          completedAt: i % 11 === 0 ? i : null,
        }),
      );
    }
    // The first call of a sort makes the Intl objects of the locale.
    view(tasks, 'title');
    view(tasks, 'date');
    for (const sort of ['my', 'date', 'deadline', 'starred', 'title'] as const) {
      const started = performance.now();
      const v = view(tasks, sort);
      const ms = performance.now() - started;
      expect(v.openCount + v.completed.length).toBe(5000);
      expect(ids(v)).toHaveLength(v.openCount);
      // A normal list has less than 100 tasks. The limit is far above the time on a fast computer,
      // so a slow test computer does not fail, but a quadratic loop does.
      expect(ms, sort).toBeLessThan(250);
    }
    const started = performance.now();
    const v = buildStarredView({ lists: [L1], tasks, today: TODAY, sort: 'date', locale: LOCALE });
    expect(performance.now() - started).toBeLessThan(250);
    expect(v.openCount).toBeGreaterThan(500);
  });
});

// ---- Review tests ----

describe('tasks that a flat sort sees as equal stay in "my order"', () => {
  // The order key of a subtask is among its siblings only. These rows are as the actions make
  // them: the subtasks of c have the first keys of the scheme, as the top-level tasks a and b have.
  const rows = (): TaskRow[] => [
    t('c2', { parentId: 'c', pos: 'a1' }),
    t('b', { pos: 'a1' }),
    t('c', { pos: 'a2' }),
    t('a', { pos: 'a0' }),
    t('c1', { parentId: 'c', pos: 'a0' }),
  ];
  const myOrder = ['a', 'b', 'c', 'c1', 'c2'];

  test('the rows in "my order"', () => {
    expect(groups(view(rows(), 'my'))).toEqual([[null, ['a', 'b', 'c', '  c1', '  c2']]]);
  });

  test.each(['date', 'deadline'] as const)('sort "%s": the tasks with no date', (sort) => {
    expect(ids(view(rows(), sort))).toEqual(myOrder);
    expect(view(rows(), sort).groups.map((group) => group.key)).toEqual(['none']);
  });

  test('sort "date": the tasks of one date with the same time, and with no time', () => {
    const sameDate = rows().map((row) => ({ ...row, due: TODAY }));
    expect(groups(view(sameDate, 'date'))).toEqual([['Today', myOrder]]);
    const sameTime = rows().map((row) => ({ ...row, due: TODAY, time: '09:00' }));
    expect(groups(view(sameTime, 'date'))).toEqual([['Today', myOrder]]);
    // The time is still before "my order".
    const early = rows().map((row) => ({ ...row, due: TODAY, time: row.id === 'c2' ? '07:00' : '09:00' }));
    expect(ids(view(early, 'date'))).toEqual(['c2', 'a', 'b', 'c', 'c1']);
    const past = rows().map((row) => ({ ...row, due: '2026-10-01' }));
    expect(groups(view(past, 'date'))).toEqual([['Past', myOrder]]);
  });

  test('sort "deadline": the tasks of one deadline. The time of the date has no effect', () => {
    const tasks = rows().map((row) => ({ ...row, deadline: '2026-10-09', due: TODAY, time: row.id === 'c2' ? '07:00' : null }));
    expect(groups(view(tasks, 'deadline'))).toEqual([['Fri 9 Oct', myOrder]]);
  });

  test('sort "title": equal titles', () => {
    const tasks = rows().map((row) => ({ ...row, title: row.id === 'b' ? 'same' : 'Same' }));
    expect(ids(view(tasks, 'title'))).toEqual(myOrder);
  });

  test('sort "starred": stars of the same time, then the tasks with no star', () => {
    const tasks = rows().map((row) => ({ ...row, starred: row.id !== 'b', starredAt: row.id !== 'b' ? 7 : null }));
    expect(ids(view(tasks, 'starred'))).toEqual(['a', 'c', 'c1', 'c2', 'b']);
  });

  test('the starred view: a starred subtask has the place of its parent, also when the parent has no star', () => {
    const tasks = rows().map((row) => ({ ...row, starred: row.id !== 'c', starredAt: row.id !== 'c' ? 7 : null }));
    tasks.push(t('z', { listId: 'l2', pos: 'Zz', starred: true, starredAt: 7 }));
    for (const sort of ['date', 'starred'] as const) {
      const v = buildStarredView({ lists: [L1, L2], tasks, today: TODAY, sort, locale: LOCALE });
      expect(ids(v), sort).toEqual(['a', 'b', 'c1', 'c2', 'z']);
      expect(v.openCount).toBe(5);
      const other = buildStarredView({ lists: [L2, L1], tasks, today: TODAY, sort, locale: LOCALE });
      expect(ids(other), sort).toEqual(['z', 'a', 'b', 'c1', 'c2']);
    }
  });

  test('the order of the input rows has no effect on a view', () => {
    let s = 77;
    const next = (): number => {
      s = (s + 0x6d2b79f5) >>> 0;
      let x = s;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
    const tasks: TaskRow[] = [];
    for (let i = 0; i < 300; i++) {
      // Few different values, so each sort has many equal tasks.
      const parent = i > 20 && next() < 0.3 ? `t${Math.floor(next() * 20)}` : null;
      tasks.push(
        t(`t${i}`, {
          listId: pick(['l1', 'l1', 'l2']),
          parentId: parent,
          pos: pick(['a0', 'a1', 'a2', 'a3', 'a1V']),
          title: pick(['one', 'One', 'two', 'Task 2', 'Task 10']),
          due: pick([null, null, TODAY, '2026-10-01', '2026-10-09']),
          time: pick([null, null, '09:00', '18:30']),
          deadline: pick([null, TODAY, '2026-10-12']),
          starred: next() < 0.4,
          starredAt: pick([null, 1, 2, 3]),
          completed: next() < 0.2,
          completedAt: pick([null, 5, 6]),
        }),
      );
    }
    const shuffled = (): TaskRow[] => {
      const copy = [...tasks];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      }
      return copy;
    };
    for (const sort of ['my', 'date', 'deadline', 'starred', 'title'] as const) {
      const expected = view(tasks, sort);
      for (let round = 0; round < 5; round++) expect(view(shuffled(), sort), sort).toEqual(expected);
    }
    for (const sort of ['date', 'starred'] as const) {
      const expected = buildStarredView({ lists: [L1, L2], tasks, today: TODAY, sort, locale: LOCALE });
      expect(expected.openCount).toBeGreaterThan(20);
      for (let round = 0; round < 5; round++) {
        expect(buildStarredView({ lists: [L1, L2], tasks: shuffled(), today: TODAY, sort, locale: LOCALE }), sort).toEqual(expected);
      }
    }
  });
});

describe('sort "title" with numbers, emoji, and other scripts', () => {
  const titles = (tasks: TaskRow[], locale = LOCALE): string[] =>
    buildListView({ list: L1, tasks, today: TODAY, sort: 'title', locale }).groups.flatMap((group) => group.items.map((item) => item.task.title));
  const byTitle = (list: string[]): TaskRow[] => list.map((title, i) => t(`n${i}`, { title }));

  test('a number in a title sorts as a number, also with more than one number', () => {
    expect(titles(byTitle(['Step 10', 'Step 9', 'step 100', 'Step 1', 'Step 2b', 'Step 2a', 'Step 02']))).toEqual([
      'Step 1',
      'Step 02',
      'Step 2a',
      'Step 2b',
      'Step 9',
      'Step 10',
      'step 100',
    ]);
    expect(titles(byTitle(['v1.10', 'v1.9', 'v1.2', 'v10.0', 'v2.0']))).toEqual(['v1.2', 'v1.9', 'v1.10', 'v2.0', 'v10.0']);
    expect(titles(byTitle(['10 eggs', '9 eggs', '100 eggs', 'eggs']))).toEqual(['9 eggs', '10 eggs', '100 eggs', 'eggs']);
  });

  test('titles with emoji: no row is lost, and the text after the same emoji gives the order', () => {
    const list = ['🎉 Party 10', '🎉 Party 9', '🍎 Apples', 'Zebra', 'apple', '👨‍👩‍👧 Family', '🇻🇳 Trip', '', '🎉'];
    const sorted = titles(byTitle(list));
    expect([...sorted].sort()).toEqual([...list].sort());
    expect(sorted.indexOf('🎉 Party 9')).toBeLessThan(sorted.indexOf('🎉 Party 10'));
    expect(sorted.indexOf('🎉')).toBeLessThan(sorted.indexOf('🎉 Party 9'));
    expect(sorted.indexOf('apple')).toBeLessThan(sorted.indexOf('Zebra'));
    // The same input in a different order gives the same result.
    expect(titles(byTitle(list)).join('|')).toBe(titles(byTitle(list).reverse()).join('|'));
  });

  test('Vietnamese titles: marks and case make no difference to the order of different words', () => {
    expect(titles(byTitle(['Đi chợ', 'ăn sáng', 'Bánh mì', 'Ăn trưa', 'cà phê']), 'vi-VN')).toEqual(['ăn sáng', 'Ăn trưa', 'Bánh mì', 'cà phê', 'Đi chợ']);
  });

  test('titles that are equal for the sort keep "my order", also when the code units are different', () => {
    const tasks = [t('3', { title: 'CAFÉ', pos: 'a3' }), t('1', { title: 'café', pos: 'a1' }), t('2', { title: 'Cafe', pos: 'a2' })];
    expect(ids(view(tasks, 'title'))).toEqual(['1', '2', '3']);
    expect(ids(view([...tasks].reverse(), 'title'))).toEqual(['1', '2', '3']);
  });
});

describe('rows that only a sync of two devices can make', () => {
  test('a task that is its own parent, and two tasks that are the parent of each other, show as top-level tasks', () => {
    const v = view([t('self', { parentId: 'self' }), t('x', { parentId: 'y' }), t('y', { parentId: 'x' }), t('ok')]);
    expect(groups(v)).toEqual([[null, ['self', 'x', 'y', 'ok']]]);
    expect(v.groups[0]!.items.every((item) => !item.hasChildren)).toBe(true);
    expect(v.openCount).toBe(4);
  });

  test('a chain of three: the middle task is a subtask, and its own subtask shows at the top level', () => {
    const v = view([t('top'), t('middle', { parentId: 'top' }), t('low', { parentId: 'middle' })]);
    expect(groups(v)).toEqual([[null, ['top', '  middle', 'low']]]);
    expect(v.openCount).toBe(3);
  });

  test('each row shows one time in each sort, for random rows with random parents', () => {
    let s = 3;
    const next = (): number => {
      s = (s * 1103515245 + 12345) >>> 0;
      return s / 4294967296;
    };
    for (let round = 0; round < 50; round++) {
      const tasks: TaskRow[] = [];
      for (let i = 0; i < 40; i++) {
        tasks.push(
          t(`t${i}`, {
            parentId: next() < 0.5 ? `t${Math.floor(next() * 44)}` : null,
            listId: next() < 0.85 ? 'l1' : 'l2',
            completed: next() < 0.2,
            completedAt: 5,
            deleted: next() < 0.1,
            pos: next() < 0.3 ? 'a0' : 'a' + String(i).padStart(3, '0'),
          }),
        );
      }
      const live = tasks.filter((task) => !task.deleted && task.listId === 'l1');
      for (const sort of ['my', 'date', 'deadline', 'starred', 'title'] as const) {
        const v = view(tasks, sort);
        const all = [...ids(v), ...v.completed.map((task) => task.id)];
        expect(new Set(all).size).toBe(all.length);
        // No task rests here, so no open task is hidden.
        expect([...all].sort()).toEqual(live.map((task) => task.id).sort());
        expect(v.openCount).toBe(ids(v).length);
      }
      // In "my order" a subtask row is directly below its parent or below a sibling.
      const items = view(tasks, 'my').groups.flatMap((group) => group.items);
      let parent: string | null = null;
      for (const item of items) {
        if (item.depth === 0) parent = item.task.id;
        else expect(item.task.parentId).toBe(parent);
      }
      for (const item of items) expect(item.hasChildren).toBe(items.some((other) => other.depth === 1 && other.task.parentId === item.task.id));
    }
  });
});

describe('speed with 5000 tasks in one list', () => {
  test('each sort builds in a few milliseconds', () => {
    let s = 9;
    const next = (): number => {
      s = (s + 0x6d2b79f5) >>> 0;
      let x = s;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    const words = ['Buy', 'milk', 'Call', 'mum', 'Fix', 'bike', '🎉', 'Émile', 'Zoë', '10', '9', '2'];
    const word = (): string => words[Math.floor(next() * words.length)]!;
    const tasks: TaskRow[] = [];
    for (let i = 0; i < 5000; i++) {
      const parent = i > 0 && next() < 0.3 ? tasks[Math.floor(next() * i)]! : null;
      tasks.push(
        t(`id${Math.floor(next() * 1e9)}-${i}`, {
          title: `${word()} ${word()} ${Math.floor(next() * 100)}`,
          pos: 'a' + String(Math.floor(next() * 100000)).padStart(5, '0'),
          parentId: parent && parent.parentId === null ? parent.id : null,
          due: next() < 0.5 ? `2026-${next() < 0.5 ? '09' : '10'}-${String(1 + Math.floor(next() * 28)).padStart(2, '0')}` : null,
          time: next() < 0.2 ? '09:30' : null,
          deadline: next() < 0.2 ? `2026-10-${String(1 + Math.floor(next() * 28)).padStart(2, '0')}` : null,
          completed: next() < 0.3,
          completedAt: Math.floor(next() * 1e6),
          starred: next() < 0.1,
          starredAt: Math.floor(next() * 1e6),
        }),
      );
    }
    const best = (build: () => ListView): number => {
      // The first calls make the Intl objects and let the engine compile the code.
      for (let i = 0; i < 3; i++) build();
      let ms = Infinity;
      for (let i = 0; i < 7; i++) {
        const started = performance.now();
        build();
        ms = Math.min(ms, performance.now() - started);
      }
      return ms;
    };
    const times: Record<string, number> = {};
    for (const sort of ['my', 'date', 'deadline', 'starred', 'title'] as const) times[sort] = best(() => view(tasks, sort));
    times.starredView = best(() => buildStarredView({ lists: [L1], tasks, today: TODAY, sort: 'date', locale: LOCALE }));
    // On the Mac of the project: my 1.5 ms, date 2.5 ms, deadline 2.8 ms, starred 1.8 ms, title 5.5 ms.
    // The limit has room for a slower computer, and a loop in a loop over 5000 rows is far above it.
    for (const [name, ms] of Object.entries(times)) expect(ms, name).toBeLessThan(40);
  });
});
