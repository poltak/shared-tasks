<script lang="ts">
  import { untrack } from 'svelte';
  import { addDays } from '../../../shared/dates.ts';
  import { sameValue } from '../../../shared/merge.ts';
  import { describeRule, firstOccurrence, nextOccurrence } from '../../../shared/recurrence.ts';
  import type { DateStr, RepeatRule, TimeStr } from '../../../shared/types.ts';
  import Button from './Button.svelte';
  import Icon from './Icon.svelte';
  import MonthGrid from './MonthGrid.svelte';
  import RepeatDialog from './RepeatDialog.svelte';
  import ResponsiveDialog from './ResponsiveDialog.svelte';
  import TimeField from './TimeField.svelte';
  import type { DateValue, RepeatResult } from './types.ts';

  interface Props {
    open?: boolean;
    value: DateValue;
    today: DateStr;
    locale?: string;
    /** false: no "Set time". */
    allowTime?: boolean;
    /** false: no "Repeat". A subtask cannot repeat. */
    allowRepeat?: boolean;
    /** A day before this one cannot be chosen. */
    minDate?: DateStr | null;
    title?: string;
    /** With a repeat rule, `date` is the first date of the rule. */
    ondone?: (value: DateValue) => void;
    /** Also for Esc, Back, and a press outside. */
    oncancel?: () => void;
  }
  let {
    open = $bindable(false),
    value,
    today,
    locale = navigator.language,
    allowTime = true,
    allowRepeat = true,
    minDate = null,
    title,
    ondone,
    oncancel,
  }: Props = $props();

  let date = $state<DateStr | null>(null);
  let time = $state<TimeStr | null>(null);
  let repeat = $state<RepeatRule | null>(null);
  let repeatOpen = $state(false);

  // Each open starts from the value of the owner.
  $effect.pre(() => {
    if (!open) return;
    untrack(() => {
      date = value.date;
      time = allowTime ? value.time : null;
      repeat = allowRepeat ? value.repeat : null;
    });
  });

  // A rule cannot start in the past, so the days before today are off while a rule is set.
  const min = $derived(repeat && (!minDate || minDate < today) ? today : minDate);

  function pick(picked: DateStr): void {
    if (repeat) {
      // The rule starts at the chosen day. The day with the mark is the first date that the rule gives.
      repeat = { ...repeat, start: picked };
      date = firstOccurrence(repeat);
    } else {
      date = picked;
    }
  }

  function setRepeat(result: RepeatResult): void {
    if (allowTime) time = result.time;
    // The same rule again must not move the date of the task.
    if (repeat && sameValue(repeat, result.rule)) return;
    repeat = result.rule;
    // An old rule has its start in the past. The task then gets the first date from today, as
    // the setRepeat action does.
    date = result.rule.start >= today ? firstOccurrence(result.rule) : nextOccurrence({ rule: result.rule, after: addDays(today, -1) });
  }

  function cancel(): void {
    open = false;
    oncancel?.();
  }

  function done(): void {
    if (!date) return;
    open = false;
    ondone?.({ date, time, repeat });
  }
</script>

<ResponsiveDialog bind:open onclose={oncancel} {title} label={title ?? 'Date and time'} width={328}>
  <MonthGrid value={date} {today} {locale} {min} onpick={pick} />
  {#if allowTime || allowRepeat}
    <div class="rows">
      {#if allowTime}
        <div class="row">
          <TimeField
            bind:value={time}
            {locale}
            onchange={(next) => {
              // A time needs a date.
              if (next && !date) date = today;
            }}
          />
        </div>
      {/if}
      {#if allowRepeat}
        <div class="row">
          <button class="repeat ui-state" type="button" onclick={() => (repeatOpen = true)}>
            <Icon name="repeat" size={20} />
            <span class="rule" class:set={repeat}>{repeat ? describeRule({ rule: repeat, locale }) : 'Repeat'}</span>
          </button>
          {#if repeat}
            <button class="stop ui-state" type="button" aria-label="Stop repeating" data-tip="Stop repeating" onclick={() => (repeat = null)}>
              <Icon name="close" size={16} />
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
  {#snippet actions()}
    <Button onclick={cancel}>Cancel</Button>
    <Button onclick={done} disabled={!date}>Done</Button>
  {/snippet}
</ResponsiveDialog>

{#if allowRepeat}
  <RepeatDialog bind:open={repeatOpen} rule={repeat} {time} {date} {today} {locale} ondone={setRepeat} />
{/if}

<style>
  .rows {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 8px;
    padding-top: 12px;
    border-top: 1px solid var(--divider);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 40px;
  }
  .row :global(.time) {
    flex: 1;
  }
  .repeat {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 8px;
    min-width: 0;
    height: 40px;
    padding: 0 12px;
    border-radius: var(--radius-pill);
    background: var(--field);
    color: var(--text-dim);
    font-size: 16px;
    text-align: left;
  }
  .rule {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rule.set {
    color: var(--text);
  }
  .stop {
    display: grid;
    flex: none;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    color: var(--text-dim);
  }
</style>
