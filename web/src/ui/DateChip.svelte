<script lang="ts">
  import { dateChipText } from '../../../shared/dates.ts';
  import type { DateStr, TimeStr } from '../../../shared/types.ts';
  import Chip from './Chip.svelte';

  // The date of a task: a clock, "Today", "Tomorrow, 14:30", "3 days ago" (in the danger color), or a date.
  interface Props {
    date: DateStr;
    time?: TimeStr | null;
    today: DateStr;
    locale?: string;
    /** The task repeats: a repeat icon shows after the text. */
    repeat?: boolean;
    /** A text before the date, for example "Next:" for a task that rests. */
    prefix?: string;
    size?: 'sm' | 'md';
    onclick?: (event: MouseEvent) => void;
    /** With a handler the chip has an X button. */
    onremove?: () => void;
  }
  let { date, time = null, today, locale = navigator.language, repeat = false, prefix, size = 'sm', onclick, onremove }: Props = $props();

  const text = $derived(dateChipText({ date, time, today, locale }));
</script>

<Chip
  icon="clock"
  trailingIcon={repeat ? 'repeat' : undefined}
  label={prefix ? `${prefix} ${text}` : text}
  tone={date < today ? 'danger' : 'normal'}
  removeLabel="Remove date"
  {size}
  {onclick}
  {onremove}
/>
