import { expect, it } from 'vitest';
import * as data from './index.ts';

it('exports the names of SPEC.md section 7, and no other name', () => {
  expect(Object.keys(data).sort()).toEqual(
    [
      'actions', 'canUndo', 'changePassword', 'getList', 'getTask', 'listView', 'listsOrdered', 'login', 'logout',
      'otherUser', 'prefs', 'push', 'register', 'rename', 'session', 'starredView', 'store', 'subtasksOf', 'sync',
      'toast', 'undo',
    ],
  );
});

it('can be imported with no browser, and does not start there', async () => {
  expect(data.session.status).toBe('loading');
  expect(data.session.me).toBeNull();
  expect(data.listsOrdered()).toEqual([]);
  expect(data.listView('no-list')).toEqual({ groups: [], completed: [], openCount: 0 });
  expect(data.starredView().openCount).toBe(0);
  expect(data.getTask('x')).toBeUndefined();
  expect(data.subtasksOf('x')).toEqual([]);
  expect(data.canUndo()).toBe(false);
  expect(data.undo()).toBe(false);
  expect(data.push.supported).toBe(false);
  expect(data.sync.pending).toBe(0);
  expect(data.prefs.theme).toBe('system');
  expect(data.toast.current).toBeNull();
  expect(data.actions.createTask({ listId: 'no-list', title: 'x' }).puts).toEqual([]);
  expect(await data.sync.now()).toBe(false);
  expect(typeof data.store.today).toBe('string');
});
