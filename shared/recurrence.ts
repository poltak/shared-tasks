import type { DateStr, RepeatRule } from './types.ts';
import { LIMITS } from './types.ts';
import {
  dayNumber,
  dayNumberOf,
  daysInMonth,
  fromDayNumber,
  isValidDate,
  monthName,
  parse,
  weekdayName,
  weekdayOf,
  weekdayOfNumber,
  weekStartOf,
} from './dates.ts';

/** The same limit as the check of the server. */
const MAX_END_COUNT = 100_000;

// A rule from a different device can lack an optional field. Each reader below then uses the
// value that the start date gives, so a rule always has dates.

function everyOf(rule: RepeatRule): number {
  return Number.isInteger(rule.every) && rule.every > 0 ? rule.every : 1;
}

/** The weekdays of a week rule, in order from Sunday, with no doubles. */
function weekdaysOf(rule: RepeatRule): number[] {
  const days = [...new Set(rule.weekdays ?? [])].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  return days.length ? days.sort((a, b) => a - b) : [weekdayOf(rule.start)];
}

function monthDayOf(rule: RepeatRule): number {
  return rule.monthDay ?? parse(rule.start).day;
}

function ordinalOf(rule: RepeatRule): number {
  if (rule.ordinal !== undefined) return rule.ordinal;
  const day = parse(rule.start).day;
  return day > 28 ? -1 : Math.ceil(day / 7);
}

/** The day number of the date that a month rule gives in that month. */
function dayInMonth({ rule, year, month }: { rule: RepeatRule; year: number; month: number }): number {
  const first = dayNumberOf({ year, month, day: 1 });
  const length = daysInMonth(year, month);
  if (rule.monthMode !== 'weekday') {
    const day = monthDayOf(rule);
    // Day 31 uses the last day of a shorter month.
    return first + (day < 1 ? length : Math.min(day, length)) - 1;
  }
  const weekday = rule.weekday ?? weekdayOf(rule.start);
  const ordinal = ordinalOf(rule);
  const firstMatch = first + ((weekday - weekdayOfNumber(first) + 7) % 7);
  const match = ordinal < 1 ? Infinity : firstMatch + (ordinal - 1) * 7;
  if (match < first + length) return match;
  const last = first + length - 1;
  return last - ((weekdayOfNumber(last) - weekday + 7) % 7);
}

/**
 * The first date of the rule after `after`. A date before `rule.start` is never given.
 * The end of the rule is not checked here: see isFinished.
 */
export function nextOccurrence({ rule, after }: { rule: RepeatRule; after: DateStr }): DateStr {
  const start = dayNumber(rule.start);
  /** The first day that the answer can be. */
  const from = Math.max(dayNumber(after) + 1, start);
  const every = everyOf(rule);
  // The loops below end after two rounds for each valid rule. A rule with a bad value from a
  // defective device must not stop the app, so each loop has a limit and a bad date gives `after`.
  if (Number.isNaN(from)) return after;

  if (rule.unit === 'day') {
    return fromDayNumber(start + Math.ceil((from - start) / every) * every);
  }

  if (rule.unit === 'week') {
    let mask = 0;
    for (const d of weekdaysOf(rule)) mask |= 1 << d;
    // The weeks are counted from the Monday of the week of the start date.
    const anchor = start - ((weekdayOfNumber(start) + 6) % 7);
    let week = Math.floor((from - anchor) / 7);
    let day = from;
    if (week % every !== 0) {
      week += every - (week % every);
      day = anchor + week * 7;
    }
    // Two rounds: the rest of this week, then the full next week of the rule.
    for (let round = 0; round < 2; round++) {
      const end = anchor + week * 7 + 7;
      for (; day < end; day++) {
        if (mask & (1 << weekdayOfNumber(day))) return fromDayNumber(day);
      }
      week += every;
      day = anchor + week * 7;
    }
    return fromDayNumber(from);
  }

  const s = parse(rule.start);
  const f = parse(fromDayNumber(from));

  if (rule.unit === 'month') {
    const startIndex = s.year * 12 + s.month - 1;
    const k = Math.ceil((f.year * 12 + f.month - 1 - startIndex) / every);
    // Two rounds: the date in the month of `from` can be before `from`.
    for (let round = 0; round < 2; round++) {
      const index = startIndex + (k + round) * every;
      const year = Math.floor(index / 12);
      const day = dayInMonth({ rule, year, month: index - year * 12 + 1 });
      if (day >= from) return fromDayNumber(day);
    }
    return fromDayNumber(from);
  }

  const k = Math.ceil((f.year - s.year) / every);
  for (let round = 0; round < 2; round++) {
    const year = s.year + (k + round) * every;
    // 29 February goes to 28 February in a common year.
    const n = dayNumberOf({ year, month: s.month, day: Math.min(s.day, daysInMonth(year, s.month)) });
    if (n >= from) return fromDayNumber(n);
  }
  return fromDayNumber(from);
}

/** The first date of the rule on or after `rule.start`. */
export function firstOccurrence(rule: RepeatRule): DateStr {
  return nextOccurrence({ rule, after: fromDayNumber(dayNumber(rule.start) - 1) });
}

/**
 * true when the rule gives no more dates. `doneCount` is the number of completed occurrences,
 * with the one that was completed now. `next` is the date that would come next.
 */
export function isFinished({ rule, doneCount, next }: { rule: RepeatRule; doneCount: number; next: DateStr }): boolean {
  if (rule.end.type === 'on') return next > rule.end.date;
  if (rule.end.type === 'after') return doneCount >= rule.end.count;
  return false;
}

const ORDINALS = ['first', 'second', 'third', 'fourth'];

/** "Daily", "Every 2 weeks on Mon, Wed", "Monthly on the first Monday", "Yearly on 5 October, until 4 Nov". */
export function describeRule({ rule, locale }: { rule: RepeatRule; locale: string }): string {
  const every = everyOf(rule);
  const start = parse(rule.start);
  const lead = (one: string, unit: string): string => (every === 1 ? one : `Every ${every} ${unit}`);
  let text: string;

  if (rule.unit === 'day') {
    text = lead('Daily', 'days');
  } else if (rule.unit === 'week') {
    const days = weekdaysOf(rule);
    const first = weekStartOf(locale);
    days.sort((a, b) => ((a - first + 7) % 7) - ((b - first + 7) % 7));
    const list =
      days.length === 7
        ? 'all days'
        : days.length === 1
          ? weekdayName({ weekday: days[0]!, locale, width: 'long' })
          : days.map((weekday) => weekdayName({ weekday, locale, width: 'short' })).join(', ');
    text = `${lead('Weekly', 'weeks')} on ${list}`;
  } else if (rule.unit === 'month') {
    let on: string;
    if (rule.monthMode === 'weekday') {
      const weekday = weekdayName({ weekday: rule.weekday ?? weekdayOf(rule.start), locale, width: 'long' });
      on = `the ${ORDINALS[ordinalOf(rule) - 1] ?? 'last'} ${weekday}`;
    } else {
      const day = monthDayOf(rule);
      on = day < 1 ? 'the last day' : `day ${day}`;
    }
    text = `${lead('Monthly', 'months')} on ${on}`;
  } else {
    text = `${lead('Yearly', 'years')} on ${start.day} ${monthName({ month: start.month, locale, width: 'long' })}`;
  }

  if (rule.end.type === 'on') {
    const end = parse(rule.end.date);
    const year = end.year === start.year ? '' : ` ${end.year}`;
    text += `, until ${end.day} ${monthName({ month: end.month, locale, width: 'short' })}${year}`;
  } else if (rule.end.type === 'after') {
    text += rule.end.count === 1 ? ', 1 time' : `, ${rule.end.count} times`;
  }
  return text;
}

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * true if the value is a rule that the other functions can use. A value from the network is not
 * trusted. The checks are the same as the checks of the server, so the server does not refuse a
 * rule that passed here.
 */
export function validateRule(value: unknown): value is RepeatRule {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const rule = value as Partial<Record<keyof RepeatRule, unknown>>;
  if (!isInt(rule.every, 1, LIMITS.repeatEvery) || !isValidDate(rule.start)) return false;
  if (rule.unit !== 'day' && rule.unit !== 'week' && rule.unit !== 'month' && rule.unit !== 'year') return false;

  const days = rule.weekdays;
  if (days !== undefined && !(Array.isArray(days) && days.length <= 7 && days.every((d) => isInt(d, 0, 6)))) return false;
  if (rule.monthMode !== undefined && rule.monthMode !== 'day' && rule.monthMode !== 'weekday') return false;
  if (rule.monthDay !== undefined && rule.monthDay !== -1 && !isInt(rule.monthDay, 1, 31)) return false;
  if (rule.ordinal !== undefined && rule.ordinal !== -1 && !isInt(rule.ordinal, 1, 4)) return false;
  if (rule.weekday !== undefined && !isInt(rule.weekday, 0, 6)) return false;

  const end = rule.end as { type?: unknown; date?: unknown; count?: unknown } | null | undefined;
  if (typeof end !== 'object' || end === null) return false;
  if (end.type === 'on') return isValidDate(end.date);
  if (end.type === 'after') return isInt(end.count, 1, MAX_END_COUNT);
  return end.type === 'never';
}
