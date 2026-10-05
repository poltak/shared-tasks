import { describe, expect, test } from 'vitest';
import type { DateStr, RepeatRule } from './types.ts';
import { addDays, dayNumber, daysInMonth, diffDays, parse, weekdayOf } from './dates.ts';
import { describeRule, firstOccurrence, isFinished, nextOccurrence, validateRule } from './recurrence.ts';

const locale = 'en-GB';

function rule(fields: Partial<RepeatRule>): RepeatRule {
  return { every: 1, unit: 'day', start: '2026-10-06', end: { type: 'never' }, ...fields };
}

/** The first `count` dates of a rule. */
function series(r: RepeatRule, count: number): DateStr[] {
  const dates = [firstOccurrence(r)];
  while (dates.length < count) dates.push(nextOccurrence({ rule: r, after: dates.at(-1)! }));
  return dates;
}

describe('every N days', () => {
  test('daily', () => {
    const r = rule({});
    expect(firstOccurrence(r)).toBe('2026-10-06');
    expect(nextOccurrence({ rule: r, after: '2026-10-06' })).toBe('2026-10-07');
    expect(nextOccurrence({ rule: r, after: '2026-12-31' })).toBe('2027-01-01');
  });

  test('every 3 days', () => {
    const r = rule({ every: 3 });
    expect(series(r, 4)).toEqual(['2026-10-06', '2026-10-09', '2026-10-12', '2026-10-15']);
    expect(nextOccurrence({ rule: r, after: '2026-10-07' })).toBe('2026-10-09');
    expect(nextOccurrence({ rule: r, after: '2026-10-08' })).toBe('2026-10-09');
    expect(nextOccurrence({ rule: r, after: '2026-10-09' })).toBe('2026-10-12');
  });

  test('a date before the start gives the start', () => {
    const r = rule({ every: 3 });
    expect(nextOccurrence({ rule: r, after: '2026-10-05' })).toBe('2026-10-06');
    expect(nextOccurrence({ rule: r, after: '2020-01-01' })).toBe('2026-10-06');
  });
});

describe('weeks', () => {
  test('weekly on the weekday of the start', () => {
    const r = rule({ unit: 'week', weekdays: [2] });
    expect(series(r, 3)).toEqual(['2026-10-06', '2026-10-13', '2026-10-20']);
  });

  test('weekly with no weekdays uses the weekday of the start', () => {
    expect(series(rule({ unit: 'week' }), 3)).toEqual(['2026-10-06', '2026-10-13', '2026-10-20']);
    expect(series(rule({ unit: 'week', weekdays: [] }), 2)).toEqual(['2026-10-06', '2026-10-13']);
  });

  test('several weekdays', () => {
    // The start is a Tuesday, so the Monday of that week is not given.
    const r = rule({ unit: 'week', weekdays: [3, 1] });
    expect(series(r, 5)).toEqual(['2026-10-07', '2026-10-12', '2026-10-14', '2026-10-19', '2026-10-21']);
    expect(nextOccurrence({ rule: r, after: '2026-10-07' })).toBe('2026-10-12');
    expect(nextOccurrence({ rule: r, after: '2026-10-11' })).toBe('2026-10-12');
    expect(nextOccurrence({ rule: r, after: '2026-10-12' })).toBe('2026-10-14');
  });

  test('every 2 weeks with several weekdays', () => {
    const r = rule({ unit: 'week', every: 2, weekdays: [1, 3] });
    expect(series(r, 5)).toEqual(['2026-10-07', '2026-10-19', '2026-10-21', '2026-11-02', '2026-11-04']);
    // A date in the week that the rule skips.
    expect(nextOccurrence({ rule: r, after: '2026-10-12' })).toBe('2026-10-19');
    expect(nextOccurrence({ rule: r, after: '2026-10-18' })).toBe('2026-10-19');
  });

  test('the weeks start on Monday, so a Sunday is the last day of its week', () => {
    // Monday 5 October and Sunday 11 October are in the same week of the rule.
    const r = rule({ unit: 'week', every: 2, weekdays: [0, 1], start: '2026-10-05' });
    expect(series(r, 6)).toEqual(['2026-10-05', '2026-10-11', '2026-10-19', '2026-10-25', '2026-11-02', '2026-11-08']);
    const sunday = rule({ unit: 'week', every: 2, weekdays: [0], start: '2026-10-11' });
    expect(series(sunday, 3)).toEqual(['2026-10-11', '2026-10-25', '2026-11-08']);
  });

  test('every 3 weeks from a start in the middle of the week', () => {
    const r = rule({ unit: 'week', every: 3, weekdays: [1, 5], start: '2026-10-08' });
    expect(series(r, 4)).toEqual(['2026-10-09', '2026-10-26', '2026-10-30', '2026-11-16']);
  });

  test('all weekdays is each day', () => {
    const r = rule({ unit: 'week', weekdays: [0, 1, 2, 3, 4, 5, 6] });
    expect(series(r, 8)).toEqual(Array.from({ length: 8 }, (_, i) => addDays('2026-10-06', i)));
  });
});

describe('months by day', () => {
  test('monthly on day 5', () => {
    const r = rule({ unit: 'month', monthMode: 'day', monthDay: 5, start: '2026-10-05' });
    expect(series(r, 4)).toEqual(['2026-10-05', '2026-11-05', '2026-12-05', '2027-01-05']);
  });

  test('the first date is in the next month when the day is before the start', () => {
    const r = rule({ unit: 'month', monthDay: 5, start: '2026-10-15' });
    expect(firstOccurrence(r)).toBe('2026-11-05');
    expect(nextOccurrence({ rule: r, after: '2026-11-04' })).toBe('2026-11-05');
    expect(nextOccurrence({ rule: r, after: '2026-11-05' })).toBe('2026-12-05');
  });

  test('with no day, the day of the start', () => {
    expect(series(rule({ unit: 'month' }), 3)).toEqual(['2026-10-06', '2026-11-06', '2026-12-06']);
  });

  test('day 31 uses the last day of a shorter month', () => {
    const r = rule({ unit: 'month', monthDay: 31, start: '2026-01-31' });
    expect(series(r, 6)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
    expect(nextOccurrence({ rule: r, after: '2028-02-01' })).toBe('2028-02-29');
  });

  test('day 29 and day 30 in February', () => {
    expect(nextOccurrence({ rule: rule({ unit: 'month', monthDay: 30, start: '2026-01-30' }), after: '2026-01-30' })).toBe('2026-02-28');
    expect(nextOccurrence({ rule: rule({ unit: 'month', monthDay: 29, start: '2024-01-29' }), after: '2024-01-29' })).toBe('2024-02-29');
    expect(nextOccurrence({ rule: rule({ unit: 'month', monthDay: 29, start: '2026-01-29' }), after: '2026-02-28' })).toBe('2026-03-29');
  });

  test('the last day', () => {
    const r = rule({ unit: 'month', monthDay: -1, start: '2026-01-10' });
    expect(series(r, 4)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    expect(nextOccurrence({ rule: r, after: '2028-02-01' })).toBe('2028-02-29');
  });

  test('every 3 months', () => {
    const r = rule({ unit: 'month', every: 3, monthDay: 31, start: '2026-01-31' });
    expect(series(r, 5)).toEqual(['2026-01-31', '2026-04-30', '2026-07-31', '2026-10-31', '2027-01-31']);
    expect(nextOccurrence({ rule: r, after: '2026-02-15' })).toBe('2026-04-30');
    expect(nextOccurrence({ rule: r, after: '2026-04-30' })).toBe('2026-07-31');
  });

  test('across a year edge', () => {
    const r = rule({ unit: 'month', every: 5, monthDay: 15, start: '2026-10-15' });
    expect(series(r, 4)).toEqual(['2026-10-15', '2027-03-15', '2027-08-15', '2028-01-15']);
  });
});

describe('months by ordinal weekday', () => {
  const monthly = (ordinal: number, weekday: number, start = '2026-10-01', every = 1) =>
    rule({ unit: 'month', every, monthMode: 'weekday', ordinal, weekday, start });

  test('the first Monday', () => {
    expect(series(monthly(1, 1), 4)).toEqual(['2026-10-05', '2026-11-02', '2026-12-07', '2027-01-04']);
  });

  test('the second Tuesday and the third Sunday', () => {
    expect(series(monthly(2, 2), 3)).toEqual(['2026-10-13', '2026-11-10', '2026-12-08']);
    expect(series(monthly(3, 0), 3)).toEqual(['2026-10-18', '2026-11-15', '2026-12-20']);
  });

  test('the fourth and the last are different in a month with five', () => {
    // October 2026 has five Fridays: 2, 9, 16, 23, 30. November has four: the last is the 27th.
    expect(series(monthly(4, 5), 3)).toEqual(['2026-10-23', '2026-11-27', '2026-12-25']);
    expect(series(monthly(-1, 5), 4)).toEqual(['2026-10-30', '2026-11-27', '2026-12-25', '2027-01-29']);
  });

  test('the first weekday when the month starts on it', () => {
    // 1 October 2026 is a Thursday. 1 February 2026 is a Sunday.
    expect(firstOccurrence(monthly(1, 4))).toBe('2026-10-01');
    expect(firstOccurrence(monthly(1, 0, '2026-02-01'))).toBe('2026-02-01');
    expect(firstOccurrence(monthly(-1, 6, '2026-02-01'))).toBe('2026-02-28');
  });

  test('a start after the date of the month goes to the next month', () => {
    expect(firstOccurrence(monthly(1, 1, '2026-10-06'))).toBe('2026-11-02');
  });

  test('every 2 months', () => {
    expect(series(monthly(1, 1, '2026-10-01', 2), 3)).toEqual(['2026-10-05', '2026-12-07', '2027-02-01']);
  });

  test('with no ordinal and no weekday, the values of the start', () => {
    // 13 October 2026 is the second Tuesday. 30 October 2026 is the last Friday.
    expect(series(rule({ unit: 'month', monthMode: 'weekday', start: '2026-10-13' }), 3)).toEqual([
      '2026-10-13', '2026-11-10', '2026-12-08',
    ]);
    expect(series(rule({ unit: 'month', monthMode: 'weekday', start: '2026-10-30' }), 3)).toEqual([
      '2026-10-30', '2026-11-27', '2026-12-25',
    ]);
  });
});

describe('years', () => {
  test('yearly', () => {
    const r = rule({ unit: 'year', start: '2026-10-05' });
    expect(series(r, 3)).toEqual(['2026-10-05', '2027-10-05', '2028-10-05']);
    expect(nextOccurrence({ rule: r, after: '2027-10-04' })).toBe('2027-10-05');
    expect(nextOccurrence({ rule: r, after: '2027-10-05' })).toBe('2028-10-05');
  });

  test('every 2 years', () => {
    const r = rule({ unit: 'year', every: 2, start: '2026-10-05' });
    expect(series(r, 3)).toEqual(['2026-10-05', '2028-10-05', '2030-10-05']);
    expect(nextOccurrence({ rule: r, after: '2027-12-31' })).toBe('2028-10-05');
  });

  test('29 February goes to 28 February in a common year', () => {
    const r = rule({ unit: 'year', start: '2024-02-29' });
    expect(series(r, 5)).toEqual(['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
    expect(nextOccurrence({ rule: r, after: '2025-02-28' })).toBe('2026-02-28');
    expect(nextOccurrence({ rule: r, after: '2099-12-31' })).toBe('2100-02-28');
  });

  test('29 February each 4 years stays on 29 February', () => {
    expect(series(rule({ unit: 'year', every: 4, start: '2024-02-29' }), 3)).toEqual(['2024-02-29', '2028-02-29', '2032-02-29']);
  });
});

describe('nextOccurrence against a day-by-day search', () => {
  function random(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** A second, slow way to tell if a date is in the rule. */
  function matches(r: RepeatRule, date: DateStr): boolean {
    if (date < r.start) return false;
    const s = parse(r.start);
    const d = parse(date);
    if (r.unit === 'day') return diffDays(date, r.start) % r.every === 0;
    if (r.unit === 'week') {
      const monday = (x: DateStr) => dayNumber(x) - ((weekdayOf(x) + 6) % 7);
      return r.weekdays!.includes(weekdayOf(date)) && ((monday(date) - monday(r.start)) / 7) % r.every === 0;
    }
    if (r.unit === 'month') {
      if (((d.year - s.year) * 12 + d.month - s.month) % r.every !== 0) return false;
      const length = daysInMonth(d.year, d.month);
      if (r.monthMode === 'day') return d.day === (r.monthDay === -1 ? length : Math.min(r.monthDay!, length));
      if (weekdayOf(date) !== r.weekday) return false;
      return r.ordinal === -1 ? d.day + 7 > length : Math.ceil(d.day / 7) === r.ordinal;
    }
    return (d.year - s.year) % r.every === 0 && d.month === s.month && d.day === Math.min(s.day, daysInMonth(d.year, s.month));
  }

  test('2000 random rules and dates', () => {
    const next = random(42);
    const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
    for (let i = 0; i < 2000; i++) {
      const start = addDays('2023-01-01', int(0, 1500));
      const unit = (['day', 'week', 'month', 'year'] as const)[int(0, 3)]!;
      const r = rule({ unit, start, every: int(1, unit === 'year' ? 3 : 5) });
      if (unit === 'week') r.weekdays = [0, 1, 2, 3, 4, 5, 6].filter(() => next() < 0.35).concat(int(0, 6)).filter((d, at, all) => all.indexOf(d) === at);
      if (unit === 'month') {
        if (next() < 0.5) {
          r.monthMode = 'day';
          r.monthDay = next() < 0.2 ? -1 : int(1, 31);
        } else {
          r.monthMode = 'weekday';
          r.ordinal = next() < 0.2 ? -1 : int(1, 4);
          r.weekday = int(0, 6);
        }
      }
      const after = addDays(start, int(-40, 900));
      let expected = after < r.start ? r.start : addDays(after, 1);
      while (!matches(r, expected)) expected = addDays(expected, 1);
      const got = nextOccurrence({ rule: r, after });
      if (got !== expected) throw new Error(`${JSON.stringify(r)} after ${after}: got ${got}, expected ${expected}`);
    }
  });

  test('a date far from the start needs no long loop', () => {
    const rules = [
      rule({ start: '1970-01-01' }),
      rule({ every: 7, start: '1970-01-01' }),
      rule({ unit: 'week', every: 3, weekdays: [1, 4], start: '1970-01-01' }),
      rule({ unit: 'month', monthDay: 31, start: '1970-01-31' }),
      rule({ unit: 'month', every: 7, monthMode: 'weekday', ordinal: -1, weekday: 5, start: '1970-01-01' }),
      rule({ unit: 'year', start: '1972-02-29' }),
    ];
    const started = performance.now();
    for (let i = 0; i < 5000; i++) {
      for (const r of rules) {
        const got = nextOccurrence({ rule: r, after: addDays('9000-01-01', i) });
        if (!(got > '9000-01-01')) throw new Error(`wrong: ${got}`);
      }
    }
    // 30000 results. A day-by-day loop over 7000 years would need minutes.
    expect(performance.now() - started).toBeLessThan(1500);
    expect(nextOccurrence({ rule: rules[0]!, after: '9000-06-15' })).toBe('9000-06-16');
    expect(nextOccurrence({ rule: rules[5]!, after: '9000-06-15' })).toBe('9001-02-28');
    expect(nextOccurrence({ rule: rule({ every: 1000, start: '2026-10-06' }), after: '2026-10-06' })).toBe('2029-07-02');
    expect(nextOccurrence({ rule: rule({ unit: 'year', every: 1000, start: '2026-10-06' }), after: '2026-10-06' })).toBe('3026-10-06');
  });
});

describe('firstOccurrence', () => {
  test('is the start when the start is in the rule', () => {
    expect(firstOccurrence(rule({ every: 9 }))).toBe('2026-10-06');
    expect(firstOccurrence(rule({ unit: 'year' }))).toBe('2026-10-06');
  });

  test('is the first date after the start when the start is not in the rule', () => {
    expect(firstOccurrence(rule({ unit: 'week', weekdays: [5] }))).toBe('2026-10-09');
    expect(firstOccurrence(rule({ unit: 'week', every: 2, weekdays: [1] }))).toBe('2026-10-19');
    expect(firstOccurrence(rule({ unit: 'month', monthDay: -1 }))).toBe('2026-10-31');
  });
});

describe('isFinished', () => {
  test('a rule with no end is never finished', () => {
    expect(isFinished({ rule: rule({}), doneCount: 100000, next: '9999-12-31' })).toBe(false);
  });

  test('an end date', () => {
    const r = rule({ end: { type: 'on', date: '2026-11-04' } });
    expect(isFinished({ rule: r, doneCount: 1, next: '2026-11-03' })).toBe(false);
    expect(isFinished({ rule: r, doneCount: 1, next: '2026-11-04' })).toBe(false);
    expect(isFinished({ rule: r, doneCount: 1, next: '2026-11-05' })).toBe(true);
  });

  test('an end count', () => {
    const r = rule({ end: { type: 'after', count: 3 } });
    expect(isFinished({ rule: r, doneCount: 1, next: '2026-10-07' })).toBe(false);
    expect(isFinished({ rule: r, doneCount: 2, next: '2026-10-08' })).toBe(false);
    expect(isFinished({ rule: r, doneCount: 3, next: '2026-10-09' })).toBe(true);
    expect(isFinished({ rule: r, doneCount: 4, next: '2026-10-10' })).toBe(true);
  });
});

describe('describeRule', () => {
  const text = (fields: Partial<RepeatRule>, loc = locale) => describeRule({ rule: rule(fields), locale: loc });

  test('days', () => {
    expect(text({})).toBe('Daily');
    expect(text({ every: 3 })).toBe('Every 3 days');
  });

  test('weeks', () => {
    expect(text({ unit: 'week', weekdays: [1] })).toBe('Weekly on Monday');
    expect(text({ unit: 'week' })).toBe('Weekly on Tuesday');
    expect(text({ unit: 'week', every: 2, weekdays: [1, 3] })).toBe('Every 2 weeks on Mon, Wed');
    expect(text({ unit: 'week', every: 2, weekdays: [5] })).toBe('Every 2 weeks on Friday');
    expect(text({ unit: 'week', weekdays: [0, 1, 2, 3, 4, 5, 6] })).toBe('Weekly on all days');
  });

  test('the weekdays are in the order of the week of the locale', () => {
    expect(text({ unit: 'week', weekdays: [3, 0, 1] })).toBe('Weekly on Mon, Wed, Sun');
    expect(text({ unit: 'week', weekdays: [3, 0, 1] }, 'en-US')).toBe('Weekly on Sun, Mon, Wed');
  });

  test('months', () => {
    expect(text({ unit: 'month', monthMode: 'day', monthDay: 5 })).toBe('Monthly on day 5');
    expect(text({ unit: 'month' })).toBe('Monthly on day 6');
    expect(text({ unit: 'month', monthDay: -1 })).toBe('Monthly on the last day');
    expect(text({ unit: 'month', every: 2, monthDay: 31 })).toBe('Every 2 months on day 31');
    expect(text({ unit: 'month', monthMode: 'weekday', ordinal: 1, weekday: 1 })).toBe('Monthly on the first Monday');
    expect(text({ unit: 'month', monthMode: 'weekday', ordinal: 2, weekday: 2 })).toBe('Monthly on the second Tuesday');
    expect(text({ unit: 'month', monthMode: 'weekday', ordinal: 3, weekday: 0 })).toBe('Monthly on the third Sunday');
    expect(text({ unit: 'month', monthMode: 'weekday', ordinal: 4, weekday: 4 })).toBe('Monthly on the fourth Thursday');
    expect(text({ unit: 'month', every: 3, monthMode: 'weekday', ordinal: -1, weekday: 5 })).toBe('Every 3 months on the last Friday');
    expect(text({ unit: 'month', monthMode: 'weekday' })).toBe('Monthly on the first Tuesday');
  });

  test('years', () => {
    expect(text({ unit: 'year', start: '2026-10-05' })).toBe('Yearly on 5 October');
    expect(text({ unit: 'year', every: 2, start: '2024-02-29' })).toBe('Every 2 years on 29 February');
  });

  test('with an end', () => {
    expect(text({ end: { type: 'on', date: '2026-11-04' } })).toBe('Daily, until 4 Nov');
    expect(text({ end: { type: 'on', date: '2027-01-15' } })).toBe('Daily, until 15 Jan 2027');
    expect(text({ end: { type: 'after', count: 30 } })).toBe('Daily, 30 times');
    expect(text({ end: { type: 'after', count: 1 } })).toBe('Daily, 1 time');
    expect(text({ unit: 'week', every: 2, weekdays: [1, 3], end: { type: 'after', count: 30 } })).toBe(
      'Every 2 weeks on Mon, Wed, 30 times',
    );
    expect(text({ unit: 'year', start: '2026-10-05', end: { type: 'on', date: '2030-10-05' } })).toBe(
      'Yearly on 5 October, until 5 Oct 2030',
    );
  });
});

describe('validateRule', () => {
  test('accepts each kind of rule', () => {
    const good: RepeatRule[] = [
      rule({}),
      rule({ every: 1000 }),
      rule({ unit: 'week' }),
      rule({ unit: 'week', weekdays: [0, 6] }),
      rule({ unit: 'month' }),
      rule({ unit: 'month', monthMode: 'day', monthDay: 31 }),
      rule({ unit: 'month', monthMode: 'day', monthDay: -1 }),
      rule({ unit: 'month', monthMode: 'weekday', ordinal: 4, weekday: 0 }),
      rule({ unit: 'month', monthMode: 'weekday', ordinal: -1, weekday: 6 }),
      rule({ unit: 'year' }),
      rule({ end: { type: 'on', date: '2026-10-06' } }),
      rule({ end: { type: 'after', count: 1 } }),
      rule({ end: { type: 'after', count: 100000 } }),
      // The server accepts these rules too. A week rule with no weekdays uses the weekday of the start.
      rule({ unit: 'week', weekdays: [] }),
      rule({ unit: 'week', weekdays: [1, 1] }),
      rule({ end: { type: 'on', date: '2026-10-05' } }),
      rule({ unit: 'day', weekdays: [1], monthMode: 'day', monthDay: 5, ordinal: 1, weekday: 1 }),
    ];
    for (const r of good) expect(validateRule(r), JSON.stringify(r)).toBe(true);
    // A rule that came through JSON.
    expect(validateRule(JSON.parse(JSON.stringify(good[7])))).toBe(true);
  });

  test('refuses a value that is not a rule', () => {
    const bad: unknown[] = [
      null,
      undefined,
      'daily',
      42,
      [],
      {},
      { ...rule({}), every: 0 },
      { ...rule({}), every: 1001 },
      { ...rule({}), every: 1.5 },
      { ...rule({}), every: '2' },
      { ...rule({}), unit: 'hour' },
      { ...rule({}), unit: undefined },
      { ...rule({}), start: '2026-02-30' },
      { ...rule({}), start: 20261006 },
      { ...rule({}), end: null },
      { ...rule({}), end: undefined },
      { ...rule({}), end: { type: 'sometime' } },
      { ...rule({}), end: { type: 'on' } },
      { ...rule({}), end: { type: 'on', date: 'tomorrow' } },
      { ...rule({}), end: { type: 'after', count: 0 } },
      { ...rule({}), end: { type: 'after', count: 2.5 } },
      { ...rule({}), end: { type: 'after' } },
      { ...rule({}), end: { type: 'after', count: 100001 } },
      rule({ unit: 'week', weekdays: [7] }),
      rule({ unit: 'week', weekdays: [-1] }),
      rule({ unit: 'week', weekdays: [0, 1, 2, 3, 4, 5, 6, 0] }),
      rule({ unit: 'day', weekdays: [1.5] }),
      { ...rule({ unit: 'week' }), weekdays: 'Mon' },
      rule({ unit: 'month', monthDay: 0 }),
      rule({ unit: 'month', monthDay: 32 }),
      rule({ unit: 'month', monthDay: -2 }),
      { ...rule({ unit: 'month' }), monthMode: 'other' },
      rule({ unit: 'month', monthMode: 'weekday', ordinal: 5, weekday: 1 }),
      rule({ unit: 'month', monthMode: 'weekday', ordinal: 0, weekday: 1 }),
      rule({ unit: 'month', monthMode: 'weekday', ordinal: 1, weekday: 7 }),
    ];
    for (const value of bad) expect(validateRule(value), JSON.stringify(value)).toBe(false);
  });
});

describe('a rule with values that are not valid', () => {
  test('gives a result and does not loop with no end', () => {
    const broken = [
      { ...rule({ unit: 'week' }), weekdays: [9, -1] },
      { ...rule({ unit: 'month' }), monthDay: Number.NaN },
      { ...rule({ unit: 'month', monthMode: 'weekday' }), ordinal: 99, weekday: 99 },
      { ...rule({ unit: 'year' }), every: Number.NaN },
      { ...rule({}), every: -3 },
      { ...rule({ unit: 'week' }), start: 'not a date' },
      { ...rule({ unit: 'month' }), start: '' },
      { ...rule({ unit: 'year' }), start: 'x' },
    ] as RepeatRule[];
    for (const r of broken) {
      expect(typeof nextOccurrence({ rule: r, after: '2026-10-06' })).toBe('string');
      expect(typeof firstOccurrence(r)).toBe('string');
      expect(typeof describeRule({ rule: r, locale })).toBe('string');
    }
    expect(nextOccurrence({ rule: rule({ unit: 'month' }), after: 'not a date' })).toBe('not a date');
    // A week rule with bad weekdays uses the weekday of the start.
    expect(nextOccurrence({ rule: broken[0]!, after: '2026-10-06' })).toBe('2026-10-13');
  });
});

// ---- Review tests: a second way to find the dates of a rule, with the Date object of JavaScript
// in UTC and with no helper of dates.ts ----

describe('against a search with the JavaScript calendar', () => {
  const DAY = 86_400_000;
  const utc = (date: DateStr): Date => new Date(date + 'T00:00:00Z');
  const text = (d: Date): DateStr => d.toISOString().slice(0, 10);
  const plus = (date: DateStr, days: number): DateStr => text(new Date(utc(date).getTime() + days * DAY));
  const monthLength = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

  /** true if the date is a date of the rule. Each optional field that is absent comes from the start date. */
  function inRule(r: RepeatRule, date: DateStr): boolean {
    if (date < r.start) return false;
    const d = utc(date);
    const s = utc(r.start);
    if (r.unit === 'day') return Math.round((d.getTime() - s.getTime()) / DAY) % r.every === 0;
    if (r.unit === 'week') {
      const mondayOf = (x: Date): number => Math.round(x.getTime() / DAY) - ((x.getUTCDay() + 6) % 7);
      const days = r.weekdays?.length ? r.weekdays : [s.getUTCDay()];
      return days.includes(d.getUTCDay()) && ((mondayOf(d) - mondayOf(s)) / 7) % r.every === 0;
    }
    const [year, month, day] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
    const [startYear, startMonth, startDay] = [s.getUTCFullYear(), s.getUTCMonth() + 1, s.getUTCDate()];
    if (r.unit === 'year') {
      return (year - startYear) % r.every === 0 && month === startMonth && day === Math.min(startDay, monthLength(year, month));
    }
    if (((year - startYear) * 12 + month - startMonth) % r.every !== 0) return false;
    const length = monthLength(year, month);
    if (r.monthMode !== 'weekday') {
      const wanted = r.monthDay ?? startDay;
      return day === (wanted === -1 ? length : Math.min(wanted, length));
    }
    if (d.getUTCDay() !== (r.weekday ?? s.getUTCDay())) return false;
    const ordinal = r.ordinal ?? (startDay > 28 ? -1 : Math.ceil(startDay / 7));
    return ordinal === -1 ? day + 7 > length : Math.ceil(day / 7) === ordinal;
  }

  /** The dates of the rule from `from` to `to`, by a look at each day. */
  function slow(r: RepeatRule, from: DateStr, to: DateStr): DateStr[] {
    const dates: DateStr[] = [];
    for (let date = from; date <= to; date = plus(date, 1)) if (inRule(r, date)) dates.push(date);
    return dates;
  }

  /** The dates that the code gives from the start to `to`. */
  function fast(r: RepeatRule, to: DateStr): DateStr[] {
    const dates: DateStr[] = [];
    for (let date = firstOccurrence(r); date <= to; date = nextOccurrence({ rule: r, after: date })) {
      dates.push(date);
      if (dates.length > 5000) throw new Error('no end');
    }
    return dates;
  }

  function same(r: RepeatRule, to: DateStr): DateStr[] {
    const dates = fast(r, to);
    expect(dates, JSON.stringify(r)).toEqual(slow(r, r.start, to));
    return dates;
  }

  test('month ends: day 31, day 30, day 29, and the last day, over 6 years with a leap year', () => {
    for (const monthDay of [28, 29, 30, 31, -1]) {
      for (const every of [1, 2, 3, 5, 12, 13]) {
        for (const start of ['2023-01-31', '2024-02-29', '2024-02-28', '2023-12-31', '2025-04-30']) {
          same(rule({ unit: 'month', monthMode: 'day', monthDay, every, start }), '2029-01-01');
        }
      }
    }
    expect(same(rule({ unit: 'month', monthMode: 'day', monthDay: 31, start: '2027-12-31' }), '2028-05-01')).toEqual([
      '2027-12-31',
      '2028-01-31',
      '2028-02-29',
      '2028-03-31',
      '2028-04-30',
    ]);
    // The day comes back after a short month: 31, 28, 31. It does not stay at 28.
    expect(fast(rule({ unit: 'month', start: '2026-01-31' }), '2026-04-01')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  });

  test('leap years: 29 February each year, each 4 years, and each 100 years', () => {
    expect(same(rule({ unit: 'year', start: '2024-02-29' }), '2029-01-01')).toEqual(['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
    expect(same(rule({ unit: 'year', every: 4, start: '2096-02-29' }), '2110-01-01')).toEqual(['2096-02-29', '2100-02-28', '2104-02-29', '2108-02-29']);
    expect(same(rule({ unit: 'year', every: 100, start: '1900-02-28' }), '2101-01-01')).toEqual(['1900-02-28', '2000-02-28', '2100-02-28']);
    expect(same(rule({ unit: 'month', monthMode: 'day', monthDay: 29, every: 12, start: '2024-02-29' }), '2029-01-01')).toHaveLength(5);
    // Each day across the end of February in a leap year and in a common year.
    expect(same(rule({ start: '2024-02-27' }), '2024-03-02')).toEqual(['2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01', '2024-03-02']);
    expect(same(rule({ start: '2025-02-27' }), '2025-03-02')).toEqual(['2025-02-27', '2025-02-28', '2025-03-01', '2025-03-02']);
  });

  test('every 2 weeks with several weekdays across a change of the year', () => {
    // 7 December 2026 is a Monday. The weeks of the rule start on 7 and 21 December, and 4 and 18 January.
    const r = rule({ unit: 'week', every: 2, weekdays: [1, 3, 0], start: '2026-12-07' });
    expect(same(r, '2027-01-25')).toEqual([
      '2026-12-07',
      '2026-12-09',
      '2026-12-13',
      '2026-12-21',
      '2026-12-23',
      '2026-12-27',
      '2027-01-04',
      '2027-01-06',
      '2027-01-10',
      '2027-01-18',
      '2027-01-20',
      '2027-01-24',
    ]);
    // A week that has days in two years: Monday 28 December 2026 to Sunday 3 January 2027.
    const across = rule({ unit: 'week', every: 2, weekdays: [1, 4, 6, 0], start: '2026-12-28' });
    expect(same(across, '2027-01-17').slice(0, 6)).toEqual(['2026-12-28', '2026-12-31', '2027-01-02', '2027-01-03', '2027-01-11', '2027-01-14']);
    for (const every of [1, 2, 3, 4, 7, 52, 53]) same(rule({ unit: 'week', every, weekdays: [0, 2, 5], start: '2024-12-30' }), '2031-01-10');
  });

  test('a start in the middle of a week: the days before the start are not dates, and the week still counts', () => {
    // Thursday 8 October 2026, with Monday, Thursday, and Saturday.
    const r = rule({ unit: 'week', every: 2, weekdays: [1, 4, 6], start: '2026-10-08' });
    expect(same(r, '2026-11-08')).toEqual(['2026-10-08', '2026-10-10', '2026-10-19', '2026-10-22', '2026-10-24', '2026-11-02', '2026-11-05', '2026-11-07']);
    // The start is not one of the weekdays: the first date is the next weekday of the same week.
    expect(firstOccurrence(rule({ unit: 'week', every: 3, weekdays: [5], start: '2026-10-07' }))).toBe('2026-10-09');
    // The only weekday of the rule is before the start in its week: the first date is in the next week of the rule.
    expect(firstOccurrence(rule({ unit: 'week', every: 3, weekdays: [1], start: '2026-10-07' }))).toBe('2026-10-26');
    // A start on Sunday is the last day of its week.
    expect(same(rule({ unit: 'week', every: 2, weekdays: [0, 1], start: '2026-10-11' }), '2026-11-09')).toEqual(['2026-10-11', '2026-10-25', '2026-10-19', '2026-11-08', '2026-11-02'].sort());
    for (let offset = 0; offset < 7; offset++) {
      for (const weekdays of [[0], [1], [3], [6], [0, 6], [1, 2, 3, 4, 5], [0, 1, 2, 3, 4, 5, 6]]) {
        for (const every of [1, 2, 3]) same(rule({ unit: 'week', every, weekdays, start: plus('2026-10-05', offset) }), '2027-03-01');
      }
    }
  });

  test('the last Friday and each other ordinal weekday of each month', () => {
    const lastFridays = same(rule({ unit: 'month', monthMode: 'weekday', ordinal: -1, weekday: 5, start: '2026-01-01' }), '2026-12-31');
    expect(lastFridays).toEqual([
      '2026-01-30',
      '2026-02-27',
      '2026-03-27',
      '2026-04-24',
      '2026-05-29',
      '2026-06-26',
      '2026-07-31',
      '2026-08-28',
      '2026-09-25',
      '2026-10-30',
      '2026-11-27',
      '2026-12-25',
    ]);
    for (const date of lastFridays) {
      expect(utc(date).getUTCDay()).toBe(5);
      expect(plus(date, 7).slice(0, 7)).not.toBe(date.slice(0, 7));
    }
    for (const ordinal of [1, 2, 3, 4, -1]) {
      for (let weekday = 0; weekday < 7; weekday++) {
        for (const every of [1, 2, 5]) same(rule({ unit: 'month', monthMode: 'weekday', ordinal, weekday, every, start: '2024-01-17' }), '2028-03-01');
      }
    }
    // With no ordinal and no weekday, they come from the start: 30 October 2026 is the last Friday.
    expect(same(rule({ unit: 'month', monthMode: 'weekday', start: '2026-10-30' }), '2027-01-31')).toEqual(['2026-10-30', '2026-11-27', '2026-12-25', '2027-01-29']);
    // 22 October 2026 is the fourth Thursday, and October has five Thursdays.
    expect(same(rule({ unit: 'month', monthMode: 'weekday', start: '2026-10-22' }), '2026-12-31')).toEqual(['2026-10-22', '2026-11-26', '2026-12-24']);
  });

  test('5000 random rules, with each optional field present or absent', () => {
    let s = 2026;
    const next = (): number => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
    for (let i = 0; i < 5000; i++) {
      const unit = (['day', 'week', 'month', 'year'] as const)[int(0, 3)]!;
      const r = rule({ unit, every: int(1, unit === 'year' ? 4 : 6), start: plus('2023-12-20', int(0, 800)) });
      if (unit === 'week' && next() < 0.9) r.weekdays = [0, 1, 2, 3, 4, 5, 6].filter(() => next() < 0.3);
      if (unit === 'month') {
        const kind = next();
        if (kind < 0.4) {
          r.monthMode = 'day';
          r.monthDay = next() < 0.2 ? -1 : int(1, 31);
        } else if (kind < 0.8) {
          r.monthMode = 'weekday';
          r.ordinal = next() < 0.25 ? -1 : int(1, 4);
          r.weekday = int(0, 6);
        } else if (kind < 0.9) {
          r.monthMode = 'weekday';
        }
      }
      expect(validateRule(r)).toBe(true);
      const after = plus(r.start, int(-30, 1200));
      let expected = after < r.start ? r.start : plus(after, 1);
      while (!inRule(r, expected)) expected = plus(expected, 1);
      const got = nextOccurrence({ rule: r, after });
      if (got !== expected) throw new Error(`${JSON.stringify(r)} after ${after}: got ${got}, expected ${expected}`);
      let first = r.start;
      while (!inRule(r, first)) first = plus(first, 1);
      if (firstOccurrence(r) !== first) throw new Error(`${JSON.stringify(r)}: first date ${firstOccurrence(r)}, expected ${first}`);
    }
  });

  test('each day between two dates of a rule gives the later date', () => {
    const rules = [
      rule({ every: 3, start: '2026-10-01' }),
      rule({ unit: 'week', every: 2, weekdays: [2, 5], start: '2026-10-01' }),
      rule({ unit: 'month', monthMode: 'day', monthDay: 31, start: '2026-10-01' }),
      rule({ unit: 'month', every: 2, monthMode: 'weekday', ordinal: -1, weekday: 5, start: '2026-10-01' }),
      rule({ unit: 'year', start: '2024-02-29' }),
    ];
    for (const r of rules) {
      const dates = fast(r, plus(r.start, 900));
      expect(dates.length).toBeGreaterThan(2);
      for (let i = 0; i + 1 < dates.length; i++) {
        expect(dates[i]! < dates[i + 1]!).toBe(true);
        for (let date = dates[i]!; date < dates[i + 1]!; date = plus(date, 1)) {
          if (nextOccurrence({ rule: r, after: date }) !== dates[i + 1]) throw new Error(`${JSON.stringify(r)} after ${date}`);
        }
      }
      // Each date before the start gives the first date.
      for (const days of [1, 2, 30, 4000]) expect(nextOccurrence({ rule: r, after: plus(r.start, -days) })).toBe(dates[0]);
    }
  });
});

describe('the end of a rule', () => {
  test('an end date: the date itself is a date of the rule, the next date is not', () => {
    const r = rule({ unit: 'week', weekdays: [2], start: '2026-10-06', end: { type: 'on', date: '2026-10-20' } });
    expect(isFinished({ rule: r, doneCount: 1, next: '2026-10-13' })).toBe(false);
    expect(isFinished({ rule: r, doneCount: 2, next: '2026-10-20' })).toBe(false);
    expect(isFinished({ rule: r, doneCount: 3, next: '2026-10-27' })).toBe(true);
    // The count has no effect with an end date, and the date has no effect with an end count.
    expect(isFinished({ rule: r, doneCount: 1000, next: '2026-10-20' })).toBe(false);
    const counted = rule({ end: { type: 'after', count: 3 } });
    expect(isFinished({ rule: counted, doneCount: 2, next: '9999-01-01' })).toBe(false);
    expect(isFinished({ rule: counted, doneCount: 3, next: '2026-10-07' })).toBe(true);
    expect(isFinished({ rule: counted, doneCount: 4, next: '2026-10-07' })).toBe(true);
  });

  test('an end date across a change of the year compares as dates', () => {
    const r = rule({ unit: 'month', monthMode: 'day', monthDay: 31, start: '2026-10-31', end: { type: 'on', date: '2027-01-31' } });
    const dates = [firstOccurrence(r)];
    while (!isFinished({ rule: r, doneCount: dates.length, next: nextOccurrence({ rule: r, after: dates.at(-1)! }) })) {
      dates.push(nextOccurrence({ rule: r, after: dates.at(-1)! }));
    }
    expect(dates).toEqual(['2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31']);
  });

  test('the end is not checked by nextOccurrence and firstOccurrence', () => {
    const r = rule({ start: '2026-10-06', end: { type: 'on', date: '2026-10-01' } });
    expect(firstOccurrence(r)).toBe('2026-10-06');
    expect(nextOccurrence({ rule: r, after: '2026-10-06' })).toBe('2026-10-07');
    expect(nextOccurrence({ rule: rule({ end: { type: 'after', count: 1 } }), after: '2026-10-06' })).toBe('2026-10-07');
  });
});

describe('the rule text for each kind of rule', () => {
  test('the texts of SPEC.md', () => {
    const texts: [Partial<RepeatRule>, string][] = [
      [{ unit: 'day' }, 'Daily'],
      [{ unit: 'day', every: 3 }, 'Every 3 days'],
      [{ unit: 'week', weekdays: [1] }, 'Weekly on Monday'],
      [{ unit: 'week', every: 2, weekdays: [1, 3] }, 'Every 2 weeks on Mon, Wed'],
      [{ unit: 'month', monthMode: 'day', monthDay: 5 }, 'Monthly on day 5'],
      [{ unit: 'month', monthMode: 'day', monthDay: -1 }, 'Monthly on the last day'],
      [{ unit: 'month', monthMode: 'weekday', ordinal: 1, weekday: 1 }, 'Monthly on the first Monday'],
      [{ unit: 'month', monthMode: 'weekday', ordinal: -1, weekday: 5 }, 'Monthly on the last Friday'],
      [{ unit: 'year', start: '2026-10-05' }, 'Yearly on 5 October'],
      [{ unit: 'day', end: { type: 'on', date: '2026-11-04' } }, 'Daily, until 4 Nov'],
      [{ unit: 'day', end: { type: 'after', count: 30 } }, 'Daily, 30 times'],
      [{ unit: 'year', every: 2, start: '2024-02-29' }, 'Every 2 years on 29 February'],
    ];
    for (const [fields, expected] of texts) expect(describeRule({ rule: rule(fields), locale })).toBe(expected);
  });
});
