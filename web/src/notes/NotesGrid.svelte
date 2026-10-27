<script lang="ts">
  import type { ID, NoteRow } from '../../../shared/types.ts';
  import { notesView } from '../data/index.ts';
  import { layout, type MenuAnchor } from '../ui/index.ts';
  import Masonry from './Masonry.svelte';
  import { columnsFor } from './masonry.ts';
  import NotesEmpty from './NotesEmpty.svelte';

  // The notes of a view (SPEC section 8, "Grid"): "Pinned" and "Others" with their masonry, or
  // an empty state. The width of the area gives the columns, so the layout gives the grid the
  // full width of its page or of its main area.
  interface Props {
    archived: boolean;
    query: string;
    /** The note of the open composer. It stays out of the grid until the composer closes. */
    hiddenId: ID | null;
    onopen: (id: ID) => void;
    /** The three-dot button of a card and the right click. */
    onmenu: (input: { note: NoteRow; anchor: MenuAnchor }) => void;
  }
  let { archived, query, hiddenId, onopen, onmenu }: Props = $props();

  const view = $derived(notesView({ archived, query }));
  const pinned = $derived(hiddenId ? view.pinned.filter((note) => note.id !== hiddenId) : view.pinned);
  const others = $derived(hiddenId ? view.others.filter((note) => note.id !== hiddenId) : view.others);

  let width = $state(0);
  const columns = $derived(columnsFor({ width, mode: layout.mode }));

  let ruler = $state<HTMLElement>();
  // The observer gives the width with no read of the layout, also after a change of the window.
  // It watches a ruler with no height, and not the grid: the height of the grid changes in the
  // frame in which the cards get their heights, and the browser would then report undelivered
  // notifications.
  $effect(() => {
    if (!ruler || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) width = entry.contentBoxSize[0]?.inlineSize ?? entry.contentRect.width;
    });
    observer.observe(ruler);
    return () => observer.disconnect();
  });
</script>

<div class={['grid', layout.mode]} style:--offset="{columns.offset}px">
  <div class="ruler" bind:this={ruler} aria-hidden="true"></div>
  {#if pinned.length > 0 || others.length > 0}
    <!-- The cards come when the width is known, so each card is measured one time at its true width. -->
    {#if width > 0}
      {#if pinned.length > 0}
        <h2 class="heading">Pinned</h2>
        <Masonry notes={pinned} {columns} {onopen} {onmenu} />
        {#if others.length > 0}<h2 class="heading later">Others</h2>{/if}
      {/if}
      {#if others.length > 0}<Masonry notes={others} {columns} {onopen} {onmenu} />{/if}
    {/if}
  {:else if query.trim()}
    <NotesEmpty kind="search" title="No matching notes" text="Try a different word." />
  {:else if archived}
    <NotesEmpty kind="archive" title="Your archived notes appear here" />
  {:else}
    <NotesEmpty kind="notes" title="Notes you add appear here" />
  {/if}
</div>

<style>
  .grid {
    position: relative;
    width: 100%;
    min-width: 0;
  }
  .ruler {
    height: 0;
  }
  .heading {
    /* In line with the left edge of the first column. */
    padding: 0 4px 8px calc(var(--offset) + 4px);
    color: var(--text-dim);
    font-size: 11px;
    font-weight: 500;
    line-height: 16px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .later {
    padding-top: 24px;
  }
  .wide .heading {
    padding-bottom: 10px;
  }
  .wide .later {
    padding-top: 32px;
  }
</style>
