import type { HLC } from './types.ts';

// A timestamp is 9 base-36 digits of milliseconds, 3 base-36 digits of a counter, and 6 characters
// of the node id. The width is fixed, so a string comparison gives the time order.
const MS_WIDTH = 9;
const COUNTER_WIDTH = 3;
const NODE_WIDTH = 6;
const COUNTER_MAX = 36 ** COUNTER_WIDTH - 1;

export interface Clock {
  ms: number;
  counter: number;
  node: string;
}

export function makeClock(node: string): Clock {
  const clean = node.toLowerCase().replace(/[^0-9a-z]/g, '');
  return { ms: 0, counter: 0, node: clean.slice(0, NODE_WIDTH).padEnd(NODE_WIDTH, '0') };
}

export function encode(clock: Clock): HLC {
  return (
    clock.ms.toString(36).padStart(MS_WIDTH, '0') +
    clock.counter.toString(36).padStart(COUNTER_WIDTH, '0') +
    clock.node
  );
}

export function decode(ts: HLC): Clock {
  return {
    ms: parseInt(ts.slice(0, MS_WIDTH), 36),
    counter: parseInt(ts.slice(MS_WIDTH, MS_WIDTH + COUNTER_WIDTH), 36),
    node: ts.slice(MS_WIDTH + COUNTER_WIDTH),
  };
}

export function isValid(ts: unknown): ts is HLC {
  return typeof ts === 'string' && /^[0-9a-z]{18}$/.test(ts);
}

/** Gives the next timestamp for a local change and moves the clock forward. */
export function tick(clock: Clock, nowMs: number): HLC {
  if (nowMs > clock.ms) {
    clock.ms = nowMs;
    clock.counter = 0;
  } else if (clock.counter < COUNTER_MAX) {
    clock.counter += 1;
  } else {
    clock.ms += 1;
    clock.counter = 0;
  }
  return encode(clock);
}

/** Moves the clock past a timestamp that came from a different device. */
export function observe(clock: Clock, ts: HLC): void {
  const seen = decode(ts);
  if (seen.ms > clock.ms || (seen.ms === clock.ms && seen.counter > clock.counter)) {
    clock.ms = seen.ms;
    clock.counter = seen.counter;
  }
}

/** A timestamp too far in the future would win each merge for a long time, so the server limits it. */
export function clamp(ts: HLC, maxMs: number): HLC {
  const c = decode(ts);
  if (c.ms <= maxMs) return ts;
  return encode({ ms: maxMs, counter: COUNTER_MAX, node: c.node });
}
