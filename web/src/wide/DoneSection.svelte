<script lang="ts">
  import type { ID, TaskRow } from '../../../shared/types.ts';
  import { prefs } from '../data/index.ts';
  import Icon from '../ui/Icon.svelte';
  import DoneItem from './DoneItem.svelte';
  import { doneShown } from './state.svelte.ts';

  // "Completed (N)" at the end of a column. Its rows are made only while it is open, and in
  // steps: a list can have thousands of completed tasks.
  interface Props {
    listId: ID;
    tasks: readonly TaskRow[];
  }
  let { listId, tasks }: Props = $props();

  const STEP = 50;
  let limit = $state(STEP);

  const open = $derived(prefs.completedOpen[listId] === true);
  const shown = $derived(open ? tasks.slice(0, limit) : []);

  $effect(() => {
    doneShown.set(listId, shown.length);
    return () => doneShown.delete(listId);
  });

  function toggle(): void {
    // The setting is a frozen object, so it gets a new one.
    prefs.completedOpen = { ...prefs.completedOpen, [listId]: !open };
    limit = STEP;
  }

  /** The end of the rows comes into view: the next step of rows is made. */
  function more(node: HTMLElement): () => void {
    const watcher = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) limit += STEP;
      },
      { rootMargin: '200px' },
    );
    watcher.observe(node);
    return () => watcher.disconnect();
  }
</script>

<div class="done">
  <button class="head ui-state" type="button" aria-expanded={open} data-flow onclick={toggle}>
    <span class={['arrow', { open }]}><Icon name="chevron-right" size={20} /></span>
    <span>Completed ({tasks.length})</span>
  </button>
  {#if open}
    <div class="rows" role="list" aria-label="Completed">
      {#each shown as task (task.id)}
        <DoneItem {task} />
      {/each}
    </div>
    {#if shown.length < tasks.length}
      {#key limit}
        <div class="more" {@attach more}></div>
      {/key}
    {/if}
  {/if}
</div>

<style>
  .done {
    margin-top: 8px;
    padding: 4px 8px 0;
    border-top: 1px solid var(--divider);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    height: 40px;
    padding: 0 12px;
    border-radius: 10px;
    color: var(--text);
    font-size: 14px;
    font-weight: 500;
    text-align: left;
  }
  .arrow {
    display: flex;
    color: var(--text-dim);
    transition: transform var(--dur) var(--ease);
  }
  .arrow.open {
    transform: rotate(90deg);
  }
  .more {
    height: 1px;
  }
</style>
