// The note menu against a real data layer, with the dialogs replaced.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuItem } from '../ui/index.ts';

vi.mock('../data/index.ts', async () => (await import('./testkit.ts')).layer);
vi.mock('../common/dialogs.svelte.ts', () => ({ pickNoteColor: vi.fn(async () => {}), askMakeTasks: vi.fn() }));

const { layer, makeNote, MY_LIST, samNote, SAM } = await import('./testkit.ts');
const dialogs = vi.mocked(await import('../common/dialogs.svelte.ts'));
const { deletedHere, noteMenuItems, runNoteMenuItem, shareNoteFlow } = await import('./menu.ts');

const ids = (items: MenuItem[]): string[] => items.map((item) => item.id);
const labels = (items: MenuItem[]): string[] => items.map((item) => item.label);
const find = (items: MenuItem[], id: string): MenuItem => items.find((item) => item.id === id)!;

beforeEach(() => {
  vi.clearAllMocks();
  layer.toast.dismiss();
});

describe('note menu', () => {
  it('has the entries of the SPEC in order, with a line before the sharing', () => {
    const note = makeNote({ body: 'Milk' });
    const items = noteMenuItems({ note });
    expect(labels(items)).toEqual(['Pin', 'Archive', 'Change color', 'Make tasks', 'Share with Sam', 'Delete']);
    expect(ids(items)).toEqual(['pin', 'archive', 'color', 'tasks', 'share', 'delete']);
    expect(items.filter((item) => item.separatorBefore).map((item) => item.id)).toEqual(['share']);
    expect(items.filter((item) => item.disabled)).toEqual([]);
    // Each entry has an icon, so the labels are in line.
    expect(items.every((item) => item.icon !== undefined)).toBe(true);
  });

  it('reads "Unpin", "Unarchive", and "Stop sharing" for a note with those states', () => {
    const pinned = makeNote({ pinned: true, shared: true });
    expect(labels(noteMenuItems({ note: pinned })).slice(0, 2)).toEqual(['Unpin', 'Archive']);
    expect(find(noteMenuItems({ note: pinned }), 'share').label).toBe('Stop sharing');
    layer.actions.setNoteArchived({ id: pinned.id, archived: true });
    const archived = layer.getNote(pinned.id)!;
    expect(labels(noteMenuItems({ note: archived })).slice(0, 2)).toEqual(['Pin', 'Unarchive']);
  });

  it('disables "Make tasks" for a note whose title and body are empty after trim', () => {
    const note = makeNote({ title: 'x' });
    layer.actions.updateNote({ id: note.id, title: '   ', body: ' \n ' });
    const item = find(noteMenuItems({ note: layer.getNote(note.id)! }), 'tasks');
    expect(item.disabled).toBe(true);
    expect(item.hint).toBe('The note is empty');
  });

  it('shows the note of the other person with "Shared by" and a disabled "Delete" that tells why', async () => {
    const note = await samNote({ body: 'Brake pads' });
    expect(note.owner).toBe(SAM);
    const items = noteMenuItems({ note });
    expect(find(items, 'share')).toMatchObject({ label: 'Shared by Sam', disabled: true });
    expect(find(items, 'delete')).toMatchObject({ disabled: true, hint: 'Only Sam can delete this note' });
    // The other entries work for each person who sees the note.
    expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(['share', 'delete']);
    await runNoteMenuItem({ note, itemId: 'delete' });
    await runNoteMenuItem({ note, itemId: 'share' });
    expect(layer.getNote(note.id)).toMatchObject({ deleted: false, shared: true });
  });

  it('disables the sharing when there is no second account', () => {
    const note = makeNote();
    const otherUser = layer.otherUser;
    layer.otherUser = () => null;
    try {
      expect(find(noteMenuItems({ note }), 'share')).toMatchObject({ label: 'Share note', disabled: true, hint: 'No other person has an account yet' });
      expect(shareNoteFlow(note)).toBe(false);
      expect(layer.getNote(note.id)!.shared).toBe(false);
    } finally {
      layer.otherUser = otherUser;
    }
  });
});

describe('the entries of the note menu', () => {
  it('pins and unpins, as the label said', async () => {
    const note = makeNote();
    await runNoteMenuItem({ note, itemId: 'pin' });
    expect(layer.getNote(note.id)!.pinned).toBe(true);
    // A second press on the same old menu does not take the pin away.
    await runNoteMenuItem({ note, itemId: 'pin' });
    expect(layer.getNote(note.id)!.pinned).toBe(true);
    await runNoteMenuItem({ note: layer.getNote(note.id)!, itemId: 'pin' });
    expect(layer.getNote(note.id)!.pinned).toBe(false);
  });

  it('archives with "Note archived" and Undo, and unarchives', async () => {
    const note = makeNote({ pinned: true });
    await runNoteMenuItem({ note, itemId: 'archive' });
    expect(layer.getNote(note.id)).toMatchObject({ archived: true, pinned: false });
    expect(layer.toast.current).toMatchObject({ message: 'Note archived', undoable: true });
    await runNoteMenuItem({ note: layer.getNote(note.id)!, itemId: 'archive' });
    expect(layer.getNote(note.id)!.archived).toBe(false);
    expect(layer.toast.current?.message).toBe('Note unarchived');
  });

  it('opens the color picker at the anchor', async () => {
    const note = makeNote();
    const anchor = { x: 10, y: 20 };
    await runNoteMenuItem({ note, itemId: 'color', anchor });
    expect(dialogs.pickNoteColor).toHaveBeenCalledExactlyOnceWith({ id: note.id, anchor });
  });

  it('makes tasks with the choice of the dialog, as one undo step', async () => {
    const note = makeNote({ title: 'Groceries', body: '- [ ] Milk\n- [x] Eggs\n- Bread' });
    dialogs.askMakeTasks.mockResolvedValueOnce({ listId: MY_LIST, mode: 'lines', archive: true });
    await runNoteMenuItem({ note, itemId: 'tasks' });
    expect(dialogs.askMakeTasks).toHaveBeenCalledExactlyOnceWith({ id: note.id });
    const titles = layer.listView(MY_LIST).groups.flatMap((group) => group.items.map((item) => item.task.title));
    expect(titles.slice(0, 2)).toEqual(['Milk', 'Bread']);
    expect(layer.getNote(note.id)!.archived).toBe(true);
    expect(layer.toast.current).toMatchObject({ message: '2 tasks added to My Tasks', undoable: true });
    layer.undo();
    expect(layer.getNote(note.id)!.archived).toBe(false);
    expect(layer.listView(MY_LIST).groups.flatMap((group) => group.items.map((item) => item.task.title))).not.toContain('Milk');
  });

  it('makes no tasks after a cancel, for an empty note, or for a note that went away', async () => {
    const note = makeNote({ body: 'One\nTwo' });
    dialogs.askMakeTasks.mockResolvedValueOnce(null);
    await runNoteMenuItem({ note, itemId: 'tasks' });
    const before = layer.listView(MY_LIST).openCount;

    const empty = makeNote({ title: 'x' });
    layer.actions.updateNote({ id: empty.id, title: '' });
    await runNoteMenuItem({ note: layer.getNote(empty.id)!, itemId: 'tasks' });
    expect(dialogs.askMakeTasks).toHaveBeenCalledTimes(1);

    dialogs.askMakeTasks.mockImplementationOnce(async () => {
      layer.actions.deleteNote({ id: note.id });
      return { listId: MY_LIST, mode: 'lines', archive: false };
    });
    await runNoteMenuItem({ note, itemId: 'tasks' });
    expect(layer.listView(MY_LIST).openCount).toBe(before);
  });

  it('shares with "Shared with Sam" and stops with "Stopped sharing", each with Undo', async () => {
    const note = makeNote();
    await runNoteMenuItem({ note, itemId: 'share' });
    expect(layer.getNote(note.id)!.shared).toBe(true);
    expect(layer.toast.current).toMatchObject({ message: 'Shared with Sam', undoable: true });
    layer.undo();
    expect(layer.getNote(note.id)!.shared).toBe(false);

    layer.actions.setNoteShared({ id: note.id, shared: true });
    await runNoteMenuItem({ note: layer.getNote(note.id)!, itemId: 'share' });
    expect(layer.getNote(note.id)!.shared).toBe(false);
    expect(layer.toast.current).toMatchObject({ message: 'Stopped sharing', undoable: true });
  });

  it('deletes with "Note deleted" and Undo, and remembers the delete for an open editor', async () => {
    const note = makeNote();
    await runNoteMenuItem({ note, itemId: 'delete' });
    expect(layer.getNote(note.id)).toBeUndefined();
    expect(layer.toast.current).toMatchObject({ message: 'Note deleted', undoable: true });
    expect(deletedHere.has(note.id)).toBe(true);
    layer.undo();
    expect(layer.getNote(note.id)).toBeDefined();
  });

  it('does nothing for a note that went away', async () => {
    const note = makeNote();
    layer.actions.deleteNote({ id: note.id, discard: true });
    await runNoteMenuItem({ note, itemId: 'color' });
    await runNoteMenuItem({ note, itemId: 'pin' });
    expect(dialogs.pickNoteColor).not.toHaveBeenCalled();
    expect(layer.getNote(note.id)).toBeUndefined();
  });
});
