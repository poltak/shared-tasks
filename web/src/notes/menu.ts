// The note menu (SPEC section 8, "Note menu") and what each entry does. The two layouts show the
// same entries in their own menu: a popover on a wide window and a bottom sheet on a phone. It has
// the same form as `taskMenuItems` and `runTaskMenuItem` in web/src/common/menus.ts.
//
// The builder reads the rows, so call it when the menu opens (or in a `$derived` while it is open).

import type { ID, NoteRow } from '../../../shared/types.ts';
import { askMakeTasks, pickNoteColor } from '../common/dialogs.svelte.ts';
import { actions, getNote, otherUser, toast } from '../data/index.ts';
import type { MenuAnchor, MenuItem } from '../ui/index.ts';
import { isEmptyNote, isNoteOwner, personName } from './names.ts';

/**
 * The notes that "Delete" of this menu deleted. An editor that is open on such a note closes with
 * the message of the delete, "Note deleted", and not with "This note is no longer available".
 */
export const deletedHere = new Set<ID>();

/**
 * The entries of the note menu.
 * Ids: 'pin', 'archive', 'color', 'tasks', 'share', 'delete'.
 */
export function noteMenuItems({ note }: { note: NoteRow }): MenuItem[] {
  const owner = isNoteOwner(note);
  const empty = isEmptyNote(note);
  const items: MenuItem[] = [
    { id: 'pin', label: note.pinned ? 'Unpin' : 'Pin', icon: 'pin' },
    { id: 'archive', label: note.archived ? 'Unarchive' : 'Archive', icon: note.archived ? 'unarchive' : 'archive' },
    { id: 'color', label: 'Change color', icon: 'palette' },
    { id: 'tasks', label: 'Make tasks', icon: 'add-task', disabled: empty, hint: empty ? 'The note is empty' : undefined },
  ];

  const share: MenuItem = { id: 'share', label: '', icon: 'people', separatorBefore: true };
  const other = otherUser();
  if (!owner) Object.assign(share, { label: `Shared by ${personName(note.owner)}`, disabled: true });
  else if (note.shared) share.label = 'Stop sharing';
  else if (other) share.label = `Share with ${other.name}`;
  else Object.assign(share, { label: 'Share note', disabled: true, hint: 'No other person has an account yet' });
  items.push(share);

  const remove: MenuItem = { id: 'delete', label: 'Delete', icon: 'bin' };
  if (!owner) Object.assign(remove, { disabled: true, hint: `Only ${personName(note.owner)} can delete this note` });
  items.push(remove);
  return items;
}

/**
 * Runs an entry of the note menu. `anchor` is where the menu opened: the color picker shows there
 * as a popover on a wide screen.
 */
export async function runNoteMenuItem({ note, itemId, anchor = null }: { note: NoteRow; itemId: string; anchor?: MenuAnchor | null }): Promise<void> {
  // A row object never changes. The other person can have changed or deleted the note since the
  // menu opened, so each entry reads it again. The pin and the archive do what the label said.
  const now = getNote(note.id);
  if (!now) return;
  const id = now.id;
  switch (itemId) {
    case 'pin':
      actions.setNotePinned({ id, pinned: !note.pinned });
      break;
    case 'archive':
      actions.setNoteArchived({ id, archived: !note.archived });
      break;
    case 'color':
      await pickNoteColor({ id, anchor });
      break;
    case 'tasks':
      await makeTasksFlow(now);
      break;
    case 'share':
      shareNoteFlow(now);
      break;
    case 'delete':
      if (actions.deleteNote({ id }).puts.length > 0) deletedHere.add(id);
      break;
  }
}

/** Asks how to make tasks from the note, then makes them. true: tasks were added. */
export async function makeTasksFlow(note: NoteRow): Promise<boolean> {
  if (isEmptyNote(note)) return false;
  const choice = await askMakeTasks({ id: note.id });
  if (!choice || !getNote(note.id)) return false;
  return actions.noteToTasks({ id: note.id, ...choice }).puts.length > 0;
}

/**
 * Starts or stops the sharing of a note. Only the owner can do it. The action has no message,
 * because only the screen knows the name. true: the sharing changed.
 */
export function shareNoteFlow(note: NoteRow): boolean {
  if (!isNoteOwner(note)) return false;
  if (note.shared) {
    if (actions.setNoteShared({ id: note.id, shared: false }).puts.length === 0) return false;
    toast.show({ message: 'Stopped sharing', undoable: true });
    return true;
  }
  const other = otherUser();
  if (!other) {
    toast.show({ message: 'No other person has an account yet' });
    return false;
  }
  if (actions.setNoteShared({ id: note.id, shared: true }).puts.length === 0) return false;
  toast.show({ message: `Shared with ${other.name}`, undoable: true });
  return true;
}
