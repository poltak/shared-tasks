<script lang="ts">
  import { untrack } from 'svelte';
  import type { ID, NoteColor } from '../../../shared/types.ts';
  import { actions, getNote } from '../data/index.ts';
  import type { MenuAnchor } from '../ui/index.ts';
  import ColorPopup from './ColorPopup.svelte';

  // "Change color" of the note menu. The dialog host of web/src/common/ shows it. Each choice
  // changes the note at once. It closes when the note goes away.
  interface Props {
    id: ID;
    anchor?: MenuAnchor | null;
    onclose: () => void;
  }
  let { id, anchor = null, onclose }: Props = $props();

  let open = $state(true);
  const note = $derived(getNote(id));
  // The picker keeps the last color while it plays its exit after the note went away.
  let last: NoteColor = 'default';
  const value = $derived.by(() => (last = note?.color ?? last));

  $effect(() => {
    if (note || !open) return;
    untrack(() => {
      open = false;
      onclose();
    });
  });
</script>

<ColorPopup bind:open {value} {anchor} {onclose} onpick={(color) => actions.setNoteColor({ id, color })} />
