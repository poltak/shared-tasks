<script lang="ts">
  import { completedText } from '../../../shared/dates.ts';
  import type { TaskRow } from '../../../shared/types.ts';
  import { isResting } from '../../../shared/view.ts';
  import { session, store } from '../data/index.ts';
  import { DateChip } from '../ui/index.ts';

  // The second line of a row in "Completed": when the task was completed, who did it if it was
  // the other person, and for a repeating task that rests, the date on which it comes back.
  interface Props {
    task: TaskRow;
  }
  let { task }: Props = $props();

  const locale = navigator.language;
  const at = $derived(task.completedAt ?? task.lastDoneAt);
  const text = $derived(at === null ? null : completedText({ at, today: store.today, locale }));
  const by = $derived(
    task.completedBy !== null && task.completedBy !== session.me?.id
      ? (session.users.find((user) => user.id === task.completedBy)?.name ?? null)
      : null,
  );
  const next = $derived(isResting({ task, today: store.today }) ? task.due : null);
</script>

{#if text || next}
  <div class="completed-meta">
    {#if text}<span class="when">{text}{#if by}<span class="by">&nbsp;· {by}</span>{/if}</span>{/if}
    {#if next}<DateChip date={next} time={task.time} today={store.today} {locale} prefix="Next:" repeat />{/if}
  </div>
{/if}

<style>
  .completed-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    min-width: 0;
    color: var(--text-dim);
    font-size: 12px;
    line-height: 16px;
  }
  .when {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
