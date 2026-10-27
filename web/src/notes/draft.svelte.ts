// The text of one note while a person writes it. The editor and the composer use it, so the two
// follow the same rules of SPEC section 8, "Note editor":
// - A new note gets its row at the first key that is not a space. Before that, there is no row,
//   and the color, the pin, and the share wait here for that first key.
// - Each key sends only the field that the person types in.
// - A change from the other person shows at once, but not in the field with the focus. That
//   field shows the stored value when it loses the focus.
// - The close rules read the row, not the fields: a field with the focus does not show a change
//   from the other person.

import { untrack } from 'svelte';
import type { ID, NoteColor, NoteRow } from '../../../shared/types.ts';
import { actions, getNote, session } from '../data/index.ts';
import { deletedHere } from './menu.ts';
import { isEmptyNote } from './names.ts';

export type NoteField = 'title' | 'body';

/** The title is one line. A pasted text can have line breaks, so each run becomes a space. */
export const oneLine = (text: string): string => text.replace(/[\r\n]+/g, ' ');

export class NoteDraft {
  readonly id: ID;
  title = $state('');
  body = $state('');
  /** true when the note had a row while this draft was open. */
  hadRow = $state(false);
  /** This draft made the row of the note, so the close rules discard it with no message. */
  made = false;
  #color = $state<NoteColor>('default');
  #pinned = $state(false);
  #shared = $state(false);
  /** The last row that this draft saw. The screen keeps it while it plays its exit after the note went away. */
  #seen = $state.raw<NoteRow | undefined>(undefined);
  #focused: NoteField | null = null;
  #finished = false;

  constructor({ id, isNew }: { id: ID; isNew: boolean }) {
    this.id = id;
    const row = untrack(() => getNote(id));
    this.title = row?.title ?? '';
    this.body = row?.body ?? '';
    this.#seen = row;
    // An older note that is not on the device went away before the editor opened.
    this.hadRow = row !== undefined || !isNew;
    // A mark from an earlier delete of this note (and an Undo) must not hide a new message.
    deletedHere.delete(id);
  }

  /** The row now, or the last row that this draft saw. Reactive. */
  get note(): NoteRow | undefined {
    return getNote(this.id) ?? this.#seen;
  }

  /** true when the note has a row now. Reactive. */
  get exists(): boolean {
    return getNote(this.id) !== undefined;
  }

  /** true when the note had a row in this draft and is gone now. A new note with no row yet is not gone. Reactive. */
  get gone(): boolean {
    return this.hadRow && !this.#finished && getNote(this.id) === undefined;
  }

  get color(): NoteColor {
    return this.note?.color ?? this.#color;
  }

  get pinned(): boolean {
    return this.note?.pinned ?? this.#pinned;
  }

  get archived(): boolean {
    return this.note?.archived ?? false;
  }

  get shared(): boolean {
    return this.note?.shared ?? this.#shared;
  }

  /** true when this person may change the sharing and delete the note. Reactive. */
  get owned(): boolean {
    const row = this.note;
    return !row || row.owner === session.me?.id;
  }

  /** Shows the stored text in each field that does not have the focus. Call it in an `$effect`. */
  follow(): void {
    const row = getNote(this.id);
    if (!row) return;
    untrack(() => {
      this.#seen = row;
      this.hadRow = true;
      if (this.#focused !== 'title' && this.title !== row.title) this.title = row.title;
      if (this.#focused !== 'body' && this.body !== row.body) this.body = row.body;
    });
  }

  focus(field: NoteField): void {
    this.#focused = field;
  }

  /** The field shows the stored value, which can have a change from the other person. */
  blur(field: NoteField): void {
    if (this.#focused === field) this.#focused = null;
    const row = untrack(() => getNote(this.id));
    if (row && this[field] !== row[field]) this[field] = row[field];
  }

  /** One key in a field. */
  type(field: NoteField, value: string): void {
    const text = field === 'title' ? oneLine(value) : value;
    this[field] = text;
    const id = this.id;
    if (untrack(() => getNote(id))) {
      actions.updateNote(field === 'title' ? { id, title: text } : { id, body: text });
      return;
    }
    // A note that went away does not come back from a key: the screen closes.
    if (this.hadRow || this.#finished) return;
    // createNote makes nothing while the title and the body are empty after trim.
    const made = actions.createNote({ id, title: this.title, body: this.body, color: this.#color, pinned: this.#pinned, shared: this.#shared });
    if (made.puts.length > 0) {
      this.made = true;
      this.hadRow = true;
      this.#seen = untrack(() => getNote(id));
    }
  }

  setColor(color: NoteColor): void {
    if (untrack(() => getNote(this.id))) actions.setNoteColor({ id: this.id, color });
    else this.#color = color;
  }

  togglePin(): void {
    const row = untrack(() => getNote(this.id));
    if (row) actions.setNotePinned({ id: this.id, pinned: !row.pinned });
    else this.#pinned = !this.#pinned;
  }

  /** Only the owner can change the sharing. A note with no row yet belongs to this person. */
  toggleShare(): void {
    const row = untrack(() => getNote(this.id));
    if (row) actions.setNoteShared({ id: this.id, shared: !row.shared });
    else this.#shared = !this.#shared;
  }

  /**
   * The message when the note went away: null when "Delete" of the note menu removed it, because
   * that action showed "Note deleted" with Undo already.
   */
  goneMessage(): string | null {
    return deletedHere.delete(this.id) ? null : 'This note is no longer available';
  }

  /**
   * The close rules. More than one call does no harm. An empty note of this person goes away: a
   * note that this draft made with no message and no undo step, an older note with "Note deleted"
   * and Undo. The note of the other person stays, because only the owner can delete it.
   */
  finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    const row = untrack(() => getNote(this.id));
    if (!row || !isEmptyNote(row) || row.owner !== session.me?.id) return;
    actions.deleteNote({ id: this.id, discard: this.made });
  }
}
