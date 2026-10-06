<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import type { ViewItem } from '../../../shared/types.ts';
  import TaskChips from '../common/TaskChips.svelte';
  import { getList } from '../data/index.ts';
  import CheckCircle from '../ui/CheckCircle.svelte';
  import Icon from '../ui/Icon.svelte';
  import IconButton from '../ui/IconButton.svelte';
  import { layout } from '../ui/layout.svelte.ts';
  import { overlays } from '../ui/overlay.svelte.ts';
  import Star from '../ui/Star.svelte';
  import TaskEditor from './TaskEditor.svelte';
  import { complete, leaving, openTaskMenu, releaseMark, startEdit, toggleStar, useMark, type ColumnKey } from './state.svelte.ts';

  // The row of an open task. A click on its text opens it for editing in place.
  interface Props {
    item: ViewItem;
    column: ColumnKey;
    /** The heading above the row gives its date. */
    hideDate?: boolean;
    /** The Starred view: the row tells its list. */
    showList?: boolean;
    /** The row is an item of the drag and drop engine. */
    draggable?: boolean;
  }
  let { item, column, hideDate = false, showList = false, draggable = true }: Props = $props();

  const task = $derived(item.task);
  // The id is the key of the row, so it is the same for the life of this part.
  const id = untrack(() => item.task.id);
  const mark = useMark(id);
  onDestroy(() => releaseMark(id));
  const session = $derived(mark.session !== null && mark.session.column === column ? mark.session : null);
  /** A new row with no title yet. It is not a task. */
  const draft = $derived(session?.draft != null);
  const selected = $derived(mark.selected && !session);
  const going = $derived(leaving.has(task.id) || (task.parentId !== null && leaving.has(task.parentId)));
  const listTitle = $derived(showList ? (getList(task.listId)?.title ?? '') : '');

  // The buttons at the right are made when the pointer comes, so a long list has fewer elements.
  // A screen with no mouse shows them from the start.
  let warm = $state(!layout.hover);
  const tools = $derived(warm || selected || session !== null);
  let row = $state<HTMLElement>();

  // The selection moved here: the row gets the focus, so the Tab key continues from it, and it
  // comes into view. A text field or a dialog keeps the focus.
  $effect(() => {
    if (!selected || !row) return;
    const element = row;
    untrack(() => {
      const active = document.activeElement;
      if (overlays.count === 0 && !(active instanceof HTMLTextAreaElement) && !(active instanceof HTMLInputElement) && !element.contains(active)) {
        element.focus({ preventScroll: true });
      }
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  });

  function open(event: MouseEvent): void {
    if (going) return;
    const notes = event.target instanceof Element && event.target.closest('[data-notes]') !== null;
    startEdit({ task, column, field: notes ? 'notes' : 'title' });
  }

  function oncontextmenu(event: MouseEvent): void {
    // The browser menu stays for a text field, where it has "Paste" and the spelling.
    if (draft || going || event.target instanceof HTMLTextAreaElement) return;
    event.preventDefault();
    openTaskMenu({ task, anchor: { x: event.clientX, y: event.clientY } });
  }
</script>

<div
  bind:this={row}
  class={['row', { sub: item.depth === 1, open: session, selected, going }]}
  role="listitem"
  tabindex="-1"
  data-row-id={task.id}
  data-flow
  data-dnd-id={draggable ? task.id : undefined}
  data-dnd-depth={draggable ? item.depth : undefined}
  onpointerenter={() => (warm = true)}
  {oncontextmenu}
>
  {#if session}
    <span class="grip" aria-hidden="true" data-print-hide><Icon name="drag" size={18} /></span>
  {/if}
  <span class="check" data-dnd-ignore>
    <CheckCircle checked={going} size={36} disabled={draft} onchange={() => complete(task)} />
  </span>
  {#if session}
    <TaskEditor {task} {session} pickList={showList} />
  {:else}
    <!-- The button in it takes the keys, and its click comes here too. -->
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="main" onclick={open}>
      <button class="title" type="button">{task.title}</button>
      {#if task.notes}<p class="notes" data-notes>{task.notes}</p>{/if}
      {#if task.due !== null || task.deadline !== null}
        <div class="chips"><TaskChips {task} {hideDate} /></div>
      {/if}
      {#if showList}<p class="where">{listTitle}</p>{/if}
    </div>
  {/if}
  <div class="tools" data-dnd-ignore data-print-hide>
    {#if tools && !draft}
      <IconButton
        class="more"
        icon="more"
        label="Task options"
        size="sm"
        onclick={(event) => openTaskMenu({ task, anchor: event.currentTarget, align: 'end' })}
      />
    {/if}
    {#if tools || task.starred}
      <Star starred={task.starred} size={32} onchange={() => toggleStar(task)} />
    {/if}
  </div>
</div>

<style>
  /* No positioned element in a closed row: each one is a paint layer, and a board with
     thousands of them makes each frame and each hit test slow. */
  .row {
    display: flex;
    align-items: flex-start;
    min-height: 40px;
    padding: 2px 2px 2px 4px;
    border-radius: 10px;
    outline: none;
    /* On the row itself: the copy that the drag engine lifts is not below the layout. */
    --row-hover: color-mix(in srgb, var(--text) 6%, var(--surface));
    --row-open: color-mix(in srgb, var(--primary) 7%, var(--surface));
    --row-plate: var(--surface);
    --dnd-lift-radius: 10px;
  }
  .sub {
    margin-left: 28px;
  }
  @media (hover: hover) {
    .row:hover {
      background: var(--row-hover);
      --row-plate: var(--row-hover);
    }
  }
  .open,
  .open:hover {
    /* For the handle. */
    position: relative;
    background: var(--row-open);
    --row-plate: var(--row-open);
  }
  /* The ring is inside the box: the column clips what is outside it. */
  .selected {
    box-shadow: inset 0 0 0 2px var(--primary);
  }

  .check {
    display: flex;
    flex: none;
  }
  .grip {
    position: absolute;
    left: -9px;
    top: 2px;
    z-index: 1;
    display: grid;
    place-items: center;
    width: 20px;
    height: 36px;
    color: var(--text-dim);
    opacity: 0.7;
    cursor: grab;
  }

  .main {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: flex-start;
    min-width: 0;
    padding: 8px 0 8px 2px;
    cursor: text;
  }
  .title {
    max-width: 100%;
    color: var(--text);
    font-size: var(--row-font, 14px);
    line-height: 20px;
    text-align: left;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    cursor: inherit;
  }
  .title:focus-visible {
    border-radius: 4px;
  }
  .notes {
    display: -webkit-box;
    max-width: 100%;
    margin-top: 2px;
    overflow: hidden;
    color: var(--text-dim);
    font-size: 12.5px;
    line-height: 17px;
    white-space: pre-line;
    overflow-wrap: anywhere;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
  .chips {
    max-width: 100%;
    margin-top: 6px;
    cursor: default;
  }
  .where {
    margin-top: 4px;
    color: var(--text-dim);
    font-size: 12px;
    line-height: 16px;
  }

  /* The title gets a line through it, then the row goes out of view and the data changes. */
  .going .title {
    color: var(--text-dim);
    text-decoration: line-through;
  }
  .going {
    animation: row-going 300ms linear forwards;
  }
  @keyframes row-going {
    0%,
    55% {
      opacity: 1;
    }
    100% {
      opacity: 0.2;
    }
  }

  /* The box has the width of the star. The three-dot button is to the left of it, above the
     end of a long title: a flex item paints above the items before it, and its plate hides the
     letters below. */
  .tools {
    display: flex;
    flex: none;
    justify-content: flex-end;
    width: 34px;
    margin-top: 2px;
  }
  .tools :global(.more) {
    background: var(--row-plate);
    /* A soft edge, so the letters do not end at a hard line. */
    box-shadow: -6px 0 6px var(--row-plate);
  }
  .tools :global(.more),
  .tools :global(.star:not(.on)) {
    visibility: hidden;
  }
  .row:hover .tools :global(*),
  .row:focus-within .tools :global(*),
  .selected .tools :global(*),
  .open .tools :global(*) {
    visibility: visible;
  }
  @media (hover: none) {
    .tools :global(*) {
      visibility: visible;
    }
  }
</style>
