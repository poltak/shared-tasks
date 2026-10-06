<script lang="ts">
  import type { ViewGroup } from '../../../shared/types.ts';
  import TaskItem from './TaskItem.svelte';
  import { DRAFT_GROUP, type ColumnKey } from './state.svelte.ts';

  // The open tasks of a column: each group with its heading and its rows. The parent element
  // has the role "list".
  interface Props {
    groups: readonly ViewGroup[];
    column: ColumnKey;
    /** The groups are dates: a heading gives the date of its rows, so the rows do not show it. */
    byDate?: boolean;
    showList?: boolean;
    draggable?: boolean;
  }
  let { groups, column, byDate = false, showList = false, draggable = true }: Props = $props();
</script>

{#each groups as group (group.key)}
  {#if group.heading !== null}
    <!-- All rows of a column are in one element, for the drag engine. So a heading is an item of the list too. -->
    <div class="heading" role="listitem" data-flow>
      <h3 class={group.tone}>{group.heading}</h3>
    </div>
  {/if}
  {#each group.items as item (item.task.id)}
    <!-- A task in "Past" keeps its date: the heading does not tell it. -->
    <TaskItem {item} {column} {showList} {draggable} hideDate={byDate && group.tone !== 'past' && group.key !== DRAFT_GROUP} />
  {/each}
{/each}

<style>
  .heading {
    padding: 14px 12px 4px;
  }
  h3 {
    color: var(--text-dim);
    font-size: 12px;
    font-weight: 600;
    line-height: 16px;
    letter-spacing: 0.02em;
  }
  .past {
    color: var(--danger);
  }
</style>
