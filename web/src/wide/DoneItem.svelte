<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import type { TaskRow } from '../../../shared/types.ts';
  import CompletedMeta from '../common/CompletedMeta.svelte';
  import CheckCircle from '../ui/CheckCircle.svelte';
  import IconButton from '../ui/IconButton.svelte';
  import { layout } from '../ui/layout.svelte.ts';
  import { overlays } from '../ui/overlay.svelte.ts';
  import { releaseMark, removeTask, uncomplete, useMark } from './state.svelte.ts';

  // A row of "Completed": a completed task, or a repeating task that rests until its next date.
  interface Props {
    task: TaskRow;
  }
  let { task }: Props = $props();

  // The id is the key of the row, so it is the same for the life of this part.
  const id = untrack(() => task.id);
  const mark = useMark(id);
  onDestroy(() => releaseMark(id));
  const selected = $derived(mark.selected);
  let warm = $state(!layout.hover);
  let row = $state<HTMLElement>();

  $effect(() => {
    if (!selected || !row) return;
    const element = row;
    untrack(() => {
      if (overlays.count === 0 && !element.contains(document.activeElement)) element.focus({ preventScroll: true });
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  });
</script>

<div bind:this={row} class={['row', { selected }]} role="listitem" tabindex="-1" data-row-id={task.id} data-flow onpointerenter={() => (warm = true)}>
  <CheckCircle checked variant="check" label="Mark uncompleted" size={36} onchange={() => uncomplete(task)} />
  <div class="main">
    <p class="title">{task.title}</p>
    <CompletedMeta {task} />
  </div>
  {#if warm || selected}
    <span class="tools" data-print-hide><IconButton icon="bin" label="Delete task" size="sm" onclick={() => removeTask(task)} /></span>
  {/if}
</div>

<style>
  .row {
    display: flex;
    align-items: flex-start;
    min-height: 40px;
    padding: 2px 2px 2px 4px;
    border-radius: 10px;
    outline: none;
  }
  @media (hover: hover) {
    .row:hover {
      background: color-mix(in srgb, var(--text) 6%, var(--surface));
    }
  }
  .selected {
    box-shadow: inset 0 0 0 2px var(--primary);
  }
  .main {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    padding: 8px 34px 8px 2px;
  }
  .main:has(+ .tools) {
    padding-right: 2px;
  }
  .title {
    color: var(--text-dim);
    font-size: var(--row-font, 14px);
    line-height: 20px;
    text-decoration: line-through;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .tools {
    display: flex;
    flex: none;
    margin-top: 2px;
    visibility: hidden;
  }
  .row:hover .tools,
  .row:focus-within .tools,
  .selected .tools {
    visibility: visible;
  }
  @media (hover: none) {
    .tools {
      visibility: visible;
    }
  }
</style>
