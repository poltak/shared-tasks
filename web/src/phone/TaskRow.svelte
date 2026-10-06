<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { TaskRow } from '../../../shared/types.ts';
  import CompletedMeta from '../common/CompletedMeta.svelte';
  import TaskChips from '../common/TaskChips.svelte';
  import { actions } from '../data/index.ts';
  import { dndItem } from '../dnd/index.ts';
  import { CheckCircle, Star } from '../ui/index.ts';
  import { openTask } from './phone.svelte.ts';

  interface Props {
    task: TaskRow;
    depth?: 0 | 1;
    /** The heading of the group gives the date. */
    hideDate?: boolean;
    /** The name of the list of the task, on the Starred page. */
    origin?: string;
    /** A row of the "Completed" card. */
    completed?: boolean;
  }
  let { task, depth = 0, hideDate = false, origin, completed = false }: Props = $props();

  /** SPEC section 8: the check mark and the line show for this time, then the row leaves. */
  const COMPLETE_MS = 300;
  /** Two lines of the details show. More text than this only makes the page heavy. */
  const NOTES_MAX = 240;

  const notes = $derived(task.notes.length > NOTES_MAX ? task.notes.slice(0, NOTES_MAX) : task.notes);
  /** The same rule as in TaskChips: is there a chip? */
  const chips = $derived((task.due !== null && (!hideDate || task.time !== null)) || task.deadline !== null);
  const under = $derived(completed ? (task.completedAt ?? task.lastDoneAt) !== null : chips || origin !== undefined);

  /** The person pressed the circle. The task is completed when the time is over. */
  let checked = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function complete(): void {
    timer = undefined;
    if (actions.completeTask({ id: task.id }).puts.length === 0) checked = false;
  }

  function toggle(next: boolean): void {
    clearTimeout(timer);
    timer = undefined;
    checked = next;
    if (next) timer = setTimeout(complete, COMPLETE_MS);
  }

  onDestroy(() => {
    if (timer === undefined) return;
    clearTimeout(timer);
    // The page went away before the time was over. The press must not be lost.
    const id = task.id;
    queueMicrotask(() => actions.completeTask({ id }));
  });
</script>

<li
  class={['row', { sub: depth === 1, done: checked || completed, under }]}
  data-flip="row"
  data-testid={completed ? 'completed-row' : 'task-row'}
  {...completed ? {} : dndItem({ id: task.id, depth })}
>
  <span class="side" data-dnd-ignore>
    {#if completed}
      <CheckCircle checked variant="check" size={44} onchange={() => actions.uncompleteTask({ id: task.id })} />
    {:else}
      <CheckCircle {checked} size={44} onchange={toggle} />
    {/if}
  </span>
  <!-- The button in this box takes the keys. The box takes a tap next to a chip too. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="main" onclick={() => openTask(task.id)}>
    <button class="open" type="button">
      <span class="title">{task.title}</span>
      {#if notes && !completed}<span class="notes">{notes}</span>{/if}
    </button>
    {#if under}
      <div class="below">
        {#if completed}
          <CompletedMeta {task} />
        {:else}
          <TaskChips {task} {hideDate} />
          {#if origin !== undefined}<span class="origin">{origin}</span>{/if}
        {/if}
      </div>
    {/if}
  </div>
  {#if !completed}
    <span class="side" data-dnd-ignore>
      <Star starred={task.starred} size={44} onchange={(starred) => actions.setStar({ id: task.id, starred })} />
    </span>
  {/if}
</li>

<style>
  /* The drag engine shows a copy of the row in a layer of <body>. So each rule here starts at the
     row, and not at an element above it. */
  .row {
    position: relative;
    display: flex;
    align-items: flex-start;
    min-height: 52px;
    padding: 0 4px;
    border-radius: 12px;
    color: var(--text);
    /* A change in one row does not make the browser look at the layout of the other rows. */
    contain: layout style;
  }
  /* SPEC section 8: a subtask is indented by 28 px. */
  .sub {
    padding-left: 32px;
  }

  /* The veil of a press, on the full row. A touch that starts a scroll must not flash it. */
  .row::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: currentColor;
    opacity: 0;
    transition: opacity var(--dur-fast) linear;
    pointer-events: none;
  }
  .row:has(.open:active)::after {
    opacity: 0.08;
    transition-delay: 50ms;
  }

  .side {
    display: flex;
    flex: none;
    /* The middle of the 44 px button is the middle of the first line of the title. */
    padding-top: 4px;
  }
  .main {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: flex-start;
    min-width: 0;
    cursor: pointer;
  }
  .open {
    display: block;
    width: 100%;
    padding: 15px 4px;
    border-radius: 8px;
    color: inherit;
    text-align: left;
  }
  .under .open {
    padding-bottom: 6px;
  }
  .title,
  .notes {
    display: -webkit-box;
    overflow: hidden;
    overflow-wrap: anywhere;
    -webkit-box-orient: vertical;
  }
  .title {
    font-size: 16px;
    line-height: 22px;
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }
  .notes {
    margin-top: 2px;
    color: var(--text-dim);
    font-size: 14px;
    line-height: 20px;
    white-space: pre-line;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
  .done .title {
    color: var(--text-dim);
    text-decoration: line-through;
  }

  .below {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
    max-width: 100%;
    padding: 0 4px 13px;
  }
  /* A chip is 26 px high. Its press area is 44 px. */
  .below :global(.chip button.main)::before {
    content: '';
    position: absolute;
    inset: -9px -3px;
  }
  .origin {
    overflow: hidden;
    color: var(--text-dim);
    font-size: 12px;
    font-weight: 500;
    line-height: 16px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
