<script lang="ts">
  import { untrack } from 'svelte';
  import type { ID } from '../../../shared/types.ts';
  import { getNote } from '../data/index.ts';
  import { portal, pushOverlay, slide } from '../ui/index.ts';
  import { closeNote, noteEditor, notes, openMenu, phone } from './phone.svelte.ts';

  // The full screen of one note (SPEC section 8, "Notes" > "Phone"). It is an overlay, as the task
  // detail is, so Back and Esc close it. The editor of web/src/notes/ draws all that is in it: the
  // bars, the safe areas, and the note color, also behind the status bar. Each close runs the
  // close rules of the editor at once, also a close by Back.
  interface Props {
    id: ID;
    isNew: boolean;
  }
  const props: Props = $props();
  // One screen is for one note. The value of the owner goes away when the screen closes.
  const id = untrack(() => props.id);
  const isNew = untrack(() => props.isNew);

  const parts = $derived(notes.parts);
  let screen = $state<HTMLElement>();

  function close(): void {
    if (phone.note?.id === id) closeNote();
  }

  $effect(() => {
    if (!screen) return;
    const element = screen;
    return pushOverlay({ close, element: () => element }).remove;
  });

  function openNoteMenu(): void {
    const note = getNote(id);
    const loaded = parts;
    if (!note || !loaded) return;
    openMenu({
      label: 'Note options',
      items: loaded.noteMenuItems({ note }),
      run: (itemId) => {
        void loaded.runNoteMenuItem({ note, itemId });
        // As the archive button of the editor does: the note goes away, as in Google Keep.
        if (itemId === 'archive') close();
      },
    });
  }
</script>

{#if parts}
  <div class="ui-layer" use:portal>
    <div
      class="screen"
      role="dialog"
      aria-modal="true"
      aria-label={isNew ? 'New note' : 'Note'}
      tabindex="-1"
      bind:this={screen}
      in:slide|global
      out:slide|global={{ duration: 180 }}
    >
      <parts.NoteEditor bind:this={noteEditor.part} {id} {isNew} onclose={close} onmenu={openNoteMenu} />
    </div>
  </div>
{/if}

<style>
  .screen {
    width: 100%;
    height: 100%;
    outline: none;
    touch-action: manipulation;
  }
</style>
