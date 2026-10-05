<script lang="ts">
  import { deadlineChipText } from '../../../shared/dates.ts';
  import type { DateStr } from '../../../shared/types.ts';
  import Chip from './Chip.svelte';

  // The deadline of a task: a target and "Due tomorrow" or "Due Wed 7 Oct". A deadline in the past is in the danger color.
  interface Props {
    deadline: DateStr;
    today: DateStr;
    locale?: string;
    size?: 'sm' | 'md';
    onclick?: (event: MouseEvent) => void;
    /** With a handler the chip has an X button. */
    onremove?: () => void;
  }
  let { deadline, today, locale = navigator.language, size = 'sm', onclick, onremove }: Props = $props();
</script>

<Chip
  icon="target"
  label={deadlineChipText({ deadline, today, locale })}
  tone={deadline < today ? 'danger' : 'normal'}
  removeLabel="Remove deadline"
  {size}
  {onclick}
  {onremove}
/>
