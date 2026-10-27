<script lang="ts">
  import { untrack } from 'svelte';
  import type { ID, NoteRow } from '../../../shared/types.ts';
  import type { MenuAnchor } from '../ui/types.ts';
  import NoteDialog from './NoteDialog.svelte';
  import { openNote, openNoteMenu, setComposer, ui, type NotesParts } from './state.svelte.ts';

  // The main area of the Notes view and of the Archive view (SPEC section 8, "Wide"): the
  // composer (Notes only), then the grid of the view, filtered by the search field of the bar.
  // A click on a card opens the note in a dialog.
  interface Props {
    parts: NotesParts;
  }
  let { parts }: Props = $props();

  const archived = $derived(ui.view === 'archive');

  let board = $state<HTMLElement>();
  let top = $state<HTMLElement>();
  let composer = $state<{ focus: () => void }>();
  /** The note of the open composer. It stays out of the grid until the composer closes. */
  let composing = $state<ID | null>(null);

  // The two views share this scroll area. Each view starts at its top.
  $effect(() => {
    void archived;
    untrack(() => board?.scrollTo({ top: 0 }));
  });

  // The composer takes the focus with no scroll, so a key or "Create" far down the grid would
  // open it out of view.
  $effect(() => {
    if (ui.composerOpen && top) top.scrollIntoView({ block: 'nearest' });
  });

  $effect(() => {
    if (!composer) return;
    setComposer(composer);
    return () => setComposer(null);
  });

  // The composer goes away with the Notes view and gives back no null for its note. Its note is
  // then in the grid, and must not stay hidden when the composer comes back.
  $effect.pre(() => {
    if (archived) composing = null;
  });

  function menu(input: { note: NoteRow; anchor: MenuAnchor }): void {
    openNoteMenu({ ...input, parts });
  }
</script>

<div class={['notes', { archived }]} bind:this={board} data-testid="notes-board">
  {#if !archived}
    <div class="compose" bind:this={top}>
      <parts.NoteComposer bind:this={composer} bind:open={() => ui.composerOpen, (open) => (ui.composerOpen = open)} bind:noteId={composing} />
    </div>
  {/if}
  <parts.NotesGrid {archived} query={ui.noteQuery} hiddenId={composing} onopen={openNote} onmenu={menu} />
</div>

{#if ui.noteId !== null}
  <!-- One editor is for one note: a different note gets a new editor, with the close rules of the old one. -->
  {#key ui.noteId}
    <NoteDialog {parts} id={ui.noteId} />
  {/key}
{/if}

<style>
  .notes {
    height: 100%;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 8px 24px 96px;
    scrollbar-width: thin;
    /* The cards fade out under the bar, and no hard line cuts them. The mask stays at the edge
       of the area while the content scrolls. */
    mask-image: linear-gradient(transparent, #000 10px);
  }
  .compose {
    padding: 8px 0 40px;
  }
  .archived {
    padding-top: 24px;
  }
</style>
