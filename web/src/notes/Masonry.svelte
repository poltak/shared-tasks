<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { ID, NoteRow } from '../../../shared/types.ts';
  import type { MenuAnchor } from '../ui/index.ts';
  import { placeCards, type Columns } from './masonry.ts';
  import NoteCard from './NoteCard.svelte';

  // The cards of one part of the grid. Each card has a position of its own (absolute, moved with
  // a transform), so the order of the document stays the order of the view: Tab and a screen
  // reader follow it. A ResizeObserver gives the height of each card. Its callback runs after the
  // layout and before the paint, so the first frame shows each card at its place, and nothing
  // reads the layout for each change.
  interface Props {
    notes: readonly NoteRow[];
    columns: Columns;
    onopen: (id: ID) => void;
    onmenu: (input: { note: NoteRow; anchor: MenuAnchor }) => void;
  }
  let { notes, columns, onopen, onmenu }: Props = $props();

  let heights = $state.raw(new Map<ID, number>());
  /** false until the first placement is on the screen. A card moves with a transition only after it. */
  let live = $state(false);
  const placement = $derived(placeCards({ heights: notes.map((note) => heights.get(note.id) ?? 0), columns }));

  const observer =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver((entries) => {
          let next: Map<ID, number> | null = null;
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset.slot!;
            const height = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
            if (heights.get(id) === height) continue;
            next ??= new Map(heights);
            next.set(id, height);
          }
          if (next) heights = next;
          if (!live) requestAnimationFrame(() => (live = true));
        })
      : null;

  onDestroy(() => observer?.disconnect());

  /**
   * Measures the slot of one card. A card that comes after the first placement also comes in with
   * a short motion. The height of a card that went away stays in the map: if the card comes
   * back, it starts near its true place.
   */
  function measure(node: HTMLElement): { destroy: () => void } {
    if (live) node.classList.add('enter');
    observer?.observe(node);
    return { destroy: () => observer?.unobserve(node) };
  }
</script>

<div class={['masonry', { live }]} style:height="{placement.height}px">
  {#each notes as note, i (note.id)}
    {@const at = placement.positions[i]!}
    <div class="slot" data-slot={note.id} style:width="{columns.width}px" style:transform="translate({at.x}px, {at.y}px)" use:measure>
      <NoteCard {note} {onopen} {onmenu} />
    </div>
  {/each}
</div>

<style>
  .masonry {
    position: relative;
  }
  .slot {
    position: absolute;
    left: 0;
    top: 0;
  }
  .live .slot {
    transition: transform var(--dur) var(--ease);
  }
  .slot:global(.enter) > :global(*) {
    animation: card-in var(--dur) var(--ease);
  }
  @keyframes card-in {
    from {
      opacity: 0;
      transform: scale(0.96);
    }
  }
</style>
