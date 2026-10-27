import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  addDays,
  addMonths,
  addYears,
  completedText,
  dateChipText,
  dateOf,
  dayNumber,
  dayNumberOf,
  daysInMonth,
  deadlineChipText,
  diffDays,
  editedText,
  formatDate,
  fromDayNumber,
  fromJsDate,
  groupHeading,
  isValidDate,
  isValidTime,
  monthGrid,
  monthName,
  monthTitle,
  parse,
  parseTime,
  timeText,
  todayOf,
  toJsDate,
  weekdayName,
  weekdayOf,
  weekStartOf,
} from './dates.ts';

const DAY_MS = 86_400_000;
const today = '2026-10-06';
const locale = 'en-GB';

describe('parts', () => {
  test('parse and dateOf are opposites', () => {
    expect(parse('2026-10-06')).toEqual({ year: 2026, month: 10, day: 6 });
    expect(dateOf({ year: 2026, month: 1, day: 9 })).toBe('2026-01-09');
    expect(dateOf({ year: 987, month: 12, day: 31 })).toBe('0987-12-31');
  });

  test('isValidDate accepts only real dates in the fixed form', () => {
    for (const ok of ['2026-10-06', '2024-02-29', '2000-02-29', '1999-12-31', '2026-01-01']) {
      expect(isValidDate(ok)).toBe(true);
    }
    for (const bad of ['2026-02-29', '1900-02-29', '2026-13-01', '2026-00-10', '2026-10-00', '2026-10-32', '2026-04-31',
      '2026-1-1', '26-10-06', '2026/10/06', '2026-10-06T00:00', '', null, undefined, 20261006, {}]) {
      expect(isValidDate(bad)).toBe(false);
    }
  });

  test('isValidTime accepts only HH:MM in 24-hour form', () => {
    for (const ok of ['00:00', '09:05', '14:30', '23:59']) expect(isValidTime(ok)).toBe(true);
    for (const bad of ['24:00', '9:05', '12:60', '12:5', '12.30', '', null, 930]) expect(isValidTime(bad)).toBe(false);
  });

  test('daysInMonth knows the leap years', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => daysInMonth(2026, m))).toEqual([
      31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ]);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2100, 2)).toBe(28);
  });
});

describe('day numbers', () => {
  test('agree with the UTC calendar of JavaScript for each day of 250 years', () => {
    const first = Date.UTC(1890, 0, 1) / DAY_MS;
    const last = Date.UTC(2140, 0, 1) / DAY_MS;
    for (let n = first; n <= last; n++) {
      const d = new Date(n * DAY_MS);
      const date = dateOf({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
      if (dayNumber(date) !== n || fromDayNumber(n) !== date || weekdayOf(date) !== d.getUTCDay()) {
        throw new Error(`wrong at ${date}: ${dayNumber(date)} ${fromDayNumber(n)} ${weekdayOf(date)}`);
      }
    }
  });

  test('known values', () => {
    expect(dayNumber('1970-01-01')).toBe(0);
    expect(dayNumber('1969-12-31')).toBe(-1);
    expect(dayNumberOf({ year: 2000, month: 3, day: 1 })).toBe(11017);
    expect(fromDayNumber(0)).toBe('1970-01-01');
    expect(fromDayNumber(-1)).toBe('1969-12-31');
  });
});

describe('date math', () => {
  test('addDays crosses month and year edges', () => {
    expect(addDays('2026-10-06', 0)).toBe('2026-10-06');
    expect(addDays('2026-10-06', 1)).toBe('2026-10-07');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2024-02-28', 2)).toBe('2024-03-01');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-10-06', 365)).toBe('2027-10-06');
    expect(addDays('2026-10-06', -10000)).toBe('1999-05-21');
  });

  test('addDays does not see daylight saving changes', () => {
    // The days on which clocks change in Europe, the United States, and New Zealand.
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
    expect(addDays('2026-10-24', 1)).toBe('2026-10-25');
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
    expect(addDays('2026-09-26', 1)).toBe('2026-09-27');
    expect(addDays('2026-09-27', 1)).toBe('2026-09-28');
    expect(diffDays('2026-11-02', '2026-03-07')).toBe(240);
  });

  test('addMonths clamps the day to the month length', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-10-31', 1)).toBe('2026-11-30');
    expect(addMonths('2026-10-31', 2)).toBe('2026-12-31');
    expect(addMonths('2026-10-31', 3)).toBe('2027-01-31');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonths('2026-10-06', 0)).toBe('2026-10-06');
  });

  test('addMonths crosses year edges in the two directions', () => {
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
    expect(addMonths('2026-10-06', 12)).toBe('2027-10-06');
    expect(addMonths('2026-10-06', -13)).toBe('2025-09-06');
    expect(addMonths('2026-10-06', 27)).toBe('2029-01-06');
    expect(addMonths('2026-01-31', -11)).toBe('2025-02-28');
  });

  test('addYears moves 29 February to 28 February in a common year', () => {
    expect(addYears('2024-02-29', 1)).toBe('2025-02-28');
    expect(addYears('2024-02-29', 4)).toBe('2028-02-29');
    expect(addYears('2024-02-29', -1)).toBe('2023-02-28');
    expect(addYears('2026-10-06', 1)).toBe('2027-10-06');
    expect(addYears('2026-10-06', -26)).toBe('2000-10-06');
  });

  test('diffDays is a minus b', () => {
    expect(diffDays('2026-10-07', '2026-10-06')).toBe(1);
    expect(diffDays('2026-10-06', '2026-10-07')).toBe(-1);
    expect(diffDays('2026-10-06', '2026-10-06')).toBe(0);
    expect(diffDays('2027-01-01', '2026-01-01')).toBe(365);
    expect(diffDays('2025-01-01', '2024-01-01')).toBe(366);
  });

  test('weekdayOf counts from Sunday', () => {
    expect(weekdayOf('2026-10-04')).toBe(0);
    expect(weekdayOf('2026-10-05')).toBe(1);
    expect(weekdayOf('2026-10-07')).toBe(3);
    expect(weekdayOf('2026-10-10')).toBe(6);
    expect(weekdayOf('1970-01-01')).toBe(4);
    expect(weekdayOf('1969-12-28')).toBe(0);
    expect(weekdayOf('2024-02-29')).toBe(4);
  });
});

describe('JavaScript dates', () => {
  test('toJsDate gives the start of the local day, and fromJsDate reads the local date', () => {
    expect(toJsDate('2026-10-06').getTime()).toBe(new Date(2026, 9, 6).getTime());
    const d = toJsDate('2024-02-29');
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2024, 1, 29, 0, 0]);
    expect(fromJsDate(new Date(2026, 9, 6, 0, 0, 0))).toBe('2026-10-06');
    expect(fromJsDate(new Date(2026, 9, 6, 23, 59, 59, 999))).toBe('2026-10-06');
    expect(fromJsDate(new Date(1969, 11, 31, 23, 0))).toBe('1969-12-31');
    expect(fromJsDate(toJsDate('2024-02-29'))).toBe('2024-02-29');
    // A format with no time zone shows the same day.
    expect(new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(toJsDate('2026-10-06'))).toBe(
      '6 October 2026',
    );
  });

  test('toJsDate keeps a year below 100', () => {
    const d = toJsDate('0099-03-01');
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([99, 2, 1]);
    expect(fromJsDate(d)).toBe('0099-03-01');
  });

  test('todayOf gives the local date of the device', () => {
    expect(todayOf(new Date(2026, 9, 6, 0, 0, 0))).toBe('2026-10-06');
    expect(todayOf(new Date(2026, 9, 6, 23, 59, 59))).toBe('2026-10-06');
    expect(todayOf(new Date(2026, 9, 7, 0, 0, 0))).toBe('2026-10-07');
    expect(todayOf(new Date(2026, 11, 31, 23, 59).getTime())).toBe('2026-12-31');
    expect(todayOf(new Date(2027, 0, 1, 0, 1).getTime())).toBe('2027-01-01');
  });
});

describe.each(['Asia/Ho_Chi_Minh', 'America/Los_Angeles', 'Europe/Berlin', 'Pacific/Auckland', 'Pacific/Kiritimati', 'UTC'])(
  'with the device in %s',
  (zone) => {
    const saved = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = zone;
    });
    afterAll(() => {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    });

    test('the date math and the date text give the same results', () => {
      expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
      expect(addDays('2026-10-25', -1)).toBe('2026-10-24');
      expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
      expect(diffDays('2026-11-02', '2026-03-07')).toBe(240);
      expect(weekdayOf('2026-10-07')).toBe(3);
      expect(monthGrid({ year: 2026, month: 3, weekStart: 1 })[0]![0]!.date).toBe('2026-02-23');
      expect(dateChipText({ date: '2026-10-07', today: '2026-10-05', locale })).toBe('Wed 7 Oct');
      expect(monthTitle({ year: 2026, month: 10, locale })).toBe('October 2026');
      expect(toJsDate('2026-10-06').getTime()).toBe(new Date(2026, 9, 6).getTime());
      expect(fromJsDate(toJsDate('2026-10-06'))).toBe('2026-10-06');
    });

    test('todayOf and completedText use the local date', () => {
      const lateEvening = new Date(2026, 9, 5, 23, 30);
      expect(todayOf(lateEvening)).toBe('2026-10-05');
      expect(completedText({ at: lateEvening.getTime(), locale })).toBe('Completed: Mon 5 Oct');
      expect(completedText({ at: new Date(2026, 9, 6, 0, 30).getTime(), locale })).toBe('Completed: Tue 6 Oct');
    });

    test('editedText uses the local date and time', () => {
      const lateEvening = new Date(2026, 9, 5, 23, 30).getTime();
      expect(editedText({ at: lateEvening, today: '2026-10-05', locale })).toBe('Edited 23:30');
      expect(editedText({ at: lateEvening, today: '2026-10-06', locale })).toBe('Edited yesterday');
      expect(editedText({ at: lateEvening, today: '2026-10-07', locale })).toBe('Edited Mon 5 Oct');
      expect(editedText({ at: new Date(2026, 9, 6, 0, 30).getTime(), today: '2026-10-06', locale })).toBe('Edited 00:30');
      expect(editedText({ at: new Date(2025, 11, 31, 23, 59).getTime(), today: '2026-01-02', locale })).toBe('Edited 31 Dec 2025');
    });
  },
);

describe('monthGrid', () => {
  const flat = (grid: ReturnType<typeof monthGrid>) => grid.flat();

  test('has 6 weeks of 7 days in order', () => {
    for (const weekStart of [0, 1, 6]) {
      for (let month = 1; month <= 12; month++) {
        const grid = monthGrid({ year: 2026, month, weekStart });
        expect(grid).toHaveLength(6);
        const cells = flat(grid);
        expect(cells).toHaveLength(42);
        expect(weekdayOf(cells[0]!.date)).toBe(weekStart);
        cells.forEach((cell, i) => {
          expect(cell.date).toBe(addDays(cells[0]!.date, i));
          expect(cell.day).toBe(parse(cell.date).day);
          expect(cell.inMonth).toBe(parse(cell.date).month === month);
        });
        expect(cells.filter((c) => c.inMonth)).toHaveLength(daysInMonth(2026, month));
        expect(grid[0]!.some((c) => c.inMonth)).toBe(true);
      }
    }
  });

  test('October 2026 with a Monday start', () => {
    const grid = monthGrid({ year: 2026, month: 10, weekStart: 1 });
    expect(grid[0]!.map((c) => c.day)).toEqual([28, 29, 30, 1, 2, 3, 4]);
    expect(grid[0]!.map((c) => c.inMonth)).toEqual([false, false, false, true, true, true, true]);
    expect(grid[0]![0]!.date).toBe('2026-09-28');
    expect(grid[4]!.map((c) => c.day)).toEqual([26, 27, 28, 29, 30, 31, 1]);
    expect(grid[5]![6]).toEqual({ date: '2026-11-08', day: 8, inMonth: false });
  });

  test('October 2026 with a Sunday start', () => {
    const grid = monthGrid({ year: 2026, month: 10, weekStart: 0 });
    expect(grid[0]!.map((c) => c.day)).toEqual([27, 28, 29, 30, 1, 2, 3]);
    expect(grid[0]![0]!.date).toBe('2026-09-27');
    expect(grid[4]!.map((c) => c.day)).toEqual([25, 26, 27, 28, 29, 30, 31]);
    expect(grid[5]![6]!.date).toBe('2026-11-07');
  });

  test('a month that starts on the first column has no days of the month before', () => {
    // 1 February 2026 is a Sunday. 1 June 2026 is a Monday.
    expect(monthGrid({ year: 2026, month: 2, weekStart: 0 })[0]![0]).toEqual({ date: '2026-02-01', day: 1, inMonth: true });
    expect(monthGrid({ year: 2026, month: 2, weekStart: 1 })[0]![0]!.date).toBe('2026-01-26');
    expect(monthGrid({ year: 2026, month: 6, weekStart: 1 })[0]![0]).toEqual({ date: '2026-06-01', day: 1, inMonth: true });
    expect(monthGrid({ year: 2026, month: 6, weekStart: 0 })[0]![0]!.date).toBe('2026-05-31');
  });

  test('year edges', () => {
    const january = monthGrid({ year: 2027, month: 1, weekStart: 1 });
    expect(january[0]!.map((c) => c.date)).toEqual([
      '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03',
    ]);
    const december = monthGrid({ year: 2026, month: 12, weekStart: 1 });
    expect(december[0]![0]!.date).toBe('2026-11-30');
    expect(december[5]![6]!.date).toBe('2027-01-10');
    const leap = monthGrid({ year: 2024, month: 2, weekStart: 1 });
    expect(flat(leap).filter((c) => c.inMonth).at(-1)!.date).toBe('2024-02-29');
  });
});

describe('weekStartOf', () => {
  test('reads the locale', () => {
    expect(weekStartOf('en-US')).toBe(0);
    expect(weekStartOf('en-GB')).toBe(1);
    expect(weekStartOf('de-DE')).toBe(1);
    expect(weekStartOf('ja-JP')).toBe(0);
    expect(weekStartOf('ar-EG')).toBe(6);
  });

  test('gives Monday for a tag that is not a locale', () => {
    expect(weekStartOf('not a locale')).toBe(1);
    expect(weekStartOf('')).toBe(1);
  });

  test('uses the region table in a browser with no week data', () => {
    const proto = Intl.Locale.prototype as unknown as Record<string, unknown>;
    const savedInfo = Object.getOwnPropertyDescriptor(proto, 'weekInfo');
    const savedGet = Object.getOwnPropertyDescriptor(proto, 'getWeekInfo');
    Object.defineProperty(proto, 'weekInfo', { configurable: true, get: () => undefined });
    Object.defineProperty(proto, 'getWeekInfo', { configurable: true, value: undefined, writable: true });
    try {
      // These tags are not in the cache from the tests above.
      expect(weekStartOf('en-CA')).toBe(0);
      expect(weekStartOf('pt-BR')).toBe(0);
      expect(weekStartOf('fr-FR')).toBe(1);
      expect(weekStartOf('vi')).toBe(1);
      expect(weekStartOf('en')).toBe(0);
      expect(weekStartOf('ar-SA')).toBe(0);
      expect(weekStartOf('fa-IR')).toBe(6);
    } finally {
      if (savedInfo) Object.defineProperty(proto, 'weekInfo', savedInfo);
      else delete proto.weekInfo;
      if (savedGet) Object.defineProperty(proto, 'getWeekInfo', savedGet);
      else delete proto.getWeekInfo;
    }
  });
});

describe('names', () => {
  test('weekday and month names in three widths', () => {
    expect(weekdayName({ weekday: 0, locale, width: 'long' })).toBe('Sunday');
    expect(weekdayName({ weekday: 3, locale, width: 'short' })).toBe('Wed');
    expect(weekdayName({ weekday: 1, locale, width: 'narrow' })).toBe('M');
    expect(monthName({ month: 10, locale, width: 'long' })).toBe('October');
    expect(monthName({ month: 1, locale, width: 'short' })).toBe('Jan');
    expect(monthName({ month: 12, locale, width: 'short' })).toBe('Dec');
    expect(weekdayName({ weekday: 9, locale, width: 'short' })).toBe('');
  });

  test('monthTitle', () => {
    expect(monthTitle({ year: 2026, month: 10, locale })).toBe('October 2026');
    expect(monthTitle({ year: 2027, month: 1, locale: 'en-US' })).toBe('January 2027');
    expect(monthTitle({ year: 2026, month: 12, locale: 'de-DE' })).toBe('Dezember 2026');
  });

  test('a different locale gives its names', () => {
    expect(formatDate({ date: '2026-10-07', locale: 'de-DE' })).toMatch(/^Mi\.? 7 Okt\.?$/);
    expect(formatDate({ date: '2026-10-07', locale: 'fr-FR' })).toMatch(/^mer\.? 7 oct\.?$/);
  });

  test('a tag that is not a locale does not throw', () => {
    expect(formatDate({ date: '2026-10-07', locale: 'not a locale' })).toContain('7');
    expect(typeof timeText({ time: '14:30', locale: 'not a locale' })).toBe('string');
  });

  test('makes the formatter of a locale one time only', () => {
    formatDate({ date: '2026-10-07', locale: 'en-AU' });
    const spy = vi.spyOn(Intl, 'DateTimeFormat');
    for (let i = 0; i < 100; i++) formatDate({ date: addDays('2026-10-07', i), locale: 'en-AU' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('dateChipText', () => {
  const chip = (date: string, time?: string | null) => dateChipText({ date, time, today, locale });

  test('days near today', () => {
    expect(chip('2026-10-06')).toBe('Today');
    expect(chip('2026-10-07')).toBe('Tomorrow');
    expect(chip('2026-10-05')).toBe('Yesterday');
  });

  test('days ago, up to 6', () => {
    expect(chip('2026-10-04')).toBe('2 days ago');
    expect(chip('2026-10-03')).toBe('3 days ago');
    expect(chip('2026-09-30')).toBe('6 days ago');
  });

  test('weeks ago, from 7 to 34 days', () => {
    expect(chip('2026-09-29')).toBe('1 week ago');
    expect(chip('2026-09-23')).toBe('1 week ago');
    expect(chip('2026-09-22')).toBe('2 weeks ago');
    expect(chip('2026-09-15')).toBe('3 weeks ago');
    expect(chip('2026-09-08')).toBe('4 weeks ago');
    expect(chip('2026-09-02')).toBe('4 weeks ago');
  });

  test('the date, for more than 34 days ago and for after tomorrow', () => {
    expect(chip('2026-09-01')).toMatch(/^Tue 1 Sept?$/);
    expect(chip('2026-08-20')).toBe('Thu 20 Aug');
    expect(chip('2026-10-08')).toBe('Thu 8 Oct');
    expect(chip('2026-12-25')).toBe('Fri 25 Dec');
    expect(dateChipText({ date: '2026-10-07', today: '2026-10-05', locale })).toBe('Wed 7 Oct');
  });

  test('a date in a different year shows the year', () => {
    expect(chip('2027-10-07')).toBe('Thu 7 Oct 2027');
    expect(chip('2027-01-01')).toBe('Fri 1 Jan 2027');
    expect(chip('2025-10-06')).toBe('Mon 6 Oct 2025');
    // Near text wins across the year edge.
    expect(dateChipText({ date: '2027-01-01', today: '2026-12-31', locale })).toBe('Tomorrow');
    expect(dateChipText({ date: '2026-12-30', today: '2027-01-02', locale })).toBe('3 days ago');
    expect(dateChipText({ date: '2026-12-20', today: '2027-01-02', locale })).toBe('1 week ago');
    expect(dateChipText({ date: '2026-11-20', today: '2027-01-02', locale })).toBe('Fri 20 Nov 2026');
  });

  test('a time follows after a comma', () => {
    expect(chip('2026-10-06', '14:30')).toBe('Today, 14:30');
    expect(chip('2026-10-07', '09:05')).toBe('Tomorrow, 09:05');
    expect(chip('2026-10-03', '08:00')).toBe('3 days ago, 08:00');
    expect(chip('2026-10-08', '00:00')).toBe('Thu 8 Oct, 00:00');
    expect(chip('2027-10-07', '23:59')).toBe('Thu 7 Oct 2027, 23:59');
    expect(chip('2026-10-06', null)).toBe('Today');
  });

  test('a time in a locale with a 12-hour clock', () => {
    expect(dateChipText({ date: today, time: '14:30', today, locale: 'en-US' })).toBe('Today, 2:30 PM');
    expect(dateChipText({ date: '2026-10-08', time: '09:05', today, locale: 'en-US' })).toBe('Thu 8 Oct, 9:05 AM');
  });
});

describe('deadlineChipText', () => {
  const chip = (deadline: string) => deadlineChipText({ deadline, today, locale });

  test('near today', () => {
    expect(chip('2026-10-06')).toBe('Due today');
    expect(chip('2026-10-07')).toBe('Due tomorrow');
  });

  test('in the future', () => {
    expect(deadlineChipText({ deadline: '2026-10-07', today: '2026-10-05', locale })).toBe('Due Wed 7 Oct');
    expect(chip('2026-10-08')).toBe('Due Thu 8 Oct');
    expect(chip('2027-10-07')).toBe('Due Thu 7 Oct 2027');
  });

  test('in the past', () => {
    expect(chip('2026-10-05')).toBe('Due yesterday');
    expect(chip('2026-10-03')).toBe('Due 3 days ago');
    expect(chip('2026-09-22')).toBe('Due 2 weeks ago');
    expect(chip('2026-08-20')).toBe('Due Thu 20 Aug');
  });
});

describe('groupHeading', () => {
  test('today, tomorrow, then the date', () => {
    expect(groupHeading({ date: '2026-10-06', today, locale })).toBe('Today');
    expect(groupHeading({ date: '2026-10-07', today, locale })).toBe('Tomorrow');
    expect(groupHeading({ date: '2026-10-08', today, locale })).toBe('Thu 8 Oct');
    expect(groupHeading({ date: '2026-10-07', today: '2026-10-05', locale })).toBe('Wed 7 Oct');
    expect(groupHeading({ date: '2027-02-01', today, locale })).toBe('Mon 1 Feb 2027');
  });
});

describe('completedText', () => {
  test('shows the local date of the completion', () => {
    expect(completedText({ at: new Date(2026, 9, 5, 12, 0).getTime(), locale })).toBe('Completed: Mon 5 Oct');
    expect(completedText({ at: new Date(2026, 9, 5, 23, 59, 59).getTime(), locale })).toBe('Completed: Mon 5 Oct');
    expect(completedText({ at: new Date(2026, 9, 6, 0, 0, 1).getTime(), locale })).toBe('Completed: Tue 6 Oct');
  });

  test('shows the year only when today is in a different year', () => {
    const at = new Date(2025, 11, 31, 12, 0).getTime();
    expect(completedText({ at, locale })).toBe('Completed: Wed 31 Dec');
    expect(completedText({ at, today: '2025-12-31', locale })).toBe('Completed: Wed 31 Dec');
    expect(completedText({ at, today: '2026-10-06', locale })).toBe('Completed: Wed 31 Dec 2025');
  });
});

describe('editedText', () => {
  const at = (month: number, day: number, hour = 12, minute = 0, year = 2026): number => new Date(year, month - 1, day, hour, minute).getTime();

  test('today: the time, in the 24-hour form of the locale', () => {
    expect(editedText({ at: at(10, 6, 14, 30), today, locale })).toBe('Edited 14:30');
    expect(editedText({ at: at(10, 6, 0, 5), today, locale })).toBe('Edited 00:05');
    expect(editedText({ at: at(10, 6, 23, 59), today, locale })).toBe('Edited 23:59');
    expect(editedText({ at: at(10, 6, 9, 7) + 59_999, today, locale })).toBe('Edited 09:07');
  });

  test('today: the time, in the 12-hour form of the locale', () => {
    const us = (time: number): string => editedText({ at: time, today, locale: 'en-US' });
    expect(us(at(10, 6, 14, 30))).toBe('Edited 2:30 PM');
    expect(us(at(10, 6, 0, 5))).toBe('Edited 12:05 AM');
    expect(us(at(10, 6, 12, 0))).toBe('Edited 12:00 PM');
    expect(us(at(10, 6, 9, 15))).toBe('Edited 9:15 AM');
  });

  test('yesterday', () => {
    expect(editedText({ at: at(10, 5, 0, 0), today, locale })).toBe('Edited yesterday');
    expect(editedText({ at: at(10, 5, 23, 59), today, locale })).toBe('Edited yesterday');
    expect(editedText({ at: at(10, 5, 8, 0), today, locale: 'en-US' })).toBe('Edited yesterday');
    // Also when yesterday is in a different year.
    expect(editedText({ at: at(12, 31, 22, 0), today: '2027-01-01', locale })).toBe('Edited yesterday');
  });

  test('a different day of this year: the weekday and the date', () => {
    expect(editedText({ at: at(10, 4), today, locale })).toBe('Edited Sun 4 Oct');
    expect(editedText({ at: at(1, 1, 0, 0), today, locale })).toBe('Edited Thu 1 Jan');
    expect(editedText({ at: at(10, 5), today: '2026-10-12', locale })).toBe('Edited Mon 5 Oct');
    expect(editedText({ at: at(10, 5), today: '2026-10-12', locale: 'en-US' })).toBe('Edited Mon 5 Oct');
  });

  test('a different year: the date and the year, with no weekday', () => {
    expect(editedText({ at: at(10, 5, 12, 0, 2025), today, locale })).toBe('Edited 5 Oct 2025');
    expect(editedText({ at: at(10, 5, 12, 0, 2025), today, locale: 'en-US' })).toBe('Edited 5 Oct 2025');
    expect(editedText({ at: at(12, 30, 12, 0), today: '2027-01-01', locale })).toBe('Edited 30 Dec 2026');
    expect(editedText({ at: at(2, 29, 12, 0, 2024), today, locale })).toBe('Edited 29 Feb 2024');
  });

  test('a time after today, from a clock that is fast, shows its date', () => {
    expect(editedText({ at: at(10, 7, 0, 10), today, locale })).toBe('Edited Wed 7 Oct');
    expect(editedText({ at: at(1, 2, 0, 10, 2027), today: '2026-12-31', locale })).toBe('Edited 2 Jan 2027');
  });

  test('a language that writes a month as a number uses its own date form', () => {
    expect(editedText({ at: at(10, 7), today, locale: 'ja-JP' })).toBe('Edited 10月7日(水)');
    expect(editedText({ at: at(10, 5, 12, 0, 2025), today, locale: 'ja-JP' })).toBe('Edited 2025年10月5日');
    expect(editedText({ at: at(10, 5, 12, 0, 2025), today, locale: 'zh-CN' })).toBe('Edited 2025年10月5日');
    expect(editedText({ at: at(10, 5, 12, 0, 2025), today, locale: 'vi-VN' })).toBe('Edited 5 thg 10 2025');
  });
});

describe('timeText', () => {
  test('24-hour form', () => {
    expect(timeText({ time: '14:30', locale })).toBe('14:30');
    expect(timeText({ time: '00:00', locale })).toBe('00:00');
    expect(timeText({ time: '09:05', locale: 'de-DE' })).toBe('09:05');
  });

  test('12-hour form', () => {
    const us = (time: string) => timeText({ time, locale: 'en-US' });
    expect(us('00:00')).toBe('12:00 AM');
    expect(us('00:05')).toBe('12:05 AM');
    expect(us('09:15')).toBe('9:15 AM');
    expect(us('11:59')).toBe('11:59 AM');
    expect(us('12:00')).toBe('12:00 PM');
    expect(us('12:30')).toBe('12:30 PM');
    expect(us('14:30')).toBe('2:30 PM');
    expect(us('23:59')).toBe('11:59 PM');
  });
});

describe('parseTime', () => {
  test.each([
    ['9', '09:00'],
    ['09', '09:00'],
    ['0', '00:00'],
    ['23', '23:00'],
    ['9:15', '09:15'],
    ['14.30', '14:30'],
    ['14:30', '14:30'],
    ['0930', '09:30'],
    ['930', '09:30'],
    ['1430', '14:30'],
    ['3pm', '15:00'],
    ['3 PM', '15:00'],
    ['3:30pm', '15:30'],
    ['3.30 p.m.', '15:30'],
    ['12am', '00:00'],
    ['12 a.m.', '00:00'],
    ['12pm', '12:00'],
    ['12:45 am', '00:45'],
    ['11:59 PM', '23:59'],
    ['7a', '07:00'],
    ['  8:05  ', '08:05'],
  ])('%s is %s', (text, expected) => {
    expect(parseTime(text)).toBe(expected);
  });

  test.each(['', 'abc', '24', '24:00', '12:60', '7:5', '13pm', '0am', '9:15:30', '-1', '1 2', 'pm', '99999'])(
    '%s is not a time',
    (text) => {
      expect(parseTime(text)).toBeNull();
    },
  );
});

// ---- Review tests: these attack the date code with a second, slow way to get each result ----

/** A small random number source with a seed, so a failure can be made again. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Runs the tests of a block with the device in a time zone. */
function inZone(zone: string): void {
  const saved = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = zone;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  });
}

describe('date math against the UTC calendar of JavaScript', () => {
  const utc = (date: string): Date => new Date(date + 'T00:00:00Z');
  const text = (d: Date): string => d.toISOString().slice(0, 10);

  test('day numbers for random dates from the year 100 to the year 9999', () => {
    const next = seeded(5);
    for (let i = 0; i < 20000; i++) {
      const n = Math.floor(next() * 3_615_000) - 683_000;
      const date = text(new Date(n * DAY_MS));
      if (fromDayNumber(n) !== date) throw new Error(`fromDayNumber(${n}) is ${fromDayNumber(n)}, not ${date}`);
      if (dayNumber(date) !== n) throw new Error(`dayNumber(${date}) is ${dayNumber(date)}, not ${n}`);
      if (weekdayOf(date) !== utc(date).getUTCDay()) throw new Error(`weekdayOf(${date})`);
      if (!isValidDate(date)) throw new Error(`isValidDate(${date})`);
    }
  });

  test('addMonths and addYears for random dates, with the day clamped to the month length', () => {
    const next = seeded(6);
    for (let i = 0; i < 20000; i++) {
      const date = text(new Date(Math.floor(next() * 40000) * DAY_MS));
      const months = Math.floor(next() * 1000) - 500;
      const d = utc(date);
      // Day 1 of the target month, then the smaller of the old day and the month length.
      const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
      const length = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
      first.setUTCDate(Math.min(d.getUTCDate(), length));
      if (addMonths(date, months) !== text(first)) throw new Error(`addMonths(${date}, ${months}) is ${addMonths(date, months)}, not ${text(first)}`);
      const years = Math.floor(months / 12);
      expect(addYears(date, years)).toBe(addMonths(date, years * 12));
    }
    expect(addMonths('2024-02-29', 12)).toBe('2025-02-28');
    expect(addMonths('2024-02-29', 48)).toBe('2028-02-29');
    expect(addMonths('2025-03-31', -1)).toBe('2025-02-28');
    expect(addMonths('2026-12-31', 2)).toBe('2027-02-28');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
  });

  test('addDays and diffDays are opposites, also over many years', () => {
    const next = seeded(7);
    for (let i = 0; i < 5000; i++) {
      const date = text(new Date(Math.floor(next() * 40000) * DAY_MS));
      const days = Math.floor(next() * 200000) - 100000;
      const moved = addDays(date, days);
      expect(moved).toBe(text(new Date(utc(date).getTime() + days * DAY_MS)));
      expect(diffDays(moved, date)).toBe(days);
    }
  });

  test('each month grid from 2020 to 2030, with each first weekday', () => {
    for (let year = 2020; year <= 2030; year++) {
      for (let month = 1; month <= 12; month++) {
        for (let weekStart = 0; weekStart < 7; weekStart++) {
          const cells = monthGrid({ year, month, weekStart }).flat();
          expect(cells).toHaveLength(42);
          expect(weekdayOf(cells[0]!.date)).toBe(weekStart);
          for (let i = 1; i < 42; i++) expect(diffDays(cells[i]!.date, cells[i - 1]!.date)).toBe(1);
          const inMonth = cells.filter((cell) => cell.inMonth);
          expect(inMonth.map((cell) => cell.day)).toEqual(Array.from({ length: daysInMonth(year, month) }, (_, i) => i + 1));
          expect(inMonth.every((cell) => cell.date.startsWith(dateOf({ year, month, day: 1 }).slice(0, 7)))).toBe(true);
          // Day 1 is in the first week.
          expect(cells.findIndex((cell) => cell.inMonth)).toBeLessThan(7);
        }
      }
    }
  });
});

describe('isValidDate agrees with the check of the server', () => {
  /** The check of server/sync.ts, which uses Date.UTC. */
  function serverCheck(value: string): boolean {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return false;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const date = new Date(Date.UTC(y, mo - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
  }

  test('a year below 100 is not valid, because the server refuses it', () => {
    for (const date of ['0000-01-01', '0050-06-15', '0099-12-31']) {
      expect(serverCheck(date)).toBe(false);
      expect(isValidDate(date)).toBe(false);
    }
    expect(isValidDate('0100-01-01')).toBe(true);
    expect(isValidDate('9999-12-31')).toBe(true);
  });

  test('random values', () => {
    const next = seeded(8);
    const pad = (n: number, width: number): string => String(n).padStart(width, '0');
    for (let i = 0; i < 20000; i++) {
      const year = next() < 0.2 ? Math.floor(next() * 200) : 1900 + Math.floor(next() * 300);
      const date = `${pad(year, 4)}-${pad(Math.floor(next() * 14), 2)}-${pad(Math.floor(next() * 33), 2)}`;
      if (isValidDate(date) !== serverCheck(date)) throw new Error(`${date}: ${isValidDate(date)} here, ${serverCheck(date)} on the server`);
    }
  });
});

// The clocks change in these zones on these dates in 2026. New York: 8 March and 1 November.
// Auckland: 5 April and 27 September. Ho Chi Minh City has no change.
describe.each([
  ['America/New_York', ['2026-03-08', '2026-11-01'], [300, 240]],
  ['Pacific/Auckland', ['2026-04-05', '2026-09-27'], [-780, -720]],
  ['Asia/Ho_Chi_Minh', ['2026-03-08', '2026-09-27'], [-420, -420]],
  ['Europe/London', ['2026-03-29', '2026-10-25'], [0, -60]],
] as const)('daylight saving changes with the device in %s', (zone, changes, offsets) => {
  inZone(zone);

  test('the zone is in use: the offsets of January and July are the offsets of the zone', () => {
    expect([new Date(2026, 0, 15, 12).getTimezoneOffset(), new Date(2026, 6, 15, 12).getTimezoneOffset()]).toEqual(offsets);
  });

  test.each(changes)('date math across %s', (change) => {
    const before = addDays(change, -1);
    const after = addDays(change, 1);
    expect(diffDays(after, before)).toBe(2);
    expect(addDays(before, 2)).toBe(after);
    expect(diffDays(change, before)).toBe(1);
    expect(weekdayOf(change)).toBe(0);
    expect(weekdayOf(after)).toBe(1);
    // Seven days are a week, also when one of the days has 23 or 25 hours.
    expect(weekdayOf(addDays(before, 7))).toBe(weekdayOf(before));
    expect(dateChipText({ date: after, today: before, locale })).toBe(formatDate({ date: after, locale }));
    expect(dateChipText({ date: change, today: before, locale })).toBe('Tomorrow');
    expect(dateChipText({ date: before, today: change, locale })).toBe('Yesterday');
    expect(dateChipText({ date: before, today: after, locale })).toBe('2 days ago');
  });

  test.each(changes)('the local date around %s', (change) => {
    const { year, month, day } = parse(change);
    for (const offset of [-1, 0, 1]) {
      const date = addDays(change, offset);
      for (const [hour, minute] of [[0, 0], [0, 30], [1, 30], [2, 30], [3, 30], [12, 0], [23, 30], [23, 59]] as const) {
        const d = new Date(year, month - 1, day + offset, hour, minute);
        // A time that the change removes moves to a later time of the same day.
        expect(todayOf(d)).toBe(date);
        expect(todayOf(d.getTime())).toBe(date);
        expect(fromJsDate(d)).toBe(date);
        expect(completedText({ at: d.getTime(), locale })).toBe('Completed: ' + formatDate({ date, locale }));
      }
      const start = toJsDate(date);
      expect([start.getFullYear(), start.getMonth() + 1, start.getDate()]).toEqual([year, parse(date).month, parse(date).day]);
      expect(fromJsDate(start)).toBe(date);
      // One millisecond before the start of a day is the day before.
      expect(todayOf(start.getTime() - 1)).toBe(addDays(date, -1));
    }
  });

  test('toJsDate and fromJsDate are opposites for each day of three years', () => {
    for (let n = dayNumber('2025-01-01'); n <= dayNumber('2027-12-31'); n++) {
      const date = fromDayNumber(n);
      const d = toJsDate(date);
      if (fromJsDate(d) !== date || d.getDate() !== parse(date).day) throw new Error(`${date} gives ${d.toString()}`);
    }
  });
});

// In these zones a change of the clocks removes midnight: the day starts at 01:00.
describe.each([
  ['America/Havana', '2026-03-08'],
  ['Africa/Cairo', '2026-04-24'],
  ['America/Santiago', '2026-09-06'],
  ['Asia/Beirut', '2026-03-29'],
] as const)('a day with no midnight, with the device in %s', (zone, change) => {
  inZone(zone);

  test('toJsDate gives a time of that day', () => {
    for (const date of [addDays(change, -1), change, addDays(change, 1)]) {
      const d = toJsDate(date);
      expect(fromJsDate(d)).toBe(date);
      expect(d.getDate()).toBe(parse(date).day);
      expect(d.getHours()).toBeLessThanOrEqual(1);
      expect(todayOf(d.getTime() - 1)).toBe(addDays(date, -1));
    }
  });

  test('each day of 2026 is its own date', () => {
    for (let n = dayNumber('2026-01-01'); n <= dayNumber('2026-12-31'); n++) {
      const date = fromDayNumber(n);
      if (fromJsDate(toJsDate(date)) !== date) throw new Error(`${date} gives ${toJsDate(date).toString()}`);
    }
  });
});

describe('date text in other languages', () => {
  test('Vietnamese: a comma keeps the number of the weekday apart from the day', () => {
    expect(formatDate({ date: '2026-10-07', locale: 'vi-VN' })).toBe('Thứ 4, 7 thg 10');
    // Sunday has a name with no number.
    expect(formatDate({ date: '2026-10-11', locale: 'vi-VN' })).toBe('CN 11 thg 10');
    expect(dateChipText({ date: '2027-01-02', time: '14:30', today, locale: 'vi-VN' })).toBe('Thứ 7, 2 thg 1 2027, 14:30');
    expect(deadlineChipText({ deadline: '2026-10-09', today, locale: 'vi-VN' })).toBe('Due Thứ 6, 9 thg 10');
  });

  test('English keeps the fixed order with no comma', () => {
    for (const tag of ['en-GB', 'en-US', 'en-AU', 'en']) expect(formatDate({ date: '2026-10-07', locale: tag })).toBe('Wed 7 Oct');
  });

  test('a language that writes a month as a number uses its own date form', () => {
    expect(formatDate({ date: '2026-10-07', locale: 'ja-JP' })).toBe('10月7日(水)');
    expect(formatDate({ date: '2026-10-07', locale: 'zh-CN' })).toBe('10月7日周三');
    expect(monthName({ month: 10, locale: 'ja-JP', width: 'long' })).toBe('10月');
    expect(dateChipText({ date: '2026-10-07', today: '2026-10-05', locale: 'ja-JP' })).toBe('10月7日(水)');
    // The same formatter is used again.
    const spy = vi.spyOn(Intl, 'DateTimeFormat');
    for (let i = 0; i < 50; i++) formatDate({ date: addDays('2026-10-07', i), locale: 'ja-JP' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('a narrow weekday name is the name that stands alone, for the head of a month grid', () => {
    const narrow = (tag: string): string[] => [0, 1, 2, 3, 4, 5, 6].map((weekday) => weekdayName({ weekday, locale: tag, width: 'narrow' }));
    expect(narrow('en-AU')).toEqual(['S', 'M', 'T', 'W', 'T', 'F', 'S']);
    expect(narrow('en-GB')).toEqual(['S', 'M', 'T', 'W', 'T', 'F', 'S']);
    expect(narrow('vi-VN')).toEqual(['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']);
    for (const tag of ['en-AU', 'en-US', 'vi-VN', 'de-DE', 'ja-JP']) for (const name of narrow(tag)) expect(name).not.toBe('');
  });

  test('each text function gives text for many languages and does not throw', () => {
    for (const tag of ['en-GB', 'en-US', 'vi-VN', 'de-DE', 'fr-FR', 'ja-JP', 'zh-CN', 'ko-KR', 'ar-EG', 'hi-IN', 'th-TH', 'ru-RU', 'not a tag', '']) {
      for (const date of ['2026-01-01', '2026-10-07', '2024-02-29']) {
        expect(formatDate({ date, locale: tag }).length).toBeGreaterThan(3);
        expect(formatDate({ date, today, locale: tag })).not.toContain('undefined');
        expect(groupHeading({ date, today, locale: tag })).not.toContain('NaN');
      }
      expect(timeText({ time: '00:05', locale: tag })).toMatch(/^(00:05|12:05 \S+)$/);
      expect(timeText({ time: '23:59', locale: tag })).toMatch(/^(23:59|11:59 \S+)$/);
      for (const at of [new Date(2026, 9, 6, 0, 5), new Date(2026, 9, 5, 12, 0), new Date(2026, 1, 1), new Date(2024, 1, 29)]) {
        const text = editedText({ at: at.getTime(), today, locale: tag });
        expect(text).toMatch(/^Edited \S/);
        expect(text).not.toMatch(/undefined|NaN/);
      }
      expect(monthTitle({ year: 2026, month: 10, locale: tag }).length).toBeGreaterThan(3);
      expect([0, 1, 6]).toContain(weekStartOf(tag));
    }
  });
});

describe('time text', () => {
  test('each minute of the day goes to the 12-hour form and back', () => {
    for (let hour = 0; hour < 24; hour++) {
      for (const minute of [0, 1, 30, 59]) {
        const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
        expect(isValidTime(time)).toBe(true);
        expect(parseTime(timeText({ time, locale: 'en-US' }))).toBe(time);
        expect(parseTime(timeText({ time, locale: 'en-GB' }))).toBe(time);
      }
    }
    expect(timeText({ time: '00:00', locale: 'en-US' })).toBe('12:00 AM');
    expect(timeText({ time: '12:00', locale: 'en-US' })).toBe('12:00 PM');
    expect(timeText({ time: '12:30', locale: 'en-US' })).toBe('12:30 PM');
    expect(timeText({ time: '00:30', locale: 'en-US' })).toBe('12:30 AM');
  });
});
