// The notes UI that the phone and the wide layout share (SPEC section 8, "Notes"). It is one
// download: a layout loads it with `import('../notes/index.ts')` and imports no other file of
// this folder.
//
// - NotesGrid: the headings, the masonry, the cards, and the empty states of a view.
// - NoteEditor: the fields and the controls of one note, in the frame of the layout. Call its
//   `focus()` (bind:this) in the handler of a tap, after `flushSync`, so iOS shows the keyboard.
// - NoteComposer: "Take a note…" of the wide notes board. `bind:noteId` gives the `hiddenId` of
//   the grid, and `focus()` opens it with the focus in the body.
// - noteMenuItems and runNoteMenuItem: the note menu. "Change color" and "Make tasks" open
//   through the dialog host of web/src/common/, which shows NoteColorDialog and MakeTasksDialog.
// - noteName: the name of a note on the screen, for example the heading of a menu sheet.

export { default as NotesGrid } from './NotesGrid.svelte';
export { default as NoteEditor } from './NoteEditor.svelte';
export { default as NoteComposer } from './NoteComposer.svelte';
export { noteMenuItems, runNoteMenuItem } from './menu.ts';
export { noteName } from './names.ts';

// For the dialog host of web/src/common/ only.
export { default as NoteColorDialog } from './NoteColorDialog.svelte';
export { default as MakeTasksDialog } from './MakeTasksDialog.svelte';
