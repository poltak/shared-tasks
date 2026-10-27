<script lang="ts">
  import { untrack } from 'svelte';
  import type { ID, TaskRow } from '../../../shared/types.ts';
  import { isOpen } from '../../../shared/view.ts';
  import '../ui/tooltip.ts';
  import { getList, getNote, getTask, prefs, store, toast } from '../data/index.ts';
  import { app, takeLaunch, type Launch } from '../shell/app.svelte.ts';
  import Menu from '../ui/Menu.svelte';
  import { reducedMotion } from '../ui/motion.ts';
  import Board from './Board.svelte';
  import { handleKey } from './keys.ts';
  import { lazy } from './lazy.svelte.ts';
  import NotesBoard from './NotesBoard.svelte';
  import Sidebar from './Sidebar.svelte';
  import StarredColumn from './StarredColumn.svelte';
  import TopBar from './TopBar.svelte';
  import {
    closeEdit,
    closeRepeat,
    compose,
    openNote,
    press,
    resetNotes,
    runMenu,
    select,
    settle,
    showList,
    showView,
    startEdit,
    ui,
  } from './state.svelte.ts';

  // The layout for a window of 840 px or more: a bar, a sidebar, and one column for each list.
  const SIDEBAR_WIDTH = 280;
  /** The same time and curve as the sidebar itself has in the styles below. */
  const SLIDE = { duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' };

  // The dialogs come after the columns are on the screen.
  const createDialog = lazy(() => import('./CreateDialog.svelte'));
  const repeatDialog = lazy(() => import('../ui/RepeatDialog.svelte'));
  $effect(() => {
    const later = (): void => void createDialog.get();
    if (typeof requestIdleCallback !== 'function') {
      const timer = setTimeout(later, 1500);
      return () => clearTimeout(timer);
    }
    const handle = requestIdleCallback(later, { timeout: 3000 });
    return () => cancelIdleCallback(handle);
  });
  $effect(() => {
    if (ui.createOpen) void createDialog.get();
  });
  $effect(() => {
    if (ui.repeat) void repeatDialog.get();
  });

  // The notes parts are one download (SPEC section 8, "Notes"). It starts when a notes view first
  // shows, and the board shows when it is there, with no spinner.
  const notes = lazy(() => import('../notes/index.ts').then((parts) => ({ default: parts })));
  $effect(() => {
    if (!ui.notes) return;
    void notes.get().then((ok) => {
      if (!ok) toast.show({ message: 'The notes could not load. Check the connection', action: { label: 'Reload', run: () => location.reload() } });
    });
  });

  // ---- The sidebar ----

  let main = $state<HTMLElement>();
  /** The main area leaves room for the sidebar. It follows `prefs.sidebarOpen`, after the motion. */
  let inset = $state(prefs.sidebarOpen);
  let motion: Animation | null = null;

  // Only transforms move. The width of the main area changes at the moment when the area that
  // comes or goes is out of the window: before the motion at a close, after it at an open.
  $effect(() => {
    const open = prefs.sidebarOpen;
    const area = main;
    untrack(() => {
      motion?.cancel();
      motion = null;
      if (open === inset) return;
      if (!area || reducedMotion()) {
        inset = open;
        return;
      }
      if (open) {
        motion = area.animate([{ transform: 'none' }, { transform: `translateX(${SIDEBAR_WIDTH}px)` }], SLIDE);
        motion.onfinish = () => (inset = true);
      } else {
        inset = false;
        motion = area.animate([{ transform: `translateX(${SIDEBAR_WIDTH}px)` }, { transform: 'none' }], SLIDE);
      }
    });
  });

  // ---- The open row closes with a click outside of it ----

  function inOpenRow(target: EventTarget | null): boolean {
    if (!(target instanceof Element) || !ui.edit) return false;
    // A menu or a dialog that the row opened is a part of it.
    if (target.closest('.ui-overlays, .ui-tooltip, .dnd-layer')) return true;
    return target.closest('[data-row-id]')?.getAttribute('data-row-id') === ui.edit.id;
  }

  // The click closes the row, and not the press: the rows below move up when the row closes,
  // and a click on one of them would then go to a different row.
  $effect(() => {
    const down = (event: PointerEvent): void => {
      press.outside = ui.edit !== null && !inOpenRow(event.target);
    };
    const click = (event: MouseEvent): void => {
      if (ui.edit && !inOpenRow(event.target)) closeEdit();
      press.outside = false;
      // A click on the board next to the rows takes the ring away.
      const target = event.target;
      if (target instanceof Element && main?.contains(target) && !target.closest('[data-row-id]')) select(null);
    };
    // A press that gives no click (on a scroll bar): the click of this press, if there is one,
    // comes before the timer.
    const up = (): void => void setTimeout(() => (press.outside = false), 0);
    // A completed row that waits, and text that waits for its pause, are saved before the page goes.
    const hide = (): void => {
      if (document.visibilityState === 'hidden') settle();
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('click', click, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    document.addEventListener('visibilitychange', hide, true);
    window.addEventListener('pagehide', settle, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('click', click, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      document.removeEventListener('visibilitychange', hide, true);
      window.removeEventListener('pagehide', settle, true);
      settle();
      closeEdit();
      select(null);
      resetNotes();
    };
  });

  // ---- What the address of the page asked for ----

  /** A task that the address asked for and that this device does not have yet. */
  let wanted = $state<ID | null>(null);
  /** The same for a note. */
  let wantedNote = $state<ID | null>(null);

  function openTask(task: TaskRow): void {
    showList(task.listId);
    if (isOpen({ task, today: store.today })) return startEdit({ task, column: task.listId });
    // The row is in "Completed".
    if (!prefs.completedOpen[task.listId]) prefs.completedOpen = { ...prefs.completedOpen, [task.listId]: true };
    select(task.id);
  }

  function act(launch: Launch): void {
    if (launch.newTask) ui.createOpen = true;
    if (launch.taskId !== null) wanted = launch.taskId;
    else if (launch.listId !== null && getList(launch.listId)) showList(launch.listId);
    // The notes show at once. The archive replaces them if the note is archived when it is there.
    if (launch.noteId !== null) {
      showView('notes');
      wantedNote = launch.noteId;
    } else if (launch.newNote) compose({ now: false });
  }

  $effect(() => {
    const { taskId, listId, newTask, noteId, newNote } = app.launch;
    if (taskId === null && listId === null && !newTask && noteId === null && !newNote) return;
    untrack(() => act(takeLaunch()));
  });

  // The task of a notification can come with the next sync. After some seconds the request ends.
  $effect(() => {
    const id = wanted;
    if (id === null) return;
    const task = getTask(id);
    if (task) {
      untrack(() => {
        wanted = null;
        openTask(task);
      });
      return;
    }
    const timer = setTimeout(() => (wanted = null), 8000);
    return () => clearTimeout(timer);
  });

  // The editor of a note that is not on the device would close at once, so it waits for the row.
  $effect(() => {
    const id = wantedNote;
    if (id === null) return;
    const note = getNote(id);
    if (note) {
      untrack(() => {
        wantedNote = null;
        // The person can have gone to a different view while the note was on the way.
        if (!ui.notes) return;
        showView(note.archived ? 'archive' : 'notes');
        openNote(id);
      });
      return;
    }
    const timer = setTimeout(() => (wantedNote = null), 8000);
    return () => clearTimeout(timer);
  });
</script>

<svelte:window onkeydown={handleKey} />

<div class="wide" data-print-flow>
  <TopBar />
  <div class="frame" data-print-flow>
    <aside id="wide-sidebar" class={['sidebar', { open: prefs.sidebarOpen }]} inert={!prefs.sidebarOpen} data-print-hide>
      <Sidebar />
    </aside>
    <main class={['main', { inset }]} bind:this={main} data-print-flow>
      {#if ui.notes}
        {#if notes.part}<NotesBoard parts={notes.part} />{/if}
      {:else if ui.starred}
        <StarredColumn />
      {:else}
        <Board />
      {/if}
    </main>
  </div>
</div>

{#if ui.menu}
  <!-- The menu stays mounted and only its `open` changes: it then gives the focus back at the
       moment of the close, and not after its motion. -->
  <Menu
    bind:open={() => ui.menuOpen, (open) => (ui.menuOpen = open)}
    anchor={ui.menu.anchor}
    items={ui.menu.items}
    align={ui.menu.align}
    label={ui.menu.label}
    onselect={runMenu}
  />
{/if}
{#if ui.createOpen && createDialog.part}
  <createDialog.part />
{/if}
{#if ui.repeat && repeatDialog.part}
  <repeatDialog.part
    open
    rule={ui.repeat.rule}
    time={ui.repeat.time}
    date={ui.repeat.date}
    today={store.today}
    ondone={(result) => closeRepeat(result)}
    oncancel={() => closeRepeat(null)}
  />
{/if}

<style>
  .wide {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    overflow: hidden;
    background: var(--bg);
    --row-font: 14px;
    --row-notes-font: 13px;
  }
  /* A finger opens the keyboard of a tablet. iOS then zooms into a field with small text. */
  @media (pointer: coarse) {
    .wide {
      --row-font: 16px;
      --row-notes-font: 16px;
    }
  }
  .frame {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .sidebar {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 280px;
    opacity: 0;
    visibility: hidden;
    transform: translateX(-100%);
    transition:
      transform var(--dur-slow) var(--ease),
      opacity var(--dur-slow) linear,
      visibility 0s linear var(--dur-slow);
  }
  .sidebar.open {
    opacity: 1;
    visibility: visible;
    transform: none;
    transition-delay: 0s;
  }
  .main {
    height: 100%;
    min-width: 0;
    padding-left: 20px;
  }
  .main.inset {
    margin-left: 280px;
    padding-left: 0;
  }

  @media print {
    .wide {
      background: none;
    }
  }
</style>
