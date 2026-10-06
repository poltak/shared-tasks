<script lang="ts">
  import type { ListRow } from '../../../shared/types.ts';
  import { actions, listView } from '../data/index.ts';
  import { dnd, dndContainer, dndItem } from '../dnd/index.ts';
  import { Icon, reducedMotion } from '../ui/index.ts';
  import { STARRED } from './phone.svelte.ts';

  interface Props {
    lists: readonly ListRow[];
    /** The id of the active tab. */
    active: string;
    onpick: (id: string) => void;
    onnew: () => void;
  }
  let { lists, active, onpick, onnew }: Props = $props();

  /** The marker is this much shorter than its tab at each end. */
  const INSET = 12;
  /** The width of the marker in the style sheet. A scale gives it the width of a tab. */
  const LINE = 100;

  interface Box {
    left: number;
    width: number;
  }

  let bar = $state<HTMLElement>();
  let row = $state<HTMLElement>();
  let line = $state<HTMLElement>();

  /** The tabs, as the last measure found them. The marker moves with these numbers and reads no layout. */
  let boxes: Box[] = [];
  let barWidth = 0;
  /** Where the pager is: 1.5 is the middle between the second and the third page. */
  let at = 0;
  let lastActive: string | null = null;
  let dropped = false;

  /** The marker follows the pager. The pager calls this in each frame of a swipe. */
  export function follow(position: number): void {
    at = position;
    draw();
  }

  function draw(): void {
    if (!line || boxes.length === 0) return;
    const last = boxes.length - 1;
    const index = Math.max(0, Math.min(last, Math.floor(at)));
    const from = boxes[index]!;
    const to = boxes[Math.min(last, index + 1)]!;
    const part = Math.max(0, Math.min(1, at - index));
    const left = from.left + (to.left - from.left) * part + INSET;
    const width = Math.max(8, from.width + (to.width - from.width) * part - 2 * INSET);
    line.style.transform = `translate3d(${left.toFixed(2)}px,0,0) scaleX(${(width / LINE).toFixed(4)})`;
    line.style.opacity = '1';
  }

  function measure(): void {
    if (!bar || !row) return;
    boxes = [...row.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => ({ left: tab.offsetLeft, width: tab.offsetWidth }));
    barWidth = bar.clientWidth;
    draw();
  }

  /** Brings the active tab to the middle of the bar. */
  function reveal(smooth: boolean): void {
    const box = boxes[active === STARRED ? 0 : lists.findIndex((list) => list.id === active) + 1];
    if (!bar || !box) return;
    bar.scrollTo({ left: box.left - (barWidth - box.width) / 2, behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });
  }

  // After the DOM has a new active tab, a new name, or a new order, the tabs have new places.
  $effect(() => {
    void lists;
    const now = active;
    measure();
    // After a drop, the drag engine moves the tabs to their places. A scroll at that time would move them again.
    if (!dropped) reveal(lastActive !== null);
    dropped = false;
    lastActive = now;
  });

  // A count with one more digit, or a window with a new width.
  $effect(() => {
    if (!bar || !row) return;
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    observer.observe(row);
    return () => observer.disconnect();
  });

  // SPEC section 8: touch and hold a tab, then move it. The star tab and "New list" stay in place.
  const drag = dnd({
    axis: 'x',
    group: 'tabs',
    lockAxis: true,
    onDrop(drop) {
      dropped = true;
      actions.moveList({ id: drop.id, beforeId: drop.beforeId, afterId: drop.afterId });
    },
  });
</script>

<div class="bar" bind:this={bar} data-print-hide>
  <div class="row" bind:this={row} role="tablist" aria-label="Lists" {...dndContainer({ id: 'tabs', group: 'tabs' })} {@attach drag}>
    <button class="tab ui-state" type="button" role="tab" aria-selected={active === STARRED} aria-label="Starred" onclick={() => onpick(STARRED)}>
      <Icon name="star-filled" size={20} />
    </button>
    {#each lists as list (list.id)}
      {@const count = listView(list.id).openCount}
      {@const selected = active === list.id}
      <button class="tab ui-state" type="button" role="tab" aria-selected={selected} {...dndItem({ id: list.id })} onclick={() => onpick(list.id)}>
        <span class="label">{list.title}</span>
        {#if list.shared}<Icon name="people" size={16} />{/if}
        {#if count > 0 && !selected}<span class="count">{count > 999 ? '999+' : count}</span>{/if}
      </button>
    {/each}
    <button class="tab new ui-state" type="button" onclick={onnew}>
      <Icon name="plus" size={18} />
      <span class="label">New list</span>
    </button>
    <span class="line" bind:this={line} aria-hidden="true"></span>
  </div>
</div>

<style>
  .bar {
    flex: none;
    overflow-x: auto;
    overflow-y: hidden;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
    box-shadow: inset 0 -1px 0 var(--divider);
  }
  .bar::-webkit-scrollbar {
    display: none;
  }
  .row {
    position: relative;
    display: inline-flex;
    align-items: stretch;
    min-width: 100%;
    height: 48px;
    padding: 0 max(4px, env(safe-area-inset-right)) 0 max(4px, env(safe-area-inset-left));
  }
  .tab {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 48px;
    max-width: 240px;
    padding: 0 14px;
    border-radius: 12px;
    color: var(--text-dim);
    font-size: 14px;
    font-weight: 500;
    line-height: 20px;
    white-space: nowrap;
  }
  .tab[aria-selected='true'] {
    color: var(--primary);
  }
  /* The ring of the focus must be in the bar, which clips. */
  .tab:focus-visible {
    outline-offset: -3px;
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .count {
    flex: none;
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    border-radius: 10px;
    background: var(--surface-3);
    color: var(--text-dim);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    line-height: 20px;
    text-align: center;
  }
  .new {
    gap: 4px;
    padding-left: 10px;
  }
  .line {
    position: absolute;
    left: 0;
    bottom: 0;
    width: 100px;
    height: 3px;
    border-radius: 3px 3px 0 0;
    background: var(--primary);
    opacity: 0;
    transform-origin: 0 50%;
    will-change: transform;
    pointer-events: none;
  }
</style>
