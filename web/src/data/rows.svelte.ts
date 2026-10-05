import { untrack } from 'svelte';
import { applyPut, emptyRows, sameValue } from '../../../shared/merge.ts';
import type { Rows } from '../../../shared/merge.ts';
import type {
  DateStr,
  ID,
  ListRow,
  ListView,
  Put,
  StarredSort,
  TaskRow,
  ViewGroup,
  ViewItem,
} from '../../../shared/types.ts';
import { buildListView, buildStarredView, comparePos, orderLists } from '../../../shared/view.ts';

// The rows of the device in memory, and what the screen reads from them.
//
// The rows are in plain Maps: 5,000 reactive objects would cost time at each start. A reader
// depends on small counters instead. Each list has two: one for its row and one for its tasks.
// So a change in one list makes only the readers of that list run again.

const EMPTY_VIEW: ListView = Object.freeze({ groups: [], completed: [], openCount: 0 }) as ListView;
const NO_TASKS: TaskRow[] = [];

/** A view, and its items by task id for the next build. */
interface Kept {
  view: ListView;
  items: Map<ID, ViewItem>;
}

/** The tasks and the counters of one list. It can be there before the row of the list is. */
class Cell {
  /** Changes when the row of the list changes. */
  row = $state(0);
  /** Changes when a task of the list changes. */
  rev = $state(0);
  tasks = new Map<ID, TaskRow>();
  /** The number of tasks with a star, in each state. */
  stars = 0;
  view: (Kept & { rev: number; today: DateStr; sort: string }) | null = null;
  /** The subtasks of each parent, in order. Made when a reader asks, dropped at each change. */
  subtasks: Map<ID, TaskRow[]> | null = null;
}

/** What a sync brings: the new row for each id, or null for a row that goes away. */
export interface RowChanges {
  lists: Map<ID, ListRow | null>;
  tasks: Map<ID, TaskRow | null>;
}

/** The ids of the rows that have a different value now. The local database must write them. */
export interface Changed {
  lists: ID[];
  tasks: ID[];
}

export interface RowStore {
  /** For shared/actions.ts and for reads with no dependency. Change the rows only through this store. */
  readonly rows: Rows;
  /** Replaces all rows, at the start of the device. */
  load(input: { lists: readonly ListRow[]; tasks: readonly TaskRow[] }): void;
  /** Applies local puts. Gives the puts that changed a row. */
  apply(puts: readonly Put[]): { applied: Put[]; changed: Changed };
  /** Writes rows from the server. A row with the values that the device has keeps its object. */
  replace(changes: RowChanges): Changed;
  listsOrdered(): ListRow[];
  getList(id: ID): ListRow | undefined;
  getTask(id: ID): TaskRow | undefined;
  listView(listId: ID): ListView;
  starredView(): ListView;
  subtasksOf(taskId: ID): TaskRow[];
  /** Makes the reader depend on each change of a row. For a reader that reads `rows` directly. */
  watchAll(): void;
  /** How many times a view was built. A test reads it. */
  readonly builds: { list: number; starred: number };
}

function sameRow(a: object, b: object): boolean {
  for (const key of Object.keys(a)) {
    if (!sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/**
 * Puts the objects of the view before into the new view where nothing changed: an item, a group,
 * the completed part, or the full view. A keyed list on the screen then updates only the rows
 * that changed, and a reader that gets the same view does nothing.
 */
function keep(view: ListView, before: Kept | null): Kept {
  const items = new Map<ID, ViewItem>();
  const oldGroups = new Map<string, ViewGroup>();
  if (before) for (const group of before.view.groups) oldGroups.set(group.key, group);
  let same = before !== null && before.view.groups.length === view.groups.length && before.view.openCount === view.openCount;

  view.groups.forEach((group, at) => {
    const old = oldGroups.get(group.key);
    let sameGroup =
      old !== undefined && old.heading === group.heading && old.tone === group.tone && old.items.length === group.items.length;
    for (let i = 0; i < group.items.length; i++) {
      let item = group.items[i]!;
      const was = before?.items.get(item.task.id);
      if (was && was.task === item.task && was.depth === item.depth && was.hasChildren === item.hasChildren) {
        item = group.items[i] = was;
      }
      items.set(item.task.id, item);
      if (sameGroup && old!.items[i] !== item) sameGroup = false;
    }
    if (sameGroup) view.groups[at] = old!;
    if (before?.view.groups[at] !== view.groups[at]) same = false;
  });

  const done = before?.view.completed;
  if (done && done.length === view.completed.length && done.every((task, i) => task === view.completed[i])) {
    view.completed = done;
  } else {
    same = false;
  }
  return same ? before! : { view, items };
}

export function createRowStore(input: {
  locale: string;
  /** The two are read in a view, so they must be reactive. */
  today: () => DateStr;
  starredSort: () => StarredSort;
}): RowStore {
  const rows = emptyRows();
  const cells = new Map<ID, Cell>();
  const builds = { list: 0, starred: 0 };

  /** Changes when a list row changes, comes, or goes. */
  let listsRev = $state(0);
  /** Changes when a task changes. For a reader of a task that is not there. */
  let tasksRev = $state(0);
  /** Changes when a task of a list with a star changes. Only these lists are in the starred view. */
  let starsRev = $state(0);
  /** Changes when a list gets its counters. For a reader of a list that is not there. */
  let cellsRev = $state(0);

  let ordered: { rev: number; lists: ListRow[] } | null = null;
  let starred: (Kept & { lists: number; stars: number; today: DateStr; sort: StarredSort }) | null = null;

  // What one change touched. `settle` tells the readers at its end.
  let dirtyLists = new Set<ID>();
  let dirtyCells = new Set<Cell>();
  let starsMoved = false;

  // A reader does not make a cell: a counter that is made in a reader is not a dependency of
  // that reader. So a cell is made here, at a change, and a reader of a list with no cell depends
  // on `cellsRev`.
  function cellOf(listId: ID): Cell {
    let cell = cells.get(listId);
    if (!cell) {
      cell = new Cell();
      cells.set(listId, cell);
      cellsRev += 1;
    }
    return cell;
  }

  function touch(cell: Cell): void {
    if (cell.stars > 0) starsMoved = true;
    dirtyCells.add(cell);
  }

  /** Keeps the tasks of each list and the star counts correct. `next` is in `rows.tasks` already. */
  function indexTask(old: TaskRow | undefined, next: TaskRow | undefined): void {
    if (old) {
      const cell = cellOf(old.listId);
      touch(cell);
      cell.tasks.delete(old.id);
      if (old.starred) cell.stars -= 1;
    }
    if (next) {
      const cell = cellOf(next.listId);
      cell.tasks.set(next.id, next);
      if (next.starred) cell.stars += 1;
      touch(cell);
    }
  }

  /** Tells the readers what changed. One time for each batch of changes. */
  function settle(): void {
    if (dirtyLists.size === 0 && dirtyCells.size === 0) return;
    for (const id of dirtyLists) cellOf(id).row += 1;
    if (dirtyLists.size > 0) listsRev += 1;
    for (const cell of dirtyCells) {
      cell.rev += 1;
      cell.subtasks = null;
    }
    if (dirtyCells.size > 0) tasksRev += 1;
    if (starsMoved) starsRev += 1;
    dirtyLists = new Set();
    dirtyCells = new Set();
    starsMoved = false;
  }

  function load({ lists, tasks }: { lists: readonly ListRow[]; tasks: readonly TaskRow[] }): void {
    untrack(() => {
      for (const id of rows.lists.keys()) dirtyLists.add(id);
      for (const task of rows.tasks.values()) indexTask(task, undefined);
      rows.lists.clear();
      rows.tasks.clear();
      for (const list of lists) {
        rows.lists.set(list.id, list);
        dirtyLists.add(list.id);
      }
      for (const task of tasks) {
        rows.tasks.set(task.id, task);
        indexTask(undefined, task);
      }
      settle();
    });
  }

  function apply(puts: readonly Put[]): { applied: Put[]; changed: Changed } {
    return untrack(() => {
      const applied: Put[] = [];
      const lists = new Set<ID>();
      const tasks = new Set<ID>();
      for (const put of puts) {
        if (put.kind === 'list') {
          const old = rows.lists.get(put.id);
          const next = applyPut(rows, put);
          // null: the row is not there and the put cannot make it. It must not go to the server.
          if (next === null || next === old) continue;
          dirtyLists.add(put.id);
          lists.add(put.id);
        } else {
          const old = rows.tasks.get(put.id);
          const next = applyPut(rows, put);
          if (next === null || next === old) continue;
          indexTask(old, next);
          tasks.add(put.id);
        }
        applied.push(put);
      }
      settle();
      return { applied, changed: { lists: [...lists], tasks: [...tasks] } };
    });
  }

  function replace(changes: RowChanges): Changed {
    return untrack(() => {
      const changed: Changed = { lists: [], tasks: [] };
      for (const [id, next] of changes.lists) {
        const old = rows.lists.get(id);
        if (next ? old !== undefined && sameRow(next, old) : old === undefined) continue;
        if (next) rows.lists.set(id, next);
        else rows.lists.delete(id);
        dirtyLists.add(id);
        changed.lists.push(id);
      }
      for (const [id, next] of changes.tasks) {
        const old = rows.tasks.get(id);
        if (next ? old !== undefined && sameRow(next, old) : old === undefined) continue;
        if (next) rows.tasks.set(id, next);
        else rows.tasks.delete(id);
        indexTask(old, next ?? undefined);
        changed.tasks.push(id);
      }
      settle();
      return changed;
    });
  }

  function listsOrdered(): ListRow[] {
    const rev = listsRev;
    if (ordered?.rev !== rev) ordered = { rev, lists: orderLists(rows.lists.values()) };
    return ordered.lists;
  }

  /** The cell of a list for a reader. With no cell, the reader waits for a new cell. */
  function readCell(listId: ID): Cell | undefined {
    const cell = cells.get(listId);
    if (!cell) void cellsRev;
    return cell;
  }

  function getList(id: ID): ListRow | undefined {
    void readCell(id)?.row;
    const list = rows.lists.get(id);
    return list && !list.deleted ? list : undefined;
  }

  function getTask(id: ID): TaskRow | undefined {
    const task = rows.tasks.get(id);
    if (!task) {
      void tasksRev;
      return undefined;
    }
    void readCell(task.listId)?.rev;
    // A task of a list that the person cannot see is not shown.
    return !task.deleted && getList(task.listId) ? task : undefined;
  }

  function listView(listId: ID): ListView {
    const today = input.today();
    const cell = readCell(listId);
    if (!cell) return EMPTY_VIEW;
    const rev = cell.rev;
    const list = getList(listId);
    if (!list) return EMPTY_VIEW;
    const hit = cell.view;
    if (hit && hit.rev === rev && hit.today === today && hit.sort === list.sort) return hit.view;
    builds.list += 1;
    const view = buildListView({ list, tasks: [...cell.tasks.values()], today, sort: list.sort, locale: input.locale });
    cell.view = { ...keep(view, hit), rev, today, sort: list.sort };
    return cell.view.view;
  }

  function starredView(): ListView {
    const today = input.today();
    const sort = input.starredSort();
    const key = { lists: listsRev, stars: starsRev };
    const hit = starred;
    if (hit && hit.lists === key.lists && hit.stars === key.stars && hit.today === today && hit.sort === sort) return hit.view;
    builds.starred += 1;
    const lists = listsOrdered();
    const tasks: TaskRow[] = [];
    for (const list of lists) {
      const cell = cells.get(list.id);
      if (cell && cell.stars > 0) for (const task of cell.tasks.values()) tasks.push(task);
    }
    const view = buildStarredView({ lists, tasks, today, sort, locale: input.locale });
    starred = { ...keep(view, hit), ...key, today, sort };
    return starred.view;
  }

  function subtasksOf(taskId: ID): TaskRow[] {
    const parent = getTask(taskId);
    // A subtask has no subtasks.
    if (!parent || parent.parentId !== null) return NO_TASKS;
    const cell = cells.get(parent.listId)!;
    if (!cell.subtasks) {
      cell.subtasks = new Map();
      for (const task of cell.tasks.values()) {
        if (task.parentId === null || task.deleted) continue;
        const siblings = cell.subtasks.get(task.parentId);
        if (siblings) siblings.push(task);
        else cell.subtasks.set(task.parentId, [task]);
      }
      for (const siblings of cell.subtasks.values()) siblings.sort(comparePos);
    }
    const subtasks = cell.subtasks.get(taskId) ?? NO_TASKS;
    // An open subtask of a completed parent shows as a task of its own in the list.
    return parent.completed ? subtasks.filter((task) => task.completed) : subtasks;
  }

  function watchAll(): void {
    void listsRev;
    void tasksRev;
  }

  return { rows, load, apply, replace, listsOrdered, getList, getTask, listView, starredView, subtasksOf, watchAll, builds };
}
