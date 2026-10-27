// The data contract between the server and the client. SPEC.md explains the rules.

export type ID = string;
/** Hybrid logical clock value. A later value is greater in a string comparison. */
export type HLC = string;
/** Local date, 'YYYY-MM-DD'. */
export type DateStr = string;
/** Local time, 'HH:MM' in 24-hour form. */
export type TimeStr = string;

export type SortMode = 'my' | 'date' | 'deadline' | 'starred' | 'title';
export type StarredSort = 'date' | 'starred';

export interface User {
  id: ID;
  name: string;
}

export type RepeatUnit = 'day' | 'week' | 'month' | 'year';

export type RepeatEnd =
  | { type: 'never' }
  | { type: 'on'; date: DateStr }
  | { type: 'after'; count: number };

export interface RepeatRule {
  /** 1 to 1000. */
  every: number;
  unit: RepeatUnit;
  /** For 'week': the weekdays, 0 is Sunday. At least one. */
  weekdays?: number[];
  /** For 'month'. 'day' uses monthDay. 'weekday' uses ordinal and weekday. */
  monthMode?: 'day' | 'weekday';
  /** 1 to 31, or -1 for the last day of the month. */
  monthDay?: number;
  /** 1 to 4, or -1 for the last one in the month. */
  ordinal?: number;
  /** 0 is Sunday. */
  weekday?: number;
  /** The first date that the rule can give. */
  start: DateStr;
  end: RepeatEnd;
}

export interface ListRow {
  id: ID;
  title: string;
  owner: ID;
  shared: boolean;
  isDefault: boolean;
  createdAt: number;
  deleted: boolean;
  // Per-person fields
  /** Order key among the lists of this person. null sorts after all keys, by createdAt. */
  pos: string | null;
  sort: SortMode;
  hidden: boolean;
}

export interface TaskRow {
  id: ID;
  listId: ID;
  parentId: ID | null;
  title: string;
  notes: string;
  /** Order key among the siblings. */
  pos: string;
  due: DateStr | null;
  time: TimeStr | null;
  deadline: DateStr | null;
  repeat: RepeatRule | null;
  /** Number of completed occurrences of a repeating task. */
  repeatCount: number;
  /** A repeating task rests in "Completed" until this date. */
  hiddenUntil: DateStr | null;
  lastDoneAt: number | null;
  lastDoneDue: DateStr | null;
  completed: boolean;
  completedAt: number | null;
  completedBy: ID | null;
  createdAt: number;
  createdBy: ID;
  deleted: boolean;
  // Per-person fields
  starred: boolean;
  starredAt: number | null;
}

/** The colors of a note, in the order of the color picker. 'default' is the color of a card. */
export const NOTE_COLORS = [
  'default',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'darkblue',
  'purple',
  'pink',
  'brown',
  'gray',
] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

/** A note: a title, a body, and a color. It is not part of a list. */
export interface NoteRow {
  id: ID;
  /** Can be empty. One line. */
  title: string;
  /** Can be empty. Plain text with line breaks. */
  body: string;
  color: NoteColor;
  /** Only the owner changes it. */
  shared: boolean;
  /** The time of the last change of the title or the body. */
  editedAt: number;
  /** The person who made the last change of the title or the body. */
  editedBy: ID | null;
  /** Only the owner changes it. */
  deleted: boolean;
  owner: ID;
  /** A put that makes a note has this field. No other put has it, except the undo of a delete. */
  createdAt: number;
  // Per-person fields
  pinned: boolean;
  archived: boolean;
}

export type ListFields = Partial<Omit<ListRow, 'id'>>;
export type TaskFields = Partial<Omit<TaskRow, 'id'>>;
export type NoteFields = Partial<Omit<NoteRow, 'id'>>;

export type Put =
  | { kind: 'list'; id: ID; fields: ListFields }
  | { kind: 'task'; id: ID; fields: TaskFields }
  | { kind: 'note'; id: ID; fields: NoteFields };

export type Op = Put & { opId: ID; ts: HLC };

export const LIST_USER_FIELDS = ['pos', 'sort', 'hidden'] as const;
export const TASK_USER_FIELDS = ['starred', 'starredAt'] as const;
export const NOTE_USER_FIELDS = ['pinned', 'archived'] as const;
export const LIST_FIXED_FIELDS = ['owner', 'isDefault', 'createdAt'] as const;
export const TASK_FIXED_FIELDS = ['createdAt', 'createdBy'] as const;
export const NOTE_FIXED_FIELDS = ['owner', 'createdAt'] as const;

export const LIMITS = {
  title: 1024,
  notes: 8192,
  listTitle: 1024,
  noteTitle: 1024,
  // A sync at page close uses keepalive only if its body has at most 20,000 characters
  // (KEEPALIVE_MAX_CHARS in layer.svelte.ts). This limit leaves room for the title, the JSON
  // escapes, and the other fields of one note op.
  noteBody: 16_000,
  /** The most tasks that one "Make tasks" can make from a note. */
  noteTasks: 200,
  repeatEvery: 1000,
  name: 40,
  passwordMin: 8,
} as const;

export interface SyncRequest {
  clientId: ID;
  /** The revision from the last response. 0 for a first sync. */
  since: number;
  ops: Op[];
  /** IANA time zone of the device, for notification times. */
  tz: string;
}

export interface SyncResponse {
  rev: number;
  /** true: the client must replace all its rows with the rows in this response. */
  reset: boolean;
  lists: ListRow[];
  tasks: TaskRow[];
  notes: NoteRow[];
  gone: { lists: ID[]; tasks: ID[]; notes: ID[] };
  acked: ID[];
  rejected: ID[];
  /** Server time in milliseconds. */
  now: number;
}

/** The answer of /api/sync as the client reads it. A server from before notes leaves out `notes` and `gone.notes`. */
export type SyncAnswer = Omit<SyncResponse, 'notes' | 'gone'> & {
  notes?: NoteRow[];
  gone: { lists: ID[]; tasks: ID[]; notes?: ID[] };
};

export interface MeResponse {
  me: User | null;
  users: User[];
  canRegister: boolean;
  vapidPublicKey: string;
  version: string;
}

export interface ApiError {
  error: {
    code: 'unauthorized' | 'forbidden' | 'invalid' | 'conflict' | 'rate_limited' | 'closed' | 'not_found' | 'server';
    message: string;
  };
}

export interface PushMessage {
  title: string;
  body: string;
  taskId: ID | null;
  listId: ID | null;
  tag: string;
}

// View types, made by shared/view.ts

export interface ViewItem {
  task: TaskRow;
  depth: 0 | 1;
  hasChildren: boolean;
}

export interface ViewGroup {
  key: string;
  heading: string | null;
  tone: 'normal' | 'past';
  items: ViewItem[];
}

export interface ListView {
  groups: ViewGroup[];
  completed: TaskRow[];
  openCount: number;
}

/** The notes of one section of the notes screen, made by buildNotesView. */
export interface NotesView {
  /** Empty in the archive. */
  pinned: NoteRow[];
  others: NoteRow[];
}

// Action types, made by shared/actions.ts

export interface ActionResult {
  puts: Put[];
  undo: Put[];
  message: string | null;
}

export type TaskPosition =
  | { at: 'top' }
  | { after: ID }
  | { parentId: ID; at: 'end' };
