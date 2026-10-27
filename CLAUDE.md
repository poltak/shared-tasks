# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:1105d646 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->


## Running bd

`bd` is a dev dependency of this repository, not a global command. Run it through pnpm:

```bash
pnpm bd ready
pnpm bd show st-abc123
```

The git hooks and the session hook call `bd` by name. They do nothing until `bd` is on the PATH.

## Build & Test

| Command | Purpose |
|---|---|
| `pnpm install` | Install the dependencies |
| `pnpm dev` | Server on port 5107 and Vite on port 5173 |
| `pnpm test` | Unit tests and server tests (Vitest) |
| `pnpm check` | Type checks (`tsc` and `svelte-check`) |
| `pnpm build` | Production build into `web/dist` |
| `pnpm e2e` | Playwright tests of the built app |

## Architecture Overview

`SPEC.md` is the contract for the behaviour and the code. Read it before a change. `README.md` tells how to run and deploy the app.

- `shared/`: pure logic and types that the server and the client both use.
- `server/`: Node.js server with `node:http` and `node:sqlite`. No npm packages.
- `web/`: the client. Svelte 5, TypeScript, Vite. `web/src/data/index.ts` is the only door from the UI to the data.

## Conventions & Patterns

`SPEC.md` section 2 has the rules for the code. The most important:

- Do not add runtime dependencies.
- `shared/` and `server/` run with type stripping: no `enum`, no `namespace`, relative imports with `.ts`.
- A function with more than two inputs takes one object.
- Tests go next to the code as `name.test.ts`.
