<script lang="ts">
  import { untrack } from 'svelte';
  import type { DateStr } from '../../../shared/types.ts';
  import Button from './Button.svelte';
  import MonthGrid from './MonthGrid.svelte';
  import ResponsiveDialog from './ResponsiveDialog.svelte';

  // A month grid with "Cancel" and "Done": the deadline, and the dates of the repeat dialog.
  interface Props {
    open?: boolean;
    value: DateStr | null;
    today: DateStr;
    locale?: string;
    /** A day before this one cannot be chosen. */
    minDate?: DateStr | null;
    title?: string;
    /** The accessible name, if there is no title. */
    label?: string;
    ondone?: (date: DateStr) => void;
    /** Also for Esc, Back, and a press outside. */
    oncancel?: () => void;
  }
  let { open = $bindable(false), value, today, locale = navigator.language, minDate = null, title, label = 'Deadline', ondone, oncancel }: Props = $props();

  let date = $state<DateStr | null>(null);

  // Each open starts from the value of the owner.
  $effect.pre(() => {
    if (open) date = untrack(() => value);
  });

  function done(): void {
    if (!date) return;
    open = false;
    ondone?.(date);
  }
</script>

<ResponsiveDialog bind:open onclose={oncancel} {title} label={title ?? label} width={328}>
  <MonthGrid value={date} {today} {locale} min={minDate} onpick={(picked) => (date = picked)} />
  {#snippet actions()}
    <Button
      onclick={() => {
        open = false;
        oncancel?.();
      }}>Cancel</Button
    >
    <Button onclick={done} disabled={!date}>Done</Button>
  {/snippet}
</ResponsiveDialog>
