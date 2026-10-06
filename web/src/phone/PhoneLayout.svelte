<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { cancelDialogs } from '../common/dialogs.svelte.ts';
  import { syncBadge } from '../common/sync-badge.svelte.ts';
  import { createListFlow } from '../common/task-ops.ts';
  import { getList, getTask, listsOrdered, prefs, session } from '../data/index.ts';
  import type { ID } from '../../../shared/types.ts';
  import { app, openSettings, takeLaunch } from '../shell/app.svelte.ts';
  import { Icon, Menu, reducedMotion } from '../ui/index.ts';
  import AddSheet from './AddSheet.svelte';
  import { closeMenu, menu, openAdd, phone, runMenu, scrollMemory, STARRED } from './phone.svelte.ts';
  import TabBar from './TabBar.svelte';
  import TaskDetail from './TaskDetail.svelte';
  import TaskPage from './TaskPage.svelte';

  /** A page counts as at rest when no scroll event came for this time. */
  const SETTLE_MS = 120;
  /** A task from a notification can be on its way from the server. The screen waits this long for it. */
  const TASK_WAIT_MS = 15_000;

  const lists = $derived(listsOrdered());
  const tabIds = $derived([STARRED, ...lists.map((list) => list.id)]);

  // The state is in a module, and the layout can start again after a change of the window width.
  phone.detailId = null;
  phone.addOpen = false;
  scrollMemory.clear();
  phone.tab = untrack(() => {
    const saved = prefs.lastTab;
    if (saved !== null && (saved === STARRED || getList(saved))) return saved;
    return listsOrdered()[0]?.id ?? STARRED;
  });

  // The overlay stack of web/src/ui sets this variable on <html> when the first sheet or screen
  // opens. A new value of a variable on <html> makes the browser compute the style of each
  // element of the page again: with 500 rows, that is a pause at the first tap. The layout has no
  // scroll bar of the page, so the value is 0 at all times, and it is set here while the page is
  // small. The same value again costs nothing.
  document.documentElement.style.setProperty('--ui-scroll-gap', '0px');

  const activeIndex = $derived(Math.max(0, tabIds.indexOf(phone.tab)));

  // The list of the active tab went away: deleted, or the other person stopped the sharing.
  // The tab at the same place becomes active.
  let lastIndex = 0;
  $effect.pre(() => {
    const index = tabIds.indexOf(phone.tab);
    if (index >= 0) lastIndex = index;
    else phone.tab = tabIds[Math.min(lastIndex, tabIds.length - 1)] ?? STARRED;
  });

  $effect(() => {
    const tab = phone.tab;
    untrack(() => {
      if (prefs.lastTab !== tab) prefs.lastTab = tab;
    });
  });

  // ---- The pager ----

  let pager = $state<HTMLElement>();
  let tabBar = $state<ReturnType<typeof TabBar>>();
  /** The width of one page. A change of the window sets it, so a scroll handler reads no layout for it. */
  let width = 0;
  let frame = 0;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  /** A scroll that the code started is on its way. The active tab does not follow the places in between. */
  let jumping = false;
  /**
   * The pages next to this tab have content. It changes only when the pager is at rest: a page
   * with 500 rows must not be made in the middle of a swipe. null: only the active page, for
   * the first paint.
   */
  let settled = $state<string | null>(null);

  function hasContent(id: string, index: number): boolean {
    if (id === phone.tab) return true;
    if (settled === null) return false;
    const at = tabIds.indexOf(settled);
    return at >= 0 && Math.abs(index - at) <= 1;
  }

  /** Puts the pager at a page. */
  function place({ index, smooth }: { index: number; smooth: boolean }): void {
    if (!pager || width === 0) return;
    const left = index * width;
    if (Math.abs(pager.scrollLeft - left) < 1) {
      tabBar?.follow(index);
      return;
    }
    jumping = smooth;
    // 'auto' is a jump: the pager has no smooth scroll in its style.
    pager.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
    if (!smooth) tabBar?.follow(index);
  }

  /** Shows a tab. A page that is not next to the active one comes with no scroll through the pages between. */
  function goTo(id: string, { smooth = true }: { smooth?: boolean } = {}): void {
    const index = tabIds.indexOf(id);
    if (index < 0) return;
    const near = Math.abs(index - activeIndex) <= 1;
    phone.tab = id;
    place({ index, smooth: smooth && near && !reducedMotion() });
  }

  function track(): void {
    frame = 0;
    if (!pager || width === 0) return;
    const at = pager.scrollLeft / width;
    tabBar?.follow(at);
    if (jumping) return;
    const id = tabIds[Math.round(at)];
    if (id !== undefined && id !== phone.tab) phone.tab = id;
  }

  function settle(): void {
    clearTimeout(settleTimer);
    jumping = false;
    track();
    settled = phone.tab;
  }

  function onScroll(): void {
    frame ||= requestAnimationFrame(track);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, SETTLE_MS);
  }

  $effect(() => {
    const element = pager;
    if (!element) return;
    const fit = (): void => {
      const next = element.clientWidth;
      if (next === width) return;
      width = next;
      place({ index: untrack(() => activeIndex), smooth: false });
    };
    // The first page is in place before the first paint.
    untrack(fit);
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    // Not all browsers have this event. The timer of the scroll handler does the same work later.
    element.addEventListener('scrollend', settle);
    // The pages next to the first one get their content after the first paint.
    const later = setTimeout(() => (settled ??= phone.tab), 200);
    return () => {
      observer.disconnect();
      element.removeEventListener('scrollend', settle);
      clearTimeout(later);
      clearTimeout(settleTimer);
      cancelAnimationFrame(frame);
    };
  });

  // After a change of the lists, the page of the active tab can be at a different place in the pager.
  $effect(() => {
    void tabIds;
    untrack(() => place({ index: activeIndex, smooth: false }));
  });

  async function newList(): Promise<void> {
    const id = await createListFlow();
    if (id === null) return;
    // The pager must have the page of the new list before it can scroll there.
    await tick();
    goTo(id);
  }

  // ---- What the address of the page asked for, and a click on a notification ----

  let wanted = $state<ID | null>(null);

  $effect(() => {
    const { taskId, listId, newTask } = app.launch;
    if (taskId === null && listId === null && !newTask) return;
    untrack(() => {
      const launch = takeLaunch();
      if (launch.listId !== null) goTo(launch.listId, { smooth: false });
      if (launch.taskId !== null) wanted = launch.taskId;
      else if (launch.newTask) openAdd();
    });
  });

  $effect(() => {
    const id = wanted;
    if (id === null) return;
    const task = getTask(id);
    if (!task) {
      const timer = setTimeout(() => (wanted = null), TASK_WAIT_MS);
      return () => clearTimeout(timer);
    }
    untrack(() => {
      wanted = null;
      // The task must not open below a menu or a picker of a different task.
      closeMenu();
      cancelDialogs();
      phone.addOpen = false;
      goTo(task.listId, { smooth: false });
      phone.detailId = id;
    });
  });

  const initial = $derived((session.me?.name.trim()[0] ?? '?').toUpperCase());
  const badge = $derived(syncBadge.current);
  const BADGES = {
    offline: { icon: 'cloud-off', text: 'Offline. Your changes are saved on this device' },
    pending: { icon: 'sync', text: 'Changes wait for the server' },
    error: { icon: 'cloud-off', text: 'The sync has a problem' },
  } as const;
</script>

<!-- The empty touch handler makes iOS show the pressed state of the controls. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="phone" data-print-flow ontouchstart={() => {}}>
  <header class="top" data-print-hide>
    <h1>Tasks</h1>
    {#if badge}
      <button class={['sync ui-state', badge]} type="button" aria-label={BADGES[badge].text} data-testid="sync-badge" onclick={openSettings}>
        <Icon name={BADGES[badge].icon} size={20} />
      </button>
    {/if}
    <button class="account ui-state" type="button" aria-label="Account and settings" onclick={openSettings}>
      <span class="avatar">{initial}</span>
    </button>
  </header>

  <TabBar bind:this={tabBar} {lists} active={phone.tab} onpick={(id) => goTo(id)} onnew={() => void newList()} />

  <!-- A finger on the pager takes over from a scroll that the code started. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="pager" bind:this={pager} onscroll={onScroll} ontouchstart={() => (jumping = false)} data-print-flow>
    {#each tabIds as id, index (id)}
      <div class="page" role="tabpanel" aria-label={id === STARRED ? 'Starred' : getList(id)?.title} data-print-flow>
        {#if hasContent(id, index)}
          <TaskPage tab={id} active={id === phone.tab} />
        {/if}
      </div>
    {/each}
  </div>

  <button class="fab ui-state" type="button" aria-label="Add a task" data-print-hide onclick={openAdd}>
    <Icon name="plus" size={28} />
  </button>
</div>

<AddSheet />

{#if phone.detailId !== null}
  {@const id = phone.detailId}
  {#key id}
    <TaskDetail {id} />
  {/key}
{/if}

<!-- One menu for the layout. It is always there, so a menu that opens while the last one goes away shows. -->
<Menu bind:open={menu.open} items={menu.request?.items ?? []} title={menu.request?.title} label={menu.request?.title ?? 'Options'} onselect={runMenu} />

<style>
  .phone {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    display: flex;
    flex-direction: column;
    height: 100dvh;
    overflow: hidden;
    background: var(--bg);
    color: var(--text);
    /* No zoom with two taps. The scroll and the zoom with two fingers stay. */
    touch-action: manipulation;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }

  .top {
    display: flex;
    flex: none;
    align-items: center;
    gap: 4px;
    height: calc(56px + env(safe-area-inset-top));
    padding: env(safe-area-inset-top) max(8px, env(safe-area-inset-right)) 0 max(20px, env(safe-area-inset-left));
  }
  h1 {
    flex: 1;
    min-width: 0;
    font-size: 22px;
    font-weight: 500;
    line-height: 28px;
    letter-spacing: -0.01em;
  }
  .sync,
  .account {
    display: grid;
    flex: none;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
  }
  .sync {
    color: var(--text-dim);
    animation: badge-in var(--dur) var(--ease);
  }
  .sync.error {
    color: var(--danger);
  }
  @keyframes badge-in {
    from {
      opacity: 0;
      transform: scale(0.7);
    }
  }
  .avatar {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--primary);
    color: var(--on-primary);
    font-size: 15px;
    font-weight: 500;
    line-height: 1;
  }

  .pager {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow-x: auto;
    overflow-y: hidden;
    overscroll-behavior: contain;
    scroll-snap-type: x mandatory;
    scrollbar-width: none;
  }
  .pager::-webkit-scrollbar {
    display: none;
  }
  .page {
    flex: 0 0 100%;
    width: 100%;
    height: 100%;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior-y: contain;
    scroll-snap-align: start;
    scroll-snap-stop: always;
    /* The room at the bottom is for the add button, and for the snackbar above it. */
    padding: 12px max(12px, env(safe-area-inset-right)) calc(96px + env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left));
    /* A change in one page costs nothing in the pages next to it. */
    contain: layout paint style;
  }

  .fab {
    position: absolute;
    right: max(16px, env(safe-area-inset-right));
    bottom: calc(16px + env(safe-area-inset-bottom));
    z-index: var(--z-fab);
    display: grid;
    place-items: center;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: var(--primary);
    box-shadow: var(--shadow-2);
    color: var(--on-primary);
    transition: transform var(--dur-fast) var(--ease);
  }
  .fab:active {
    transform: scale(0.94);
  }

  /* The base has 40 px icon buttons. On a phone, the press area is 44 px. */
  :global(button.icon-btn.tap) {
    width: 44px;
    height: 44px;
  }
  /* The sheets and the dialogs are not in this layout, and they must not zoom with two taps too. */
  :global(.ui-overlays) {
    touch-action: manipulation;
  }

  @media print {
    .page {
      padding: 0;
      contain: none;
    }
  }
</style>
