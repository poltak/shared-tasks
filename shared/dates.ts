import type { DateStr, TimeStr } from './types.ts';

// A date is a calendar day with no time zone. All math is on a day number (days from 1970-01-01),
// so the time zone and the daylight saving of the device cannot change a result. Only todayOf(),
// toJsDate(), fromJsDate(), completedText(), and editedText() use the local time of the device,
// because "today" is a local idea.

const DAY_MS = 86_400_000;

export interface DateParts {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
}

export interface MonthCell {
  date: DateStr;
  day: number;
  /** false for the days of the month before and the month after that fill the weeks. */
  inMonth: boolean;
}

export type NameWidth = 'narrow' | 'short' | 'long';

// ---- Date math ----

const pad = (n: number): string => (n < 10 ? '0' + n : String(n));

export function parse(date: DateStr): DateParts {
  return { year: +date.slice(0, 4), month: +date.slice(5, 7), day: +date.slice(8, 10) };
}

export function dateOf({ year, month, day }: DateParts): DateStr {
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

export function isValidDate(value: unknown): value is DateStr {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const { year, month, day } = parse(value);
  // The server refuses a year below 100, so a date that passes here must not have one.
  return year >= 100 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export function isValidTime(value: unknown): value is TimeStr {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** Days from 1970-01-01. Integer math on the Gregorian calendar, with no Date object. */
export function dayNumber(date: DateStr): number {
  return dayNumberOf(parse(date));
}

export function dayNumberOf({ year, month, day }: DateParts): number {
  // The year starts in March here, so the leap day is the last day of the year.
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

export function fromDayNumber(n: number): DateStr {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365,
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const m = Math.floor((5 * dayOfYear + 2) / 153);
  const month = m < 10 ? m + 3 : m - 9;
  return dateOf({
    year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0),
    month,
    day: dayOfYear - Math.floor((153 * m + 2) / 5) + 1,
  });
}

/** The local date of the device at that moment. */
export function todayOf(now: Date | number): DateStr {
  const d = typeof now === 'number' ? new Date(now) : now;
  return dateOf({ year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() });
}

/**
 * The start of that day in the local time of the device, so getDate() and a format with no time
 * zone give the same day. Where a daylight saving change removes midnight, it is 01:00 of the day.
 */
export function toJsDate(date: DateStr): Date {
  const { year, month, day } = parse(date);
  // Not `new Date(year, ...)`: that reads a year below 100 as 19xx.
  const d = new Date(0);
  d.setFullYear(year, month - 1, day);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** The local date of a Date. This is the opposite of toJsDate, and the same as todayOf. */
export function fromJsDate(date: Date): DateStr {
  return todayOf(date);
}

export function addDays(date: DateStr, days: number): DateStr {
  return fromDayNumber(dayNumber(date) + days);
}

/** The day is clamped to the length of the new month: 31 January plus 1 month is 28 or 29 February. */
export function addMonths(date: DateStr, months: number): DateStr {
  const { year, month, day } = parse(date);
  const index = year * 12 + month - 1 + months;
  const y = Math.floor(index / 12);
  const m = index - y * 12 + 1;
  return dateOf({ year: y, month: m, day: Math.min(day, daysInMonth(y, m)) });
}

/** 29 February goes to 28 February in a common year. */
export function addYears(date: DateStr, years: number): DateStr {
  return addMonths(date, years * 12);
}

/** a minus b, in days. Positive when a is after b. */
export function diffDays(a: DateStr, b: DateStr): number {
  return dayNumber(a) - dayNumber(b);
}

/** 0 is Sunday. */
export function weekdayOfNumber(n: number): number {
  // 1970-01-01 was a Thursday.
  return (((n + 4) % 7) + 7) % 7;
}

/** 0 is Sunday. */
export function weekdayOf(date: DateStr): number {
  return weekdayOfNumber(dayNumber(date));
}

/**
 * The weeks of a month for a date picker: always 6 rows of 7 days, so the picker keeps its height.
 * `month` is 1 to 12. `weekStart` is the weekday of the first column, 0 is Sunday.
 */
export function monthGrid({ year, month, weekStart }: { year: number; month: number; weekStart: number }): MonthCell[][] {
  const first = dayNumberOf({ year, month, day: 1 });
  const start = first - ((weekdayOfNumber(first) - weekStart + 7) % 7);
  const last = first + daysInMonth(year, month) - 1;
  const weeks: MonthCell[][] = [];
  for (let w = 0; w < 6; w++) {
    const week: MonthCell[] = [];
    for (let d = 0; d < 7; d++) {
      const n = start + w * 7 + d;
      const date = fromDayNumber(n);
      week.push({ date, day: +date.slice(8, 10), inMonth: n >= first && n <= last });
    }
    weeks.push(week);
  }
  return weeks;
}

// Regions where the week does not start on Monday. Only for a browser with no week data in Intl.
const SUNDAY_REGIONS =
  'AG AS BD BR BS BT BW BZ CA CO DM DO ET GT GU HK HN ID IL IN JM JP KE KH KR LA MH MM MO MT MX MZ NI NP PA PE PH PK PR PT PY SA SG SV TH TT TW UM US VE VI WS YE ZA ZW';
const SATURDAY_REGIONS = 'AE AF BH DJ DZ EG IQ IR JO KW LY OM QA SD SY';

const weekStarts = new Map<string, number>();

/** The first weekday of the week in that locale. 0 is Sunday, 1 is Monday. */
export function weekStartOf(locale: string): number {
  let start = weekStarts.get(locale);
  if (start === undefined) {
    start = 1;
    try {
      const loc = new Intl.Locale(locale) as Intl.Locale & {
        getWeekInfo?: () => { firstDay: number };
        weekInfo?: { firstDay: number };
      };
      const info = loc.getWeekInfo?.() ?? loc.weekInfo;
      if (info) {
        // Intl counts Monday as 1 and Sunday as 7.
        start = info.firstDay % 7;
      } else {
        const region = loc.maximize().region ?? '';
        if (region.length !== 2) start = 1;
        else if (SUNDAY_REGIONS.includes(region)) start = 0;
        else if (SATURDAY_REGIONS.includes(region)) start = 6;
      }
    } catch {
      // A locale tag that Intl refuses: keep Monday.
    }
    weekStarts.set(locale, start);
  }
  return start;
}

// ---- Names from Intl ----

// To make an Intl formatter is slow, and a list shows many dates. So each locale makes its names
// one time, and the text of a date is then only a join of strings.

function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' });
  } catch {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' });
  }
}

interface Names {
  weekdays: string[];
  months: string[];
  /**
   * Set for a language that writes a month as a number in a date (Japanese, Chinese). The fixed
   * order "Wed 7 Oct" would give "水 7 10" there, so the text of a date comes from this formatter.
   */
  whole: Intl.DateTimeFormat | null;
}

const nameCache = new Map<string, Names>();

function names(locale: string, width: NameWidth): Names {
  const key = width + ' ' + locale;
  let found = nameCache.get(key);
  if (!found) {
    // A format with a day number gives the form of the name that a date uses in each language.
    const inDate = formatter(locale, { weekday: width, day: 'numeric', month: width });
    const part = (ms: number, type: string): string => inDate.formatToParts(ms).find((p) => p.type === type)?.value ?? '';
    /** The names from a formatter that gives only the name. */
    const alone = (options: Intl.DateTimeFormatOptions, times: number[]): string[] => {
      const f = formatter(locale, options);
      return times.map((ms) => f.format(ms));
    };
    // 1970-01-04 was a Sunday.
    const weekdayTimes = Array.from({ length: 7 }, (_, i) => (3 + i) * DAY_MS);
    const monthTimes = Array.from({ length: 12 }, (_, i) => Date.UTC(2001, i, 15));
    const months = monthTimes.map((ms) => part(ms, 'month'));
    const numeric = /^\d+$/.test(months[0]!);
    found = {
      // A narrow name is for the head of a month grid, where it is alone. Some languages make it
      // longer in a date ("Su." in Australia).
      weekdays: width === 'narrow' ? alone({ weekday: width }, weekdayTimes) : weekdayTimes.map((ms) => part(ms, 'weekday')),
      months: numeric ? alone({ month: width }, monthTimes) : months,
      whole: numeric ? inDate : null,
    };
    nameCache.set(key, found);
  }
  return found;
}

/** `weekday`: 0 is Sunday. */
export function weekdayName({ weekday, locale, width }: { weekday: number; locale: string; width: NameWidth }): string {
  return names(locale, width).weekdays[weekday] ?? '';
}

/** `month`: 1 to 12. */
export function monthName({ month, locale, width }: { month: number; locale: string; width: NameWidth }): string {
  return names(locale, width).months[month - 1] ?? '';
}

const titleFormatters = new Map<string, Intl.DateTimeFormat>();

/** The heading of a month in a date picker: "October 2026". */
export function monthTitle({ year, month, locale }: { year: number; month: number; locale: string }): string {
  let f = titleFormatters.get(locale);
  if (!f) titleFormatters.set(locale, (f = formatter(locale, { month: 'long', year: 'numeric' })));
  return f.format(dayNumberOf({ year, month, day: 1 }) * DAY_MS);
}

interface Clock {
  hour12: boolean;
  am: string;
  pm: string;
}

const clocks = new Map<string, Clock>();

function clockOf(locale: string): Clock {
  let clock = clocks.get(locale);
  if (!clock) {
    const f = formatter(locale, { hour: 'numeric', minute: '2-digit' });
    const period = (hour: number): string =>
      f.formatToParts(hour * 3_600_000).find((p) => p.type === 'dayPeriod')?.value ?? '';
    const hour12 = f.resolvedOptions().hour12 === true;
    clock = { hour12, am: hour12 ? period(1) : '', pm: hour12 ? period(13) : '' };
    clocks.set(locale, clock);
  }
  return clock;
}

// ---- Text ----

/** "Wed 7 Oct". With `today`, a date in a different year also shows the year: "Thu 7 Oct 2027". */
export function formatDate({ date, today, locale }: { date: DateStr; today?: DateStr; locale: string }): string {
  const { year, month, day } = parse(date);
  const n = names(locale, 'short');
  const weekday = n.weekdays[weekdayOf(date)]!;
  const text = n.whole
    ? n.whole.format(dayNumber(date) * DAY_MS)
    : // A Vietnamese weekday name ends in a number ("Thứ 4"). A comma keeps it apart from the day.
      `${weekday}${/\d$/.test(weekday) ? ',' : ''} ${day} ${n.months[month - 1]}`;
  return today !== undefined && today.slice(0, 4) !== date.slice(0, 4) ? `${text} ${year}` : text;
}

/** The text for a date near today, or null when the date itself is the better text. */
function nearText(days: number): string | null {
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days < 0 && days > -7) return `${-days} days ago`;
  if (days <= -7 && days >= -34) {
    const weeks = Math.floor(-days / 7);
    return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
  }
  return null;
}

/** 24-hour form "14:30", or 12-hour form "2:30 PM" where the locale uses it. */
export function timeText({ time, locale }: { time: TimeStr; locale: string }): string {
  const clock = clockOf(locale);
  if (!clock.hour12) return time;
  const hour = +time.slice(0, 2);
  return `${hour % 12 || 12}:${time.slice(3, 5)} ${hour < 12 ? clock.am : clock.pm}`;
}

/** "Today", "Tomorrow", "Yesterday", "3 days ago", "2 weeks ago", "Wed 7 Oct". With a time: "Today, 14:30". */
export function dateChipText({
  date,
  time,
  today,
  locale,
}: {
  date: DateStr;
  time?: TimeStr | null;
  today: DateStr;
  locale: string;
}): string {
  const text = nearText(diffDays(date, today)) ?? formatDate({ date, today, locale });
  return time ? `${text}, ${timeText({ time, locale })}` : text;
}

/** "Due today", "Due tomorrow", "Due yesterday", "Due 3 days ago", "Due Wed 7 Oct". */
export function deadlineChipText({ deadline, today, locale }: { deadline: DateStr; today: DateStr; locale: string }): string {
  const near = nearText(diffDays(deadline, today));
  return 'Due ' + (near ? near.charAt(0).toLowerCase() + near.slice(1) : formatDate({ date: deadline, today, locale }));
}

/** The heading of a date group: "Today", "Tomorrow", "Wed 7 Oct". */
export function groupHeading({ date, today, locale }: { date: DateStr; today: DateStr; locale: string }): string {
  const days = diffDays(date, today);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return formatDate({ date, today, locale });
}

/** "Completed: Mon 5 Oct". `at` is a time in milliseconds. The date is the local date of the device. */
export function completedText({ at, today, locale }: { at: number; today?: DateStr; locale: string }): string {
  return 'Completed: ' + formatDate({ date: todayOf(at), today, locale });
}

const yearFormatters = new Map<string, Intl.DateTimeFormat>();

/** "5 Oct 2025": a date in a different year, where the weekday helps less than the year. */
function dateWithYear({ date, locale }: { date: DateStr; locale: string }): string {
  const n = names(locale, 'short');
  if (n.whole) {
    let f = yearFormatters.get(locale);
    if (!f) yearFormatters.set(locale, (f = formatter(locale, { day: 'numeric', month: 'short', year: 'numeric' })));
    return f.format(dayNumber(date) * DAY_MS);
  }
  const { year, month, day } = parse(date);
  return `${day} ${n.months[month - 1]} ${year}`;
}

/**
 * The time of the last edit of a note: "Edited 14:30" today, "Edited yesterday", "Edited Mon 5 Oct"
 * for a different day, and "Edited 5 Oct 2025" for a different year. `at` is a time in
 * milliseconds. The date and the time are the local values of the device.
 */
export function editedText({ at, today, locale }: { at: number; today: DateStr; locale: string }): string {
  const d = new Date(at);
  const date = todayOf(d);
  const days = diffDays(date, today);
  if (days === 0) return 'Edited ' + timeText({ time: `${pad(d.getHours())}:${pad(d.getMinutes())}`, locale });
  if (days === -1) return 'Edited yesterday';
  if (date.slice(0, 4) === today.slice(0, 4)) return 'Edited ' + formatDate({ date, locale });
  return 'Edited ' + dateWithYear({ date, locale });
}

/**
 * Reads a time that a person typed: "9", "9:15", "14.30", "0930", "3pm", "3:30 PM", "12 a.m.".
 * Gives null if the text is not a time.
 */
export function parseTime(text: string): TimeStr | null {
  const m = /^(\d{1,2})(?:[:.]?(\d{2}))?\s*(?:([ap])\.?(?:m\.?)?)?$/i.exec(text.trim());
  if (!m) return null;
  let hour = +m[1]!;
  const minute = m[2] === undefined ? 0 : +m[2];
  const half = m[3]?.toLowerCase();
  if (minute > 59) return null;
  if (half) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (half === 'p' ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  return `${pad(hour)}:${pad(minute)}`;
}
