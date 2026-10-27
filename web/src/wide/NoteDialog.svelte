<script lang="ts">
  import type { ID } from '../../../shared/types.ts';
  import { getNote } from '../data/index.ts';
  import Dialog from '../ui/Dialog.svelte';
  import type { MenuAnchor } from '../ui/types.ts';
  import { closeNote, openNoteMenu, type NotesParts } from './state.svelte.ts';

  // A note of the notes board in a 600 px dialog (SPEC section 8, "Wide"). The editor paints the
  // note color over all of the card, so the dialog has no title, no buttons, and no padding. Esc,
  // a click outside, and Back close the dialog. The close rules of the editor run at once, and
  // not at the end of the exit motion: an emptied note is deleted with Undo, and it does not show
  // as an "Empty note" card behind the fading scrim.
  interface Props {
    parts: NotesParts;
    id: ID;
  }
  let { parts, id }: Props = $props();

  let editor = $state<{ finish: () => void }>();

  function close(): void {
    editor?.finish();
    closeNote();
  }

  function menu(anchor: MenuAnchor): void {
    const note = getNote(id);
    // As the archive button of the editor does: the note goes away, as in Google Keep.
    if (note) openNoteMenu({ note, anchor, parts, onrun: (itemId) => itemId === 'archive' && close() });
  }
</script>

<Dialog open width={600} padded={false} label="Note" onclose={close}>
  <parts.NoteEditor bind:this={editor} {id} isNew={false} onclose={close} onmenu={menu} />
</Dialog>
