# Shared Tasks: specification

Shared Tasks is a todo list web app for two people. Its feature set follows Google Tasks, without the Calendar integration. It also has notes like Google Keep. Each device keeps a full copy of the data and works offline. A small server on an old phone keeps the devices in sync.

This file is the contract for the code.

## 1. Principles

1. **Fast.** Each user action changes the screen in the same frame. The app never waits for the network before it shows a result. No spinners for local data.
2. **Offline first.** The device is the source of what the user sees. The server is a relay and a backup.
3. **Small.** The server has no npm packages. The client ships one library, Svelte. Do not add a dependency.
4. **Familiar.** A person who knows a common todo app can use this one with no instructions.

Performance budget:

- The JavaScript for the first screen is less than 90 kB after gzip.
- A warm start from the service worker cache shows the task lists in less than 300 ms on a mid-range phone.
- A tap on a task circle gives visible feedback in the same frame.
- Animations use only `transform` and `opacity`. Durations are 120 ms to 220 ms.

## 2. Repository layout

| Path | Contents | Runs in |
|---|---|---|
| `shared/` | Pure logic and types. No DOM, no Node.js API | Server and client |
| `server/` | HTTP server, SQLite, sync, push | Node.js 24 on the phone, Node.js 22.18 or later on the Mac |
| `web/` | The client. Svelte 5 with runes, TypeScript, Vite | Browser |
| `web/src/data/` | Local database, in-memory store, sync engine | Browser |
| `web/src/ui/` | Design tokens, icons, primitives, pickers | Browser |
| `web/src/dnd/` | Drag and drop engine | Browser |
| `web/src/wide/` | Layout for a wide screen | Browser |
| `web/src/phone/` | Layout for a phone | Browser |
| `e2e/` | Playwright tests and fixtures | Mac |
| `deploy/` | Scripts for the S22 | Mac and phone |
| `scripts/` | Build helpers | Mac |

Rules for the code:

- Use `pnpm`. Do not add dependencies.
- `shared/` and `server/` run in Node.js with type stripping and no build step. Use only TypeScript syntax that can be erased: no `enum`, no `namespace`, no constructor parameter properties. Write relative imports with the `.ts` extension. Use `import type` for types.
- A function with more than two inputs takes one object. Example: `moveTask({ id, listId, parentId, beforeId })`.
- No comments that repeat the code. A comment gives a reason.
- Tests are in a file next to the code: `name.test.ts`. Use Vitest.
- Do not run `git commit`. The orchestrator makes the commits.

## 3. Data model

`shared/types.ts` is the source of truth. Read it.

There are three kinds of row: a list, a task, and a note. A row is a flat record. Each field is merged separately (section 4).

A put makes a row only if it has the field that marks a new row: `title` for a list, `listId` for a task, `createdAt` for a note. The client (`applyPut`) and the server have the same rule. A different put for a row that is not there is a late change to a row that was dropped, and it makes nothing.

Dates and times are local values with no time zone. A date is `YYYY-MM-DD`. A time is `HH:MM` in 24-hour form. "Today" is the local date of the device.

### Per-person fields

Some fields have a separate value for each person. The server stores them for each person and puts them into the row that it sends to that person. The client treats them like other fields.

- List: `pos` (the order of the lists), `sort`, `hidden`.
- Task: `starred`, `starredAt`.
- Note: `pinned`, `archived`.

### Fields that cannot change after the row is made

- List: `owner`, `isDefault`, `createdAt`.
- Task: `createdAt`, `createdBy`.
- Note: `owner`, `createdAt`.

### Notes

A note is not part of a list. It has a `title` (one line, can be empty), a `body` (plain text with line breaks, can be empty), and a `color` from `NOTE_COLORS`. `editedAt` and `editedBy` change with each change of the title or the body. A color, a pin, or an archive does not change them.

The colors and their names on the screen: `default` "Default", `red` "Red", `orange` "Orange", `yellow` "Yellow", `green` "Green", `teal` "Teal", `blue` "Blue", `darkblue` "Dark blue", `purple` "Purple", `pink` "Pink", `brown` "Brown", `gray` "Gray".

`createdAt` marks the put that makes a note, because a title can be empty and each typed key sends the title. Only `createNote` and the undo of `deleteNote` send it.

Two people who change the same text field at the same time: the later change wins for the full field. There is no merge inside a text.

## 4. Sync

### Model

Each change is a **put**: a row kind, a row id, and a set of fields with new values. The client makes ids with `crypto.randomUUID()`. To make a row, the client sends a put with all fields. To delete a row, the client sends a put with `deleted: true`.

An **op** is a put with an op id and a timestamp. The timestamp is a hybrid logical clock value (`shared/hlc.ts`). It is a string, and a later value is greater in a plain string comparison.

The server merges each field by itself. For each field in an op, the server keeps the value with the greater timestamp. So if one person changes the title and the other person changes the date at the same time, the two changes stay. If an op arrives two times, the second time changes nothing.

The server gives each changed row a new revision number. The revision is one counter for the full database.

### Request

`POST /api/sync` with a `SyncRequest`. The server does these steps in one transaction:

1. Apply each op that the person is permitted to make. Put the op id in `acked`, or in `rejected` if it is not permitted.
2. Collect the rows with a revision greater than `since` that the person can see. Put them in `lists`, `tasks`, and `notes`.
3. Collect the ids of rows with a revision greater than `since` that are deleted or that the person can no longer see. Put them in `gone`.
4. For each rejected op, send the current row (or put its id in `gone`), so the client goes back to the true state.

When `since` is 0, the server sends all visible rows and no `gone` ids.

The server deletes a tombstone (a list, a task, or a note) after 180 days. If `since` is older than the last deleted tombstone, the server sets `reset: true` and sends all visible rows. The client then replaces its rows and keeps its outbox.

### Client

- The client applies a put to its memory and its local database immediately. It adds the op to an outbox in the local database.
- Puts on the same row that are still in the outbox merge into one op.
- A sync sends the outbox and receives rows. The client writes the received rows over its rows, removes the `gone` rows, removes the acked and rejected ops from the outbox, and then applies the ops that are still in the outbox again.
- The client starts a sync 50 ms after a discrete action (complete, delete, move, star), 800 ms after the last text change, when the app becomes visible, when the network comes back, and when the server sends a poke.
- `GET /api/events` is a server-sent event stream. The server sends `event: poke` with the new revision when a row changes. The client that made the change does not need the poke, but a poke that it gets does no harm.
- Without the event stream, the client syncs each 60 seconds while the app is visible.
- On a network error the client tries again after 1 s, 2 s, 4 s, up to 60 s.

### Notes and a server or a client from before notes

- A server from before notes leaves out `notes` and `gone.notes`, and refuses each op of kind `note`. The client reads the answer of `/api/sync` as `SyncAnswer` (`shared/types.ts`), where the two are optional.
- The meta key `notesSynced` is true when the notes of the device match the server. Each answer with no `notes` sets it to false.
- The client sends an op of kind `note` only while `notesSynced` is true. Until then the op stays in the outbox and merges with later puts. If an answer has no `notes`, the client keeps the note ops of that request in the outbox, also if the server refused them, and does not count them in the message "The server refused a change".
- A device that ran the app from before notes moved `since` past the revisions of the notes, so it must get all rows one time. While `notesSynced` is not true and the last answer on this page did not lack `notes`, a request sends `since: 0`, and the answer replaces all rows as `reset: true` does. Such an answer with `notes` sets `notesSynced` to true. The request sends 0, but the stored `since` does not change, so the start does not wait as for a new device.
- An answer that has `notes` while `notesSynced` was not true starts the next request at once, in the same round, as when the body limit kept ops out. So the full sync and the held note ops do not wait for a later trigger.

### Visibility and permissions

A person can see a list if the person is its owner or if `shared` is true. A person can see a task if the person can see its list. A person can see a note if the person is its owner or if `shared` is true.

| Change | Who can make it |
|---|---|
| Make a list | Each person. The server sets `owner` to that person |
| Change `title` of a list | Each person who can see it |
| Change `shared` or `deleted` of a list | The owner |
| Change `pos`, `sort`, `hidden` of a list | Each person who can see it, for that person only |
| Delete the default list | No person |
| Make or change a task | Each person who can see its list. If `listId` changes, the person must see the old list and the new list |
| Make a note | Each person. The server sets `owner` to that person. The put must have `createdAt` |
| Change `title`, `body`, `color`, `editedAt`, `editedBy` of a note | Each person who can see it |
| Change `shared` or `deleted` of a note | The owner. In an op of a different person, a value equal to the stored value is no change |
| Change `pinned`, `archived` of a note | Each person who can see it, for that person only |

When `shared` or `deleted` of a list changes, the server gives a new revision to each task in the list. Then each client gets the tasks or drops them.

A task in a deleted list is not shown. The client drops it.

When `shared` or `deleted` of a note changes, each person who could see the note and cannot see it now gets its id in `gone.notes`. A note has no child rows, so nothing else changes.

### Clock

The server sends its time in `now`. The client keeps the difference and uses it for new timestamps. The server changes a timestamp that is more than 60 seconds in the future to its own time.

## 5. Server

Node.js with `node:http` and `node:sqlite`. One process. Settings come from environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `5107` | Port |
| `HOST` | `127.0.0.1` | Address |
| `DATA_DIR` | `./data` | Folder of the database |
| `WEB_DIR` | `./web/dist` | Folder of the built client |
| `PUBLIC_ORIGIN` | none | Public address, for example `https://s22.example.ts.net:8443`. If it starts with `https`, the session cookie is `Secure` |
| `MAX_USERS` | `2` | Sign-up closes at this number of accounts |
| `VAPID_SUBJECT` | `PUBLIC_ORIGIN` | Contact value for the push services |
| `BACKUP_DIR` | none | If set, the server writes one database copy each day to this folder and keeps 30 |

### API

All bodies are JSON. A request with a body must have `Content-Type: application/json`. For a `POST`, the `Origin` header, if present, must match the `Host` header.

| Route | Purpose |
|---|---|
| `GET /api/health` | `{ ok: true, version }`. No session necessary |
| `GET /api/me` | `MeResponse`. No session necessary. Tells the client if a person is signed in and if sign-up is open |
| `POST /api/register` | `{ name, password }`. Makes an account and its default list "My Tasks". Signs in. Closed when `MAX_USERS` accounts exist |
| `POST /api/login` | `{ name, password }`. After 5 wrong passwords for a name, the server refuses that name for 30 seconds |
| `POST /api/logout` | Ends the session |
| `POST /api/password` | `{ current, next }` |
| `POST /api/profile` | `{ name }`. Changes the display name |
| `POST /api/sync` | Section 4 |
| `GET /api/events` | Event stream |
| `POST /api/push/subscribe` | `{ endpoint, keys: { p256dh, auth } }` for this session |
| `POST /api/push/unsubscribe` | `{ endpoint }` |
| `POST /api/push/test` | Sends a test notification to the devices of the person |
| `POST /api/test/reset` | Only when the environment variable `ST_TEST_RESET` is `1`: deletes all data and writes the seed data again. For automated tests. In each other case the route does not exist |

Errors are `{ error: { code, message } }` with a 4xx or 5xx status. Codes: `unauthorized`, `forbidden`, `invalid`, `conflict`, `rate_limited`, `closed`, `not_found`, `server`.

### Accounts and sessions

- A name is 1 to 40 characters and is unique without regard to case. A password is at least 8 characters.
- Passwords are stored as scrypt hashes with a salt for each account.
- A session token is 32 random bytes. The database stores its SHA-256 hash. The cookie is `st_session`, `HttpOnly`, `SameSite=Lax`, `Path=/`, 400 days. Each sync renews it if more than one day went by.
- `server/cli.ts` has the commands `add-user`, `reset-password`, `list-users`, and `seed`. `seed` fills an empty database with the test accounts in `e2e/fixtures/users.json` and with sample lists. It is for tests only.

### Static files

- The server serves `WEB_DIR`. A path with no file gets `index.html`.
- Files under `/assets/` have a hash in the name: `Cache-Control: public, max-age=31536000, immutable`.
- `index.html`, `sw.js`, and `manifest.webmanifest`: `Cache-Control: no-cache`.
- If `file.br` or `file.gz` exists and the client accepts it, the server sends that file.
- Security headers on each response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and a `Content-Security-Policy` that permits only the app's own origin (plus `data:` images and inline styles).

### Notifications

- The server makes its VAPID key pair on the first start and keeps it in the database.
- `server/push.ts` implements Web Push with `node:crypto`: the VAPID token (RFC 8292) and the `aes128gcm` message encryption (RFC 8291). A test checks the encryption against the example in RFC 8291.
- A scheduler runs each 20 seconds. A task gives one notification for its date and one for its deadline:
  - A task with a date and a time: at that time.
  - A task with a date and no time: at 09:00.
  - A task with a deadline: at 09:00 on that day.
- Times are in the time zone of the person who gets the notification. The client sends its time zone with each sync.
- The people who get it: the owner of a private list, each person for a shared list.
- No notification for a completed, deleted, or resting task. No notification that is more than 12 hours late.
- The server records each sent notification, so a restart does not send it again.
- The message has `{ title, body, taskId, listId, tag }`. The title is the task title. The body is the list name and the time, or "Deadline today".
- If a push service answers 404 or 410, the server deletes that subscription.

## 6. Shared logic

Each module is pure. Each function that needs the date or time gets it as an input.

| Module | Contents |
|---|---|
| `types.ts` | Types. Written already |
| `hlc.ts` | Clock for timestamps. Written already |
| `ids.ts` | `newId()` |
| `fracindex.ts` | `keyBetween(a, b)` and `keysBetween(a, b, n)`. Order keys are strings. `a` or `b` can be `null` for the start or the end |
| `dates.ts` | Date math and date text |
| `recurrence.ts` | Repeat rules |
| `merge.ts` | `applyPut(rows, put)` for the client, with defaults for a new row |
| `view.ts` | From rows to what the screen shows |
| `actions.ts` | From a user intent to puts, with the puts that undo it |

Each value export of `actions.ts` becomes an action of the data layer. So `actions.ts` exports only action functions. Constants go in `types.ts`, and helpers stay private or go in a different module.

### `dates.ts`

`todayOf(date)`, `parse`, `toJsDate`, `fromJsDate`, `addDays`, `addMonths` (the day is clamped to the month length), `addYears`, `diffDays`, `weekdayOf` (0 is Sunday), `daysInMonth`, `monthGrid({ year, month, weekStart })`, `weekStartOf(locale)`.

Text, with a locale input:

- `dateChipText({ date, time, today, locale })`: "Today", "Tomorrow", "Yesterday", "3 days ago", "2 weeks ago" (7 to 34 days), then "Wed 7 Oct". A date in a different year also shows the year. A time, if present, follows after a comma: "Today, 14:30".
- `deadlineChipText({ deadline, today, locale })`: "Due today", "Due tomorrow", "Due Wed 7 Oct". A deadline in the past: "Due yesterday", "Due 3 days ago".
- `groupHeading({ date, today, locale })`: "Today", "Tomorrow", "Wed 7 Oct".
- `completedText({ at, locale })`: "Completed: Mon 5 Oct".
- `timeText({ time, locale })`: 24-hour or 12-hour form from the locale.
- `editedText({ at, today, locale })`: the text for the time of the last edit of a note. `at` is a time in milliseconds. "Edited 14:30" for today, "Edited yesterday", "Edited Mon 5 Oct" for an earlier day, and "Edited 5 Oct 2025" for a different year. The screen adds " by NAME" when the other person made the edit.

### `recurrence.ts`

- `firstOccurrence(rule)`: the first date of the rule on or after `rule.start`.
- `nextOccurrence({ rule, after })`: the first date of the rule after `after`. `null` never. The end of the rule is not checked here.
- `isFinished({ rule, doneCount, next })`: true when the end of the rule is reached.
- `describeRule({ rule, locale })`: "Daily", "Every 3 days", "Weekly on Monday", "Every 2 weeks on Mon, Wed", "Monthly on day 5", "Monthly on the last day", "Monthly on the first Monday", "Yearly on 5 October". With an end: ", until 4 Nov" or ", 30 times".
- `validateRule(rule)`.

A month rule with day 31 uses the last day of a shorter month.

### `view.ts`

- `isResting({ task, today })`: the task repeats and `hiddenUntil` is after today.
- `isOpen({ task, today })`: not deleted, not completed, not resting.
- `buildListView({ list, tasks, today, sort })` gives `{ groups, completed, openCount }`.
  - `groups` is an array of `{ key, heading, tone, items }`. `tone` is `'normal'` or `'past'`. An item is `{ task, depth, hasChildren }`.
  - Sort `my`: one group with no heading. Top-level tasks by `pos`, then `id`. Subtasks follow their parent with depth 1, by `pos`.
  - Sort `date`: flat. Groups "Past", "Today", "Tomorrow", one for each later date, "No date". In a group: tasks with no time first, then by time, then by `pos`.
  - Sort `deadline`: flat. Groups "Past", "Today", "Tomorrow", one for each later date, "No deadline".
  - Sort `starred`: flat, one group. Starred tasks first, newest star first. Then the other tasks in `my` order.
  - Sort `title`: flat, one group. Text order from `Intl.Collator` with `numeric: true` and `sensitivity: 'base'`.
  - `completed`: the completed tasks and the resting tasks, newest first by `completedAt` or `lastDoneAt`. Flat.
  - `openCount` counts open tasks and open subtasks.
- Parent rule for the `my` sort: a subtask shows below its parent only if the parent is in the same list and is open. If the parent is resting, the subtask is hidden. In each other case (the parent is deleted, completed, missing, or in a different list) the subtask shows as a top-level task.
- `buildStarredView({ lists, tasks, today, sort })`: the open starred tasks of all visible lists. Sort `date` uses the date groups. Sort `starred` is one group, newest star first.
- `buildNotesView({ notes, archived, query, locale })` gives a `NotesView`: `{ pinned, others }`.
  - Deleted notes are not in it.
  - `archived: false`: `pinned` has the notes that are pinned and not archived. `others` has the notes that are not pinned and not archived.
  - `archived: true`: `pinned` is empty. `others` has all archived notes.
  - In each part: newest `createdAt` first, then `id`. An edit does not move a note.
  - `query`: if it is not empty after trim, a note stays only if each word of the query is in its title or its body. The comparison ignores case and accents (`normalize('NFD')`, marks removed, `toLocaleLowerCase(locale)`).
- `noteTaskTitles(body)`: the task titles that a note body gives for "Make tasks", in order, before any limit. Each line of the body gives at most one title. For each line: trim it. Remove one leading `- `, `* `, `• `, or `+ `, or one number (digits) followed by `. ` or `) `, then trim again. If the line then starts with `[x]` or `[X]`, skip it. Else remove one leading `[ ]` or `[]` and trim again. Skip an empty line. Example: `  - [ ] Milk` gives "Milk", and `- [x] Eggs` gives nothing.

### `actions.ts`

Each function takes the current rows and an intent. It returns `{ puts, undo, message }`. `undo` is the list of puts that brings back the values from before. `message` is the snackbar text or `null`. The functions do not change their inputs.

| Function | Rule |
|---|---|
| `createTask` | Inputs: `listId`, `title`, optional fields, and a position: `{ at: 'top' }`, `{ after: id }`, or `{ parentId, at: 'end' }`. No task if the title is empty after trim |
| `updateTask` | A change of fields. The title cannot become empty: an empty title keeps the old title |
| `setDate` | Sets `due` and `time`. `time` with no `due` sets `due` to today |
| `setRepeat` | Sets the rule and sets `due` to `firstOccurrence`. A subtask cannot repeat. `null` stops the repeat and keeps `due` |
| `completeTask` | See below |
| `uncompleteTask` | See below |
| `deleteTask` | The task and its subtasks. Message "Task deleted", or "3 tasks deleted" |
| `moveTask` | Inputs: `id`, `listId`, `parentId`, `beforeId` or `afterId` or neither for the end. Sets `listId`, `parentId`, `pos`. The subtasks of a moved task go with it to the new list. A task with subtasks cannot become a subtask: its subtasks become subtasks of the new parent, directly after it. A subtask cannot be a parent |
| `indentTask` | The task becomes the last subtask of the top-level task above it. Not possible for the first task, a subtask, or a repeating task |
| `unindentTask` | The subtask becomes a top-level task directly after its old parent |
| `moveToTop` | First position among its siblings |
| `setStar` | Sets `starred` and `starredAt` |
| `createList` | Inputs: `title`. The list goes to the end of the list order |
| `renameList`, `setListSort`, `setListHidden`, `setListShared`, `moveList` | Field changes. `moveList` takes `beforeId` or `afterId` or `toFirst` |
| `deleteList` | Sets `deleted`. Not for the default list. Message "List deleted" |
| `clearCompleted` | Deletes each completed task of the list. Resting tasks stay. Message "5 completed tasks deleted" |
| `createNote` | Inputs: optional `id`, `title`, `body`, `color`, `pinned`, `shared`. No note if the title and the body are both empty after trim, or if a row with that id is there. The text is cut to the limits but not trimmed, because the editor makes the note at the first key. One put with all fields: `owner` me, `createdAt` and `editedAt` now, `editedBy` me, `archived` false. An unknown color gives `default`. No message |
| `updateNote` | Inputs: `id`, optional `title`, optional `body`. A field that is not in the intent stays as it is. The title and the body can become empty. A change of the text also sets `editedAt` now and `editedBy` me. A title loses its line breaks. No message |
| `setNoteColor` | Inputs: `id`, `color`. No puts for a color that is not in `NOTE_COLORS`. No message |
| `setNotePinned` | Inputs: `id`, `pinned`. A pin also sets `archived` to false. No message, or "Note unarchived" if the pin took the note out of the archive |
| `setNoteArchived` | Inputs: `id`, `archived`. An archive also sets `pinned` to false. Message "Note archived" or "Note unarchived" |
| `setNoteShared` | Inputs: `id`, `shared`. Only the owner. No message: the screen shows "Shared with NAME" or "Stopped sharing", because only the screen knows the name |
| `deleteNote` | Inputs: `id`, optional `discard`. Only the owner. Sets `deleted`. Message "Note deleted". With `discard: true` the message is `null` and `undo` is empty |
| `noteToTasks` | Inputs: `id`, `listId`, `mode` (`'one'` or `'lines'`), optional `archive`. See below |

Complete:

- A task that does not repeat: `completed: true`, `completedAt`, `completedBy`. Each open subtask gets the same. Message "Task completed", or "3 tasks completed".
- A task that repeats: find the next date after the later of `due` and today. If the rule is finished, clear `repeat` and complete the task as above. If not, set `lastDoneDue` to the old `due`, `lastDoneAt` to now, `due` and `hiddenUntil` to the next date, and add 1 to `repeatCount`. Each subtask of the task becomes open again, so a checklist starts new for the next date. Message "Task completed. It comes back on Wed 7 Oct".

Make tasks from a note (`noteToTasks`):

- `'lines'`: the titles are `noteTaskTitles(note.body)` (`view.ts`), in order. The title of the note gives no task, because it is a heading such as "Groceries".
- `'one'`: one task. Its title is the trimmed note title. With no title, the first line of the body that has text is the title and the lines after it are the details. With a title, the body is the details.
- At most `LIMITS.noteTasks` tasks. A title is cut to `LIMITS.title` and the details to `LIMITS.notes`. The tasks go to the top of the list in their order. They have no date.
- `archive: true` also archives the note for this person, as `setNoteArchived` does: `archived` true and `pinned` false.
- No puts if the note or the list is not there, or if no task has a title.
- Message "Task added to Groceries" or "5 tasks added to Groceries". The undo deletes the tasks and puts back `archived` and `pinned`.

Uncomplete:

- A completed task: `completed: false`, `completedAt: null`, `completedBy: null`. The task goes to the top of its siblings. Its subtasks stay as they are. Message "Task marked uncompleted".
- A resting task: `due` gets `lastDoneDue`, `hiddenUntil` and `lastDoneAt` and `lastDoneDue` get `null`, and `repeatCount` goes down by 1.

## 7. Client data layer

`web/src/data/index.ts` is the only door from the UI to the data. The UI does not import other files of `web/src/data/`.

```ts
// Session
session.status            // 'loading' | 'signedOut' | 'signedIn'
session.me                // User | null
session.users             // User[]   all accounts on the server
session.canRegister       // boolean
login({ name, password }), register({ name, password }), logout()
changePassword({ current, next }), rename({ name })   // each returns { ok: true } or { ok: false, message }

// Rows (reactive)
store.today               // DateStr, changes at midnight
listsOrdered()            // ListRow[] visible lists in the order of this person
getList(id), getTask(id)
listView(listId)          // ListView from buildListView, with the sort of the list. Cached for each list
starredView()             // from buildStarredView with prefs.starredSort
subtasksOf(taskId)        // TaskRow[] open and completed, for the detail screen
getNote(id)               // NoteRow | undefined: undefined for a deleted note or one that is not there
notesView({ archived, query })  // NotesView from buildNotesView. Cached for each input
otherUser()               // User | null

// Actions: each applies the puts now, starts a sync, records the undo, and shows the snackbar message
actions.createTask(...), actions.updateTask(...), ...   // one for each function of shared/actions.ts
undo()                    // undoes the last action. Returns false if there is none
canUndo()

// Sync state (reactive)
sync.status               // 'idle' | 'syncing' | 'offline' | 'error'
sync.pending              // number of ops in the outbox
sync.lastSyncedAt         // number | null
sync.now()                // start a sync

// Snackbar (reactive)
toast.current             // { id, message, undoable } | null
toast.show({ message, undoable }), toast.dismiss()

// Settings of this device (reactive, in localStorage)
prefs.theme               // 'system' | 'light' | 'dark'
prefs.starredSort         // 'date' | 'starred'
prefs.completedOpen       // Record<listId, boolean>
prefs.lastTab             // null or a list id ("All tasks" on a wide screen, that tab on the phone), 'starred', or 'notes' (the Notes tab on the phone, the Notes or Archive view on a wide screen)
prefs.sidebarOpen         // boolean

// Notifications
push.supported, push.permission, push.enabled
push.enable(), push.disable(), push.test()
```

Rules:

- Start: open the local database, read all rows into memory in one transaction, then show the screen. Call `/api/me` and sync in the background. If the device is offline and has rows, show them.
- A change in one list must not make the views of other lists run again. A change of a note must not make a list view or the starred view run again, and a change of a task must not make the notes view run again.
- An action with an empty `undo` records no undo step.
- `updateNote` with only `id`, `title`, and `body` is typing, like `updateTask` with only `id`, `title`, and `notes`: the sync starts 800 ms after the last key, and a burst of keys is one undo step.
- Sign-out deletes the local database of that account.
- The local database has the stores `lists`, `tasks`, `notes`, `outbox`, and `meta` (`since`, `clientId`, the clock, the signed-in person, `notesSynced`). Version 2 of the database adds `notes`. The upgrade from version 1 keeps the other stores.

## 8. Screens

The layout is `wide` when the window is at least 840 px wide, and `phone` when it is narrower. `web/src/App.svelte` selects the layout. It also shows the sign-in screen, the snackbar, and the dialogs.

### Looks

- System fonts: `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`. No web fonts.
- Colors come from CSS variables in `web/src/ui/tokens.css`. Light and dark themes. `data-theme` on `<html>` forces a theme. With no value the system setting applies.
- Cards have a 16 px radius. Chips and buttons are pills. Icons are inline SVG from `web/src/ui/icons.ts`, 24 px grid, drawn for this app.
- Text inputs are at least 16 px so that iOS does not zoom.
- Respect `prefers-reduced-motion`.
- Each control that is only an icon has an `aria-label`. Menus, dialogs, and sheets trap the focus and close with Esc. The browser Back action closes the top sheet, dialog, or detail screen.

### Sign-in

One card: name, password, a "Sign in" button. If sign-up is open, a second mode "Create account" with name, password, and password again. Errors show below the field. The name of the app is "Shared Tasks".

### Task row

- A circle at the left. A click completes the task. The circle fills with a check mark and the title gets a line through it for 300 ms, then the row leaves.
- Title. Below it, up to two lines of the details in a smaller, dimmer text.
- Chips below: date (clock icon, red if in the past, with a repeat icon if the task repeats), deadline (target icon).
- A star at the right. Filled if set.
- A subtask is indented by 28 px.

### Phone layout

- **Top bar**: the title "Tasks" ("Notes" on the Notes tab), a small sync icon that shows only when the device is offline or has pending changes, and a round button with the first letter of the person's name. The button opens Settings.
- **Tabs**: a row that scrolls sideways. First a star tab, then the Notes tab, then one tab for each list, then "+ New list". The Notes tab has a light bulb icon and the text "Notes". It has no count and does not move. A tab shows the open count in a pill, but not on the active tab and not for 0. A shared list has a small people icon.
- **Pages**: one page for each tab, in a sideways scroll area with scroll snap. A swipe changes the tab. A tap on a tab scrolls to the page. Only the active page and its two neighbors have content.
- **Page of a list**: a card with a header row (list name, a sort button, a three-dot button), then the task groups. A second card "Completed (N)" that opens and closes. The empty states have a small drawing and the texts "Nothing here yet" with "Add a task to get started", and "All done" with "Every task in this list is complete".
- **Add button**: a round button at the bottom right. On the Notes tab it opens a new note (see "Notes"). On each other tab it opens a bottom sheet above the keyboard: a title field, and a row with a details button, a date button, a star button, and "Save". "Save" is disabled when the title is empty. Enter or "Save" adds the task at the top of the list, clears the field, and keeps the sheet open for the next task. A tap outside or Back closes the sheet. On the star tab, the sheet has a list selector and the task gets a star.
- **Task detail**: a tap on a row opens a full screen that slides in. Top: Back, a list selector, a star, a three-dot menu with "Delete". Then the title, the details, a row "Add date/time", a row "Add deadline", a row for the repeat rule, and the subtasks with "Add subtasks". A wide pill button at the bottom: "Mark completed" or "Mark uncompleted". Changes save as the user types.
- **Menus** open as bottom sheets.
- **Reorder**: touch and hold a row for 250 ms, then move it. A move to the right below a task makes a subtask. Only in the "My order" sort.
- **List order**: touch and hold a tab, then move it. The list menu also has "Move list left" and "Move list right".
- Use `100dvh`, and `env(safe-area-inset-*)` for the notch and the home bar.

### Wide layout

- **Top bar**: a menu button that shows and hides the sidebar, the app icon and "Tasks" ("Notes" in the two notes views, with the notes search field in the middle of the bar), a sync icon as on the phone, a "?" button for the shortcut list, and the round account button.
- **Sidebar**: a "Create" button, "All tasks", "Starred", "Notes", "Archive" (the archived notes), a "Lists" heading that opens and closes, one row for each list with a check box and the open count, and "Create new list". The check box shows or hides the column of the list.
- **Main area**: "All tasks" shows one column for each list that is not hidden, 320 px wide, with sideways scroll. "Starred" shows one column of starred tasks.
- **Column**: the list name, a people icon if shared, a three-dot button, an "Add a task" row, the task groups, "Completed (N)".
- **Edit in place**: a click on a title opens the row. The open row shows the title field with the text selected, a "Details" field, the chips "Today" and "Tomorrow" and a clock button (or the date chip with an X), the deadline chip with an X, and a repeat button. A six-dot handle shows at the left. Enter saves and opens a new row below. In a subtask, Enter opens a new subtask. Esc or a click outside saves and closes. A new row with an empty title is dropped.
- **"Create" button**: a dialog with title, details, date, and a list selector. "Save". In the Notes view it opens the note composer.
- **Hover**: a row shows a three-dot button and the star. A completed row shows a bin button.
- **Right click** on a row opens the task menu.
- **Drag**: a row moves in its column and to other columns. A drop at an indent makes a subtask. A column header moves the column.
- **Print**: "Print list" prints only that list, with open completed tasks if the section is open.

### Notes

The notes screens follow Google Keep. The phone and the wide layout use the same parts from `web/src/notes/`. They are one download: `web/src/notes/index.ts` is the only door to the folder, and a layout loads it with one `import('../notes/index.ts')` and imports no other file of the folder. The phone starts the download when the Notes page first gets content, and at the start when `prefs.lastTab` is 'notes'. The wide layout starts it when it first shows the Notes or the Archive view. The Notes page and its neighbors show their content when the download is done, with no spinner.

`web/src/notes/index.ts` exports:

- `NotesGrid`, props `{ archived: boolean; query: string; hiddenId: ID | null; onopen: (id: ID) => void; onmenu: (input: { note: NoteRow; anchor: MenuAnchor }) => void }`. The headings, the masonry, the cards, and the empty states. The column rules come from `layout.mode`. `hiddenId` is the note of the open composer. The card controls and the right click call `onmenu` for the note menu.
- `NoteEditor`, props `{ id: ID; isNew: boolean; onclose: () => void; onmenu: (anchor: MenuAnchor) => void }`. The fields, the controls, the "Edited" text, and each rule of "Note editor" below. The phone puts it in its full-screen overlay. The wide layout puts it in a 600 px dialog. `onclose` asks the layout to close the overlay. The editor does its close rules when it goes off the screen, so Back and Esc follow them too. The editor paints the note color over all of its frame, so the frame has no padding (a `Dialog` with `padded={false}` and no title). Its function `focus(field?: 'title' | 'body')` (through `bind:this`) puts the focus in a field in the same call: the phone calls it after `flushSync` in the handler of the tap.
- `NoteComposer`, props `{ onclose?: () => void; open?: boolean; noteId?: ID | null }`. Wide only. `bind:open` opens and closes it. `bind:noteId` gives the note of the open composer, for `hiddenId` of the grid. Its function `focus()` (through `bind:this`) opens it with the focus in the body.
- `noteMenuItems({ note })` and `runNoteMenuItem({ note, itemId, anchor? })`, with the same form as `taskMenuItems` and `runTaskMenuItem` in `web/src/common/menus.ts`. The layout shows the items in its own menu. "Change color" and "Make tasks" open their sheet or dialog through the dialog host of `web/src/common/`, so the layout mounts nothing more for them. `anchor` is where the menu opened: the color picker shows there as a popover on a wide screen.
- `NoteColorDialog` and `MakeTasksDialog`, for the dialog host of `web/src/common/` only.

The icons are in `web/src/ui/icons.ts` with these names: `bulb` (the Notes tab and the sidebar), `pin`, `pin-filled` (a pinned note), `archive`, `unarchive`, `palette` (the color button), `search`. Each note color is the variable `--note-<color>` in `tokens.css`, for example `--note-darkblue`, with a light and a dark value in each theme block. `--note-default` is `var(--surface)`. Text on a note uses `--text`, and dim text on a note uses `--note-text-dim`. Each of the two has a contrast of at least 4.5:1 on each note color in each theme.

**Note card**

- A card is an `<article>` with the note color as its background. A `default` card has the card color and a thin edge. Its open control is a `<button>` that covers the card. Its name is the title, the first line of the body for a note with no title, or "Empty note". The other controls are separate buttons after it in the document, never inside it. Enter or Space on the open control opens the note.
- The title (16 px, weight 500, 4 lines at most), then the body (14 px, line breaks kept, 10 lines at most on the phone and 16 on a wide screen). A note with no title and a short body (40 characters or fewer) shows the body in larger text. A note whose title and body are empty after trim shows "Empty note" in a dimmer text.
- A shared note shows a people icon at the bottom. Its label is "Shared with NAME" for the owner and "Shared by NAME" for the other person.
- A tap or a click opens the note. The text is plain text: never HTML.

**Grid**

- The cards are in the order of the view: "Pinned", then "Others". The two headings show only when there are pinned notes.
- Masonry: each card goes to the column that is the shortest at that moment. The order of the cards in the document is the order of the view, so Tab and a screen reader follow it. The cards move with `transform` only.
- Phone: two columns with an 8 px gap. A wide screen: columns of 240 px with a 16 px gap, as many as fit, in the middle of the area.
- Empty states: "Notes you add appear here" for the notes, "Your archived notes appear here" for the archive, and "No matching notes" for a search with no result.

**Note editor**

- The fields: "Title" (one line, Enter moves to the body) and "Note" (the body). The background is the note color.
- The controls: a pin button ("Pin note" or "Unpin note"), an archive button ("Archive" or "Unarchive"), a color button ("Change color"), and a three-dot button ("Note options") that opens the note menu. The text "Edited 14:30" shows at the bottom, with " by NAME" when the other person made the last edit.
- Changes save as the user types. A new note gets a row at the first key that is not a space. Before that, there is no row. Each key sends only the field that the person types in.
- A change from the other person shows at once, but not in the field that has the focus. When that field loses the focus, it shows the stored value.
- At the close, the editor reads the row (`getNote`), not its own fields, because a field with the focus does not show a change from the other person. If the title and the body of the row are both empty after trim and this person is the owner, the note is deleted. A note that this editor made is deleted with `discard: true`, so there is no message and no undo step. An older note gives "Note deleted" with Undo. The wide composer has the same rule at its close.
- The note goes away when it had a row in this editor and `getNote(id)` is now undefined. A new note with no row yet does not go away. If the note goes away because of "Delete" in this editor, the editor closes and the message is "Note deleted". In each other case (the owner deleted it or stopped the sharing), the editor closes and the snackbar shows "This note is no longer available".

**Color picker**: a row of 12 round buttons, one for each color, each with the name of the color as its label. The current color has a check mark. A choice changes the note at once.

**Note menu**: "Pin" or "Unpin", "Archive" or "Unarchive", "Change color", "Make tasks", then "Share with NAME" or "Stop sharing" (owner only; the other person sees "Shared by NAME", disabled; with no second account the entry is disabled), then "Delete" (disabled for a person who is not the owner, with the text "Only NAME can delete this note"). A share or a stop shows "Shared with NAME" or "Stopped sharing" with Undo.

**"Make tasks" dialog**: N is `Math.min(noteTaskTitles(note.body).length, LIMITS.noteTasks)`. The choice "A task for each line (N)" or "One task": the first is the default when N is 2 or more, and is disabled when N is 0. A list selector that starts at the default list of the person. A check box "Archive the note" that starts clear and does not show for an archived note. The buttons "Cancel" and "Add N tasks" ("Add task" for one task). The snackbar then shows the message with Undo. "Make tasks" in the note menu is disabled when the title and the body are empty after trim.

**Phone**

- The Notes page: a search row at the top with the field "Search notes" (an X clears it) and an "Archive" button that changes between the notes and the archive. In the archive the field says "Search archive". Then the grid.
- The add button on the Notes tab ("New note") opens the editor for a new note. It puts the editor on the screen and gives the focus to the body in the handler of the tap (`flushSync`, as for the add sheet), because iOS shows the keyboard only then. Until the download of the notes parts is done, the add button on the Notes tab is disabled.
- The editor is a full screen that slides in. Back closes it. The color button opens a bottom sheet "Color" with the color picker.

**Wide**

- "Notes" in the sidebar shows the notes board. At the top is the composer: a card with the text "Take a note…". A click opens it in place, with "Title", the body, a pin button, a color button, a share button, and "Close". The note gets a row at the first key, and stays out of the grid until the composer closes. Esc, "Close", or a click outside closes the composer.
- "Archive" in the sidebar shows the archived notes, with no composer. The Notes view and the Archive view both set `prefs.lastTab` to 'notes'. A start or a change of the layout with 'notes' shows the notes, not the archive.
- The search field in the top bar filters the notes of the view.
- A card shows its controls on `:hover` and `:focus-within`: a pin button at the top right, and a color button, an archive button, and a three-dot button at the bottom. A right click opens the note menu.
- A click on a card opens the editor in a dialog, 600 px wide.

### Menus

List menu:

1. "Sort by": "My order", "Date", "Deadline", "Starred recently", "Title". A check mark on the active one.
2. "Rename list". "Share with NAME" or "Stop sharing" (owner only. A person who is not the owner sees "Shared by NAME", disabled). "Delete list" (disabled on the default list, with the text "The default list can't be deleted". Disabled for a person who is not the owner). "Move list to first position".
3. "Print list" (wide only). "Delete all completed tasks" (disabled when there are none).

Task menu:

1. "Move to top", "Add deadline", "Add a subtask", "Indent" or "Unindent", "Delete".
2. One entry for each list. A check mark on the current list.
3. "New list": asks for a name, makes the list, and moves the task there.

"Add a subtask" and "Indent" do not show for a subtask or where they are not possible.

Starred view menu: "Sort by": "Date", "Recently starred".

### Pickers

- **Date picker**: month and year, two arrows, a month grid, "Set time", "Repeat", "Cancel", "Done". A ring around today. On the phone it is a bottom sheet. "Set time" shows a list with each half hour and accepts typed text such as "9", "9:15", "14.30", "3pm".
- **Repeat dialog**:
  - "Repeats every" with a number and a unit: day, week, month, year.
  - Week: seven round buttons, one for each weekday. The weekday of the start date is selected.
  - Month: a choice between a day number ("Day 5", up to "Day 31", and "Last day") and an ordinal with a weekday ("First" to "Fourth" and "Last").
  - "Set time", optional.
  - "Starts": a date. It cannot be in the past.
  - "Ends": "Never", "On" with a date, or "After" with a number of occurrences. The number starts at 30.
- **Deadline picker**: the month grid, "Cancel", "Done".

### Settings

A dialog on a wide screen, a full screen on the phone.

- Account: the name with an edit button, "Change password", "Sign out".
- Appearance: "System", "Light", "Dark".
- Notifications: a switch, a "Send test notification" button, and a text that tells an iPhone user to add the app to the Home Screen first.
- Sync: the state, the number of pending changes, the time of the last sync, "Sync now".
- About: the version.

### Keyboard shortcuts on a wide screen

On a Mac, Command replaces Ctrl and Option replaces Alt. The Up and Down keys move the selection. The selection has a visible ring.

| Action | Keys |
|---|---|
| Edit the selected task | Enter |
| Add a task below, while in a title | Enter |
| Finish editing | Esc |
| Mark complete | Space |
| Indent, remove indent | Ctrl+] and Ctrl+[ |
| Add a subtask | Ctrl+Alt+Enter |
| Open the task menu | . or v |
| Move up, move down | Ctrl+Up, Ctrl+Down |
| Move to top, move to bottom | Ctrl+Shift+Up, Ctrl+Shift+Down |
| Star | s |
| Delete | Delete or Backspace |
| Select first, select last | Home, End |
| New task in the selected list | n |
| Print the list | Ctrl+P |
| Show the shortcut list | ? or Ctrl+/ |
| Undo | Ctrl+Z |

In the Notes and Archive views, the keys of the first table do nothing, except ?, Ctrl+/, and Ctrl+Z. These keys work there:

| Action | Keys |
|---|---|
| New note | n or c |
| Search the notes | / |
| Close the composer or the editor | Esc |

In the Archive view, n, c, and the "Create" button show the Notes view and open the composer. The composer opens with the focus in the body. The shortcut list shows this table after the first one, with the heading "Notes".

Single keys work only when no text field has the focus.

### Snackbar

Bottom left on a wide screen. Above the add button on the phone. It shows for 6 seconds, with "Undo" when the action can be undone. A new message replaces the old one.

## 9. Installed app

- `web/public/manifest.webmanifest`: name "Shared Tasks", short name "Tasks", `display: standalone`, icons 192 and 512 and a maskable 512, and two shortcuts: "New task" that opens `/?new=1`, and "New note" that opens `/?new=note`.
- `web/public/sw.js` is plain JavaScript. The build script `scripts/postbuild.ts` writes the list of built files and a version into it, and makes `.br` and `.gz` copies of the text files.
- The service worker keeps all built files in a cache at install time. It answers a page load with the cached `index.html`. It never caches `/api/`.
- A new version installs in the background. The page then shows a snackbar "New version ready" with "Reload".
- `push` event: show the notification. `notificationclick`: put the open window in front, or open one, at `/?task=ID`.
- `/?task=ID` opens that task. `/?list=ID` opens that list. `/?new=1` opens the add sheet or the create dialog. `/?note=ID` opens that note. `/?new=note` opens a new note.
- `LaunchParams` (`web/src/pwa/launch.ts`) and `Launch` (`web/src/shell/app.svelte.ts`) get `noteId: ID | null` from `/?note=ID` and `newNote: boolean` from `/?new=note`. `newTask` is true only for `new=1`. `readLaunchParams` also removes `note` from the address. A layout acts on a launch when one of the five fields has a value.
- `/?new=note`: the phone shows the Notes tab with the notes (not the archive) and opens the editor for a new note. The wide layout shows the Notes view and opens the composer with the focus in the body.
- `/?note=ID`: the phone shows the Notes tab and the wide layout shows the Notes view, or the archive if the note is archived for this person. Then the layout opens the editor of the note. If the note is not on the device, the layout waits for it as it waits for the task of `/?task=ID`.
- `web/index.html` has an inline script that sets `data-theme` before the first paint, and inline CSS for the background color.

## 10. Tests

- `pnpm test`: Vitest for `shared/`, `server/`, and `web/src/data/`.
- `pnpm check`: `tsc` and `svelte-check`.
- `pnpm e2e`: Playwright against the built client that the real server serves from a temporary data folder with the seed data. Projects: a desktop Chromium at 1440 by 900, and a phone at 412 by 915 with touch.
- E2E covers: sign-in, add, edit, complete, undo, delete, subtasks, dates, repeat, sort, star, move between lists, list actions, sharing between two people in two browser contexts, offline edits that sync later, and a restart of the page with no network. For notes: add, edit, color, pin, archive, search, delete with Undo, "Make tasks" with Undo, a shared note between two people, and an offline edit of a note.

Ports for development on the Mac. Each agent that runs servers uses its own ports and its own data folder under `.tmp/`:

| Use | API | Vite |
|---|---|---|
| Default (`pnpm dev`) | 5107 | 5173 |
| Wide layout work | 5111 | 5181 |
| Phone layout work | 5112 | 5182 |
| Shell work | 5113 | 5183 |
| E2E | 5120 | none |
| Other | 5130 to 5139 | 5190 to 5199 |

`API_PORT` tells the Vite dev server where to send `/api`.

## 11. Deployment on the S22

- The code is in `~/shared-tasks/app` on the phone: `server/`, `shared/`, and `web/dist/`. The database is in `~/shared-tasks/data`.
- `~/shared-tasks/start.sh` starts the server on `127.0.0.1:5007`.
- `~/server/start-all.sh` starts it with `keep-running.sh`, like the other services.
- `tailscale serve --bg --https=8443 http://127.0.0.1:5007` gives the public address, `https://HOST:8443`.
- `deploy/deploy.sh` builds on the Mac, copies the files to the phone through SSH, and restarts the server.
- The server writes a database copy each day to `~/backups`.
- The notes deploy has no way back with `app.old`. A server from before notes refuses the database after the notes migration (`user_version` 2). A client from before notes cannot open version 2 of the local database and keeps its data only in memory. A fix after the notes deploy goes forward as a new deploy. If a way back is necessary, stop the server and set `PRAGMA user_version = 1` first. The notes migration uses only `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`, so it can run again later.
