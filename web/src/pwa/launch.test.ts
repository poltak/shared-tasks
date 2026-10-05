import { afterEach, expect, test, vi } from 'vitest';
import { readLaunchParams } from './launch.ts';

function open(address: string) {
  const replaceState = vi.fn();
  vi.stubGlobal('location', new URL(address, 'https://tasks.test'));
  vi.stubGlobal('history', { state: { page: 1 }, replaceState });
  return replaceState;
}

afterEach(() => vi.unstubAllGlobals());

test('reads the task, the list, and the new task flag', () => {
  open('/?task=t1&list=l1&new=1');
  expect(readLaunchParams()).toEqual({ taskId: 't1', listId: 'l1', newTask: true });
});

test('removes only its own values from the address and keeps the history state', () => {
  const replaceState = open('/some/page?task=t1&keep=yes&new=1#part');
  readLaunchParams();
  expect(replaceState).toHaveBeenCalledExactlyOnceWith({ page: 1 }, '', '/some/page?keep=yes#part');
});

test('gives empty values and does not change the address when there is nothing to read', () => {
  const replaceState = open('/?keep=yes');
  expect(readLaunchParams()).toEqual({ taskId: null, listId: null, newTask: false });
  expect(replaceState).not.toHaveBeenCalled();
});

test('an empty value is no value, and only new=1 opens a new task', () => {
  const replaceState = open('/?task=&new=0');
  expect(readLaunchParams()).toEqual({ taskId: null, listId: null, newTask: false });
  expect(replaceState).toHaveBeenCalledExactlyOnceWith({ page: 1 }, '', '/');
});
