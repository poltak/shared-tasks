<script lang="ts">
  import { tick } from 'svelte';
  import { moveToList } from '../common/task-ops.ts';
  import { actions, getList, getTask, listsOrdered, listView } from '../data/index.ts';
  import type { DndController, DndOptions } from '../dnd/index.ts';
  import Column from './Column.svelte';
  import { closeEdit, leaving, select, ui } from './state.svelte.ts';

  // "All tasks": one column for each list that is not hidden, side by side.
  const lists = $derived(listsOrdered().filter((list) => !list.hidden));
  let board = $state<HTMLElement>();

  /** What the drag engine asks about at each place, read one time at the start of a drag. */
  let dragged: { listId: string; fixed: boolean } | null = null;

  const rowOptions: DndOptions = {
    group: 'tasks',
    autoScroll: 'both',
    // A new row with no title is not a task, and a row that leaves is gone in a moment.
    canDrag: (id) => getTask(id) !== undefined && !leaving.has(id),
    onDragStart({ id }) {
      closeEdit();
      select(null);
      const task = getTask(id);
      if (!task) return;
      const item = listView(task.listId)
        .groups.flatMap((group) => group.items)
        .find((each) => each.task.id === id);
      // A task with subtasks cannot become a subtask, and a subtask cannot repeat.
      dragged = { listId: task.listId, fixed: item?.hasChildren === true || task.repeat !== null };
    },
    maxDepthAt({ containerId }) {
      const target = getList(containerId);
      if (!target || !dragged) return -1;
      if (target.sort === 'my') return dragged.fixed ? 0 : 1;
      // A sorted list has no places of its own. A task from a different list can come in.
      return target.id === dragged.listId ? -1 : 0;
    },
    onDrop(drop) {
      const task = getTask(drop.id);
      const target = getList(drop.toContainerId);
      if (!task || !target) return;
      // The sort of the list gives the place on the screen. In "My order" the task is then the first.
      if (target.sort !== 'my') moveToList(task, target.id);
      else actions.moveTask({ id: task.id, listId: target.id, parentId: drop.parentId, beforeId: drop.beforeId, afterId: drop.afterId });
    },
    onDragEnd: () => (dragged = null),
  };

  const columnOptions: DndOptions = {
    axis: 'x',
    group: 'columns',
    handle: '[data-column-grip]',
    onDragStart: () => closeEdit(),
    // A hidden list between two columns keeps its place: the list goes next to a column on the screen.
    onDrop: (drop) => void actions.moveList({ id: drop.id, beforeId: drop.beforeId, afterId: drop.afterId }),
  };

  // The engine comes after the first paint: no person drags in the first moment.
  $effect(() => {
    const root = board;
    if (!root) return;
    let engines: DndController[] = [];
    let gone = false;
    const start = (): void => {
      void import('../dnd/index.ts').then(({ createDnd }) => {
        if (!gone) engines = [createDnd(root, rowOptions), createDnd(root, columnOptions)];
      });
    };
    const idle = typeof requestIdleCallback === 'function';
    const handle = idle ? requestIdleCallback(start, { timeout: 1200 }) : setTimeout(start, 300);
    return () => {
      gone = true;
      if (idle) cancelIdleCallback(handle as number);
      else clearTimeout(handle);
      for (const engine of engines) engine.destroy();
    };
  });

  // A request to show one column (a new list, a link to a list or a task).
  $effect(() => {
    const id = ui.reveal;
    if (id === null) return;
    ui.reveal = null;
    void tick().then(() => {
      board?.querySelector(`[data-column="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  });
</script>

<div class="board" bind:this={board} data-print-flow data-dnd-container="board" data-dnd-group="columns">
  {#each lists as list (list.id)}
    <Column {list} />
  {/each}
  {#if lists.length === 0}
    <div class="none">
      <p class="none-title">No lists are shown</p>
      <p>Select a list in the sidebar to see its tasks.</p>
    </div>
  {/if}
</div>

<style>
  .board {
    display: flex;
    align-items: flex-start;
    gap: 16px;
    height: 100%;
    padding: 4px 24px 24px 4px;
    overflow-x: auto;
    overflow-y: hidden;
    overscroll-behavior-x: contain;
  }
  /* The last column keeps its space from the edge of the window after a scroll to the end. */
  .board::after {
    content: '';
    flex: 0 0 8px;
    align-self: stretch;
  }
  .none {
    margin: 64px auto 0;
    color: var(--text-dim);
    font-size: 14px;
    text-align: center;
  }
  .none-title {
    margin-bottom: 4px;
    color: var(--text);
    font-size: 16px;
    font-weight: 500;
  }

  @media print {
    .board::after {
      display: none;
    }
  }
</style>
