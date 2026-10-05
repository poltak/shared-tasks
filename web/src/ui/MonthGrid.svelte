<script lang="ts" module>
  import { addDays, addMonths, monthGrid, monthTitle, parse, toJsDate, weekdayName, weekdayOf, weekStartOf } from '../../../shared/dates.ts';
  import type { DateStr } from '../../../shared/types.ts';

  const labelFormats = new Map<string, Intl.DateTimeFormat>();

  /** "Wednesday 7 October 2026", for a screen reader. */
  function dayLabel(date: DateStr, locale: string): string {
    let format = labelFormats.get(locale);
    if (!format) {
      format = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      labelFormats.set(locale, format);
    }
    return format.format(toJsDate(date));
  }
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import IconButton from './IconButton.svelte';

  interface Props {
    /** The chosen day, shown as a filled circle. */
    value: DateStr | null;
    /** The day with the ring. */
    today: DateStr;
    locale?: string;
    /** A day before this one cannot be chosen. */
    min?: DateStr | null;
    onpick?: (date: DateStr) => void;
  }
  let { value, today, locale = navigator.language, min = null, onpick }: Props = $props();

  /**
   * The day that the arrow keys start from. Its month is the month on the screen. The arrows and
   * the keys write it. When the owner changes the chosen day, it goes to that day again.
   */
  let cursor = $derived<DateStr>(value ?? (min && min > today ? min : today));
  let grid = $state<HTMLElement>();

  const view = $derived(parse(cursor));
  const weekStart = $derived(weekStartOf(locale));
  const weeks = $derived(monthGrid({ year: view.year, month: view.month, weekStart }));
  const heads = $derived(
    Array.from({ length: 7 }, (_, i) => {
      const weekday = (weekStart + i) % 7;
      return { short: weekdayName({ weekday, locale, width: 'narrow' }), long: weekdayName({ weekday, locale, width: 'long' }) };
    }),
  );

  const allowed = (date: DateStr): boolean => !min || date >= min;

  function turn(months: number): void {
    cursor = addMonths(cursor, months);
  }

  function onclick(event: MouseEvent): void {
    const date = (event.target as Element).closest<HTMLElement>('[data-date]')?.dataset.date;
    if (!date || !allowed(date)) return;
    cursor = date;
    onpick?.(date);
  }

  async function onkeydown(event: KeyboardEvent): Promise<void> {
    const column = (weekdayOf(cursor) - weekStart + 7) % 7;
    let next: DateStr;
    if (event.key === 'ArrowLeft') next = addDays(cursor, -1);
    else if (event.key === 'ArrowRight') next = addDays(cursor, 1);
    else if (event.key === 'ArrowUp') next = addDays(cursor, -7);
    else if (event.key === 'ArrowDown') next = addDays(cursor, 7);
    else if (event.key === 'Home') next = addDays(cursor, -column);
    else if (event.key === 'End') next = addDays(cursor, 6 - column);
    else if (event.key === 'PageUp') next = addMonths(cursor, -1);
    else if (event.key === 'PageDown') next = addMonths(cursor, 1);
    else return;
    event.preventDefault();
    if (!allowed(next)) next = min!;
    cursor = next;
    // The button of the new day can be in a month that is not on the screen yet.
    await tick();
    grid?.querySelector<HTMLElement>(`[data-date="${next}"]`)?.focus();
  }
</script>

<div class="month">
  <div class="head">
    <div class="title" aria-live="polite">{monthTitle({ year: view.year, month: view.month, locale })}</div>
    <IconButton icon="chevron-left" label="Previous month" size="sm" tooltip={false} onclick={() => turn(-1)} />
    <IconButton icon="chevron-right" label="Next month" size="sm" tooltip={false} onclick={() => turn(1)} />
  </div>
  <div class="grid" role="grid" tabindex="-1" bind:this={grid} {onclick} {onkeydown}>
    <div class="row" role="row">
      {#each heads as head, i (i)}
        <span class="weekday" role="columnheader" aria-label={head.long}>{head.short}</span>
      {/each}
    </div>
    {#each weeks as week (week[0]!.date)}
      <div class="row" role="row">
        {#each week as cell (cell.date)}
          <span role="gridcell" aria-selected={cell.date === value}>
            <button
              class={['day', { out: !cell.inMonth, today: cell.date === today, chosen: cell.date === value }]}
              type="button"
              tabindex={cell.date === cursor ? 0 : -1}
              aria-label={dayLabel(cell.date, locale)}
              aria-current={cell.date === today ? 'date' : undefined}
              aria-disabled={allowed(cell.date) ? undefined : true}
              data-date={cell.date}
            >
              <span>{cell.day}</span>
            </button>
          </span>
        {/each}
      </div>
    {/each}
  </div>
</div>

<style>
  .month {
    width: 100%;
    color: var(--text);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 40px;
    padding-left: 10px;
  }
  .title {
    flex: 1;
    font-size: 14px;
    font-weight: 500;
  }
  .grid {
    outline: none;
  }
  .row {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
  }
  .weekday {
    display: grid;
    place-items: center;
    height: 32px;
    color: var(--text-dim);
    font-size: 12px;
    font-weight: 500;
  }
  .day {
    display: grid;
    place-items: center;
    width: 100%;
    height: 40px;
    color: inherit;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
  /* The button fills the cell, so there is no dead area between the days. The circle is its child. */
  .day span {
    position: relative;
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
  }
  .day:focus-visible {
    outline: none;
  }
  .day:focus-visible span {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }
  @media (hover: hover) {
    .day:hover:not(.chosen):not([aria-disabled]) span {
      background: color-mix(in srgb, var(--text) 8%, transparent);
    }
  }
  .day:active:not(.chosen):not([aria-disabled]) span {
    background: color-mix(in srgb, var(--text) 13%, transparent);
  }
  .out {
    color: var(--text-off);
  }
  .today span {
    box-shadow: inset 0 0 0 1.5px var(--primary);
    color: var(--primary);
    font-weight: 600;
  }
  .chosen span {
    background: var(--primary);
    color: var(--on-primary);
    font-weight: 600;
  }
  .day[aria-disabled] {
    color: var(--text-off);
    opacity: 0.55;
  }
  /* In a bottom sheet the columns are wide, and the numbers can be larger. */
  @media (max-width: 839.98px) {
    .title {
      font-size: 16px;
    }
    .day {
      height: 44px;
      font-size: 15px;
    }
    .day span {
      width: 40px;
      height: 40px;
    }
  }
</style>
