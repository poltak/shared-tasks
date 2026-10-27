// Names and texts of notes that more than one part of this folder shows.

import type { ID, NoteColor, NoteRow } from '../../../shared/types.ts';
import { otherUser, session } from '../data/index.ts';

/** The names of the colors on the screen (SPEC section 3). */
export const COLOR_NAMES: Record<NoteColor, string> = {
  default: 'Default',
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  teal: 'Teal',
  blue: 'Blue',
  darkblue: 'Dark blue',
  purple: 'Purple',
  pink: 'Pink',
  brown: 'Brown',
  gray: 'Gray',
};

/** The CSS value of the background of a note. */
export const noteBackground = (color: NoteColor): string => `var(--note-${color})`;

/** The name of an account, or a word that fits a sentence when the account is not known. */
export function personName(id: ID | null): string {
  return session.users.find((user) => user.id === id)?.name ?? 'the owner';
}

export function isNoteOwner(note: NoteRow): boolean {
  return note.owner === session.me?.id;
}

/** true when the title and the body are both empty after trim. */
export function isEmptyNote(note: Pick<NoteRow, 'title' | 'body'>): boolean {
  return note.title.trim() === '' && note.body.trim() === '';
}

/** The name of a note for a screen reader: the title, the first line of the body that has text, or "Empty note". */
export function noteName(note: Pick<NoteRow, 'title' | 'body'>): string {
  const title = note.title.trim();
  if (title) return title;
  const line = note.body.split(/\r\n|\r|\n/).find((each) => each.trim() !== '');
  return line?.trim() ?? 'Empty note';
}

/** "Shared with Sam" for the owner, "Shared by Sam" for the other person. Null for a note that is not shared. */
export function sharedText(note: NoteRow): string | null {
  if (!note.shared) return null;
  if (!isNoteOwner(note)) return `Shared by ${personName(note.owner)}`;
  const other = otherUser();
  return other ? `Shared with ${other.name}` : 'Shared';
}
