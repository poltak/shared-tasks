// The views of the wide layout against a real data layer: the two notes views, the way back to
// the tasks, and what a change of the view closes.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteRow } from '../../../shared/types.ts';
import type { MenuItem } from '../ui/types.ts';

vi.mock('../data/index.ts', async () => {
  const { fakeClock, makeDevice, stubServer } = await import('../data/testkit.ts');
  const clock = fakeClock();
  const device = makeDevice({ server: stubServer(clock.now), clock, locale: 'en-GB' });
  await device.layer.start();
  await clock.advance(0);
  return device.layer;
});
vi.mock('../common/print.ts', () => ({ printList: vi.fn() }));

const layer = await import('../data/index.ts');
const { prefs } = layer;
const state = await import('./state.svelte.ts');
const { compose, closeNote, NOTES, openNote, openNoteMenu, resetNotes, runMenu, setComposer, showAll, showList, showStarred, showView, STARRED, ui } = state;

/** The first list of the person. */
const firstList = (): string => layer.listsOrdered()[0]!.id;

beforeEach(() => {
  showView('board');
  resetNotes();
  setComposer(null);
  prefs.lastTab = null;
});

describe('views', () => {
  it('reads the view from prefs.lastTab, and a list id of the phone is "All tasks"', () => {
    expect(ui.view).toBe('board');
    prefs.lastTab = STARRED;
    expect(ui.view).toBe('starred');
    prefs.lastTab = NOTES;
    expect(ui.view).toBe('notes');
    expect(ui.notes).toBe(true);
    prefs.lastTab = firstList();
    expect(ui.view).toBe('board');
    expect(ui.notes).toBe(false);
  });

  it('stores "notes" for the Notes view and for the Archive view', () => {
    showView('archive');
    expect(ui.view).toBe('archive');
    expect(prefs.lastTab).toBe(NOTES);
    showView('notes');
    expect(ui.view).toBe('notes');
    expect(prefs.lastTab).toBe(NOTES);
  });

  it('starts with the notes and not the archive when the last view was the archive', () => {
    showView('archive');
    // The layout goes away (a change to the phone layout) and comes back.
    resetNotes();
    expect(prefs.lastTab).toBe(NOTES);
    expect(ui.view).toBe('notes');
  });

  it('"All tasks" and "Starred" work from each notes view', () => {
    showView('notes');
    showAll();
    expect(ui.view).toBe('board');
    expect(prefs.lastTab).toBeNull();
    showView('archive');
    showStarred();
    expect(ui.view).toBe('starred');
    showView('archive');
    showAll();
    expect(ui.view).toBe('board');
  });

  it('a link to a list shows "All tasks" from the archive', () => {
    showView('archive');
    showList(firstList());
    expect(ui.view).toBe('board');
  });
});

describe('notes views', () => {
  it('leaving a notes view closes the editor and the composer, and clears the search', () => {
    showView('notes');
    openNote('note-1');
    ui.composerOpen = true;
    ui.noteQuery = 'milk';
    showView('board');
    expect(ui.noteId).toBeNull();
    expect(ui.composerOpen).toBe(false);
    expect(ui.noteQuery).toBe('');
  });

  it('keeps the search between the Notes view and the Archive view, and closes the editor', () => {
    showView('notes');
    ui.noteQuery = 'milk';
    openNote('note-1');
    showView('archive');
    expect(ui.noteQuery).toBe('milk');
    expect(ui.noteId).toBeNull();
  });

  it('opens and closes the note of the editor dialog', () => {
    showView('notes');
    openNote('note-1');
    expect(ui.noteId).toBe('note-1');
    closeNote();
    expect(ui.noteId).toBeNull();
  });

  it('compose from the archive shows the notes and puts the focus in the composer in the same call', () => {
    showView('archive');
    const composer = { focus: vi.fn(() => expect(ui.view).toBe('notes')) };
    setComposer(composer);
    compose();
    expect(ui.view).toBe('notes');
    expect(composer.focus).toHaveBeenCalledOnce();
  });

  it('compose with no composer on the screen yet asks the composer to open when it comes', () => {
    showView('board');
    compose();
    expect(ui.view).toBe('notes');
    expect(ui.composerOpen).toBe(true);
  });

  it('compose from an effect (a launch) does not wait for the screen and only asks the composer to open', () => {
    const composer = { focus: vi.fn() };
    setComposer(composer);
    showView('archive');
    compose({ now: false });
    expect(ui.view).toBe('notes');
    expect(ui.composerOpen).toBe(true);
    expect(composer.focus).not.toHaveBeenCalled();
  });

  it('the note menu shows the entries of the notes parts and runs them with the note and the anchor of the open', () => {
    const note = { id: 'note-1', pinned: false } as NoteRow;
    const items: MenuItem[] = [{ id: 'pin', label: 'Pin' }];
    const parts = { noteMenuItems: vi.fn(() => items), runNoteMenuItem: vi.fn(async () => {}) };
    const anchor = { x: 10, y: 20 };
    openNoteMenu({ note, anchor, parts });
    expect(parts.noteMenuItems).toHaveBeenCalledWith({ note });
    expect(ui.menu).toMatchObject({ anchor, items, label: 'Note options' });
    expect(ui.menuOpen).toBe(true);
    runMenu('pin');
    expect(parts.runNoteMenuItem).toHaveBeenCalledWith({ note, itemId: 'pin', anchor });
  });

  it('the note menu tells the opener which entry ran, after the entry started', () => {
    const note = { id: 'note-1', archived: false } as NoteRow;
    const order: string[] = [];
    const parts = { noteMenuItems: vi.fn(() => []), runNoteMenuItem: vi.fn(async () => void order.push('run')) };
    openNoteMenu({ note, anchor: { x: 0, y: 0 }, parts, onrun: (itemId) => void order.push(itemId) });
    runMenu('archive');
    expect(order).toEqual(['run', 'archive']);
  });
});
