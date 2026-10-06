<script lang="ts">
  import { untrack } from 'svelte';
  import type { ID, ViewGroup, ViewItem } from '../../../shared/types.ts';
  import { listMenuItems, runListMenuItem, runStarredMenuItem, sortMenuItems, starredMenuItems } from '../common/menus.ts';
  import { isOwner, ownerName } from '../common/task-ops.ts';
  import { actions, getList, getTask, listView, otherUser, prefs, starredView } from '../data/index.ts';
  import { dnd, dndContainer, type DndOptions } from '../dnd/index.ts';
  import { EmptyState, Icon, IconButton } from '../ui/index.ts';
  import { createFlip } from './flip.ts';
  import { openMenu, phone, scrollMemory, STARRED } from './phone.svelte.ts';
  import TaskRow from './TaskRow.svelte';

  interface Props {
    /** A list id, or STARRED. */
    tab: string;
    /** The page is the one on the screen. */
    active: boolean;
  }
  let { tab, active }: Props = $props();

  /** The first paint of a page has this number of rows. It fills the screen of a phone two times. */
  const FIRST_ROWS = 40;
  /** The other rows come in parts of this size, so a long list does not hold the screen. */
  const MORE_ROWS = 100;
  const COMPLETED_STEP = 50;

  const starred = $derived(tab === STARRED);
  const list = $derived(starred ? undefined : getList(tab));
  const view = $derived(starred ? starredView() : listView(tab));
  const total = $derived(view.groups.reduce((sum, group) => sum + group.items.length, 0));
  const doneCount = $derived(view.completed.length);
  const doneOpen = $derived(prefs.completedOpen[tab] === true);
  const dateSort = $derived(starred ? prefs.starredSort === 'date' : list?.sort === 'date');
  const sharing = $derived.by(() => {
    if (!list?.shared) return null;
    if (!isOwner(list)) return `Shared by ${ownerName(list)}`;
    const other = otherUser();
    return other ? `Shared with ${other.name}` : 'Shared';
  });

  let root = $state<HTMLElement>();

  // ---- Rows in parts ----

  // A page that comes back at a scroll position needs all its rows at once.
  let limit = $state(untrack(() => ((scrollMemory.get(tab) ?? 0) > 0 ? Infinity : FIRST_ROWS)));

  $effect(() => {
    if (limit === Infinity) return;
    if (limit >= total) {
      limit = Infinity;
      return;
    }
    const next = limit + MORE_ROWS;
    const timer = setTimeout(() => (limit = next), 32);
    return () => clearTimeout(timer);
  });

  /** The rows of a group that show while the page has only a part of its rows. */
  function part(group: ViewGroup, index: number): ViewItem[] {
    if (limit === Infinity) return group.items;
    let before = 0;
    for (let i = 0; i < index; i++) before += view.groups[i]!.items.length;
    return before + group.items.length <= limit ? group.items : group.items.slice(0, Math.max(0, limit - before));
  }

  // ---- "Completed" in steps ----

  let doneShown = $state(COMPLETED_STEP);

  /** The element after the last row. When it comes near the screen, the next rows come. */
  function moreCompleted(node: HTMLElement): () => void {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) doneShown += COMPLETED_STEP;
      },
      { root: node.closest('.page'), rootMargin: '600px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }

  function toggleCompleted(): void {
    if (doneOpen) doneShown = COMPLETED_STEP;
    prefs.completedOpen = { ...prefs.completedOpen, [tab]: !doneOpen };
  }

  // ---- Motion ----

  /** A drag has its own motion. It ends some time after the drop. */
  let dragging = false;
  let dragTimer: ReturnType<typeof setTimeout> | undefined;

  const flip = createFlip({
    root: () => root,
    scroller: () => root?.parentElement,
    // A page that is not in view, or below the detail screen, needs no motion.
    enabled: () => active && limit === Infinity && phone.detailId === null && !dragging && !document.hidden,
  });

  $effect.pre(() => {
    void view;
    void doneOpen;
    untrack(flip.capture);
  });
  $effect(() => {
    void view;
    void doneOpen;
    untrack(flip.play);
  });

  // ---- Scroll position ----

  $effect(() => {
    const scroller = root?.parentElement;
    if (!scroller) return;
    const key = tab;
    const top = scrollMemory.get(key) ?? 0;
    if (top > 0) scroller.scrollTop = top;
    const remember = (): void => void scrollMemory.set(key, scroller.scrollTop);
    scroller.addEventListener('scroll', remember, { passive: true });
    return () => scroller.removeEventListener('scroll', remember);
  });

  // ---- Drag ----

  /** The tasks that have subtasks, at the start of a drag. Such a task cannot become a subtask. */
  let parents = new Set<ID>();

  const dragOptions: DndOptions = {
    group: 'tasks',
    lockAxis: true,
    // SPEC section 8: the order can change only in the "My order" sort.
    get disabled() {
      return starred || list?.sort !== 'my' || limit !== Infinity;
    },
    maxDepthAt: ({ id }) => (parents.has(id) || getTask(id)?.repeat ? 0 : 1),
    onDragStart() {
      clearTimeout(dragTimer);
      dragging = true;
      parents = new Set();
      for (const group of view.groups) for (const item of group.items) if (item.hasChildren) parents.add(item.task.id);
    },
    onDrop(drop) {
      flip.pause();
      actions.moveTask({ id: drop.id, listId: tab, parentId: drop.parentId, beforeId: drop.beforeId, afterId: drop.afterId });
    },
    onDragEnd() {
      dragTimer = setTimeout(() => (dragging = false), 320);
    },
  };
  // Made one time: a new function in the template would start the engine again at each change.
  const drag = dnd(dragOptions);

  // ---- Menus ----

  function openSort(): void {
    if (starred) {
      openMenu({ title: 'Starred', items: starredMenuItems(), run: runStarredMenuItem });
    } else if (list) {
      const row = list;
      openMenu({ title: 'Sort by', items: sortMenuItems({ list: row }), run: (itemId) => void runListMenuItem({ list: row, itemId }) });
    }
  }

  function openListMenu(): void {
    if (!list) return;
    const row = list;
    openMenu({
      title: row.title,
      items: listMenuItems({ list: row, layout: 'phone' }),
      run: (itemId) => void runListMenuItem({ list: row, itemId }),
    });
  }
</script>

<div class="content" bind:this={root} data-print-list={starred ? undefined : tab}>
  <section class="card" data-flip-block="card">
    <header class="head">
      <div class="names">
        <h2 class="name">{starred ? 'Starred' : (list?.title ?? '')}</h2>
        {#if sharing}
          <p class="sharing"><Icon name="people" size={14} /><span>{sharing}</span></p>
        {/if}
      </div>
      <span class="tools" data-print-hide>
        <IconButton class="tap" icon="sort" label="Sort" tooltip={false} onclick={openSort} />
        {#if !starred}
          <IconButton class="tap" icon="more" label="List options" tooltip={false} onclick={openListMenu} />
        {/if}
      </span>
    </header>

    {#if total > 0}
      <ul class="rows" data-flip-list {...dndContainer({ id: tab, group: 'tasks' })} {@attach drag}>
        {#each view.groups as group, index (group.key)}
          {@const items = part(group, index)}
          {#if group.heading !== null && items.length > 0}
            <li class={['heading', { past: group.tone === 'past' }]}>{group.heading}</li>
          {/if}
          {#each items as item (item.task.id)}
            <TaskRow
              task={item.task}
              depth={item.depth}
              hideDate={dateSort && group.tone !== 'past'}
              origin={starred ? (getList(item.task.listId)?.title ?? '') : undefined}
            />
          {/each}
        {/each}
      </ul>
    {:else}
      <div class="empty" data-flip-block>
        {#if starred}
          <EmptyState title="No starred tasks" text="Star a task to find it here" />
        {:else if doneCount > 0}
          <EmptyState kind="done" title="All done" text="Every task in this list is complete" />
        {:else}
          <EmptyState title="Nothing here yet" text="Add a task to get started" />
        {/if}
      </div>
    {/if}
  </section>

  {#if doneCount > 0}
    <section class="card" data-flip-block="card">
      <button class="done-head ui-state" type="button" aria-expanded={doneOpen} onclick={toggleCompleted}>
        <span>Completed ({doneCount})</span>
        <span class={['chevron', { open: doneOpen }]}><Icon name="chevron-down" /></span>
      </button>
      {#if doneOpen}
        <ul class="rows" data-flip-list>
          {#each doneShown >= doneCount ? view.completed : view.completed.slice(0, doneShown) as task (task.id)}
            <TaskRow {task} completed />
          {/each}
        </ul>
        {#if doneShown < doneCount}
          <div class="more" {@attach moreCompleted}></div>
        {/if}
      {/if}
    </section>
  {/if}
</div>

<style>
  .content {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 12px;
    animation: page-in var(--dur) var(--ease);
  }
  /* A page that the person jumped to comes in softly. A page next to the screen is out of view when it gets its content. */
  @keyframes page-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }

  .card {
    position: relative;
    isolation: isolate;
    border-radius: var(--radius-card);
    background: var(--surface);
    box-shadow: var(--shadow-1);
  }

  .head {
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 60px;
    /* The buttons at the right are in line with the stars of the rows. */
    padding: 8px 8px 4px 20px;
  }
  .names {
    flex: 1;
    min-width: 0;
  }
  .name {
    overflow: hidden;
    font-size: 20px;
    font-weight: 500;
    line-height: 28px;
    letter-spacing: -0.01em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sharing {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--text-dim);
    font-size: 12px;
    font-weight: 500;
    line-height: 16px;
  }
  .sharing span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tools {
    display: flex;
    flex: none;
  }

  .rows {
    position: relative;
    padding: 0 4px 8px;
    --dnd-lift-radius: 12px;
  }
  .heading {
    padding: 14px 16px 2px;
    color: var(--text-dim);
    font-size: 13px;
    font-weight: 500;
    line-height: 18px;
  }
  .heading.past {
    color: var(--danger);
  }
  .heading:first-child {
    padding-top: 4px;
  }

  .empty {
    padding: 8px 0 12px;
  }

  .done-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    min-height: 56px;
    padding: 0 14px 0 20px;
    border-radius: var(--radius-card);
    color: var(--text);
    font-size: 15px;
    font-weight: 500;
    line-height: 22px;
    text-align: left;
  }
  .chevron {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    color: var(--text-dim);
    transition: transform var(--dur) var(--ease);
  }
  .chevron.open {
    transform: rotate(180deg);
  }
  .more {
    height: 1px;
  }
</style>
