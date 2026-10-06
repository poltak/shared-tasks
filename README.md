# Shared Tasks

A todo list web app for two people. Its feature set follows Google Tasks, without the Calendar integration. Each device keeps a full copy of the data and works offline. A small server keeps the devices in sync.

`SPEC.md` is the contract for the behaviour and the code.

## What it does

- Lists, tasks, subtasks, details, dates and times, deadlines, repeat rules, and stars.
- Five sort modes for each list, a "Completed" section, and Undo for each action.
- Two layouts. A phone gets tabs, an add sheet, and a full task screen. A wide window gets a sidebar and one column for each list, with edit in place, keyboard shortcuts, and drag and drop.
- Two accounts. Each list is private or shared. In a shared list, the two people see and change the same tasks. The star, the sort mode, the list order, and the hidden columns are separate for each person.
- Notifications through Web Push for a task time (or 09:00 for a date with no time) and for a deadline.
- It installs to the home screen and starts with no network.

## Use it

1. Open the address of the server in a browser.
2. Select "Create account" and give a name and a password. Sign-up closes after two accounts.
3. Install the page:
   - Android with Chrome: menu, then "Add to Home screen".
   - iPhone with Safari: Share, then "Add to Home Screen". Open the app from the icon.
4. For notifications, open Settings (the round button at the top right) and set "Notifications" to on. An iPhone permits this only in the installed app.

To share a list, open the list menu (three dots) and select "Share with NAME".

## How it is built

| Path | Contents |
|---|---|
| `shared/` | Logic that the server and the client both use: dates, repeat rules, views, actions |
| `server/` | Node.js server with the built-in HTTP and SQLite modules. No npm packages |
| `web/` | The client: Svelte 5, TypeScript, Vite |
| `e2e/` | Playwright tests |
| `deploy/` | Scripts for the phone |

The server runs the TypeScript files directly. It needs Node.js 22.18 or later and no build step.

Each change is a set of fields with a timestamp. The server keeps the newest value of each field, so two people can change one task at the same time and lose nothing. A device applies a change to its own data first and sends it later.

## Develop

```bash
pnpm install
```

```bash
pnpm dev
```

This starts the server on port 5107 and the Vite dev server on port 5173. To fill an empty database with two test accounts and sample lists:

```bash
DATA_DIR=.tmp/dev node server/cli.ts seed
```

The test accounts are in `e2e/fixtures/users.json`.

| Command | Purpose |
|---|---|
| `pnpm test` | Unit tests and server tests |
| `pnpm check` | Type checks |
| `pnpm build` | Production build into `web/dist` |
| `pnpm e2e` | Browser tests of the built app: a desktop and a phone profile in Chromium, and an iPhone profile in WebKit |
| `deploy/test-on-phone.sh` | The same browser tests against the code on the phone, with a test database |

## Server settings

The server reads environment variables. `SPEC.md` section 5 has the full list.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `5107` | Port |
| `HOST` | `127.0.0.1` | Address |
| `DATA_DIR` | `./data` | Folder of the database |
| `PUBLIC_ORIGIN` | none | Public HTTPS address. Makes the session cookie `Secure` |
| `MAX_USERS` | `2` | Sign-up closes at this number of accounts |
| `BACKUP_DIR` | none | Folder for one database copy each day. The newest 30 stay |

Account commands, run in the folder of the app with the same `DATA_DIR` as the server:

```bash
node server/cli.ts list-users
```

```bash
node server/cli.ts reset-password NAME
```

## Run it on the phone

The server runs in Termux on an Android phone, behind `tailscale serve`.

The scripts read the address of the phone from `deploy/.env`. Copy `deploy/env.example` to that name and set the values. The file is not in the repository.

First install:

```bash
deploy/deploy.sh
```

```bash
deploy/install-phone.sh https://HOST:8443
```

Each later update:

```bash
deploy/deploy.sh
```

The script builds the client, copies the app through SSH, and restarts the server. The copy from before stays on the phone as `~/shared-tasks/app.old`.

| Path on the phone | Contents |
|---|---|
| `~/shared-tasks/app` | The code |
| `~/shared-tasks/data` | The database. This is the folder to back up |
| `~/shared-tasks/env` | Settings of this phone |
| `~/shared-tasks/start.sh` | Starts the server on `127.0.0.1:5007` |
| `~/backups/shared-tasks-DATE.db` | One database copy for each day |
| `~/server/log/tasks.log` | The log |

To restart the server on the phone:

```bash
pkill -f server/main.ts
```

The restart loop starts it again after 5 seconds.

To put a database copy back: stop the restart loop and the server, delete `shared-tasks.db`, `shared-tasks.db-wal`, and `shared-tasks.db-shm` in the data folder, copy the backup file to `shared-tasks.db`, and start the server. Each device then gets all rows again.

## Known limits

- The texts are English only.
- Notifications need the server to know the task. A task made offline gives no notification until the device syncs.
- An iPhone shows notifications only for the installed app.
- Sign-out with no network loses the changes that were not sent. The app warns first.
