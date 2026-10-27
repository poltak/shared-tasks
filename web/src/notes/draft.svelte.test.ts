// The rules of the note editor (SPEC section 8, "Note editor") against a real data layer.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../data/index.ts', async () => (await import('./testkit.ts')).layer);
vi.mock('../common/dialogs.svelte.ts', () => ({ pickNoteColor: vi.fn(), askMakeTasks: vi.fn() }));

const { layer, makeNote, samChanges, samNote, server, syncNow, ALEX } = await import('./testkit.ts');
const { NoteDraft } = await import('./draft.svelte.ts');
const { deletedHere } = await import('./menu.ts');

const newDraft = () => new NoteDraft({ id: crypto.randomUUID(), isNew: true });

beforeEach(() => {
  vi.restoreAllMocks();
  layer.toast.dismiss();
});

describe('a new note', () => {
  it('gets its row at the first key that is not a space, with the color, the pin, and the share of the draft', () => {
    const draft = newDraft();
    draft.setColor('teal');
    draft.togglePin();
    draft.toggleShare();
    expect(draft.color).toBe('teal');
    draft.type('body', ' ');
    draft.type('body', '  \n');
    expect(layer.getNote(draft.id)).toBeUndefined();
    expect(draft.gone).toBe(false);
    draft.type('body', '  \nM');
    expect(layer.getNote(draft.id)).toMatchObject({ title: '', body: '  \nM', color: 'teal', pinned: true, shared: true, owner: ALEX });
    expect(draft.made).toBe(true);
    // No message for a new note.
    expect(layer.toast.current).toBeNull();
  });

  it('sends only the field that the person types in', () => {
    const draft = newDraft();
    draft.type('title', 'G');
    const update = vi.spyOn(layer.actions, 'updateNote');
    draft.type('title', 'Gr');
    draft.type('body', 'Milk');
    expect(update.mock.calls.map(([intent]) => intent)).toEqual([
      { id: draft.id, title: 'Gr' },
      { id: draft.id, body: 'Milk' },
    ]);
    // After the first key, the color goes to the row.
    draft.setColor('pink');
    expect(layer.getNote(draft.id)!.color).toBe('pink');
  });

  it('keeps the title on one line', () => {
    const draft = newDraft();
    draft.type('title', 'Two\nlines\r\n\nhere');
    expect(draft.title).toBe('Two lines here');
    expect(layer.getNote(draft.id)!.title).toBe('Two lines here');
  });

  it('is discarded at the close when it is empty again: no message and no undo step', () => {
    const before = layer.canUndo();
    const draft = newDraft();
    draft.type('body', 'x');
    draft.type('body', '');
    draft.finish();
    expect(layer.getNote(draft.id)).toBeUndefined();
    expect(layer.toast.current).toBeNull();
    expect(layer.canUndo()).toBe(before);
    // A close of a note that never got a row does nothing.
    newDraft().finish();
    expect(layer.toast.current).toBeNull();
  });

  it('does not come back from a key after it went away', () => {
    const draft = newDraft();
    draft.type('body', 'x');
    layer.actions.deleteNote({ id: draft.id, discard: true });
    expect(draft.gone).toBe(true);
    draft.type('body', 'xy');
    expect(layer.getNote(draft.id)).toBeUndefined();
  });
});

describe('an older note', () => {
  it('shows a change from the other person, but not in the field with the focus until it loses the focus', async () => {
    const note = await samNote({ title: 'Bikes', body: 'Pads' });
    const draft = new NoteDraft({ id: note.id, isNew: false });
    expect([draft.title, draft.body]).toEqual(['Bikes', 'Pads']);
    draft.focus('body');
    draft.type('body', 'Pads and');
    // The key of Alex reaches the server first. A later change of Sam wins for the full field.
    await syncNow();
    await samChanges(note.id, { title: 'Bike parts', body: 'Chain oil' });
    draft.follow();
    expect(draft.title).toBe('Bike parts');
    expect(draft.body).toBe('Pads and');
    draft.blur('body');
    expect(draft.body).toBe('Chain oil');
    // "Edited ... by Sam" reads the person of the last edit.
    expect(draft.note!.editedBy).toBe('user-2');
  });

  it('gives "Note deleted" with Undo at the close when this person emptied it', () => {
    const note = makeNote({ title: 'Old', body: 'Text' });
    const draft = new NoteDraft({ id: note.id, isNew: false });
    draft.type('title', '');
    draft.type('body', ' ');
    draft.finish();
    expect(layer.getNote(note.id)).toBeUndefined();
    expect(layer.toast.current).toMatchObject({ message: 'Note deleted', undoable: true });
    layer.undo();
    expect(layer.getNote(note.id)).toBeDefined();
  });

  it('reads the row at the close, not the fields', async () => {
    const note = await samNote({ title: '', body: 'Pads' });
    // Sam owns it: Alex can empty it, and it stays.
    const draft = new NoteDraft({ id: note.id, isNew: false });
    draft.type('body', '');
    draft.finish();
    expect(layer.getNote(note.id)).toMatchObject({ body: '' });

    // A note of Alex that Sam filled while Alex had the focus in the empty field stays.
    const mine = makeNote({ title: 'Mine', shared: true });
    await syncNow();
    const second = new NoteDraft({ id: mine.id, isNew: false });
    second.focus('title');
    second.type('title', '');
    server.putNote({ user: 'user-2', id: mine.id, fields: { body: 'Sam wrote this', editedAt: 1, editedBy: 'user-2' } });
    await syncNow();
    second.follow();
    expect(second.body).toBe('Sam wrote this');
    second.finish();
    expect(layer.getNote(mine.id)).toBeDefined();
  });

  it('goes away when the row goes, with the message for the cause', async () => {
    const note = makeNote();
    const draft = new NoteDraft({ id: note.id, isNew: false });
    expect(draft.gone).toBe(false);
    deletedHere.add(note.id);
    layer.actions.deleteNote({ id: note.id });
    expect(draft.gone).toBe(true);
    expect(draft.goneMessage()).toBeNull();
    // The screen keeps the last row while it plays its exit.
    expect(draft.note?.id).toBe(note.id);

    const shared = await samNote();
    const other = new NoteDraft({ id: shared.id, isNew: false });
    server.putNote({ user: 'user-2', id: shared.id, fields: { shared: false } });
    await syncNow();
    expect(other.gone).toBe(true);
    expect(other.goneMessage()).toBe('This note is no longer available');
    // After the close rules, the draft is not "gone" again.
    other.finish();
    expect(other.gone).toBe(false);
  });

  it('is gone at once when the note is not on the device', () => {
    expect(new NoteDraft({ id: 'not-here', isNew: false }).gone).toBe(true);
  });

  it('lets only the owner change the sharing', async () => {
    const note = await samNote();
    const draft = new NoteDraft({ id: note.id, isNew: false });
    expect(draft.owned).toBe(false);
    expect(newDraft().owned).toBe(true);
  });
});
