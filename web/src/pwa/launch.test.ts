import { afterEach, expect, test, vi } from 'vitest';
import { readLaunchParams } from './launch.ts';

function open(address: string) {
  const replaceState = vi.fn();
  vi.stubGlobal('location', new URL(address, 'https://tasks.test'));
  vi.stubGlobal('history', { state: { page: 1 }, replaceState });
  return replaceState;
}

const NONE = { taskId: null, listId: null, newTask: false, noteId: null, newNote: false };

afterEach(() => vi.unstubAllGlobals());

test('reads the task, the list, and the new task flag', () => {
  open('/?task=t1&list=l1&new=1');
  expect(readLaunchParams()).toEqual({ ...NONE, taskId: 't1', listId: 'l1', newTask: true });
});

test('reads a note, and new=note asks for a new note and not a new task', () => {
  open('/?note=n1');
  expect(readLaunchParams()).toEqual({ ...NONE, noteId: 'n1' });
  open('/?new=note');
  expect(readLaunchParams()).toEqual({ ...NONE, newNote: true });
});

test('removes only its own values from the address and keeps the history state', () => {
  const replaceState = open('/some/page?task=t1&keep=yes&new=1#part');
  readLaunchParams();
  expect(replaceState).toHaveBeenCalledExactlyOnceWith({ page: 1 }, '', '/some/page?keep=yes#part');
});

test('removes the note from the address, so a reload does not open it again', () => {
  const replaceState = open('/?note=n1&keep=yes');
  readLaunchParams();
  expect(replaceState).toHaveBeenCalledExactlyOnceWith({ page: 1 }, '', '/?keep=yes');
});

test('gives empty values and does not change the address when there is nothing to read', () => {
  const replaceState = open('/?keep=yes');
  expect(readLaunchParams()).toEqual(NONE);
  expect(replaceState).not.toHaveBeenCalled();
});

test('an empty value is no value, and only new=1 and new=note open something new', () => {
  const replaceState = open('/?task=&note=&new=0');
  expect(readLaunchParams()).toEqual(NONE);
  expect(replaceState).toHaveBeenCalledExactlyOnceWith({ page: 1 }, '', '/');
  open('/?new=Note');
  expect(readLaunchParams()).toEqual(NONE);
});
