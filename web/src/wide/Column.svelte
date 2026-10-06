<script lang="ts">
  import { untrack } from 'svelte';
  import type { ListRow } from '../../../shared/types.ts';
  import { isOwner, ownerName } from '../common/task-ops.ts';
  import { listView, otherUser } from '../data/index.ts';
  import EmptyState from '../ui/EmptyState.svelte';
  import Icon from '../ui/Icon.svelte';
  import IconButton from '../ui/IconButton.svelte';
  import DoneSection from './DoneSection.svelte';
  import Groups from './Groups.svelte';
  import { closeEdit, draftTop, openListMenu, shownGroups, ui } from './state.svelte.ts';

  // The column of one list: its name, "Add a task", the open tasks, and "Completed".
  interface Props {
    list: ListRow;
  }
  let { list }: Props = $props();

  const view = $derived(listView(list.id));
  const session = $derived(ui.edit !== null && ui.edit.column === list.id ? ui.edit : null);
  const groups = $derived(shownGroups({ view, session }));
  const sharedTip = $derived(
    !list.shared ? null : isOwner(list) ? `Shared with ${otherUser()?.name ?? 'the other person'}` : `Shared by ${ownerName(list)}`,
  );
  let body = $state<HTMLElement>();

  // The task of the open row left the list (completed or deleted on a different device, or
  // moved): the row cannot stay open.
  $effect(() => {
    if (!session || session.draft) return;
    const id = session.id;
    if (!groups.some((group) => group.items.some((item) => item.task.id === id))) untrack(() => closeEdit());
  });

  function add(): void {
    draftTop(list.id);
    body?.scrollTo({ top: 0 });
  }
</script>

<section class="column" aria-label={list.title} data-column={list.id} data-print-list={list.id} data-dnd-id={list.id}>
  <header class="head" data-column-grip>
    <h2 class="name">{list.title}</h2>
    {#if sharedTip}
      <span class="shared" role="img" aria-label={sharedTip} data-tip={sharedTip}><Icon name="people" size={18} /></span>
    {/if}
    <span class="menu" data-dnd-ignore data-print-hide>
      <IconButton icon="more" label="List options" size="sm" onclick={(event) => openListMenu({ list, anchor: event.currentTarget })} />
    </span>
  </header>
  <div class="add-wrap" data-print-hide>
    <button class="add ui-state" type="button" onclick={add}>
      <Icon name="add-task" size={20} />
      <span>Add a task</span>
    </button>
  </div>
  <div class="body" bind:this={body} data-flow-root data-print-flow>
    <div class="rows" role="list" aria-label="Tasks" data-dnd-container={list.id} data-dnd-group="tasks">
      <Groups {groups} column={list.id} byDate={list.sort === 'date'} />
    </div>
    {#if groups.length === 0}
      {#if view.completed.length === 0}
        <EmptyState kind="empty" title="No tasks yet" text="Add your to-dos and keep track of them here" />
      {:else}
        <EmptyState kind="done" title="All tasks complete" text="Nice work!" />
      {/if}
    {/if}
    {#if view.completed.length > 0}
      <DoneSection listId={list.id} tasks={view.completed} />
    {/if}
    <div data-flow-end></div>
  </div>
</section>

<style>
  .column {
    display: flex;
    flex: 0 0 320px;
    flex-direction: column;
    min-width: 0;
    max-height: 100%;
    border-radius: var(--radius-card);
    background: var(--surface);
    box-shadow: var(--shadow-1);
    /* A column out of view costs no layout and no paint. */
    content-visibility: auto;
    contain-intrinsic-size: auto 320px auto 480px;
    --dnd-lift-radius: var(--radius-card);
  }
  .head {
    display: flex;
    flex: none;
    align-items: center;
    gap: 8px;
    height: 52px;
    padding: 4px 8px 0 20px;
    cursor: grab;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: 16px;
    font-weight: 500;
    line-height: 24px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .shared {
    display: flex;
    flex: none;
    color: var(--text-dim);
  }
  .menu {
    display: flex;
    flex: none;
    cursor: default;
  }
  .add-wrap {
    flex: none;
    padding: 0 8px 4px;
  }
  .add {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    height: 40px;
    padding: 0 12px;
    border-radius: 10px;
    color: var(--primary);
    font-size: 14px;
    font-weight: 500;
    text-align: left;
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding-bottom: 8px;
    border-radius: 0 0 var(--radius-card) var(--radius-card);
    scrollbar-width: thin;
  }
  .rows {
    padding: 0 8px;
  }

  @media print {
    .column {
      max-height: none;
      margin-bottom: 24px;
      content-visibility: visible;
    }
  }
</style>
