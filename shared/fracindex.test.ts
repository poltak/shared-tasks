import { describe, expect, test } from 'vitest';
import { keyBetween, keysBetween } from './fracindex.ts';

/** A small random generator with a seed, so that a failure can be repeated. */
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

function expectSortedAndUnique(keys: string[]): void {
  for (let i = 1; i < keys.length; i++) {
    if (!(keys[i - 1]! < keys[i]!)) throw new Error(`not in order at ${i}: ${keys[i - 1]} then ${keys[i]}`);
  }
}

describe('keyBetween', () => {
  // The values of the reference implementation of this scheme.
  const cases: [string | null, string | null, string][] = [
    [null, null, 'a0'],
    [null, 'a0', 'Zz'],
    [null, 'Zz', 'Zy'],
    ['a0', null, 'a1'],
    ['a1', null, 'a2'],
    ['a0', 'a1', 'a0V'],
    ['a1', 'a2', 'a1V'],
    ['a0V', 'a1', 'a0l'],
    ['Zz', 'a0', 'ZzV'],
    ['Zz', 'a1', 'a0'],
    [null, 'Y00', 'Xzzz'],
    ['bzz', null, 'c000'],
    ['a0', 'a0V', 'a0G'],
    ['a0', 'a0G', 'a08'],
    ['b125', 'b129', 'b127'],
    ['a0', 'a1V', 'a1'],
    ['Zz', 'a01', 'a0'],
    [null, 'a0V', 'a0'],
    [null, 'b999', 'b99'],
    ['az', null, 'b00'],
    [null, 'Z0', 'Yzz'],
    [null, 'A000000000000000000000000001', 'A000000000000000000000000000V'],
    ['zzzzzzzzzzzzzzzzzzzzzzzzzzy', null, 'zzzzzzzzzzzzzzzzzzzzzzzzzzz'],
    ['zzzzzzzzzzzzzzzzzzzzzzzzzzz', null, 'zzzzzzzzzzzzzzzzzzzzzzzzzzzV'],
  ];
  test.each(cases)('between %s and %s is %s', (a, b, expected) => {
    expect(keyBetween(a, b)).toBe(expected);
  });

  test.each([
    ['a00', null],
    ['a00', 'a1'],
    ['0', '1'],
    ['', null],
    [null, 'a'],
    [null, 'a0-'],
    [null, 'A00000000000000000000000000'],
    ['a1', 'a0'],
    ['a1', 'a1'],
  ])('throws for %s and %s', (a, b) => {
    expect(() => keyBetween(a, b)).toThrow();
  });
});

describe('keysBetween', () => {
  test('gives the keys of the reference implementation', () => {
    expect(keysBetween(null, null, 5)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4']);
    expect(keysBetween('a4', null, 10)).toEqual(['a5', 'a6', 'a7', 'a8', 'a9', 'aA', 'aB', 'aC', 'aD', 'aE']);
    expect(keysBetween(null, 'a0', 5)).toEqual(['Zv', 'Zw', 'Zx', 'Zy', 'Zz']);
    expect(keysBetween('a0', 'a2', 3)).toEqual(['a0V', 'a1', 'a1V']);
    expect(keysBetween('a0', 'a2', 20).join(' ')).toBe(
      'a04 a08 a0G a0K a0O a0V a0Z a0d a0l a0t a1 a14 a18 a1G a1O a1V a1Z a1d a1l a1t',
    );
  });

  test('gives no key for a count of zero and one key for one', () => {
    expect(keysBetween('a0', 'a1', 0)).toEqual([]);
    expect(keysBetween('a0', 'a1', 1)).toEqual(['a0V']);
  });

  test('keeps many keys in order and in the gap', () => {
    const gaps: [string | null, string | null][] = [
      [null, null],
      ['a0', null],
      [null, 'a0'],
      ['a0', 'a1'],
      ['a0', 'a0V'],
      ['Zz', 'a0'],
    ];
    for (const [a, b] of gaps) {
      const keys = keysBetween(a, b, 500);
      expect(keys).toHaveLength(500);
      expectSortedAndUnique([...(a === null ? [] : [a]), ...keys, ...(b === null ? [] : [b])]);
    }
  });

  test('keeps keys short when a gap gets many keys at one time', () => {
    const keys = keysBetween('a0', 'a1', 1000);
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThanOrEqual(5);
  });
});

describe('repeated inserts', () => {
  test('5000 inserts at random places keep the order and give no equal keys', () => {
    for (const seed of [1, 2, 3]) {
      const next = random(seed);
      const keys: string[] = [];
      for (let i = 0; i < 5000; i++) {
        const at = Math.floor(next() * (keys.length + 1));
        const before = keys[at - 1] ?? null;
        const after = keys[at] ?? null;
        const key = keyBetween(before, after);
        if (before !== null && !(before < key)) throw new Error(`${key} is not after ${before}`);
        if (after !== null && !(key < after)) throw new Error(`${key} is not before ${after}`);
        keys.splice(at, 0, key);
      }
      expectSortedAndUnique(keys);
      expect(new Set(keys).size).toBe(5000);
      // Random places halve a gap only now and then, so the keys stay short.
      expect(Math.max(...keys.map((k) => k.length))).toBeLessThanOrEqual(12);
    }
  });

  test('random groups of keys keep the order', () => {
    const next = random(7);
    let keys: string[] = [];
    for (let i = 0; i < 400; i++) {
      const at = Math.floor(next() * (keys.length + 1));
      const group = keysBetween(keys[at - 1] ?? null, keys[at] ?? null, 1 + Math.floor(next() * 6));
      keys = [...keys.slice(0, at), ...group, ...keys.slice(at)];
    }
    expectSortedAndUnique(keys);
  });

  test('3000 inserts at the end keep keys short', () => {
    let key: string | null = null;
    const keys: string[] = [];
    for (let i = 0; i < 3000; i++) keys.push((key = keyBetween(key, null)));
    expectSortedAndUnique(keys);
    expect(key!.length).toBeLessThanOrEqual(3);
  });

  test('3000 inserts at the start keep keys short', () => {
    let key: string | null = null;
    const keys: string[] = [];
    for (let i = 0; i < 3000; i++) keys.unshift((key = keyBetween(null, key)));
    expectSortedAndUnique(keys);
    expect(key!.length).toBeLessThanOrEqual(3);
  });

  test('inserts between the same two neighbours grow a key by one character for about 6 inserts', () => {
    // Each insert halves the gap, and one base-62 digit holds almost 6 halvings. No scheme with
    // fixed keys can do better for this worst case.
    for (const side of ['low', 'high'] as const) {
      let low = 'a0';
      let high = 'a1';
      const keys: string[] = [];
      for (let i = 0; i < 1000; i++) {
        const key = keyBetween(low, high);
        expect(low < key && key < high).toBe(true);
        keys.push(key);
        if (side === 'low') high = key;
        else low = key;
      }
      expect(new Set(keys).size).toBe(1000);
      expect(keys[29]!.length).toBeLessThanOrEqual(8);
      expect(keys[999]!.length).toBeLessThanOrEqual(2 + Math.ceil(1000 / 5));
    }
  });

  test('a new row below the last new row, 200 times, keeps keys short', () => {
    // The pattern of "Enter opens a new row below": each key goes after the key before it.
    let low = 'a0';
    for (let i = 0; i < 200; i++) low = keyBetween(low, 'a1');
    expect(low.length).toBeLessThanOrEqual(2 + Math.ceil(200 / 5));
  });
});

// ---- Review tests ----

describe('5000 inserts at one place', () => {
  /** The largest key that the server accepts (POS_MAX in server/sync.ts). */
  const SERVER_LIMIT = 1024;
  const KEY = /^[A-Za-z][0-9A-Za-z]*$/;

  function check(keys: string[]): void {
    expectSortedAndUnique(keys);
    for (const key of keys) {
      if (!KEY.test(key)) throw new Error(`not a key: ${key}`);
      // A key that the code gives must be a legal input for the next call.
      keyBetween(key, null);
      keyBetween(null, key);
    }
  }

  test('directly after one row: each new key goes between the row and the key before', () => {
    const keys = ['a0', 'a1'];
    for (let i = 0; i < 5000; i++) keys.splice(1, 0, keyBetween('a0', keys[1]!));
    check(keys);
    const longest = Math.max(...keys.map((key) => key.length));
    // One character for almost 6 inserts. The actions give new keys to all siblings long before
    // this length (see `place` in actions.ts), and the server accepts this length too.
    expect(longest).toBeLessThanOrEqual(2 + Math.ceil(5000 / 5.9));
    expect(longest).toBeLessThan(SERVER_LIMIT);
  });

  test('directly before one row: each new key goes between the key before and the row', () => {
    const keys = ['a0', 'a1'];
    for (let i = 0; i < 5000; i++) keys.splice(keys.length - 1, 0, keyBetween(keys[keys.length - 2]!, 'a1'));
    check(keys);
    const longest = Math.max(...keys.map((key) => key.length));
    // In this direction the scheme needs one character for 5 inserts: 1002 characters after 5000
    // inserts. That is near the limit of the server, so the actions must keep keys short. They
    // do: see "many tasks at one place" in actions.test.ts.
    expect(longest).toBeLessThanOrEqual(2 + 5000 / 5);
    expect(longest).toBeLessThan(SERVER_LIMIT);
  });

  test('into the middle of the gap, with the side by turns', () => {
    let low = 'a0';
    let high = 'a1';
    const made: string[] = [];
    for (let i = 0; i < 5000; i++) {
      const key = keyBetween(low, high);
      made.push(key);
      if (i % 2) low = key;
      else high = key;
    }
    expect(new Set(made).size).toBe(5000);
    check([...made].sort());
    expect(Math.max(...made.map((key) => key.length))).toBeLessThan(SERVER_LIMIT);
  });

  test('at the top and at the end of a list, the keys stay very short', () => {
    let top: string | null = null;
    let end: string | null = null;
    const keys: string[] = [];
    for (let i = 0; i < 5000; i++) {
      keys.unshift((top = keyBetween(null, top)));
      keys.push((end = keyBetween(end ?? top, null)));
    }
    check(keys);
    expect(Math.max(...keys.map((key) => key.length))).toBeLessThanOrEqual(4);
  });

  test('the keys of a group that goes into a gap of long keys stay in the gap', () => {
    let low = 'a0';
    for (let i = 0; i < 300; i++) low = keyBetween(low, 'a1');
    const high = keyBetween(low, 'a1');
    const group = keysBetween(low, high, 50);
    check([low, ...group, high]);
  });

  test('far from the middle of the key space', () => {
    // An integer part far below zero, and the largest integer part that the scheme has.
    const low = 'B' + '0'.repeat(24) + '1';
    const below = keyBetween(null, low);
    expect(below < low).toBe(true);
    expect(keyBetween(below, low) > below).toBe(true);
    const largest = 'z' + 'z'.repeat(26);
    const above = keyBetween(largest, null);
    expect(above > largest).toBe(true);
    expect(keyBetween(above, null) > above).toBe(true);
    check([keyBetween(null, below), below, low, largest, above, keyBetween(above, null)]);
  });
});

describe('keys in the plain string order of JavaScript', () => {
  test('the order of keys is the order of their UTF-16 code units, as SQLite and the sort of the view use it', () => {
    const next = random(11);
    const keys: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const at = Math.floor(next() * (keys.length + 1));
      keys.splice(at, 0, keyBetween(keys[at - 1] ?? null, keys[at] ?? null));
    }
    // The default sort of JavaScript compares code units. localeCompare would give a different order.
    expect([...keys].sort()).toEqual(keys);
    expect([...keys].reverse().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(keys);
  });
});
