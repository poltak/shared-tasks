<script lang="ts">
  import { untrack } from 'svelte';
  import { prefs, starredView } from '../data/index.ts';
  import EmptyState from '../ui/EmptyState.svelte';
  import Icon from '../ui/Icon.svelte';
  import IconButton from '../ui/IconButton.svelte';
  import Groups from './Groups.svelte';
  import { closeEdit, draftTop, openStarredMenu, shownGroups, STARRED, ui } from './state.svelte.ts';

  // The Starred view: the open tasks with a star from all lists, in one column.
  const view = $derived(starredView());
  const session = $derived(ui.edit !== null && ui.edit.column === STARRED ? ui.edit : null);
  const groups = $derived(shownGroups({ view, session }));
  let body = $state<HTMLElement>();

  // The star of the open row went away, or the task did.
  $effect(() => {
    if (!session || session.draft) return;
    const id = session.id;
    if (!groups.some((group) => group.items.some((item) => item.task.id === id))) untrack(() => closeEdit());
  });

  function add(): void {
    draftTop(STARRED);
    body?.scrollTo({ top: 0 });
  }
</script>

<div class="board" data-print-flow>
  <section class="column" aria-label="Starred" data-column={STARRED}>
    <header class="head">
      <span class="mark"><Icon name="star-filled" size={20} /></span>
      <h2 class="name">Starred</h2>
      <span data-print-hide>
        <IconButton icon="more" label="Starred options" size="sm" onclick={(event) => openStarredMenu(event.currentTarget)} />
      </span>
    </header>
    <div class="add-wrap" data-print-hide>
      <button class="add ui-state" type="button" onclick={add}>
        <Icon name="add-task" size={20} />
        <span>Add a task</span>
      </button>
    </div>
    <div class="body" bind:this={body} data-flow-root data-print-flow>
      <div class="rows" role="list" aria-label="Starred tasks">
        <Groups {groups} column={STARRED} byDate={prefs.starredSort === 'date'} showList draggable={false} />
      </div>
      {#if groups.length === 0}
        <EmptyState kind="empty" title="No starred tasks" text="Star a task to find it here" />
      {/if}
      <div data-flow-end></div>
    </div>
  </section>
</div>

<style>
  .board {
    display: flex;
    align-items: flex-start;
    height: 100%;
    padding: 4px 24px 24px 4px;
    overflow: hidden;
  }
  .column {
    display: flex;
    flex: 0 1 440px;
    flex-direction: column;
    min-width: 0;
    max-height: 100%;
    border-radius: var(--radius-card);
    background: var(--surface);
    box-shadow: var(--shadow-1);
  }
  .head {
    display: flex;
    flex: none;
    align-items: center;
    gap: 10px;
    height: 52px;
    padding: 4px 8px 0 20px;
  }
  .mark {
    display: flex;
    color: var(--star);
  }
  .name {
    flex: 1;
    min-width: 0;
    font-size: 16px;
    font-weight: 500;
    line-height: 24px;
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
</style>
