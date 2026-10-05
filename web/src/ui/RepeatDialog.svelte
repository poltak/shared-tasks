<script lang="ts" module>
  import { addMonths, formatDate, parse, weekdayName, weekdayOf, weekStartOf } from '../../../shared/dates.ts';
  import { validateRule } from '../../../shared/recurrence.ts';
  import type { DateStr, RepeatEnd, RepeatRule, RepeatUnit, TimeStr } from '../../../shared/types.ts';

  import type { RepeatResult } from './types.ts';

  const UNITS: RepeatUnit[] = ['day', 'week', 'month', 'year'];
  const ORDINALS = [
    { value: 1, label: 'First' },
    { value: 2, label: 'Second' },
    { value: 3, label: 'Third' },
    { value: 4, label: 'Fourth' },
    { value: -1, label: 'Last' },
  ];
  const MONTH_DAYS = [...Array.from({ length: 31 }, (_, i) => ({ value: i + 1, label: `Day ${i + 1}` })), { value: -1, label: 'Last day' }];

  /** The place of a day in its month: 1 to 4, or -1 for a day after the 28th. */
  function ordinalOf(date: DateStr): number {
    const day = parse(date).day;
    return day > 28 ? -1 : Math.ceil(day / 7);
  }
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import Button from './Button.svelte';
  import Chip from './Chip.svelte';
  import DeadlinePicker from './DeadlinePicker.svelte';
  import Dialog from './Dialog.svelte';
  import Radio from './Radio.svelte';
  import Select from './Select.svelte';
  import TimeField from './TimeField.svelte';

  interface Props {
    open?: boolean;
    /** The rule of the task, or null for a new rule. */
    rule: RepeatRule | null;
    time?: TimeStr | null;
    /** The date of the task. A new rule starts there, or today if the date is in the past. */
    date?: DateStr | null;
    today: DateStr;
    locale?: string;
    ondone?: (result: RepeatResult) => void;
    /** Also for Esc, Back, and a press outside. */
    oncancel?: () => void;
  }
  let { open = $bindable(false), rule, time = null, date = null, today, locale = navigator.language, ondone, oncancel }: Props = $props();

  let every = $state<number | null>(1);
  let unit = $state<RepeatUnit>('week');
  let weekdays = $state<number[]>([]);
  let monthMode = $state<'day' | 'weekday'>('day');
  let monthDay = $state(1);
  let ordinal = $state(1);
  let weekday = $state(0);
  let start = $state<DateStr>('');
  let endType = $state<RepeatEnd['type']>('never');
  let endDate = $state<DateStr>('');
  let endCount = $state<number | null>(30);
  let atTime = $state<TimeStr | null>(null);
  /** The choices for the week and the month follow the start date until the person changes them. */
  let followStart = $state(true);
  let startOpen = $state(false);
  let endOpen = $state(false);

  function fromStart(): void {
    weekdays = [weekdayOf(start)];
    monthDay = parse(start).day;
    ordinal = ordinalOf(start);
    weekday = weekdayOf(start);
  }

  // Each open starts from the rule of the owner.
  $effect.pre(() => {
    if (!open) return;
    untrack(() => {
      // A start in the past stays if it comes from the rule. The person cannot choose one.
      start = rule?.start ?? (date && date > today ? date : today);
      fromStart();
      followStart = !rule;
      every = rule?.every ?? 1;
      unit = rule?.unit ?? 'week';
      if (rule?.weekdays?.length) weekdays = [...rule.weekdays];
      monthMode = rule?.monthMode ?? 'day';
      monthDay = rule?.monthDay ?? monthDay;
      ordinal = rule?.ordinal ?? ordinal;
      weekday = rule?.weekday ?? weekday;
      endType = rule?.end.type ?? 'never';
      endDate = rule?.end.type === 'on' ? rule.end.date : addMonths(start, 1);
      endCount = rule?.end.type === 'after' ? rule.end.count : 30;
      atTime = time;
    });
  });

  const weekOrder = $derived(Array.from({ length: 7 }, (_, i) => (weekStartOf(locale) + i) % 7));
  const unitOptions = $derived(UNITS.map((value) => ({ value, label: every === 1 ? value : `${value}s` })));
  const weekdayOptions = $derived(weekOrder.map((value) => ({ value, label: weekdayName({ weekday: value, locale, width: 'long' }) })));

  const result = $derived.by((): RepeatRule => {
    const end: RepeatEnd = endType === 'on' ? { type: 'on', date: endDate } : endType === 'after' ? { type: 'after', count: endCount ?? 0 } : { type: 'never' };
    const base = { every: every ?? 0, unit, start, end };
    if (unit === 'week') return { ...base, weekdays: [...weekdays].sort((a, b) => a - b) };
    if (unit === 'month') return monthMode === 'day' ? { ...base, monthMode, monthDay } : { ...base, monthMode, ordinal, weekday };
    return base;
  });
  const valid = $derived(
    validateRule(result) && (unit !== 'week' || weekdays.length > 0) && (result.end.type !== 'on' || result.end.date >= start),
  );

  function toggleDay(day: number): void {
    followStart = false;
    weekdays = weekdays.includes(day) ? weekdays.filter((d) => d !== day) : [...weekdays, day];
  }

  function setStart(next: DateStr): void {
    start = next;
    if (followStart) fromStart();
    if (endDate < next) endDate = addMonths(next, 1);
  }

  function cancel(): void {
    open = false;
    oncancel?.();
  }

  function done(): void {
    if (!valid) return;
    open = false;
    ondone?.({ rule: result, time: atTime });
  }
</script>

<Dialog bind:open onclose={oncancel} title="Repeat" width={376}>
  <div class="form" data-testid="repeat-form">
    <div class="line">
      <span class="caption">Repeats every</span>
      <input class="number" type="number" inputmode="numeric" min="1" max="1000" aria-label="Interval" bind:value={every} />
      <Select bind:value={unit} options={unitOptions} label="Unit" />
    </div>

    {#if unit === 'week'}
      <div class="days" role="group" aria-label="Repeat on">
        {#each weekOrder as day (day)}
          <button
            class={['day', { on: weekdays.includes(day) }]}
            type="button"
            aria-pressed={weekdays.includes(day)}
            aria-label={weekdayName({ weekday: day, locale, width: 'long' })}
            onclick={() => toggleDay(day)}
          >
            {weekdayName({ weekday: day, locale, width: 'narrow' })}
          </button>
        {/each}
      </div>
    {:else if unit === 'month'}
      <div class="choices" role="radiogroup" aria-label="Day of the month">
        <div class="line">
          <Radio bind:group={monthMode} value="day" name="repeat-month" ariaLabel="On a day of the month" onchange={() => (followStart = false)} />
          <Select
            bind:value={monthDay}
            options={MONTH_DAYS}
            label="Day"
            onchange={() => {
              monthMode = 'day';
              followStart = false;
            }}
          />
        </div>
        <div class="line">
          <Radio bind:group={monthMode} value="weekday" name="repeat-month" ariaLabel="On a weekday of the month" onchange={() => (followStart = false)} />
          <Select
            bind:value={ordinal}
            options={ORDINALS}
            label="Week"
            onchange={() => {
              monthMode = 'weekday';
              followStart = false;
            }}
          />
          <Select
            bind:value={weekday}
            options={weekdayOptions}
            label="Weekday"
            onchange={() => {
              monthMode = 'weekday';
              followStart = false;
            }}
          />
        </div>
      </div>
    {/if}

    <div class="line">
      <TimeField bind:value={atTime} {locale} />
    </div>

    <div class="line">
      <span class="caption">Starts</span>
      <Chip icon="calendar" label={formatDate({ date: start, today, locale })} onclick={() => (startOpen = true)} />
    </div>

    <fieldset class="choices">
      <legend class="caption">Ends</legend>
      <div class="line"><Radio bind:group={endType} value="never" name="repeat-end" label="Never" /></div>
      <div class="line">
        <Radio bind:group={endType} value="on" name="repeat-end" label="On" />
        <Chip
          icon="calendar"
          label={formatDate({ date: endDate, today, locale })}
          onclick={() => {
            endType = 'on';
            endOpen = true;
          }}
        />
      </div>
      <div class="line">
        <Radio bind:group={endType} value="after" name="repeat-end" label="After" />
        <input
          class="number"
          type="number"
          inputmode="numeric"
          min="1"
          max="100000"
          aria-label="Number of occurrences"
          bind:value={endCount}
          onfocus={() => (endType = 'after')}
        />
        <span class="unit">{endCount === 1 ? 'occurrence' : 'occurrences'}</span>
      </div>
    </fieldset>
  </div>
  {#snippet actions()}
    <Button onclick={cancel}>Cancel</Button>
    <Button onclick={done} disabled={!valid}>Done</Button>
  {/snippet}
</Dialog>

<DeadlinePicker bind:open={startOpen} value={start} {today} {locale} minDate={today} label="Start date" ondone={setStart} />
<DeadlinePicker
  bind:open={endOpen}
  value={endDate}
  {today}
  {locale}
  minDate={start > today ? start : today}
  label="End date"
  ondone={(picked) => (endDate = picked)}
/>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 4px 0 8px;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 40px;
  }
  .caption {
    color: var(--text);
    font-size: 14px;
  }
  legend.caption {
    margin-bottom: 2px;
  }
  .unit {
    color: var(--text-dim);
  }
  .choices {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .number {
    width: 68px;
    height: 40px;
    padding: 0 12px;
    border-radius: var(--radius-md);
    background: var(--field);
    color: var(--text);
    text-align: center;
    font-variant-numeric: tabular-nums;
    -moz-appearance: textfield;
    appearance: textfield;
  }
  .number::-webkit-inner-spin-button,
  .number::-webkit-outer-spin-button {
    margin: 0;
    -webkit-appearance: none;
  }
  .number:focus {
    box-shadow: inset 0 0 0 2px var(--primary);
  }
  .number:invalid {
    box-shadow: inset 0 0 0 2px var(--danger);
  }
  .days {
    display: flex;
    justify-content: space-between;
    gap: 4px;
  }
  .day {
    display: grid;
    flex: none;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--field);
    color: var(--text-dim);
    font-size: 12px;
    font-weight: 600;
  }
  .day.on {
    background: var(--primary);
    color: var(--on-primary);
  }
</style>
