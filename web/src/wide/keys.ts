// The keyboard shortcuts of the wide layout (SPEC.md section 8). They work on the selected row.
// The notes views have their own short table, and the keys of the tasks do nothing there.
// Ctrl+Z is in the shell, because it is the same in the two layouts.

import { isOpen } from '../../../shared/view.ts';
import { printList } from '../common/print.ts';
import { hasMod } from '../common/shortcuts.ts';
import { actions, getList, getTask, store } from '../data/index.ts';
import { openShortcuts } from '../shell/app.svelte.ts';
import { overlays } from '../ui/overlay.svelte.ts';
import { rowElement } from './flow.ts';
import {
  closeEdit,
  columnOf,
  complete,
  compose,
  currentColumn,
  draftChild,
  draftTop,
  focusSearch,
  moveBy,
  moveColumn,
  moveSelection,
  moveToEdge,
  openTaskMenu,
  removeTask,
  selectEdge,
  startEdit,
  STARRED,
  toggleStar,
  ui,
  uncomplete,
} from './state.svelte.ts';

function isTextField(element: EventTarget | null): boolean {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
  if (element instanceof HTMLInputElement) return !['checkbox', 'radio', 'button', 'submit', 'range'].includes(element.type);
  return element instanceof HTMLElement && element.isContentEditable;
}

/** A control that uses Enter and Space itself. */
function isControl(element: EventTarget | null): boolean {
  return element instanceof Element && element.closest('button, a[href], input, select, summary, [role="button"], [role="checkbox"]') !== null;
}

/** Handles a key press on the window. Does nothing while a dialog or a menu is open, or in a text field. */
export function handleKey(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing || overlays.count > 0) return;
  // The open row has its own keys. Esc closes it also when the focus is not in it.
  if (ui.edit) {
    if (event.key === 'Escape' && !isTextField(event.target)) {
      event.preventDefault();
      closeEdit({ select: true });
    }
    return;
  }
  if (isTextField(event.target)) return;

  const mod = hasMod(event);
  const other = event.altKey || (mod ? false : event.ctrlKey || event.metaKey);
  const plain = !mod && !other;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const id = ui.selectedId;
  const task = id === null ? undefined : getTask(id);
  // A repeating task that rests is in "Completed" too.
  const open = task !== undefined && isOpen({ task, today: store.today });
  const done = (): void => event.preventDefault();

  if ((plain && event.key === '?') || (mod && !event.altKey && event.key === '/')) {
    done();
    openShortcuts();
    return;
  }

  if (ui.notes) {
    if (plain) notesKey(event, key);
    return;
  }

  if (mod && !event.altKey && key === 'p') {
    const column = currentColumn();
    // With no list, the browser prints the page.
    if (column === null || column === STARRED || !getList(column)) return;
    done();
    printList(column);
    return;
  }

  if (key === 'ArrowUp' || key === 'ArrowDown') {
    if (other) return;
    done();
    const step = key === 'ArrowUp' ? -1 : 1;
    if (!mod) moveSelection(step);
    else if (task && open && event.shiftKey) moveToEdge({ task, edge: step < 0 ? 'top' : 'bottom' });
    else if (task && open) moveBy({ task, step });
    return;
  }
  if (plain && (key === 'ArrowLeft' || key === 'ArrowRight')) {
    done();
    moveColumn(key === 'ArrowLeft' ? -1 : 1);
    return;
  }
  if (plain && (key === 'Home' || key === 'End')) {
    done();
    selectEdge(key === 'Home' ? 'first' : 'last');
    return;
  }
  if (plain && key === 'n') {
    const column = currentColumn();
    if (column === null) return;
    done();
    draftTop(column);
    return;
  }

  if (!task || id === null) return;
  const column = columnOf(id);
  if (column === null) return;

  if (key === 'Enter') {
    if (mod && event.altKey) {
      done();
      if (open) draftChild({ task, column });
    } else if (plain && !isControl(event.target)) {
      done();
      if (open) startEdit({ task, column });
    }
    return;
  }
  if (plain && key === ' ') {
    if (isControl(event.target)) return;
    done();
    if (event.repeat) return;
    if (open) complete(task);
    else uncomplete(task);
    return;
  }
  if (plain && (key === 'Delete' || key === 'Backspace')) {
    done();
    if (!event.repeat) removeTask(task);
    return;
  }
  if (!open) return;

  if (mod && !event.altKey && (key === ']' || key === '[')) {
    done();
    if (key === ']') actions.indentTask({ id });
    else actions.unindentTask({ id });
  } else if (plain && (key === '.' || key === 'v')) {
    done();
    const row = rowElement(id);
    const anchor = row?.querySelector('.more') ?? row;
    if (anchor) openTaskMenu({ task, anchor, align: 'end' });
  } else if (plain && key === 's') {
    done();
    toggleStar(task);
  }
}

/** The keys of the Notes view and of the Archive view. */
function notesKey(event: KeyboardEvent, key: string): void {
  if (key === 'n' || key === 'c') {
    event.preventDefault();
    // A key that stays down must not open a second note.
    if (!event.repeat) compose();
  } else if (key === '/') {
    event.preventDefault();
    focusSearch();
  } else if (key === 'Escape' && ui.composerOpen) {
    // The composer uses Esc itself while the focus is in it. This is for a focus outside of it.
    event.preventDefault();
    ui.composerOpen = false;
  }
}
