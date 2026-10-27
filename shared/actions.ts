import type {
  ActionResult,
  DateStr,
  ID,
  ListFields,
  ListRow,
  NoteColor,
  NoteFields,
  NoteRow,
  Put,
  RepeatRule,
  SortMode,
  TaskFields,
  TaskPosition,
  TaskRow,
  TimeStr,
} from './types.ts';
import { LIMITS, NOTE_COLORS } from './types.ts';
import type { Rows } from './merge.ts';
import { defaultList, defaultNote, defaultTask, sameValue } from './merge.ts';
import { keysBetween } from './fracindex.ts';
import { newId } from './ids.ts';
import { addDays, formatDate, isValidDate, isValidTime } from './dates.ts';
import { firstOccurrence, isFinished, nextOccurrence, validateRule } from './recurrence.ts';
import { comparePos, isOpen, isParentOf, isResting, noteTaskTitles, orderLists } from './view.ts';

// Each action reads the rows and gives the puts that make the change, and the puts that undo it.
// An action that is not possible gives no puts. No action changes the rows: the caller applies
// the puts.

export interface ActionContext {
  rows: Rows;
  /** The time in milliseconds. */
  now: number;
  /** The local date of the device. */
  today: DateStr;
  /** The id of the person who does the action. */
  me: ID;
  locale: string;
}

export interface CreateTaskIntent {
  listId: ID;
  title: string;
  /** The id of the new task. Without it, the action makes one: it is the id of the first put. */
  id?: ID;
  notes?: string;
  due?: DateStr | null;
  time?: TimeStr | null;
  deadline?: DateStr | null;
  repeat?: RepeatRule | null;
  starred?: boolean;
  /** Without it, the task goes to the top of the list. */
  position?: TaskPosition;
}

/** A field that is not in the intent stays as it is. */
export interface UpdateTaskIntent {
  id: ID;
  title?: string;
  notes?: string;
  due?: DateStr | null;
  time?: TimeStr | null;
  deadline?: DateStr | null;
}

export interface SetDateIntent {
  id: ID;
  due: DateStr | null;
  /** No value is the same as null: the task gets no time. */
  time?: TimeStr | null;
}

export interface SetRepeatIntent {
  id: ID;
  rule: RepeatRule | null;
}

export interface TaskIntent {
  id: ID;
}

export interface MoveTaskIntent {
  id: ID;
  /** Without it, the task stays in its list. */
  listId?: ID;
  /**
   * null: the task becomes a top-level task. Without it, the task keeps its parent in the same
   * list, and becomes a top-level task in a different list.
   */
  parentId?: ID | null;
  /** The sibling that follows the task in its new place. */
  beforeId?: ID | null;
  /** The sibling before the task in its new place. With no `beforeId` and no `afterId`, the task goes to the end. */
  afterId?: ID | null;
}

export interface SetStarIntent {
  id: ID;
  starred: boolean;
}

export interface CreateListIntent {
  title: string;
  /** The id of the new list. Without it, the action makes one: it is the id of the first put. */
  id?: ID;
}

export interface RenameListIntent {
  id: ID;
  title: string;
}

export interface SetListSortIntent {
  id: ID;
  sort: SortMode;
}

export interface SetListHiddenIntent {
  id: ID;
  hidden: boolean;
}

export interface SetListSharedIntent {
  id: ID;
  shared: boolean;
}

/** With no `beforeId`, no `afterId`, and no `toFirst`, the list goes to the end. */
export interface MoveListIntent {
  id: ID;
  beforeId?: ID | null;
  afterId?: ID | null;
  toFirst?: boolean;
}

export interface ListIntent {
  id: ID;
}

export interface ClearCompletedIntent {
  listId: ID;
}

export interface CreateNoteIntent {
  /** The id of the new note. Without it, the action makes one: it is the id of the put. */
  id?: ID;
  title?: string;
  body?: string;
  /** A color that is not in NOTE_COLORS gives 'default'. */
  color?: NoteColor;
  pinned?: boolean;
  shared?: boolean;
}

/** A field that is not in the intent stays as it is. */
export interface UpdateNoteIntent {
  id: ID;
  title?: string;
  body?: string;
}

export interface SetNoteColorIntent {
  id: ID;
  color: NoteColor;
}

export interface SetNotePinnedIntent {
  id: ID;
  pinned: boolean;
}

export interface SetNoteArchivedIntent {
  id: ID;
  archived: boolean;
}

export interface SetNoteSharedIntent {
  id: ID;
  shared: boolean;
}

export interface DeleteNoteIntent {
  id: ID;
  /** For a note that the editor made and the person emptied again: no message and no undo. */
  discard?: boolean;
}

export interface NoteToTasksIntent {
  /** The note. */
  id: ID;
  listId: ID;
  /** 'one': one task for the note. 'lines': one task for each line of the body. */
  mode: 'one' | 'lines';
  /** Also archives the note for this person. */
  archive?: boolean;
}

// ---- Collecting the puts of one action ----

function nothing(): ActionResult {
  return { puts: [], undo: [], message: null };
}

/** The changes of one action. Many changes to one row become one put. */
class Batch {
  rows: Rows;
  lists = new Map<ID, ListFields>();
  tasks = new Map<ID, TaskFields>();
  notes = new Map<ID, NoteFields>();
  /** The ids of the rows that the action makes. */
  made = new Set<ID>();
  /** For each row ('note:ID'), the fields that a put has all together or not at all. */
  together = new Map<string, Set<string>>();

  constructor(rows: Rows) {
    this.rows = rows;
  }

  task(id: ID, fields: TaskFields): void {
    this.tasks.set(id, { ...this.tasks.get(id), ...fields });
  }

  list(id: ID, fields: ListFields): void {
    this.lists.set(id, { ...this.lists.get(id), ...fields });
  }

  note(id: ID, fields: NoteFields): void {
    this.notes.set(id, { ...this.notes.get(id), ...fields });
  }

  /**
   * A change of fields that must arrive at the server as one, also the fields that have that value
   * on this device already. The server merges each field by itself. So a pin on one device
   * ({ pinned: true }) and an archive on a different device ({ archived: true }) would give a note
   * that is pinned and archived.
   */
  noteTogether(id: ID, fields: NoteFields): void {
    this.note(id, fields);
    this.together.set(`note:${id}`, new Set([...(this.together.get(`note:${id}`) ?? []), ...Object.keys(fields)]));
  }

  makeTask({ id, ...fields }: TaskRow): void {
    this.made.add(id);
    this.tasks.set(id, fields);
  }

  makeList({ id, ...fields }: ListRow): void {
    this.made.add(id);
    this.lists.set(id, fields);
  }

  makeNote({ id, ...fields }: NoteRow): void {
    this.made.add(id);
    this.notes.set(id, fields);
  }

  /**
   * A task that shows at the top level can have a parent id that points to a deleted or completed
   * task. Before it gets subtasks or a repeat rule, it lets go of that parent.
   */
  detach(task: TaskRow): void {
    if (task.parentId !== null) this.task(task.id, { parentId: null });
  }

  /**
   * One put for each row, with only the fields that get a different value. The puts of new rows
   * are first. With no put, there is no message.
   */
  finish(message: string | null = null): ActionResult {
    const puts: Put[] = [];
    const undo: Put[] = [];
    const kinds = [
      { kind: 'list', changes: this.lists, rows: this.rows.lists },
      { kind: 'task', changes: this.tasks, rows: this.rows.tasks },
      { kind: 'note', changes: this.notes, rows: this.rows.notes },
    ] as const;
    for (const made of [true, false]) {
      for (const { kind, changes, rows } of kinds) {
        for (const [id, fields] of changes) {
          if (this.made.has(id) !== made) continue;
          if (made) {
            puts.push({ kind, id, fields } as Put);
            undo.push({ kind, id, fields: { deleted: true } });
            continue;
          }
          const old = rows.get(id) as Record<string, unknown> | undefined;
          if (!old) continue;
          const next: Record<string, unknown> = {};
          let before: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(fields)) {
            if (value === undefined || sameValue(old[key], value)) continue;
            next[key] = value;
            before[key] = old[key];
          }
          if (Object.keys(next).length === 0) continue;
          for (const key of this.together.get(`${kind}:${id}`) ?? []) {
            if (key in next) continue;
            next[key] = (fields as Record<string, unknown>)[key];
            before[key] = old[key];
          }
          if (kind === 'note' && ('pinned' in before || 'archived' in before)) {
            // The undo of an unpin is a pin, and the undo of an unarchive is an archive. Like the
            // actions, each must have the other field too (see noteTogether). The unpin itself
            // sends only { pinned: false }: an archive that a different device made at the same
            // time must stay.
            before.pinned = old.pinned;
            before.archived = old.archived;
          }
          if (next.deleted === true) {
            // The device drops a deleted row after the next sync. The undo then makes the row
            // again, so it has all fields.
            const { id: _, ...all } = old;
            before = all;
          }
          puts.push({ kind, id, fields: next });
          undo.push({ kind, id, fields: before });
        }
      }
    }
    return { puts, undo, message: puts.length ? message : null };
  }
}

// ---- Reading the rows ----

function liveTask(rows: Rows, id: ID | null | undefined): TaskRow | undefined {
  const task = id == null ? undefined : rows.tasks.get(id);
  return task && !task.deleted ? task : undefined;
}

function liveList(rows: Rows, id: ID | null | undefined): ListRow | undefined {
  const list = id == null ? undefined : rows.lists.get(id);
  return list && !list.deleted ? list : undefined;
}

function liveNote(rows: Rows, id: ID | null | undefined): NoteRow | undefined {
  const note = id == null ? undefined : rows.notes.get(id);
  return note && !note.deleted ? note : undefined;
}

/** The parent that the task shows below, or null for a task that shows at the top level. */
function shownParent(rows: Rows, task: TaskRow): TaskRow | null {
  const parent = task.parentId === null ? undefined : rows.tasks.get(task.parentId);
  return isParentOf(parent, task) ? parent : null;
}

/**
 * The tasks of one level of a list, in order. Completed and resting tasks are in the result,
 * because they keep their place and their keys must stay different from the keys of the others.
 */
function siblingsOf({
  rows,
  listId,
  parentId,
  skip,
}: {
  rows: Rows;
  listId: ID;
  parentId: ID | null;
  skip?: ReadonlySet<ID>;
}): TaskRow[] {
  const siblings: TaskRow[] = [];
  for (const task of rows.tasks.values()) {
    if (task.deleted || task.listId !== listId || skip?.has(task.id)) continue;
    if ((shownParent(rows, task)?.id ?? null) === parentId) siblings.push(task);
  }
  return siblings.sort(comparePos);
}

/**
 * The subtasks that go with a task when it is completed, moved, or deleted, in order.
 * An open subtask of a completed parent shows as a task of its own, so it does not go with it.
 */
function subtasksOf(rows: Rows, task: TaskRow): TaskRow[] {
  if (task.parentId !== null) return [];
  const subtasks: TaskRow[] = [];
  for (const other of rows.tasks.values()) {
    if (other.parentId !== task.id || other.deleted || other.listId !== task.listId) continue;
    if (other.completed || !task.completed) subtasks.push(other);
  }
  return subtasks.sort(comparePos);
}

const MAX_KEY_LENGTH = 40;

/**
 * Gives order keys for `count` new neighbours at `index` of the ordered items.
 * `rekey` gets each old item that needs a new key too.
 */
function place({
  items,
  index,
  count,
  rekey,
}: {
  items: readonly { id: ID; pos: string | null }[];
  index: number;
  count: number;
  rekey: (id: ID, pos: string) => void;
}): string[] {
  // An item with no key sorts after all keys. So each such item before the gap gets a key.
  let from = index;
  while (from > 0 && items[from - 1]!.pos === null) from--;
  const lower = items[from - 1]?.pos ?? null;
  // Two devices can give the same key to two items. No key fits between equal keys, so the
  // items after the gap that are not after `lower` get new keys.
  let to = index;
  for (; lower !== null && to < items.length; to++) {
    const pos = items[to]!.pos;
    if (pos === null || pos > lower) break;
  }
  const upper = items[to]?.pos ?? null;
  let keys: string[] | undefined;
  try {
    keys = keysBetween(lower, upper, to - from + count);
  } catch {
    // A key that is not from the scheme of this app.
  }
  // A key grows by one character for about 6 inserts into the same gap. Before a key gets long,
  // all items get new, short keys. The server refuses a key of more than 1024 characters.
  if (!keys || keys.some((key) => key.length > MAX_KEY_LENGTH)) {
    from = 0;
    to = items.length;
    keys = keysBetween(null, null, items.length + count);
  }
  for (let i = from; i < index; i++) rekey(items[i]!.id, keys[i - from]!);
  for (let i = index; i < to; i++) rekey(items[i]!.id, keys[i - from + count]!);
  return keys.slice(index - from, index - from + count);
}

/**
 * Cuts text to the limit, as the server does. Half of a character pair (an emoji) at the end
 * would be invalid text, so it goes too.
 */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * The date of a task that gets a rule: the first date of the rule. A rule that the person
 * changes after some weeks has its start in the past, and the date must not go back to that
 * start. The date is then the first date of the rule from today.
 */
function firstDue(rule: RepeatRule, today: DateStr): DateStr {
  return rule.start >= today ? firstOccurrence(rule) : nextOccurrence({ rule, after: addDays(today, -1) });
}

/** true for two rules with the same values. A field with no value and the order of the weekdays make no difference. */
function sameRule(a: RepeatRule, b: RepeatRule): boolean {
  const plain = (rule: RepeatRule): unknown =>
    JSON.parse(JSON.stringify({ ...rule, weekdays: rule.weekdays && [...rule.weekdays].sort() }));
  return sameValue(plain(a), plain(b));
}

const STOP_REPEAT: TaskFields = {
  repeat: null,
  repeatCount: 0,
  hiddenUntil: null,
  lastDoneAt: null,
  lastDoneDue: null,
};

// ---- Tasks ----

/** No task if the title is empty after trim, or if the list or the parent is not there. */
export function createTask(ctx: ActionContext, intent: CreateTaskIntent): ActionResult {
  const { rows } = ctx;
  const title = cut(intent.title.trim(), LIMITS.title);
  const list = liveList(rows, intent.listId);
  const id = intent.id ?? newId();
  if (!title || !list || rows.tasks.has(id)) return nothing();

  const batch = new Batch(rows);
  const position = intent.position ?? { at: 'top' };
  let parentId: ID | null = null;
  /** The task directly above the new task. Without it, the new task is the first of its siblings. */
  let above: TaskRow | undefined;
  let atEnd = false;
  if ('parentId' in position) {
    const parent = liveTask(rows, position.parentId);
    // A subtask cannot be a parent. A subtask of a completed task would show as a top-level task.
    if (!parent || parent.listId !== list.id || parent.completed || shownParent(rows, parent)) return nothing();
    batch.detach(parent);
    parentId = parent.id;
    atEnd = true;
  } else if ('after' in position) {
    above = liveTask(rows, position.after);
    if (above?.listId !== list.id) above = undefined;
    // The new task has the same parent as the task above it.
    else parentId = shownParent(rows, above)?.id ?? null;
  }
  const siblings = siblingsOf({ rows, listId: list.id, parentId });
  const [pos] = place({
    items: siblings,
    index: atEnd ? siblings.length : above ? siblings.indexOf(above) + 1 : 0,
    count: 1,
    rekey: (taskId, key) => batch.task(taskId, { pos: key }),
  });

  // A subtask cannot repeat.
  const repeat = parentId === null && validateRule(intent.repeat) ? intent.repeat : null;
  const time = isValidTime(intent.time) ? intent.time : null;
  let due = isValidDate(intent.due) ? intent.due : null;
  if (repeat) due = firstDue(repeat, ctx.today);
  else if (time && !due) due = ctx.today;
  const starred = intent.starred === true;

  batch.makeTask({
    ...defaultTask(id),
    listId: list.id,
    parentId,
    title,
    notes: cut(intent.notes ?? '', LIMITS.notes),
    pos: pos!,
    due,
    time,
    deadline: isValidDate(intent.deadline) ? intent.deadline : null,
    repeat,
    createdAt: ctx.now,
    createdBy: ctx.me,
    starred,
    starredAt: starred ? ctx.now : null,
  });
  return batch.finish();
}

/**
 * The fields for a new date and time. A time needs a date: with no date it gets today.
 * A task with no date cannot repeat. null if a value is not valid.
 */
function dateFields({
  ctx,
  task,
  due,
  time,
}: {
  ctx: ActionContext;
  task: TaskRow;
  due: DateStr | null;
  time: TimeStr | null;
}): TaskFields | null {
  if ((due !== null && !isValidDate(due)) || (time !== null && !isValidTime(time))) return null;
  if (time !== null && due === null) due = ctx.today;
  if (due === null) return { due: null, time: null, ...STOP_REPEAT };
  // A resting task comes back on its date.
  return isResting({ task, today: ctx.today }) ? { due, time, hiddenUntil: due } : { due, time };
}

/** The title cannot become empty: an empty title keeps the old title. The title is kept as typed. */
export function updateTask(ctx: ActionContext, intent: UpdateTaskIntent): ActionResult {
  const task = liveTask(ctx.rows, intent.id);
  if (!task) return nothing();
  const fields: TaskFields = {};
  if (intent.title !== undefined && intent.title.trim()) fields.title = cut(intent.title, LIMITS.title);
  if (intent.notes !== undefined) fields.notes = cut(intent.notes, LIMITS.notes);
  if (intent.deadline === null || isValidDate(intent.deadline)) fields.deadline = intent.deadline;
  if (intent.due !== undefined || intent.time !== undefined) {
    const due = intent.due !== undefined ? intent.due : task.due;
    // A date that goes away takes the time with it.
    const time = intent.time !== undefined ? intent.time : intent.due === null ? null : task.time;
    Object.assign(fields, dateFields({ ctx, task, due, time }));
  }
  const batch = new Batch(ctx.rows);
  batch.task(task.id, fields);
  return batch.finish();
}

/** Sets `due` and `time`. A time with no date sets the date to today. No date stops a repeat. */
export function setDate(ctx: ActionContext, intent: SetDateIntent): ActionResult {
  const task = liveTask(ctx.rows, intent.id);
  const fields = task && dateFields({ ctx, task, due: intent.due, time: intent.time ?? null });
  if (!task || !fields) return nothing();
  const batch = new Batch(ctx.rows);
  batch.task(task.id, fields);
  return batch.finish();
}

/**
 * Sets the rule and sets `due` to its first date (from today, if the start of the rule is in the
 * past). A subtask cannot repeat. null stops the repeat and keeps `due`.
 */
export function setRepeat(ctx: ActionContext, intent: SetRepeatIntent): ActionResult {
  const { rows, today } = ctx;
  const task = liveTask(rows, intent.id);
  if (!task) return nothing();
  const batch = new Batch(rows);
  if (intent.rule === null) {
    batch.task(task.id, STOP_REPEAT);
    return batch.finish();
  }
  if (!validateRule(intent.rule) || shownParent(rows, task)) return nothing();
  // The same rule again is no change: the person closed the dialog and changed nothing. A new
  // first date and a new count would move the task.
  if (task.repeat && sameRule(task.repeat, intent.rule)) return nothing();
  const due = firstDue(intent.rule, today);
  batch.detach(task);
  batch.task(task.id, {
    repeat: intent.rule,
    // A new rule starts its count again.
    repeatCount: 0,
    due,
    hiddenUntil: isResting({ task, today }) ? due : null,
  });
  return batch.finish();
}

/**
 * A task that does not repeat becomes completed, with its open subtasks.
 * A task that repeats goes to its next date and rests until then. After the last date of its
 * rule it stops the repeat and becomes completed.
 */
export function completeTask(ctx: ActionContext, intent: TaskIntent): ActionResult {
  const { rows, now, today, me, locale } = ctx;
  const task = liveTask(rows, intent.id);
  if (!task || task.completed || isResting({ task, today })) return nothing();
  const batch = new Batch(rows);
  const subtasks = subtasksOf(rows, task);

  if (task.repeat) {
    const next = nextOccurrence({ rule: task.repeat, after: task.due !== null && task.due > today ? task.due : today });
    const doneCount = task.repeatCount + 1;
    if (!isFinished({ rule: task.repeat, doneCount, next })) {
      batch.task(task.id, {
        lastDoneDue: task.due,
        lastDoneAt: now,
        due: next,
        hiddenUntil: next,
        repeatCount: doneCount,
      });
      // The subtasks are a checklist that starts new for the next date.
      for (const subtask of subtasks) batch.task(subtask.id, { completed: false, completedAt: null, completedBy: null });
      return batch.finish(`Task completed. It comes back on ${formatDate({ date: next, today, locale })}`);
    }
    batch.task(task.id, { repeat: null, hiddenUntil: null });
  }

  const done: TaskFields = { completed: true, completedAt: now, completedBy: me };
  batch.task(task.id, done);
  let count = 1;
  for (const subtask of subtasks) {
    if (subtask.completed) continue;
    batch.task(subtask.id, done);
    count++;
  }
  return batch.finish(count === 1 ? 'Task completed' : `${count} tasks completed`);
}

/**
 * A completed task becomes open and goes to the top of its siblings. Its subtasks stay as they are.
 * A resting task goes back to the date that was completed.
 */
export function uncompleteTask(ctx: ActionContext, intent: TaskIntent): ActionResult {
  const { rows, today } = ctx;
  const task = liveTask(rows, intent.id);
  if (!task) return nothing();
  const batch = new Batch(rows);
  if (task.completed) {
    batch.task(task.id, { completed: false, completedAt: null, completedBy: null });
    const siblings = siblingsOf({
      rows,
      listId: task.listId,
      parentId: shownParent(rows, task)?.id ?? null,
      skip: new Set([task.id]),
    });
    if (siblings.length && task.pos >= siblings[0]!.pos) {
      const [pos] = place({ items: siblings, index: 0, count: 1, rekey: (id, key) => batch.task(id, { pos: key }) });
      batch.task(task.id, { pos });
    }
  } else if (isResting({ task, today })) {
    batch.task(task.id, {
      due: task.lastDoneDue ?? task.due,
      hiddenUntil: null,
      lastDoneAt: null,
      lastDoneDue: null,
      repeatCount: Math.max(0, task.repeatCount - 1),
    });
  }
  return batch.finish('Task marked uncompleted');
}

/** Deletes the task and its subtasks. */
export function deleteTask(ctx: ActionContext, intent: TaskIntent): ActionResult {
  const task = liveTask(ctx.rows, intent.id);
  if (!task) return nothing();
  const batch = new Batch(ctx.rows);
  const all = [task, ...subtasksOf(ctx.rows, task)];
  for (const each of all) batch.task(each.id, { deleted: true });
  return batch.finish(all.length === 1 ? 'Task deleted' : `${all.length} tasks deleted`);
}

/**
 * Sets `listId`, `parentId`, and `pos`. The subtasks of the task go with it to the new list.
 * A task with subtasks cannot become a subtask: its subtasks become subtasks of the new parent,
 * directly after it. No puts for a move that is not permitted or that changes nothing.
 */
export function moveTask(ctx: ActionContext, intent: MoveTaskIntent): ActionResult {
  const { rows, today } = ctx;
  const task = liveTask(rows, intent.id);
  const list = liveList(rows, intent.listId ?? task?.listId);
  if (!task || !list) return nothing();
  const listId = list.id;
  const keptParent = listId === task.listId ? (shownParent(rows, task)?.id ?? null) : null;
  const parentId = intent.parentId !== undefined ? intent.parentId : keptParent;
  const batch = new Batch(rows);

  let moved = [task];
  /** Subtasks that keep the task as their parent and only change the list. */
  let followers = subtasksOf(rows, task);
  if (parentId !== null) {
    const parent = liveTask(rows, parentId);
    if (
      !parent ||
      parent.id === task.id ||
      parent.listId !== listId ||
      parent.completed ||
      isResting({ task: parent, today }) ||
      // A subtask cannot be a parent, and a subtask cannot repeat.
      shownParent(rows, parent) ||
      task.repeat
    ) {
      return nothing();
    }
    batch.detach(parent);
    moved = [task, ...followers];
    followers = [];
  }

  /** The new level with the task, if the task is there now. */
  const level = siblingsOf({ rows, listId, parentId });
  const movedIds = new Set(moved.map((each) => each.id));
  const siblings = level.filter((each) => !movedIds.has(each.id));
  let index = -1;
  if (intent.beforeId != null) index = siblings.findIndex((each) => each.id === intent.beforeId);
  if (index < 0 && intent.afterId != null) {
    if (intent.afterId === parentId) {
      // Directly below the parent row: the first subtask.
      index = 0;
    } else {
      let after = liveTask(rows, intent.afterId);
      // At the top level, "after a subtask" is after its parent and all subtasks of that parent.
      if (after && parentId === null) after = shownParent(rows, after) ?? after;
      index = siblings.findIndex((each) => each.id === after?.id) + 1 || -1;
    }
  }
  if (index < 0) {
    if (intent.beforeId != null || intent.afterId != null) return nothing();
    index = siblings.length;
  }

  // If the task has this level already and has this place too, nothing changes. `level` is
  // `siblings` with the task at its place now, so the same index is the same place.
  if (task.listId === listId && keptParent === parentId && level[index]?.id === task.id) return nothing();

  const keys = place({ items: siblings, index, count: moved.length, rekey: (id, key) => batch.task(id, { pos: key }) });
  moved.forEach((each, i) => batch.task(each.id, { listId, parentId, pos: keys[i]! }));
  for (const each of followers) batch.task(each.id, { listId });
  return batch.finish();
}

/**
 * The task becomes the last subtask of the open top-level task above it.
 * Not possible for the first task, a subtask, or a repeating task.
 */
export function indentTask(ctx: ActionContext, intent: TaskIntent): ActionResult {
  const { rows, today } = ctx;
  const task = liveTask(rows, intent.id);
  if (!task || task.repeat || !isOpen({ task, today }) || shownParent(rows, task)) return nothing();
  const above = siblingsOf({ rows, listId: task.listId, parentId: null }).filter((each) => isOpen({ task: each, today }));
  const parent = above[above.findIndex((each) => each.id === task.id) - 1];
  return parent ? moveTask(ctx, { id: task.id, parentId: parent.id }) : nothing();
}

/** The subtask becomes a top-level task directly after its old parent. */
export function unindentTask(ctx: ActionContext, intent: TaskIntent): ActionResult {
  const task = liveTask(ctx.rows, intent.id);
  const parent = task && shownParent(ctx.rows, task);
  return task && parent ? moveTask(ctx, { id: task.id, parentId: null, afterId: parent.id }) : nothing();
}

/** The task goes to the first position among its siblings. */
export function moveToTop(ctx: ActionContext, intent: TaskIntent): ActionResult {
  const { rows, today } = ctx;
  const task = liveTask(rows, intent.id);
  if (!task) return nothing();
  const parentId = shownParent(rows, task)?.id ?? null;
  const siblings = siblingsOf({ rows, listId: task.listId, parentId });
  const first = siblings[0]!;
  // The first open task is at the top of the screen already, also if a completed task is before it.
  if (siblings.find((each) => isOpen({ task: each, today }))?.id === task.id || first.id === task.id) return nothing();
  return moveTask(ctx, { id: task.id, parentId, beforeId: first.id });
}

export function setStar(ctx: ActionContext, intent: SetStarIntent): ActionResult {
  const task = liveTask(ctx.rows, intent.id);
  if (!task || task.starred === intent.starred) return nothing();
  const batch = new Batch(ctx.rows);
  batch.task(task.id, { starred: intent.starred, starredAt: intent.starred ? ctx.now : null });
  return batch.finish();
}

// ---- Lists ----

/** The list goes to the end of the list order. No list if the title is empty after trim. */
export function createList(ctx: ActionContext, intent: CreateListIntent): ActionResult {
  const { rows } = ctx;
  const title = cut(intent.title.trim(), LIMITS.listTitle);
  const id = intent.id ?? newId();
  if (!title || rows.lists.has(id)) return nothing();
  const batch = new Batch(rows);
  const lists = orderLists(rows.lists.values());
  const [pos] = place({ items: lists, index: lists.length, count: 1, rekey: (listId, key) => batch.list(listId, { pos: key }) });
  batch.makeList({ ...defaultList(id), title, owner: ctx.me, createdAt: ctx.now, pos: pos! });
  return batch.finish();
}

/** A change of the fields of one list. `fields` gives null when the change is not permitted. */
function changeList({
  ctx,
  id,
  fields,
  message = null,
}: {
  ctx: ActionContext;
  id: ID;
  fields: (list: ListRow) => ListFields | null;
  message?: string | null;
}): ActionResult {
  const list = liveList(ctx.rows, id);
  const change = list && fields(list);
  if (!list || !change) return nothing();
  const batch = new Batch(ctx.rows);
  batch.list(list.id, change);
  return batch.finish(message);
}

/** An empty title keeps the old title. */
export function renameList(ctx: ActionContext, intent: RenameListIntent): ActionResult {
  const title = cut(intent.title.trim(), LIMITS.listTitle);
  return changeList({ ctx, id: intent.id, fields: () => (title ? { title } : null) });
}

const SORT_MODES: readonly string[] = ['my', 'date', 'deadline', 'starred', 'title'] satisfies SortMode[];

export function setListSort(ctx: ActionContext, intent: SetListSortIntent): ActionResult {
  return changeList({ ctx, id: intent.id, fields: () => (SORT_MODES.includes(intent.sort) ? { sort: intent.sort } : null) });
}

export function setListHidden(ctx: ActionContext, intent: SetListHiddenIntent): ActionResult {
  return changeList({ ctx, id: intent.id, fields: () => ({ hidden: intent.hidden }) });
}

/** Only the owner can share a list or stop the sharing. */
export function setListShared(ctx: ActionContext, intent: SetListSharedIntent): ActionResult {
  return changeList({ ctx, id: intent.id, fields: (list) => (list.owner === ctx.me ? { shared: intent.shared } : null) });
}

/** With no `beforeId`, no `afterId`, and no `toFirst`, the list goes to the end. */
export function moveList(ctx: ActionContext, intent: MoveListIntent): ActionResult {
  const { rows } = ctx;
  const list = liveList(rows, intent.id);
  if (!list) return nothing();
  const all = orderLists(rows.lists.values());
  const others = all.filter((each) => each.id !== list.id);
  let index = others.length;
  if (intent.toFirst) {
    index = 0;
  } else if (intent.beforeId != null || intent.afterId != null) {
    // As in moveTask: `beforeId` is used, and `afterId` only if `beforeId` is not a list.
    index = others.findIndex((each) => each.id === intent.beforeId);
    if (index < 0) index = others.findIndex((each) => each.id === intent.afterId) + 1 || -1;
  }
  // `all` is `others` with the list at its place now. The same index is the same place.
  if (index < 0 || all[index]?.id === list.id) return nothing();
  const batch = new Batch(rows);
  const [pos] = place({ items: others, index, count: 1, rekey: (id, key) => batch.list(id, { pos: key }) });
  batch.list(list.id, { pos });
  return batch.finish();
}

/** Only the owner can delete a list, and not the default list. */
export function deleteList(ctx: ActionContext, intent: ListIntent): ActionResult {
  return changeList({
    ctx,
    id: intent.id,
    fields: (list) => (list.isDefault || list.owner !== ctx.me ? null : { deleted: true }),
    message: 'List deleted',
  });
}

/** Deletes each completed task of the list. Resting tasks stay. */
export function clearCompleted(ctx: ActionContext, intent: ClearCompletedIntent): ActionResult {
  const batch = new Batch(ctx.rows);
  let count = 0;
  for (const task of ctx.rows.tasks.values()) {
    if (task.listId !== intent.listId || !task.completed || task.deleted) continue;
    batch.task(task.id, { deleted: true });
    count++;
  }
  return batch.finish(count === 1 ? '1 completed task deleted' : `${count} completed tasks deleted`);
}

// ---- Notes ----

/** The title of a note is one line. A pasted text can have line breaks, so each run becomes a space. */
function noteTitle(text: string): string {
  return cut(text.replace(/[\r\n]+/g, ' '), LIMITS.noteTitle);
}

const isNoteColor = (color: unknown): color is NoteColor => (NOTE_COLORS as readonly unknown[]).includes(color);

/**
 * No note if the title and the body are both empty after trim, or if a row with that id is there.
 * The text is not trimmed: the editor makes the note at the first key, and a trim would take away
 * the space that the person typed before it.
 */
export function createNote(ctx: ActionContext, intent: CreateNoteIntent): ActionResult {
  const { rows } = ctx;
  const title = noteTitle(intent.title ?? '');
  const body = cut(intent.body ?? '', LIMITS.noteBody);
  const id = intent.id ?? newId();
  if ((!title.trim() && !body.trim()) || rows.notes.has(id)) return nothing();
  const batch = new Batch(rows);
  batch.makeNote({
    ...defaultNote(id),
    title,
    body,
    color: isNoteColor(intent.color) ? intent.color : 'default',
    shared: intent.shared === true,
    editedAt: ctx.now,
    editedBy: ctx.me,
    owner: ctx.me,
    createdAt: ctx.now,
    pinned: intent.pinned === true,
    archived: false,
  });
  return batch.finish();
}

/** The title and the body can become empty. Only a real change of the text sets the time and the person of the edit. */
export function updateNote(ctx: ActionContext, intent: UpdateNoteIntent): ActionResult {
  const note = liveNote(ctx.rows, intent.id);
  if (!note) return nothing();
  const fields: NoteFields = {};
  const before: NoteFields = {};
  const title = intent.title === undefined ? note.title : noteTitle(intent.title);
  const body = intent.body === undefined ? note.body : cut(intent.body, LIMITS.noteBody);
  if (title !== note.title) {
    fields.title = title;
    before.title = note.title;
  }
  if (body !== note.body) {
    fields.body = body;
    before.body = note.body;
  }
  if (fields.title === undefined && fields.body === undefined) return nothing();
  // Not a Batch, which drops a value that does not change. The server merges each field by
  // itself, so the person and the time must go with each text. Else an edit of the other person
  // at the same time can put that name on this text.
  return {
    puts: [{ kind: 'note', id: note.id, fields: { ...fields, editedAt: ctx.now, editedBy: ctx.me } }],
    undo: [{ kind: 'note', id: note.id, fields: { ...before, editedAt: note.editedAt, editedBy: note.editedBy } }],
    message: null,
  };
}

/**
 * A change of the fields of one note. `fields` gives null when the change is not permitted. The
 * fields of the change go out together: a pin with its { archived: false } is one decision.
 */
function changeNote({
  ctx,
  id,
  fields,
  message = null,
}: {
  ctx: ActionContext;
  id: ID;
  fields: (note: NoteRow) => NoteFields | null;
  message?: string | null | ((note: NoteRow) => string | null);
}): ActionResult {
  const note = liveNote(ctx.rows, id);
  const change = note && fields(note);
  if (!note || !change) return nothing();
  const batch = new Batch(ctx.rows);
  batch.noteTogether(note.id, change);
  return batch.finish(typeof message === 'function' ? message(note) : message);
}

/** The server refuses an op with an unknown color, and with it the text changes that the outbox merged into that op. */
export function setNoteColor(ctx: ActionContext, intent: SetNoteColorIntent): ActionResult {
  return changeNote({ ctx, id: intent.id, fields: () => (isNoteColor(intent.color) ? { color: intent.color } : null) });
}

/** A pin also takes the note out of the archive, as in Google Keep. */
export function setNotePinned(ctx: ActionContext, intent: SetNotePinnedIntent): ActionResult {
  const pinned = intent.pinned === true;
  return changeNote({
    ctx,
    id: intent.id,
    fields: () => (pinned ? { pinned, archived: false } : { pinned }),
    message: (note) => (pinned && note.archived ? 'Note unarchived' : null),
  });
}

/** An archive also takes away the pin. */
export function setNoteArchived(ctx: ActionContext, intent: SetNoteArchivedIntent): ActionResult {
  const archived = intent.archived === true;
  return changeNote({
    ctx,
    id: intent.id,
    fields: () => (archived ? { archived, pinned: false } : { archived }),
    message: archived ? 'Note archived' : 'Note unarchived',
  });
}

/** Only the owner can share a note or stop the sharing. The screen gives the message, because only it knows the name. */
export function setNoteShared(ctx: ActionContext, intent: SetNoteSharedIntent): ActionResult {
  return changeNote({
    ctx,
    id: intent.id,
    fields: (note) => (note.owner === ctx.me ? { shared: intent.shared === true } : null),
  });
}

/**
 * Only the owner can delete a note. `discard` is for a note that the editor made and that the
 * person emptied again: the person sees no message, and no undo can bring back the empty note.
 */
export function deleteNote(ctx: ActionContext, intent: DeleteNoteIntent): ActionResult {
  const result = changeNote({
    ctx,
    id: intent.id,
    fields: (note) => (note.owner === ctx.me ? { deleted: true } : null),
    message: intent.discard ? null : 'Note deleted',
  });
  return intent.discard ? { ...result, undo: [] } : result;
}

/** The title and the details of each task that a note gives, in order, before the limits. */
function tasksOfNote(note: NoteRow, mode: NoteToTasksIntent['mode']): { title: string; notes: string }[] {
  if (mode === 'lines') return noteTaskTitles(note.body).map((title) => ({ title, notes: '' }));
  if (mode !== 'one') return [];
  const title = note.title.trim();
  if (title) return [{ title, notes: note.body }];
  const lines = note.body.split(/\r\n|\r|\n/);
  const first = lines.findIndex((line) => line.trim() !== '');
  return first < 0 ? [] : [{ title: lines[first]!.trim(), notes: lines.slice(first + 1).join('\n') }];
}

/**
 * Makes tasks from a note, at the top of the list in their order. 'lines' gives one task for each
 * line of the body: the title of the note is a heading such as "Groceries", so it gives no task.
 * 'one' gives one task with the note title, or with the first line of a note with no title.
 */
export function noteToTasks(ctx: ActionContext, intent: NoteToTasksIntent): ActionResult {
  const { rows } = ctx;
  const note = liveNote(rows, intent.id);
  const list = liveList(rows, intent.listId);
  if (!note || !list) return nothing();
  const made = tasksOfNote(note, intent.mode)
    .slice(0, LIMITS.noteTasks)
    .map((task) => ({ title: cut(task.title, LIMITS.title), notes: cut(task.notes, LIMITS.notes) }));
  if (made.length === 0) return nothing();

  const batch = new Batch(rows);
  // All keys come from one call: one call for each task would give each task the same key.
  const keys = place({
    items: siblingsOf({ rows, listId: list.id, parentId: null }),
    index: 0,
    count: made.length,
    rekey: (taskId, key) => batch.task(taskId, { pos: key }),
  });
  made.forEach((task, i) => {
    batch.makeTask({
      ...defaultTask(newId()),
      listId: list.id,
      title: task.title,
      notes: task.notes,
      pos: keys[i]!,
      createdAt: ctx.now,
      createdBy: ctx.me,
    });
  });
  if (intent.archive === true) batch.noteTogether(note.id, { archived: true, pinned: false });
  return batch.finish(made.length === 1 ? `Task added to ${list.title}` : `${made.length} tasks added to ${list.title}`);
}
