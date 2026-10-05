// Order keys by fractional indexing with base-62 digits (the scheme of David Greenspan,
// "Implementing Fractional Indexing"). A key is an integer part and an optional fraction part.
// The first character of the integer part gives its length: 'a' is 2 characters, 'b' is 3, and
// 'Z' is 2 characters below zero, 'Y' is 3. So a plain string comparison gives the order, and
// keys at the two ends of a list grow by one character only after 62, 62 * 62, ... inserts.

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;
const ZERO = '0';
const LAST = 'z';
/** No key can be before this one, so it is not a legal key. */
const SMALLEST = 'A' + ZERO.repeat(26);

function digitAt(text: string, index: number): number {
  const code = text.charCodeAt(index);
  if (code >= 97) return code - 61;
  if (code >= 65) return code - 55;
  return code - 48;
}

/** A fraction between the fractions a and b. For a, '' is zero. For b, null is one. a < b. */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    // b can be longer than a in the common prefix, so a gets zeros at its end.
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? digitAt(a, 0) : 0;
  const digitB = b !== null ? digitAt(b, 0) : BASE;
  if (digitB - digitA > 1) return DIGITS.charAt(Math.round((digitA + digitB) / 2));
  // The first digits are neighbours. If b has more digits, its first digit alone is between.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS.charAt(digitA) + midpoint(a.slice(1), null);
}

function integerLength(key: string): number {
  const code = key.charCodeAt(0);
  if (code >= 97 && code <= 122) return code - 95;
  if (code >= 65 && code <= 90) return 92 - code;
  throw new Error(`invalid order key: ${key}`);
}

function check(key: string): void {
  const length = /^[0-9A-Za-z]+$/.test(key) ? integerLength(key) : Infinity;
  // A fraction that ends in zero has a shorter form, and two forms of one value would break the order.
  if (key.length < length || key === SMALLEST || (key.length > length && key.endsWith(ZERO))) {
    throw new Error(`invalid order key: ${key}`);
  }
}

/** The next integer part, or null after the largest one. */
function increment(integer: string): string | null {
  const head = integer.charAt(0);
  const digits = integer.slice(1).split('');
  let i = digits.length - 1;
  for (; i >= 0; i--) {
    const d = digitAt(digits[i]!, 0) + 1;
    if (d < BASE) {
      digits[i] = DIGITS.charAt(d);
      break;
    }
    digits[i] = ZERO;
  }
  if (i >= 0) return head + digits.join('');
  if (head === 'Z') return 'a' + ZERO;
  if (head === 'z') return null;
  // The next head has one more digit above zero, and one fewer below zero.
  const next = String.fromCharCode(head.charCodeAt(0) + 1);
  if (next > 'a') digits.push(ZERO);
  else digits.pop();
  return next + digits.join('');
}

/** The integer part before, or null before the smallest one. */
function decrement(integer: string): string | null {
  const head = integer.charAt(0);
  const digits = integer.slice(1).split('');
  let i = digits.length - 1;
  for (; i >= 0; i--) {
    const d = digitAt(digits[i]!, 0) - 1;
    if (d >= 0) {
      digits[i] = DIGITS.charAt(d);
      break;
    }
    digits[i] = LAST;
  }
  if (i >= 0) return head + digits.join('');
  if (head === 'a') return 'Z' + LAST;
  if (head === 'A') return null;
  const next = String.fromCharCode(head.charCodeAt(0) - 1);
  if (next < 'Z') digits.push(LAST);
  else digits.pop();
  return next + digits.join('');
}

/**
 * A key that sorts after a and before b. null for a is the start, null for b is the end.
 * Throws if a key is not legal or if a is not before b.
 */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null) check(a);
  if (b !== null) check(b);
  if (a !== null && b !== null && a >= b) throw new Error(`order keys are not in order: ${a} >= ${b}`);

  if (a === null) {
    if (b === null) return 'a' + ZERO;
    const intB = b.slice(0, integerLength(b));
    if (intB === SMALLEST) return intB + midpoint('', b.slice(intB.length));
    if (intB < b) return intB;
    return decrement(intB)!;
  }

  const intA = a.slice(0, integerLength(a));
  const fracA = a.slice(intA.length);
  if (b === null) return increment(intA) ?? intA + midpoint(fracA, null);

  const intB = b.slice(0, integerLength(b));
  if (intA === intB) return intA + midpoint(fracA, b.slice(intB.length));
  const next = increment(intA)!;
  return next < b ? next : intA + midpoint(fracA, null);
}

/** n keys in order, all after a and before b. */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  const keys: string[] = [];
  if (b === null) {
    let key = a;
    for (let i = 0; i < n; i++) keys.push((key = keyBetween(key, null)));
    return keys;
  }
  if (a === null) {
    let key = b;
    for (let i = 0; i < n; i++) keys.push((key = keyBetween(null, key)));
    return keys.reverse();
  }
  // Halve the gap each time, so the keys stay short.
  const half = Math.floor(n / 2);
  const middle = keyBetween(a, b);
  return [...keysBetween(a, middle, half), middle, ...keysBetween(middle, b, n - half - 1)];
}
