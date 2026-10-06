<script lang="ts">
  import { timeText } from '../../../shared/dates.ts';
  import type { TaskRow } from '../../../shared/types.ts';
  import { store } from '../data/index.ts';
  import { Chip, DateChip, DeadlineChip } from '../ui/index.ts';
  import { clearDate, clearDeadline, editDate, editDeadline } from './task-ops.ts';

  type Handler = (task: TaskRow, event: MouseEvent) => void;

  // The date chip and the deadline chip of a task. With no date and no deadline it renders nothing.
  interface Props {
    task: TaskRow;
    /** true in the date sort for the groups that are not "Past": the heading gives the date. A time still shows. */
    hideDate?: boolean;
    /** Each chip gets an X that removes the value. For a row that is open for editing. */
    removable?: boolean;
    size?: 'sm' | 'md';
    /** Default: the date picker opens. null: the chip is not a button. */
    ondate?: Handler | null;
    /** Default: the deadline picker opens. null: the chip is not a button. */
    ondeadline?: Handler | null;
  }
  let { task, hideDate = false, removable = false, size = 'sm', ondate, ondeadline }: Props = $props();

  const locale = navigator.language;
  const openDate: Handler = (row) => void editDate(row);
  const openDeadline: Handler = (row) => void editDeadline(row);

  /** A click on a chip must not also open the row below it. */
  function press(handler: Handler | null): ((event: MouseEvent) => void) | undefined {
    if (!handler) return undefined;
    return (event) => {
      event.stopPropagation();
      handler(task, event);
    };
  }

  const dateClick = $derived(press(ondate === undefined ? openDate : ondate));
  const deadlineClick = $derived(press(ondeadline === undefined ? openDeadline : ondeadline));
  const showDate = $derived(task.due !== null && !hideDate);
  const showTime = $derived(task.due !== null && hideDate && task.time !== null);
</script>

{#if showDate || showTime || task.deadline}
  <div class="task-chips">
    {#if showDate && task.due}
      <DateChip
        date={task.due}
        time={task.time}
        today={store.today}
        {locale}
        repeat={task.repeat !== null}
        {size}
        onclick={dateClick}
        onremove={removable ? () => clearDate(task) : undefined}
      />
    {:else if showTime && task.time}
      <Chip
        icon="clock"
        trailingIcon={task.repeat ? 'repeat' : undefined}
        label={timeText({ time: task.time, locale })}
        removeLabel="Remove date"
        {size}
        onclick={dateClick}
        onremove={removable ? () => clearDate(task) : undefined}
      />
    {/if}
    {#if task.deadline}
      <DeadlineChip
        deadline={task.deadline}
        today={store.today}
        {locale}
        {size}
        onclick={deadlineClick}
        onremove={removable ? () => clearDeadline(task) : undefined}
      />
    {/if}
  </div>
{/if}

<style>
  .task-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
  }
</style>
