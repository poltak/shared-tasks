// The state of the wide layout that more than one part reads: the view, the selected row, the
// row that is open for editing, the rows that leave after "complete", the open menu, and the
// note editor and composer of the notes views.
//
// A row is open by its id, not by the focus. So the row stays open when the browser moves its
// element (a new sort place, a different column), and the editor puts the focus back.

import { flushSync, untrack } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import { addDays } from '../../../shared/dates.ts';
import { newId } from '../../../shared/ids.ts';
import { defaultTask } from '../../../shared/merge.ts';
import { firstOccurrence } from '../../../shared/recurrence.ts';
import type {
  DateStr,
  ID,
  ListRow,
  ListView,
  NoteRow,
  RepeatRule,
  TaskPosition,
  TaskRow,
  TimeStr,
  ViewGroup,
  ViewItem,
} from '../../../shared/types.ts';
import { listMenuItems, runListMenuItem, runStarredMenuItem, runTaskMenuItem, starredMenuItems, taskMenuItems } from '../common/menus.ts';
import { applyDate, isOwner, isSubtask } from '../common/task-ops.ts';
import { actions, getList, getTask, listView, listsOrdered, prefs, starredView, store, toast } from '../data/index.ts';
import { reducedMotion } from '../ui/motion.ts';
import type { DateValue, MenuAnchor, MenuItem } from '../ui/types.ts';
import { flowAfter, rowElement } from './flow.ts';

/** The parts of web/src/notes/. The layout downloads them when a notes view first shows. */
export type NotesParts = typeof import('../notes/index.ts');

/** A column of the main area: the id of a list, or `STARRED`. */
export type ColumnKey = string;
export const STARRED = 'starred';
/** `prefs.lastTab` of the Notes view and of the Archive view. On the phone it is the Notes tab. */
export const NOTES = 'notes';

/** The views of the main area. 'notes' and 'archive' are the two notes views. */
export type View = 'board' | 'starred' | 'notes' | 'archive';

/** The id of the search field of the notes views, for the key "/". */
export const NOTES_SEARCH_ID = 'notes-search';

/** The group of a row that has no place in the view yet. It shows above all groups. */
export const DRAFT_GROUP = '~draft';

/** The text of an open row goes to the data layer after this pause in the typing. */
const SAVE_MS = 300;
/** The time for which a completed row stays, with a line through its title. */
const LEAVE_MS = 300;

// ---- The open row ----

/** A new task that has no title yet. The data layer gets it when it has one. */
export interface Draft {
  listId: ID;
  parentId: ID | null;
  position: TaskPosition;
  depth: 0 | 1;
  due: DateStr | null;
  time: TimeStr | null;
  repeat: RepeatRule | null;
  deadline: DateStr | null;
  starred: boolean;
}

/**
 * The place of the open row on the screen, where the view cannot give it: a draft is not in the
 * view, and in a sorted list each saved letter of a title would move the row.
 */
export interface Slot {
  /** null: a group of its own above all groups. */
  group: { key: string; heading: string | null; tone: ViewGroup['tone']; index: number } | null;
  /** The row directly above, in that group. null: the first row. */
  afterId: ID | null;
  /** The place in the group, if the row above is gone. */
  index: number;
}

export class EditSession {
  readonly id: ID;
  readonly column: ColumnKey;
  draft = $state.raw<Draft | null>(null);
  slot = $state.raw<Slot | null>(null);
  title = $state('');
  notes = $state('');
  /** The field that has the focus, or gets it when the editor shows again. */
  field: 'title' | 'notes' = 'title';
  /** The first focus selects the full title. */
  selectAll = false;
  /** The selection in the field, to put it back after the browser moved the row. */
  caret: readonly [number, number] | null = null;
  /** The person typed in the field after the last save. */
  dirtyTitle = false;
  dirtyNotes = false;
  /** This session made the task. If it ends with an empty title, the task goes away again. */
  born = false;
  /** false: after the task is made, the view gives the place. */
  pinned = false;
  /** The row of a draft, for the screen. */
  readonly item = $derived.by<ViewItem | null>(() => {
    const draft = this.draft;
    if (!draft) return null;
    const { listId, parentId, due, time, repeat, deadline, starred } = draft;
    return { task: { ...defaultTask(this.id), listId, parentId, due, time, repeat, deadline, starred }, depth: draft.depth, hasChildren: false };
  });

  constructor({ id, column }: { id: ID; column: ColumnKey }) {
    this.id = id;
    this.column = column;
  }
}

/**
 * What one row reads about itself. A change of the selection or of the open row gives a new
 * value only to the rows that it is about, so it costs the same with ten rows and with
 * thousands.
 */
export class RowMark {
  selected = $state(false);
  session = $state.raw<EditSession | null>(null);
  /** The rows that use this mark. A task can have two for a moment: one that goes and one that comes. */
  uses = 0;
}

const marks = new Map<ID, RowMark>();
let editNow = $state.raw<EditSession | null>(null);
let selectedNow = $state.raw<ID | null>(null);
let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** For a row: its mark. Call `releaseMark` when the row goes away. */
export function useMark(id: ID): RowMark {
  let mark = marks.get(id);
  if (!mark) {
    mark = new RowMark();
    mark.selected = untrack(() => selectedNow) === id;
    const session = untrack(() => editNow);
    mark.session = session?.id === id ? session : null;
    marks.set(id, mark);
  }
  mark.uses += 1;
  return mark;
}

export function releaseMark(id: ID): void {
  const mark = marks.get(id);
  if (mark && --mark.uses <= 0) marks.delete(id);
}

function setEdit(next: EditSession | null): void {
  const before = untrack(() => editNow);
  if (before === next) return;
  const old = before && marks.get(before.id);
  if (old) old.session = null;
  editNow = next;
  const mark = next && marks.get(next.id);
  if (mark) mark.session = next;
}

function setSelected(id: ID | null): void {
  const before = untrack(() => selectedNow);
  if (before === id) return;
  const old = before !== null && marks.get(before);
  if (old) old.selected = false;
  selectedNow = id;
  const mark = id !== null && marks.get(id);
  if (mark) mark.selected = true;
}

// ---- Menus and dialogs of the layout ----

export interface OpenMenu {
  anchor: MenuAnchor;
  items: MenuItem[];
  align: 'start' | 'end';
  label: string;
  run: (itemId: string) => void;
}

/** What the repeat dialog changes: the open row. */
export interface RepeatRequest {
  rule: RepeatRule | null;
  time: TimeStr | null;
  date: DateStr | null;
}

let menu = $state.raw<OpenMenu | null>(null);
let menuOpen = $state(false);
let createOpen = $state(false);
let repeatRequest = $state.raw<RepeatRequest | null>(null);
/** A column that the board must bring into view. The board clears it. */
let reveal = $state.raw<ColumnKey | null>(null);

// The two notes views store the same `prefs.lastTab`, so the choice between them is only here.
// A start shows the notes, not the archive.
let archiveShown = $state(false);
/** The note of the editor dialog. */
let noteOpen = $state.raw<ID | null>(null);
let composerOpen = $state(false);
let noteQuery = $state('');
/** The composer of the notes board, while it is on the screen. */
let composer: { focus: () => void } | null = null;

/** The rows that show as completed for a moment before the data changes. */
export const leaving = new SvelteSet<ID>();
const leaveTimers = new Map<ID, ReturnType<typeof setTimeout>>();

/** How many rows of "Completed" each column shows. The section writes it, the keyboard reads it. */
export const doneShown = new Map<ID, number>();

/** true from a press outside the open row to the click that closes the row. */
export const press = { outside: false };

export const ui = {
  get edit(): EditSession | null {
    return editNow;
  },
  get selectedId(): ID | null {
    return selectedNow;
  },
  /** The content of the menu. It stays after the close, for the motion of the close. */
  get menu(): OpenMenu | null {
    return menu;
  },
  get menuOpen(): boolean {
    return menuOpen;
  },
  set menuOpen(open: boolean) {
    menuOpen = open;
  },
  get createOpen(): boolean {
    return createOpen;
  },
  set createOpen(open: boolean) {
    createOpen = open;
  },
  get repeat(): RepeatRequest | null {
    return repeatRequest;
  },
  get reveal(): ColumnKey | null {
    return reveal;
  },
  set reveal(column: ColumnKey | null) {
    reveal = column;
  },
  /** The view of the main area. A list id in `prefs.lastTab` (from the phone) is "All tasks". */
  get view(): View {
    const tab = prefs.lastTab;
    if (tab === STARRED) return 'starred';
    if (tab === NOTES) return archiveShown ? 'archive' : 'notes';
    return 'board';
  },
  /** true: the Starred view. */
  get starred(): boolean {
    return prefs.lastTab === STARRED;
  },
  /** true: the Notes view or the Archive view. */
  get notes(): boolean {
    return prefs.lastTab === NOTES;
  },
  /** The note that is open in the editor dialog. */
  get noteId(): ID | null {
    return noteOpen;
  },
  /** The composer of the Notes view is open. The composer writes it too. */
  get composerOpen(): boolean {
    return composerOpen;
  },
  set composerOpen(open: boolean) {
    composerOpen = open;
  },
  /** The text of the search field of the notes views. */
  get noteQuery(): string {
    return noteQuery;
  },
  set noteQuery(text: string) {
    noteQuery = text;
  },
};

// ---- Views ----

/** Shows a view. The open row, the selection, the note editor, and the composer close. */
export function showView(view: View): void {
  if (ui.view === view) return;
  closeEdit();
  setSelected(null);
  noteOpen = null;
  composerOpen = false;
  // The search is for the notes. Between the two notes views it stays, as the field does.
  if (view !== 'notes' && view !== 'archive') noteQuery = '';
  archiveShown = view === 'archive';
  // The phone layout reads the same setting for its last tab. With null it starts at its first list.
  prefs.lastTab = view === 'board' ? null : view === 'starred' ? STARRED : NOTES;
}

export function showAll(): void {
  showView('board');
}

export function showStarred(): void {
  showView('starred');
}

/**
 * The layout goes off the screen. The next wide layout starts with the notes and not the archive,
 * also after a change to the phone layout and back.
 */
export function resetNotes(): void {
  archiveShown = false;
  noteOpen = null;
  composerOpen = false;
  noteQuery = '';
}

// ---- Notes ----

/** The notes board gives its composer while the composer is on the screen. */
export function setComposer(part: { focus: () => void } | null): void {
  composer = part;
}

/**
 * "Create", n, and c in the notes views, and /?new=note: the Notes view with the composer open
 * and the focus in its body. `now`: the call is in the handler of a press or a key, so the focus
 * comes in the same call, which a tablet needs to show its keyboard. An effect must give false.
 */
export function compose({ now = true }: { now?: boolean } = {}): void {
  showView('notes');
  if (now) {
    // From the archive, the composer comes with this change of the view.
    flushSync();
    if (composer) return composer.focus();
  }
  // The composer is not there yet (the notes parts are still on the way): it opens when it comes.
  composerOpen = true;
}

export function openNote(id: ID): void {
  noteOpen = id;
}

export function closeNote(): void {
  noteOpen = null;
}

/** "/" in the notes views. The text in the field is selected, so a new word replaces it. */
export function focusSearch(): void {
  const field = document.getElementById(NOTES_SEARCH_ID);
  if (!(field instanceof HTMLInputElement)) return;
  field.focus();
  field.select();
}

/** Shows the column of a list: the view with all lists, the list not hidden, the column in view. */
export function showList(listId: ID): void {
  const list = getList(listId);
  if (!list) return;
  showAll();
  if (list.hidden) actions.setListHidden({ id: listId, hidden: false });
  reveal = listId;
}

export function viewOf(column: ColumnKey): ListView {
  return column === STARRED ? starredView() : listView(column);
}

/** true if the view gives the place of a new row in the column: the list is in "My order". */
function ordered(column: ColumnKey): boolean {
  return column !== STARRED && getList(column)?.sort === 'my';
}

interface Found {
  group: ViewGroup;
  groupIndex: number;
  index: number;
  item: ViewItem;
}

function findItem(groups: readonly ViewGroup[], id: ID): Found | null {
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const group = groups[groupIndex]!;
    const index = group.items.findIndex((item) => item.task.id === id);
    if (index >= 0) return { group, groupIndex, index, item: group.items[index]! };
  }
  return null;
}

/**
 * The groups of a column as the screen shows them: the groups of the view, with the open row at
 * its slot. A group that the open row does not touch keeps its object.
 */
export function shownGroups({ view, session }: { view: ListView; session: EditSession | null }): readonly ViewGroup[] {
  const slot = session?.slot;
  if (!session || !slot) return view.groups;
  let item = session.item;
  const groups = [...view.groups];
  if (!item) {
    const found = findItem(groups, session.id);
    // The task left the view. The column closes the row.
    if (!found) return view.groups;
    item = found.item;
    if (found.group.items.length === 1 && found.group.key !== slot.group?.key) groups.splice(found.groupIndex, 1);
    else groups[found.groupIndex] = { ...found.group, items: found.group.items.toSpliced(found.index, 1) };
  }
  if (!slot.group) return [{ key: DRAFT_GROUP, heading: null, tone: 'normal', items: [item] }, ...groups];
  const { key, heading, tone } = slot.group;
  const at = groups.findIndex((group) => group.key === key);
  if (at < 0) {
    groups.splice(Math.min(slot.group.index, groups.length), 0, { key, heading, tone, items: [item] });
    return groups;
  }
  const group = groups[at]!;
  const above = slot.afterId === null ? -1 : group.items.findIndex((each) => each.task.id === slot.afterId);
  const index = slot.afterId === null ? 0 : above >= 0 ? above + 1 : Math.min(slot.index, group.items.length);
  groups[at] = { ...group, items: group.items.toSpliced(index, 0, item) };
  return groups;
}

/** The ids of the open rows of a column, from top to bottom. */
function openIds(column: ColumnKey): ID[] {
  const ids: ID[] = [];
  for (const group of shownGroups({ view: viewOf(column), session: editNow?.column === column ? editNow : null })) {
    for (const item of group.items) ids.push(item.task.id);
  }
  return ids;
}

/** The ids of the rows of "Completed" that are on the screen. */
function doneIds(column: ColumnKey): ID[] {
  if (column === STARRED || !prefs.completedOpen[column]) return [];
  return listView(column)
    .completed.slice(0, doneShown.get(column) ?? 0)
    .map((task) => task.id);
}

function rowIds(column: ColumnKey): ID[] {
  return [...openIds(column), ...doneIds(column)];
}

function columnKeys(): ColumnKey[] {
  if (ui.starred) return [STARRED];
  return listsOrdered()
    .filter((list) => !list.hidden)
    .map((list) => list.id);
}

/** The column that shows the row. */
export function columnOf(id: ID): ColumnKey | null {
  if (editNow?.id === id) return editNow.column;
  if (ui.starred) return STARRED;
  return getTask(id)?.listId ?? null;
}

/** The column of the selected row, or the first column. */
export function currentColumn(): ColumnKey | null {
  return (selectedNow !== null ? columnOf(selectedNow) : null) ?? columnKeys()[0] ?? null;
}

// ---- Selection ----

export function select(id: ID | null): void {
  setSelected(id);
}

/** Up and Down. With no selection, the first row of the first column that has rows. */
export function moveSelection(step: -1 | 1): void {
  const column = selectedNow !== null ? columnOf(selectedNow) : null;
  if (column === null) {
    for (const key of columnKeys()) {
      const ids = rowIds(key);
      if (ids.length === 0) continue;
      setSelected(ids[0]!);
      return;
    }
    return;
  }
  const ids = rowIds(column);
  const at = ids.indexOf(selectedNow!);
  const next = ids[at < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, at + step))];
  if (next !== undefined) setSelected(next);
}

/** The place in the column from which Left and Right started. A short column between two long ones does not change it. */
let level: { id: ID; index: number } | null = null;

/** Left and Right: the row at the same place in the next column that has rows. */
export function moveColumn(step: -1 | 1): void {
  const keys = columnKeys();
  const column = selectedNow !== null ? columnOf(selectedNow) : null;
  if (column === null) return moveSelection(1);
  const at = level?.id === selectedNow ? level.index : rowIds(column).indexOf(selectedNow!);
  for (let k = keys.indexOf(column) + step; k >= 0 && k < keys.length; k += step) {
    const ids = rowIds(keys[k]!);
    if (ids.length === 0) continue;
    const next = ids[Math.max(0, Math.min(ids.length - 1, at))]!;
    setSelected(next);
    level = { id: next, index: at };
    return;
  }
}

export function selectEdge(edge: 'first' | 'last'): void {
  const column = currentColumn();
  if (column === null) return;
  const ids = rowIds(column);
  const next = edge === 'first' ? ids[0] : ids[ids.length - 1];
  if (next !== undefined) setSelected(next);
}

/**
 * Runs a change that takes a row away. The rows below move up, and the selection goes to the
 * row that takes its place.
 */
function removeRow(id: ID, change: () => void): void {
  const column = columnOf(id);
  const wasSelected = selectedNow === id && column !== null;
  const done = wasSelected && doneIds(column!).includes(id);
  const at = wasSelected ? (done ? doneIds(column!) : openIds(column!)).indexOf(id) : -1;
  flowAfter({ row: rowElement(id), change });
  if (!wasSelected) return;
  const now = (done ? doneIds(column!) : openIds(column!)).filter((each) => each !== id);
  setSelected(now[Math.min(at, now.length - 1)] ?? null);
}

// ---- Editing ----

function begin(session: EditSession): void {
  clearTimeout(saveTimer);
  setEdit(session);
  setSelected(session.id);
}

/** Opens the row of a task for editing. */
export function startEdit({ task, column, field = 'title' }: { task: TaskRow; column: ColumnKey; field?: 'title' | 'notes' }): void {
  if (editNow?.id === task.id && editNow.column === column) return;
  closeEdit();
  const now = getTask(task.id);
  if (!now || now.completed) return;
  const session = new EditSession({ id: now.id, column });
  session.title = now.title;
  session.notes = now.notes;
  session.field = field;
  session.selectAll = field === 'title';
  if (!ordered(column)) {
    const found = findItem(viewOf(column).groups, now.id);
    if (found) {
      const { key, heading, tone } = found.group;
      session.pinned = true;
      session.slot = {
        group: { key, heading, tone, index: found.groupIndex },
        afterId: found.group.items[found.index - 1]?.task.id ?? null,
        index: found.index,
      };
    }
  }
  begin(session);
}

const NO_DATES = { due: null, time: null, repeat: null, deadline: null } as const;

function startDraft({ column, draft, slot }: { column: ColumnKey; draft: Draft; slot: Slot }): void {
  const session = new EditSession({ id: newId(), column });
  session.draft = draft;
  session.slot = slot;
  session.pinned = !ordered(column);
  begin(session);
}

/** The list of a new task in the Starred view: the default list of the person. */
function homeList(): ListRow | undefined {
  const lists = listsOrdered();
  return lists.find((list) => list.isDefault && isOwner(list)) ?? lists[0];
}

/** "Add a task": a new row at the top of the column. */
export function draftTop(column: ColumnKey): void {
  if (editNow?.draft && editNow.column === column && editNow.slot?.afterId === null && !editNow.title.trim()) return;
  closeEdit();
  const listId = column === STARRED ? homeList()?.id : getList(column)?.id;
  if (listId === undefined) return;
  // With one group and no headings, the new row is the first row of that group. Then it is the
  // same row for the screen after the task is made.
  const flat = column === STARRED ? prefs.starredSort === 'starred' : ordered(column);
  startDraft({
    column,
    draft: { listId, parentId: null, position: { at: 'top' }, depth: 0, ...NO_DATES, starred: column === STARRED },
    slot: { group: flat ? { key: viewOf(column).groups[0]?.key ?? 'all', heading: null, tone: 'normal', index: 0 } : null, afterId: null, index: 0 },
  });
}

/** A new row directly below a task. Below a subtask it is a subtask. */
export function draftAfter({ task, column }: { task: TaskRow; column: ColumnKey }): void {
  closeEdit();
  const now = getTask(task.id);
  const found = now && findItem(viewOf(column).groups, now.id);
  if (!now || !found) return draftTop(column);
  const { group, groupIndex } = found;
  let index = found.index + 1;
  // A new task after a parent is the next top-level task: it goes below the subtasks.
  if (found.item.depth === 0) while (group.items[index]?.depth === 1) index++;
  startDraft({
    column,
    draft: {
      listId: now.listId,
      parentId: isSubtask(now) ? now.parentId : null,
      position: { after: now.id },
      depth: found.item.depth,
      ...NO_DATES,
      starred: column === STARRED,
    },
    slot: { group: { key: group.key, heading: group.heading, tone: group.tone, index: groupIndex }, afterId: group.items[index - 1]!.task.id, index },
  });
}

/** "Add a subtask": a new row at the end of the subtasks of the task. For a subtask: of its parent. */
export function draftChild({ task, column }: { task: TaskRow; column: ColumnKey }): void {
  closeEdit();
  const now = getTask(task.id);
  const parent = now && isSubtask(now) ? getTask(now.parentId!) : now;
  // The title is only a probe: `can` does not make the task.
  if (!parent || !store.can('createTask', { listId: parent.listId, title: '-', position: { parentId: parent.id, at: 'end' } })) return;
  const found = findItem(viewOf(column).groups, parent.id);
  if (!found) return;
  const { group, groupIndex } = found;
  // A sorted list shows no levels: the new row is a plain row below the parent.
  const nested = ordered(column);
  let index = found.index + 1;
  if (nested) while (group.items[index]?.depth === 1) index++;
  startDraft({
    column,
    draft: {
      listId: parent.listId,
      parentId: parent.id,
      position: { parentId: parent.id, at: 'end' },
      depth: nested ? 1 : 0,
      ...NO_DATES,
      starred: column === STARRED,
    },
    slot: { group: { key: group.key, heading: group.heading, tone: group.tone, index: groupIndex }, afterId: group.items[index - 1]!.task.id, index },
  });
}

/** The person typed. The text goes to the data layer after a pause. */
export function touchEdit(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flushEdit(), SAVE_MS);
}

/**
 * Saves the text of the open row. A draft becomes a task when it has a title.
 * `final`: the row closes, so the title loses the spaces at its ends.
 */
export function flushEdit({ final = false }: { final?: boolean } = {}): void {
  clearTimeout(saveTimer);
  const session = editNow;
  if (!session) return;
  const title = final ? session.title.trim() : session.title;
  const draft = session.draft;
  if (draft) {
    if (!title.trim()) return;
    const { depth: _depth, parentId: _parentId, position, ...fields } = draft;
    const intent = { id: session.id, title, notes: session.notes, ...fields };
    let made = actions.createTask({ ...intent, position }).puts.length > 0;
    // The row above or the parent can be gone. The text of the person must not be lost.
    if (!made) made = actions.createTask({ ...intent, position: { at: 'top' } }).puts.length > 0;
    if (!made) return;
    session.draft = null;
    session.born = true;
    if (!session.pinned) session.slot = null;
    session.dirtyNotes = false;
    // The data layer has the title with no spaces at its ends. The field keeps what the person typed.
    session.dirtyTitle = session.title !== getTask(session.id)?.title;
    return;
  }
  const task = getTask(session.id);
  if (!task) return;
  const fields: { title?: string; notes?: string } = {};
  // An empty title is not saved: the task keeps its old title.
  if ((session.dirtyTitle || final) && title.trim() && title !== task.title) fields.title = title;
  if (session.dirtyNotes && session.notes !== task.notes) fields.notes = session.notes;
  session.dirtyNotes = false;
  session.dirtyTitle = session.title.trim() === '' && session.dirtyTitle;
  if (fields.title !== undefined || fields.notes !== undefined) actions.updateTask({ id: session.id, ...fields });
}

/** Saves and closes the open row. `select`: the row stays selected, for the keyboard. */
export function closeEdit({ select: keep = false }: { select?: boolean } = {}): void {
  const session = editNow;
  if (!session) return;
  flushEdit({ final: true });
  // A new row that ends with no title makes no task. The keyboard continues from the row next to it.
  const dropped = session.draft !== null || (session.born && !session.title.trim());
  let near: ID | null = null;
  if (dropped && keep) {
    const ids = openIds(session.column);
    const at = ids.indexOf(session.id);
    near = ids[at - 1] ?? ids[at + 1] ?? null;
  }
  setEdit(null);
  press.outside = false;
  if (dropped && session.draft === null && actions.deleteTask({ id: session.id }).puts.length > 0) toast.dismiss();
  if (selectedNow === session.id) setSelected(dropped ? near : keep ? session.id : null);
}

/** Enter in a title: save, and open a new row below. An empty title only closes the row. */
export function enterEdit(): void {
  const session = editNow;
  if (!session) return;
  if (!session.title.trim()) return closeEdit({ select: true });
  flushEdit({ final: true });
  const task = getTask(session.id);
  if (!task) return closeEdit();
  draftAfter({ task, column: session.column });
}

/** Backspace in an empty new row: the row goes away and the row above is selected. */
export function dropDraft(): void {
  if (editNow?.draft) closeEdit({ select: true });
}

/** The task of the open row, or the row of a draft. */
function editRow(): TaskRow | null {
  if (!editNow) return null;
  return editNow.item?.task ?? getTask(editNow.id) ?? null;
}

/** Sets the date, the time, and the rule of the open row. */
export function setEditDate(value: DateValue): void {
  flushEdit();
  const session = editNow;
  if (!session) return;
  if (session.draft) {
    session.draft = { ...session.draft, due: value.date, time: value.date === null ? null : value.time, repeat: value.date === null ? null : value.repeat };
    return;
  }
  const task = getTask(session.id);
  if (task) applyDate(task, value);
}

export function setEditDay(offset: number): void {
  const row = editRow();
  if (row) setEditDate({ date: addDays(store.today, offset), time: row.time, repeat: row.repeat });
}

export function setEditDeadline(deadline: DateStr | null): void {
  flushEdit();
  const session = editNow;
  if (!session) return;
  if (session.draft) session.draft = { ...session.draft, deadline };
  else actions.updateTask({ id: session.id, deadline });
}

/** The Starred view: the list of a new task. */
export function setDraftList(listId: ID): void {
  if (editNow?.draft && getList(listId)) editNow.draft = { ...editNow.draft, listId, parentId: null, position: { at: 'top' } };
}

export function openRepeat(): void {
  const row = editRow();
  if (row) repeatRequest = { rule: row.repeat, time: row.time, date: row.due };
}

export function closeRepeat(result: { rule: RepeatRule; time: TimeStr | null } | null): void {
  repeatRequest = null;
  if (!result) return;
  flushEdit();
  const session = editNow;
  if (!session) return;
  if (session.draft) {
    // The data layer gives a new task with a rule the first date of that rule. The row shows it now.
    session.draft = { ...session.draft, repeat: result.rule, time: result.time, due: firstOccurrence(result.rule) };
    return;
  }
  actions.setRepeat({ id: session.id, rule: result.rule });
  const task = getTask(session.id);
  if (task && task.time !== result.time) actions.setDate({ id: task.id, due: task.due, time: result.time });
}

// ---- Actions on a task ----

function finishComplete(id: ID): void {
  clearTimeout(leaveTimers.get(id));
  leaveTimers.delete(id);
  removeRow(id, () => {
    actions.completeTask({ id });
    leaving.delete(id);
  });
}

/**
 * Completes a task. The row shows as completed in the same frame, and leaves after a moment.
 * A second call in that moment takes the first one back.
 */
export function complete(task: TaskRow): void {
  const id = task.id;
  if (leaveTimers.has(id)) {
    clearTimeout(leaveTimers.get(id));
    leaveTimers.delete(id);
    leaving.delete(id);
    return;
  }
  if (editNow?.id === id) closeEdit();
  if (!getTask(id)) return;
  if (reducedMotion()) return finishComplete(id);
  leaving.add(id);
  leaveTimers.set(
    id,
    setTimeout(() => finishComplete(id), LEAVE_MS),
  );
}

/** The page or the layout goes away: the rows that wait become completed now, with no motion. */
export function settle(): void {
  for (const [id, timer] of leaveTimers) {
    clearTimeout(timer);
    actions.completeTask({ id });
    leaving.delete(id);
  }
  leaveTimers.clear();
  flushEdit();
}

export function uncomplete(task: TaskRow): void {
  removeRow(task.id, () => void actions.uncompleteTask({ id: task.id }));
}

export function removeTask(task: TaskRow): void {
  if (editNow?.id === task.id) closeEdit({ select: selectedNow === task.id });
  if (getTask(task.id)) removeRow(task.id, () => void actions.deleteTask({ id: task.id }));
}

export function toggleStar(task: TaskRow): void {
  const session = editNow;
  if (session?.id === task.id && session.draft) {
    session.draft = { ...session.draft, starred: !session.draft.starred };
    return;
  }
  // In the Starred view the row leaves when its star goes.
  if (ui.starred && task.starred) removeRow(task.id, () => void actions.setStar({ id: task.id, starred: false }));
  else actions.setStar({ id: task.id, starred: !task.starred });
}

/** The open tasks of the level of a task in "My order", from top to bottom. */
function siblings(task: TaskRow): TaskRow[] | null {
  if (ui.starred || !ordered(task.listId)) return null;
  const found = findItem(listView(task.listId).groups, task.id);
  if (!found) return null;
  const parentId = found.item.depth === 1 ? task.parentId : null;
  return found.group.items
    .filter((item) => item.depth === found.item.depth && (item.depth === 0 || item.task.parentId === parentId))
    .map((item) => item.task);
}

/** Ctrl+Up and Ctrl+Down: one place among the tasks of the same level. */
export function moveBy({ task, step }: { task: TaskRow; step: -1 | 1 }): void {
  const all = siblings(task);
  if (!all) return;
  const other = all[all.findIndex((each) => each.id === task.id) + step];
  if (!other) return;
  if (step < 0) actions.moveTask({ id: task.id, beforeId: other.id });
  else actions.moveTask({ id: task.id, afterId: other.id });
}

/** Ctrl+Shift+Up and Ctrl+Shift+Down. */
export function moveToEdge({ task, edge }: { task: TaskRow; edge: 'top' | 'bottom' }): void {
  const all = siblings(task);
  if (!all) return;
  if (edge === 'top') {
    actions.moveToTop({ id: task.id });
    return;
  }
  const last = all[all.length - 1]!;
  if (last.id !== task.id) actions.moveTask({ id: task.id, afterId: last.id });
}

// ---- Menus ----

// The Menu part calls onclose before onselect, so what an entry runs is not in the state that
// the close clears.
let chosen: OpenMenu | null = null;

function openMenu(next: OpenMenu): void {
  chosen = next;
  menu = next;
  menuOpen = true;
}

export function runMenu(itemId: string): void {
  chosen?.run(itemId);
}

export function openTaskMenu({ task, anchor, align = 'start' }: { task: TaskRow; anchor: MenuAnchor; align?: 'start' | 'end' }): void {
  const column = columnOf(task.id);
  closeEdit({ select: true });
  const now = getTask(task.id);
  if (!now || now.completed || column === null) return;
  setSelected(now.id);
  openMenu({
    anchor,
    align,
    label: 'Task options',
    items: taskMenuItems({ task: now, layout: 'wide' }),
    run(itemId) {
      const row = getTask(now.id);
      if (!row) return;
      if (itemId === 'delete') return removeTask(row);
      void runTaskMenuItem({ task: row, itemId, hooks: { addSubtask: (parent) => draftChild({ task: parent, column }) } });
    },
  });
}

export function openListMenu({ list, anchor }: { list: ListRow; anchor: MenuAnchor }): void {
  closeEdit();
  openMenu({
    anchor,
    align: 'end',
    label: 'List options',
    items: listMenuItems({ list, layout: 'wide' }),
    run: (itemId) => {
      const row = getList(list.id);
      if (row) void runListMenuItem({ list: row, itemId });
    },
  });
}

export function openStarredMenu(anchor: MenuAnchor): void {
  closeEdit();
  openMenu({ anchor, align: 'end', label: 'Starred options', items: starredMenuItems(), run: runStarredMenuItem });
}

/**
 * The note menu: from the three-dot button of a card or of the editor, or a right click on a
 * card. `anchor` goes to "Change color" too, so the color picker shows at the same place.
 * `onrun` is called after an entry started, for example so the editor closes after "Archive".
 */
export function openNoteMenu({
  note,
  anchor,
  parts,
  onrun,
}: {
  note: NoteRow;
  anchor: MenuAnchor;
  parts: Pick<NotesParts, 'noteMenuItems' | 'runNoteMenuItem'>;
  onrun?: (itemId: string) => void;
}): void {
  openMenu({
    anchor,
    align: 'start',
    label: 'Note options',
    items: parts.noteMenuItems({ note }),
    // The note of the time of the open: "Pin" and "Archive" do what their labels said then.
    run: (itemId) => {
      void parts.runNoteMenuItem({ note, itemId, anchor });
      onrun?.(itemId);
    },
  });
}

/** A menu with one entry for each list, for the list of a new task. */
export function openListPicker({ anchor, value, onpick }: { anchor: MenuAnchor; value: ID; onpick: (listId: ID) => void }): void {
  openMenu({
    anchor,
    align: 'start',
    label: 'List',
    items: listsOrdered().map((list) => ({ id: list.id, label: list.title, checked: list.id === value })),
    run: onpick,
  });
}
