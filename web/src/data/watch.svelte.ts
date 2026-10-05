// For tests: a reader that runs in an effect, as a component does.
import { flushSync } from 'svelte';

export interface Watch<T> {
  /** How many times the reader ran. */
  runs: number;
  /** The last value of the reader. */
  value: T;
  stop(): void;
}

export function watch<T>(read: () => T): Watch<T> {
  const seen: Watch<T> = { runs: 0, value: undefined as T, stop: () => undefined };
  seen.stop = $effect.root(() => {
    $effect(() => {
      seen.value = read();
      seen.runs += 1;
    });
  });
  flushSync();
  return seen;
}

/**
 * true if runes are live in this process.
 *
 * The compiler has two outputs. The output for a server has plain variables in place of runes
 * and no effects. Vitest uses it in the Node.js environment, unless its config asks for the
 * output for a browser. A test that counts the runs of readers needs the output for a browser.
 */
export const reactive: boolean = watch(() => 0).runs === 1;

export { flushSync };
