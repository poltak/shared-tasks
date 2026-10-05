import type { DateStr, ID, ListRow, ListView, SortMode, StarredSort, TaskRow, ViewGroup, ViewItem } from './types.ts';
import { groupHeading } from './dates.ts';

/** The task repeats and waits in "Completed" for its next date. */
export function isResting({ task, today }: { task: TaskRow; today: DateStr }): boolean {
  return task.repeat !== null && task.hiddenUntil !== null && task.hiddenUntil > today;
}

export function isOpen({ task, today }: { task: TaskRow; today: DateStr }): boolean {
  return !task.deleted && !task.completed && !isResting({ task, today });
}

/**
 * The parent rule. A subtask stays with its parent only while the parent is a top-level task of
 * the same list that is not deleted and not completed. In each other case the subtask shows as a
 * top-level task. Sync can bring such rows: one person deletes a parent while the other person
 * adds a subtask to it.
 */
export function isParentOf(parent: TaskRow | undefined, task: TaskRow): parent is TaskRow {
  return (
    parent !== undefined &&
    !parent.deleted &&
    !parent.completed &&
    parent.parentId === null &&
    parent.listId === task.listId
  );
}

/** Order keys are compared as plain strings, not by locale. Two equal keys fall back to the id. */
export function comparePos(a: TaskRow, b: TaskRow): number {
  return a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The lists that are not deleted, in the order of this person. A list with no key is after all keys. */
export function orderLists(lists: Iterable<ListRow>): ListRow[] {
  const live: ListRow[] = [];
  for (const list of lists) if (!list.deleted) live.push(list);
  return live.sort((a, b) => {
    if (a.pos !== b.pos) {
      if (a.pos === null) return 1;
      if (b.pos === null) return -1;
      return a.pos < b.pos ? -1 : 1;
    }
    return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}

interface Sifted {
  /** Open tasks that show as top-level tasks. */
  top: TaskRow[];
  /** Open subtasks that show below their parent, by the id of the parent. */
  children: Map<ID, TaskRow[]>;
  /** Completed tasks and resting tasks. */
  done: TaskRow[];
}

function sift(tasks: readonly TaskRow[], today: DateStr): Sifted {
  const byId = new Map<ID, TaskRow>();
  for (const task of tasks) byId.set(task.id, task);
  const sifted: Sifted = { top: [], children: new Map(), done: [] };
  for (const task of tasks) {
    if (task.deleted) continue;
    if (task.completed || isResting({ task, today })) {
      sifted.done.push(task);
      continue;
    }
    const parent = task.parentId === null ? undefined : byId.get(task.parentId);
    if (!isParentOf(parent, task)) {
      sifted.top.push(task);
    } else if (!isResting({ task: parent, today })) {
      const siblings = sifted.children.get(parent.id);
      if (siblings) siblings.push(task);
      else sifted.children.set(parent.id, [task]);
    }
    // The subtask of a resting parent is hidden: it comes back with the parent.
  }
  return sifted;
}

/** Each parent, then its subtasks. */
function inMyOrder({ top, children }: Pick<Sifted, 'top' | 'children'>): { task: TaskRow; depth: 0 | 1 }[] {
  const out: { task: TaskRow; depth: 0 | 1 }[] = [];
  for (const task of [...top].sort(comparePos)) {
    out.push({ task, depth: 0 });
    const subtasks = children.get(task.id);
    if (subtasks) for (const subtask of [...subtasks].sort(comparePos)) out.push({ task: subtask, depth: 1 });
  }
  return out;
}

const NO_RANK: ReadonlyMap<ID, number> = new Map();

// The sorts below get the tasks in "my order" and give 0 for two tasks that they see as equal.
// A sort keeps the order of equal items, so such tasks stay in "my order": a subtask is below its
// parent. The order key of a subtask is among its siblings only, so a comparison of the keys of a
// subtask and a top-level task would put them at a random place.

/** Newest star first, then the order of the lists. */
function byStar(rank: ReadonlyMap<ID, number>): (a: TaskRow, b: TaskRow) => number {
  return (a, b) => (b.starredAt ?? 0) - (a.starredAt ?? 0) || (rank.get(a.listId) ?? 0) - (rank.get(b.listId) ?? 0);
}

function oneGroup(items: ViewItem[]): ViewGroup[] {
  return items.length ? [{ key: 'all', heading: null, tone: 'normal', items }] : [];
}

/**
 * Groups for the sort by date or by deadline: "Past", then one group for each date, then the
 * tasks with no date. `tasks` are in "my order". `rank` gives the order of the lists when the
 * tasks are from many lists.
 */
function dateGroups({
  tasks,
  field,
  today,
  locale,
  children,
  rank,
}: {
  tasks: TaskRow[];
  field: 'due' | 'deadline';
  today: DateStr;
  locale: string;
  children: ReadonlyMap<ID, TaskRow[]>;
  rank: ReadonlyMap<ID, number>;
}): ViewGroup[] {
  tasks.sort((a, b) => {
    const dateA = a[field];
    const dateB = b[field];
    if (dateA !== dateB) {
      if (dateA === null) return 1;
      if (dateB === null) return -1;
      return dateA < dateB ? -1 : 1;
    }
    if (field === 'due' && a.time !== b.time) {
      if (a.time === null) return -1;
      if (b.time === null) return 1;
      return a.time < b.time ? -1 : 1;
    }
    return (rank.get(a.listId) ?? 0) - (rank.get(b.listId) ?? 0);
  });
  const groups: ViewGroup[] = [];
  let group: ViewGroup | undefined;
  for (const task of tasks) {
    const date = task[field];
    const key = date === null ? 'none' : date < today ? 'past' : date;
    if (!group || group.key !== key) {
      const heading =
        date === null
          ? field === 'due' ? 'No date' : 'No deadline'
          : date < today ? 'Past' : groupHeading({ date, today, locale });
      group = { key, heading, tone: key === 'past' ? 'past' : 'normal', items: [] };
      groups.push(group);
    }
    group.items.push({ task, depth: 0, hasChildren: children.has(task.id) });
  }
  return groups;
}

const collators = new Map<string, Intl.Collator>();

function collatorOf(locale: string): Intl.Collator {
  let collator = collators.get(locale);
  if (!collator) {
    const options: Intl.CollatorOptions = { numeric: true, sensitivity: 'base' };
    try {
      collator = new Intl.Collator(locale, options);
    } catch {
      collator = new Intl.Collator(undefined, options);
    }
    collators.set(locale, collator);
  }
  return collator;
}

/**
 * What a list shows. `tasks` are the tasks of the list in any state.
 * A group is never empty: a list with no open task has no groups.
 * Group keys: 'all' for a sort with one group, 'past', a date, and 'none'.
 */
export function buildListView({
  list,
  tasks,
  today,
  sort,
  locale,
}: {
  list: ListRow;
  tasks: readonly TaskRow[];
  today: DateStr;
  sort: SortMode;
  locale: string;
}): ListView {
  if (list.deleted) return { groups: [], completed: [], openCount: 0 };
  const sifted = sift(
    tasks.filter((task) => task.listId === list.id),
    today,
  );
  const { children } = sifted;
  const ordered = inMyOrder(sifted);
  const flat = (task: TaskRow): ViewItem => ({ task, depth: 0, hasChildren: children.has(task.id) });

  let groups: ViewGroup[];
  if (sort === 'date' || sort === 'deadline') {
    groups = dateGroups({
      tasks: ordered.map((entry) => entry.task),
      field: sort === 'date' ? 'due' : 'deadline',
      today,
      locale,
      children,
      rank: NO_RANK,
    });
  } else if (sort === 'starred') {
    const starred = ordered.filter((entry) => entry.task.starred).map((entry) => entry.task);
    const others = ordered.filter((entry) => !entry.task.starred).map((entry) => entry.task);
    groups = oneGroup([...starred.sort(byStar(NO_RANK)), ...others].map(flat));
  } else if (sort === 'title') {
    const collator = collatorOf(locale);
    const byTitle = (a: TaskRow, b: TaskRow): number => collator.compare(a.title, b.title);
    groups = oneGroup(ordered.map((entry) => entry.task).sort(byTitle).map(flat));
  } else {
    groups = oneGroup(ordered.map(({ task, depth }) => ({ task, depth, hasChildren: children.has(task.id) })));
  }

  const doneAt = (task: TaskRow): number => (task.completed ? task.completedAt : task.lastDoneAt) ?? 0;
  // A parent and its subtasks get the same time when the person completes the parent. The parent
  // is first then, and its subtasks follow in their order, as they were in the list.
  const level = (task: TaskRow): number => (task.parentId === null ? 0 : 1);
  const completed = sifted.done.sort((a, b) => doneAt(b) - doneAt(a) || level(a) - level(b) || comparePos(a, b));
  return { groups, completed, openCount: ordered.length };
}

/**
 * The open starred tasks of all lists in `lists`, in the same form as a list view.
 * `lists` are the lists that the person can see, in their order. `tasks` are all tasks.
 */
export function buildStarredView({
  lists,
  tasks,
  today,
  sort,
  locale,
}: {
  lists: readonly ListRow[];
  tasks: readonly TaskRow[];
  today: DateStr;
  sort: StarredSort;
  locale: string;
}): ListView {
  const rank = new Map<ID, number>();
  for (const list of lists) if (!list.deleted) rank.set(list.id, rank.size);
  const { top, children } = sift(
    tasks.filter((task) => rank.has(task.listId)),
    today,
  );
  // "My order" of a starred subtask needs its parent, so such a parent stays until the order is made.
  const wanted = top.filter((task) => task.starred || children.get(task.id)?.some((subtask) => subtask.starred));
  const starred = inMyOrder({ top: wanted, children })
    .map((entry) => entry.task)
    .filter((task) => task.starred);

  const groups =
    sort === 'date'
      ? dateGroups({ tasks: starred, field: 'due', today, locale, children, rank })
      : oneGroup(starred.sort(byStar(rank)).map((task) => ({ task, depth: 0, hasChildren: children.has(task.id) })));
  return { groups, completed: [], openCount: starred.length };
}
