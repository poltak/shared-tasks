import { describe, expect, it } from 'vitest';
import { closeNote, loadNotes, newNote, noteEditor, notes, openNote, phone } from './phone.svelte.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The tests run in order: the first one needs the parts not downloaded yet.
describe('notes on the phone', () => {
  it('opens no new note before the download of the notes parts is done', () => {
    newNote();
    expect(phone.note).toBeNull();
    expect(notes.parts).toBeNull();
  });

  it('downloads the notes parts one time, through the one door of the folder', async () => {
    const first = loadNotes();
    expect(loadNotes()).toBe(first);
    const parts = await first;
    expect(parts).not.toBeNull();
    expect(notes.parts).toBe(parts);
    expect(Object.keys(parts!)).toEqual(expect.arrayContaining(['NotesGrid', 'NoteEditor', 'noteMenuItems', 'runNoteMenuItem']));
  });

  it('opens a new note in the notes, not in the archive, with the focus in the body', async () => {
    await loadNotes();
    const fields: (string | undefined)[] = [];
    noteEditor.part = { focus: (field) => void fields.push(field), finish: () => {} };
    phone.archive = true;
    newNote();
    const first = phone.note;
    expect(first).toEqual({ id: expect.stringMatching(UUID), isNew: true });
    expect(phone.archive).toBe(false);
    expect(fields).toEqual(['body']);

    newNote();
    expect(phone.note?.id).not.toBe(first?.id);
    noteEditor.part = null;
  });

  it('opens a note that has a row', () => {
    openNote('note-1');
    expect(phone.note).toEqual({ id: 'note-1', isNew: false });
  });

  it('runs the close rules of the editor before the screen goes away', () => {
    const calls: string[] = [];
    noteEditor.part = { focus: () => {}, finish: () => void calls.push(phone.note === null ? 'closed' : 'open') };
    openNote('note-1');
    closeNote();
    expect(calls).toEqual(['open']);
    expect(phone.note).toBeNull();
    noteEditor.part = null;
  });
});
