import { describe, expect, test } from 'vitest';
import type { ListRow, NoteRow, Put, RepeatRule, TaskRow } from './types.ts';
import { applyPut, applyPuts, defaultList, defaultNote, defaultTask, emptyRows } from './merge.ts';

const rule: RepeatRule = { every: 1, unit: 'day', start: '2026-10-06', end: { type: 'never' } };

describe('defaults', () => {
  test('emptyRows gives new empty maps each time', () => {
    const a = emptyRows();
    const b = emptyRows();
    expect(a.lists.size).toBe(0);
    expect(a.tasks.size).toBe(0);
    expect(a.notes.size).toBe(0);
    expect(a.lists).not.toBe(b.lists);
    expect(a.tasks).not.toBe(b.tasks);
    expect(a.notes).not.toBe(b.notes);
  });

  test('defaultList has each field of a list', () => {
    const expected: ListRow = {
      id: 'l1', title: '', owner: '', shared: false, isDefault: false, createdAt: 0, deleted: false,
      pos: null, sort: 'my', hidden: false,
    };
    expect(defaultList('l1')).toEqual(expected);
    expect(defaultList('l1')).not.toBe(defaultList('l1'));
  });

  test('defaultTask has each field of a task', () => {
    const expected: TaskRow = {
      id: 't1', listId: '', parentId: null, title: '', notes: '', pos: 'a0', due: null, time: null,
      deadline: null, repeat: null, repeatCount: 0, hiddenUntil: null, lastDoneAt: null, lastDoneDue: null,
      completed: false, completedAt: null, completedBy: null, createdAt: 0, createdBy: '', deleted: false,
      starred: false, starredAt: null,
    };
    expect(defaultTask('t1')).toEqual(expected);
  });

  test('defaultNote has each field of a note', () => {
    const expected: NoteRow = {
      id: 'n1', title: '', body: '', color: 'default', shared: false, editedAt: 0, editedBy: null, deleted: false,
      owner: '', createdAt: 0, pinned: false, archived: false,
    };
    expect(defaultNote('n1')).toEqual(expected);
    expect(defaultNote('n1')).not.toBe(defaultNote('n1'));
  });
});

describe('applyPut', () => {
  test('makes a task from the default row and the fields', () => {
    const rows = emptyRows();
    const row = applyPut(rows, { kind: 'task', id: 't1', fields: { listId: 'l1', title: 'Milk', pos: 'a5' } });
    expect(row).toEqual({ ...defaultTask('t1'), listId: 'l1', title: 'Milk', pos: 'a5' });
    expect(rows.tasks.get('t1')).toBe(row);
    expect(rows.lists.size).toBe(0);
  });

  test('makes a list from the default row and the fields', () => {
    const rows = emptyRows();
    const row = applyPut(rows, { kind: 'list', id: 'l1', fields: { title: 'Home', owner: 'u1', pos: 'a0' } });
    expect(row).toEqual({ ...defaultList('l1'), title: 'Home', owner: 'u1', pos: 'a0' });
    expect(rows.lists.get('l1')).toBe(row);
    expect(rows.tasks.size).toBe(0);
  });

  test('a put with only the list of a task, or only the title of a list, makes the row with defaults', () => {
    const rows = emptyRows();
    expect(applyPut(rows, { kind: 'task', id: 't1', fields: { listId: 'l1' } })).toEqual({ ...defaultTask('t1'), listId: 'l1' });
    expect(applyPut(rows, { kind: 'list', id: 'l1', fields: { title: '' } })).toEqual(defaultList('l1'));
    expect(rows.tasks.size + rows.lists.size).toBe(2);
  });

  test('a put that cannot make a row gives null for a row that is not there, and makes no row', () => {
    const rows = emptyRows();
    // An undo, or an op from the outbox, for a row that the device dropped after a sync.
    expect(applyPut(rows, { kind: 'task', id: 't1', fields: {} })).toBeNull();
    expect(applyPut(rows, { kind: 'task', id: 't1', fields: { title: 'Milk', completed: false, pos: 'a1' } })).toBeNull();
    expect(applyPut(rows, { kind: 'task', id: 't1', fields: { deleted: true } })).toBeNull();
    expect(applyPut(rows, { kind: 'list', id: 'l1', fields: { pos: 'a3', sort: 'date', hidden: false } })).toBeNull();
    expect(applyPut(rows, { kind: 'list', id: 'l1', fields: { deleted: false, shared: true } })).toBeNull();
    expect(applyPut(rows, { kind: 'task', id: 't1', fields: { listId: undefined, title: 'x' } })).toBeNull();
    expect(rows.tasks.size + rows.lists.size).toBe(0);
    applyPuts(rows, [
      { kind: 'task', id: 't1', fields: { title: 'late' } },
      { kind: 'list', id: 'l1', fields: { pos: 'a0' } },
    ]);
    expect(rows.tasks.size + rows.lists.size).toBe(0);
    // The same puts change a row that is there.
    applyPut(rows, { kind: 'task', id: 't1', fields: { listId: 'l1', title: 'Milk' } });
    expect(applyPut(rows, { kind: 'task', id: 't1', fields: { title: 'late' } })).toMatchObject({ listId: 'l1', title: 'late' });
  });

  test('a put with all fields makes a row again after the device dropped it: the undo of a deletion', () => {
    const rows = emptyRows();
    const { id: _, ...task } = { ...defaultTask('t1'), listId: 'l1', title: 'Milk', starred: true, starredAt: 5 };
    const { id: __, ...list } = { ...defaultList('l1'), title: 'Home', owner: 'u1', pos: 'a2' };
    expect(applyPut(rows, { kind: 'task', id: 't1', fields: task })).toEqual({ id: 't1', ...task });
    expect(applyPut(rows, { kind: 'list', id: 'l1', fields: list })).toEqual({ id: 'l1', ...list });
  });

  test('a change gives a new object and does not touch the old object', () => {
    const rows = emptyRows();
    const first = applyPut(rows, { kind: 'task', id: 't1', fields: { title: 'Milk', listId: 'l1' } });
    const copy = structuredClone(first);
    const second = applyPut(rows, { kind: 'task', id: 't1', fields: { title: 'Oat milk', starred: true } })!;
    expect(second).not.toBe(first);
    expect(first).toEqual(copy);
    expect(second).toEqual({ ...copy, title: 'Oat milk', starred: true });
    expect(rows.tasks.get('t1')).toBe(second);
    expect(rows.tasks.size).toBe(1);
  });

  test('changes only the fields of the put', () => {
    const rows = emptyRows();
    applyPut(rows, { kind: 'task', id: 't1', fields: { listId: 'l1', title: 'Milk', due: '2026-10-06', time: '09:00' } });
    const row = applyPut(rows, { kind: 'task', id: 't1', fields: { due: null } })!;
    expect(row.title).toBe('Milk');
    expect(row.due).toBeNull();
    expect(row.time).toBe('09:00');
  });

  test('a put that changes no value keeps the object', () => {
    const rows = emptyRows();
    const first = applyPut(rows, { kind: 'task', id: 't1', fields: { listId: 'l1', title: 'Milk', repeat: rule } });
    expect(first).not.toBeNull();
    const second = applyPut(rows, { kind: 'task', id: 't1', fields: { title: 'Milk', repeat: structuredClone(rule), due: null } });
    expect(second).toBe(first);
    const list = applyPut(rows, { kind: 'list', id: 'l1', fields: { title: 'Home' } });
    expect(applyPut(rows, { kind: 'list', id: 'l1', fields: { title: 'Home', pos: null } })).toBe(list);
  });

  test('a different repeat rule is a change', () => {
    const rows = emptyRows();
    const first = applyPut(rows, { kind: 'task', id: 't1', fields: { listId: 'l1', repeat: rule } });
    const second = applyPut(rows, { kind: 'task', id: 't1', fields: { repeat: { ...rule, every: 2 } } })!;
    expect(second).not.toBe(first);
    expect(second.repeat?.every).toBe(2);
    expect(applyPut(rows, { kind: 'task', id: 't1', fields: { repeat: null } })!.repeat).toBeNull();
  });

  test('ignores undefined values, the id, and unknown fields', () => {
    const rows = emptyRows();
    const first = applyPut(rows, { kind: 'task', id: 't1', fields: { listId: 'l1', title: 'Milk' } })!;
    const fields = { title: undefined, id: 'other', extra: 1 } as unknown as Put['fields'];
    const second = applyPut(rows, { kind: 'task', id: 't1', fields } as Put);
    expect(second).toBe(first);
    expect(rows.tasks.has('other')).toBe(false);
    expect('extra' in first).toBe(false);
  });

  test('deleted is a field like the others', () => {
    const rows = emptyRows();
    applyPut(rows, { kind: 'list', id: 'l1', fields: { title: 'Home' } });
    expect(applyPut(rows, { kind: 'list', id: 'l1', fields: { deleted: true } })!.deleted).toBe(true);
    expect(rows.lists.size).toBe(1);
    expect(applyPut(rows, { kind: 'list', id: 'l1', fields: { deleted: false } })!.deleted).toBe(false);
  });

  test('a task and a list can have the same id', () => {
    const rows = emptyRows();
    applyPut(rows, { kind: 'list', id: 'x', fields: { title: 'List' } });
    applyPut(rows, { kind: 'task', id: 'x', fields: { listId: 'x', title: 'Task' } });
    expect(rows.lists.get('x')?.title).toBe('List');
    expect(rows.tasks.get('x')?.title).toBe('Task');
  });
});

describe('applyPuts', () => {
  test('applies the puts in order', () => {
    const rows = emptyRows();
    applyPuts(rows, [
      { kind: 'list', id: 'l1', fields: { title: 'Home' } },
      { kind: 'task', id: 't1', fields: { listId: 'l1', title: 'A' } },
      { kind: 'task', id: 't2', fields: { listId: 'l1', title: 'B' } },
      { kind: 'task', id: 't1', fields: { title: 'A2' } },
    ]);
    expect(rows.lists.get('l1')?.title).toBe('Home');
    expect(rows.tasks.get('t1')?.title).toBe('A2');
    expect(rows.tasks.get('t2')?.title).toBe('B');
    expect([...rows.tasks.keys()]).toEqual(['t1', 't2']);
  });

  test('does nothing for no puts', () => {
    const rows = emptyRows();
    applyPuts(rows, []);
    expect(rows.tasks.size + rows.lists.size).toBe(0);
  });
});

describe('applyPut for a note', () => {
  const made = { title: 'Ideas', body: 'One\nTwo', owner: 'u1', createdAt: 5, editedAt: 5, editedBy: 'u1' };

  test('makes a note from the default row and the fields when the put has the creation time', () => {
    const rows = emptyRows();
    const row = applyPut(rows, { kind: 'note', id: 'n1', fields: made });
    expect(row).toEqual({ ...defaultNote('n1'), ...made });
    expect(rows.notes.get('n1')).toBe(row);
    expect(rows.lists.size + rows.tasks.size).toBe(0);
    expect(applyPut(rows, { kind: 'note', id: 'n2', fields: { createdAt: 7 } })).toEqual({ ...defaultNote('n2'), createdAt: 7 });
    // An empty title is a title like the others.
    expect(applyPut(rows, { kind: 'note', id: 'n3', fields: { title: '', body: 'x', createdAt: 8 } })?.title).toBe('');
  });

  test('a put with no creation time makes no note: a late key in the editor for a note that the device dropped', () => {
    const rows = emptyRows();
    const late: Put[] = [
      { kind: 'note', id: 'n1', fields: { title: '' } },
      { kind: 'note', id: 'n1', fields: { title: 'Milk', editedAt: 9, editedBy: 'u2' } },
      { kind: 'note', id: 'n1', fields: { body: 'x' } },
      { kind: 'note', id: 'n1', fields: { pinned: true, archived: false } },
      { kind: 'note', id: 'n1', fields: { color: 'red' } },
      { kind: 'note', id: 'n1', fields: { deleted: true } },
      { kind: 'note', id: 'n1', fields: { shared: false } },
      { kind: 'note', id: 'n1', fields: { createdAt: undefined, title: 'x' } },
      // A put with all other fields, as an undo of a change of many fields can be.
      { kind: 'note', id: 'n1', fields: { title: 'a', body: 'b', color: 'red', shared: true, editedAt: 1, editedBy: 'u1', deleted: false, owner: 'u1', pinned: true, archived: false } },
    ];
    for (const put of late) expect(applyPut(rows, put)).toBeNull();
    applyPuts(rows, late);
    expect(rows.notes.size).toBe(0);
    // The same puts change a note that is there.
    applyPut(rows, { kind: 'note', id: 'n1', fields: made });
    expect(applyPut(rows, { kind: 'note', id: 'n1', fields: { title: 'late' } })).toMatchObject({ title: 'late', body: 'One\nTwo' });
  });

  test('the undo of a delete makes the note again after the device dropped it, because it has all fields', () => {
    const rows = emptyRows();
    const { id: _, ...all } = { ...defaultNote('n1'), ...made, color: 'teal' as const, shared: true, pinned: true };
    expect(applyPut(rows, { kind: 'note', id: 'n1', fields: all })).toEqual({ id: 'n1', ...all });
  });

  test('a change gives a new object, and a put that changes no value keeps the object', () => {
    const rows = emptyRows();
    const first = applyPut(rows, { kind: 'note', id: 'n1', fields: made })!;
    const copy = structuredClone(first);
    const second = applyPut(rows, { kind: 'note', id: 'n1', fields: { color: 'yellow', archived: true } })!;
    expect(second).not.toBe(first);
    expect(first).toEqual(copy);
    expect(second).toEqual({ ...copy, color: 'yellow', archived: true });
    expect(applyPut(rows, { kind: 'note', id: 'n1', fields: { color: 'yellow', title: 'Ideas', editedBy: 'u1' } })).toBe(second);
  });

  test('ignores undefined values, the id, and unknown fields', () => {
    const rows = emptyRows();
    const first = applyPut(rows, { kind: 'note', id: 'n1', fields: made })!;
    const fields = { title: undefined, id: 'other', pos: 'a0', listId: 'l1' } as unknown as Put['fields'];
    expect(applyPut(rows, { kind: 'note', id: 'n1', fields } as Put)).toBe(first);
    expect('pos' in first).toBe(false);
    expect(rows.notes.has('other')).toBe(false);
    expect(rows.tasks.size).toBe(0);
  });

  test('a list, a task, and a note can have the same id', () => {
    const rows = emptyRows();
    applyPuts(rows, [
      { kind: 'list', id: 'x', fields: { title: 'List' } },
      { kind: 'task', id: 'x', fields: { listId: 'x', title: 'Task' } },
      { kind: 'note', id: 'x', fields: { title: 'Note', createdAt: 1 } },
    ]);
    expect(rows.lists.get('x')?.title).toBe('List');
    expect(rows.tasks.get('x')?.title).toBe('Task');
    expect(rows.notes.get('x')?.title).toBe('Note');
    // A put of a task with the field that makes a note is not a note.
    expect(applyPut(rows, { kind: 'task', id: 'y', fields: { createdAt: 1 } })).toBeNull();
    expect(applyPut(rows, { kind: 'note', id: 'y', fields: { listId: 'x' } as never })).toBeNull();
  });
});
