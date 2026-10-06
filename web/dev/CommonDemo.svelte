<script lang="ts">
  // A page to try the common task UI against a development server with the seed data.
  import type { ListRow, TaskRow } from '../../shared/types.ts';
  import fixtures from '../../e2e/fixtures/users.json';
  import CompletedMeta from '../src/common/CompletedMeta.svelte';
  import DialogHost from '../src/common/DialogHost.svelte';
  import TaskChips from '../src/common/TaskChips.svelte';
  import { confirmDialog, pickDate, pickDeadline, promptText } from '../src/common/dialogs.svelte.ts';
  import {
    listMenuItems,
    runListMenuItem,
    runStarredMenuItem,
    runTaskMenuItem,
    sortMenuItems,
    starredMenuItems,
    taskMenuItems,
  } from '../src/common/menus.ts';
  import { SHORTCUTS, shortcutKeys } from '../src/common/shortcuts.ts';
  import { syncBadge } from '../src/common/sync-badge.svelte.ts';
  import { createListFlow, editDate, setToday, setTomorrow, stopRepeat } from '../src/common/task-ops.ts';
  import { actions, listView, listsOrdered, login, prefs, session, sync, toast, undo } from '../src/data/index.ts';
  import { Button, CheckCircle, IconButton, Menu, Snackbar, layout, type MenuAnchor, type MenuItem } from '../src/ui/index.ts';

  let result = $state('none');
  let log = $state('');
  let editing = $state<string | null>(null);
  interface OpenMenu {
    anchor: MenuAnchor;
    items: MenuItem[];
    title: string;
    run: (id: string) => void;
  }
  let menu = $state.raw<OpenMenu | null>(null);
  // The Menu part calls onclose before onselect. So what the entry runs is kept apart from the
  // state that onclose clears.
  let chosen: OpenMenu | null = null;
  $effect.pre(() => {
    if (menu) chosen = menu;
  });

  const account = fixtures.users[new URLSearchParams(location.search).get('user') === 'sam' ? 1 : 0]!;

  $effect(() => {
    if (session.status === 'signedOut') void login(account);
  });

  const show = (value: unknown): void => void (result = JSON.stringify(value));

  function taskMenu(event: MouseEvent, task: TaskRow): void {
    menu = {
      anchor: event.currentTarget as Element,
      items: taskMenuItems({ task, layout: layout.mode }),
      title: task.title,
      run: (itemId) =>
        void runTaskMenuItem({
          task,
          itemId,
          hooks: { addSubtask: (parent) => (log = `add a subtask to "${parent.title}"`), afterDelete: (gone) => (log = `deleted "${gone.title}"`) },
        }),
    };
  }

  function listMenu(event: MouseEvent, list: ListRow): void {
    menu = {
      anchor: event.currentTarget as Element,
      items: listMenuItems({ list, layout: layout.mode }),
      title: list.title,
      run: (itemId) => void runListMenuItem({ list, itemId }),
    };
  }

  function sortMenu(event: MouseEvent, list: ListRow): void {
    menu = {
      anchor: event.currentTarget as Element,
      items: sortMenuItems({ list }),
      title: 'Sort by',
      run: (itemId) => void runListMenuItem({ list, itemId }),
    };
  }

  function starredMenu(event: MouseEvent): void {
    menu = { anchor: event.currentTarget as Element, items: starredMenuItems(), title: 'Starred', run: runStarredMenuItem };
  }
</script>

<div class="page">
  <header class="top" data-print-hide>
    <h1>Common task UI</h1>
    <span class="meta" data-testid="who">{session.status} {session.me?.name ?? ''}</span>
    <span class="meta" data-testid="badge">badge: {syncBadge.current ?? 'none'} (status {sync.status}, pending {sync.pending})</span>
    <Button size="sm" onclick={() => (prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark')}>Theme: {prefs.theme}</Button>
  </header>

  <section class="card" data-print-hide>
    <h2>Dialogs</h2>
    <div class="buttons">
      <Button variant="tonal" data-testid="pick-date" onclick={async () => show(await pickDate({ value: { date: null, time: null, repeat: null } }))}>pickDate</Button>
      <Button
        variant="tonal"
        data-testid="pick-date-plain"
        onclick={async () => show(await pickDate({ value: { date: '2026-10-09', time: '14:30', repeat: null }, allowRepeat: false, title: 'Date of the subtask' }))}
        >pickDate, no repeat</Button
      >
      <Button variant="tonal" data-testid="pick-deadline" onclick={async () => show(await pickDeadline({ value: null }))}>pickDeadline</Button>
      <Button variant="tonal" data-testid="prompt" onclick={async () => show(await promptText({ title: 'Create new list' }))}>promptText</Button>
      <Button variant="tonal" data-testid="confirm" onclick={async () => show(await confirmDialog({ title: 'Stop repeating?', message: 'The task keeps its date.', confirmLabel: 'Stop repeating' }))}
        >confirmDialog</Button
      >
      <Button
        variant="tonal"
        data-testid="confirm-danger"
        onclick={async () => show(await confirmDialog({ title: 'Delete this list?', message: 'Its 12 tasks are deleted too.', confirmLabel: 'Delete', danger: true }))}
        >confirmDialog, danger</Button
      >
      <Button variant="tonal" data-testid="new-list" onclick={async () => show(await createListFlow())}>createListFlow</Button>
      <Button variant="tonal" data-testid="starred-menu" onclick={starredMenu}>Starred menu</Button>
    </div>
    <p class="meta">Result: <code data-testid="result">{result}</code></p>
    <p class="meta">Hook: <code data-testid="log">{log || 'none'}</code></p>
  </section>

  <div class="lists" data-print-flow>
    {#each listsOrdered() as list (list.id)}
      {@const view = listView(list.id)}
      <section class="card list" data-print-list={list.id} data-testid="list-{list.title}">
        <header class="list-head">
          <h2>{list.title}</h2>
          <span class="meta">{list.sort}{list.shared ? ', shared' : ''}</span>
          <span class="grow"></span>
          <span data-print-hide><IconButton icon="sort" label="Sort" size="sm" onclick={(event) => sortMenu(event, list)} /></span>
          <span data-print-hide><IconButton icon="more" label="List options" size="sm" onclick={(event) => listMenu(event, list)} /></span>
        </header>
        {#each view.groups as group (group.key)}
          {#if group.heading}<h3 class={['heading', group.tone]}>{group.heading}</h3>{/if}
          {#each group.items as item (item.task.id)}
            {@const task = item.task}
            <div class="row" style:padding-left="{item.depth * 28}px" data-testid="task-{task.title}">
              <CheckCircle checked={false} label="Mark completed" onchange={() => actions.completeTask({ id: task.id })} />
              <div class="body">
                <button class="title" type="button" onclick={() => (editing = editing === task.id ? null : task.id)}>{task.title}</button>
                {#if editing === task.id}
                  <div class="edit">
                    {#if !task.due}
                      <Button size="sm" variant="tonal" onclick={() => setToday(task)}>Today</Button>
                      <Button size="sm" variant="tonal" onclick={() => setTomorrow(task)}>Tomorrow</Button>
                      <IconButton icon="clock" label="Add date/time" size="sm" onclick={() => void editDate(task)} />
                    {/if}
                    <TaskChips {task} removable size="md" />
                    {#if task.repeat}<Button size="sm" onclick={() => void stopRepeat(task)}>Stop repeating</Button>{/if}
                  </div>
                {:else}
                  <TaskChips {task} hideDate={list.sort === 'date' && group.tone !== 'past'} />
                {/if}
              </div>
              <span data-print-hide><IconButton icon="more" label="Task options" size="sm" onclick={(event) => taskMenu(event, task)} /></span>
            </div>
          {/each}
        {/each}
        {#if view.completed.length}
          <h3 class="heading">Completed ({view.completed.length})</h3>
          {#each view.completed as task (task.id)}
            <div class="row" data-testid="done-{task.title}">
              <CheckCircle checked variant="check" label="Mark uncompleted" onchange={() => actions.uncompleteTask({ id: task.id })} />
              <div class="body">
                <span class="title done">{task.title}</span>
                <CompletedMeta {task} />
              </div>
            </div>
          {/each}
        {/if}
      </section>
    {/each}
  </div>

  <section class="card" data-print-hide>
    <h2>Shortcuts</h2>
    <table class="keys">
      <tbody>
        {#each SHORTCUTS as shortcut (shortcut.action)}
          <tr>
            <td>{shortcut.action}</td>
            <td>
              {#each shortcutKeys(shortcut) as combo, i (i)}
                {#if i > 0}<span class="meta"> {shortcut.joiner} </span>{/if}
                {#each combo as key, k (k)}<kbd>{key}</kbd>{/each}
              {/each}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </section>
</div>

{#if menu}
  <Menu open anchor={menu.anchor} items={menu.items} title={menu.title} align="end" label="Options" onselect={(id) => chosen?.run(id)} onclose={() => (menu = null)} />
{/if}

<DialogHost />

{#if toast.current}
  {#key toast.current.id}
    <Snackbar message={toast.current.message} actionLabel={toast.current.undoable ? 'Undo' : toast.current.action?.label} onaction={() => (toast.current?.undoable ? undo() : toast.current?.action?.run())} />
  {/key}
{/if}

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 16px;
    max-width: 1100px;
    margin: 0 auto;
    padding: 16px;
  }
  .top {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
  }
  h1 {
    font-size: 20px;
  }
  h2 {
    font-size: 16px;
  }
  .card {
    padding: 16px;
    border-radius: var(--radius-card);
    background: var(--surface);
    box-shadow: var(--shadow-1);
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 12px 0;
  }
  .meta {
    color: var(--text-dim);
    font-size: 13px;
  }
  .lists {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 16px;
  }
  .list {
    flex: 1 1 320px;
    min-width: 0;
    padding: 8px 8px 12px;
  }
  .list-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 4px 4px 12px;
  }
  .grow {
    flex: 1;
  }
  .heading {
    padding: 12px 12px 4px;
    color: var(--text-dim);
    font-size: 13px;
    font-weight: 500;
  }
  .heading.past {
    color: var(--danger);
  }
  .row {
    display: flex;
    align-items: flex-start;
    gap: 4px;
  }
  .body {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    padding: 10px 0;
  }
  .title {
    color: var(--text);
    font-size: 14px;
    line-height: 20px;
    text-align: left;
  }
  .title.done {
    color: var(--text-dim);
    text-decoration: line-through;
  }
  .edit {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .keys {
    width: 100%;
    margin-top: 8px;
    border-collapse: collapse;
    font-size: 14px;
  }
  .keys td {
    padding: 6px 0;
    border-top: 1px solid var(--divider);
  }
  kbd {
    display: inline-block;
    min-width: 24px;
    margin: 0 2px;
    padding: 2px 6px;
    border: 1px solid var(--outline);
    border-radius: 6px;
    background: var(--surface-2);
    font: inherit;
    font-size: 12px;
    text-align: center;
  }
</style>
