<script lang="ts" module>
  /** The browser can make a text area as high as its text. If not, the editor sets the height. */
  const AUTO_SIZE = typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content');
</script>

<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { describeRule } from '../../../shared/recurrence.ts';
  import { LIMITS } from '../../../shared/types.ts';
  import type { TaskRow } from '../../../shared/types.ts';
  import { pickDate, pickDeadline } from '../common/dialogs.svelte.ts';
  import { hasMod } from '../common/shortcuts.ts';
  import { isSubtask, stopRepeat } from '../common/task-ops.ts';
  import { actions, getList, getTask, store } from '../data/index.ts';
  import Chip from '../ui/Chip.svelte';
  import DateChip from '../ui/DateChip.svelte';
  import DeadlineChip from '../ui/DeadlineChip.svelte';
  import Icon from '../ui/Icon.svelte';
  import IconButton from '../ui/IconButton.svelte';
  import { overlayRoot, overlays } from '../ui/overlay.svelte.ts';
  import {
    closeEdit,
    draftChild,
    dropDraft,
    enterEdit,
    flushEdit,
    openListPicker,
    openRepeat,
    press,
    setDraftList,
    setEditDate,
    setEditDay,
    setEditDeadline,
    touchEdit,
    ui,
    type EditSession,
  } from './state.svelte.ts';

  // The content of a row that is open for editing: the title, the details, and the date controls.
  // The session keeps the text, so this part can go away and come back (the row moved to a
  // different group or column) with no loss.
  interface Props {
    /** The task, or the row of a draft that is not a task yet. */
    task: TaskRow;
    session: EditSession;
    /** The Starred view: a new task shows a control for its list. */
    pickList?: boolean;
  }
  let { task, session, pickList = false }: Props = $props();

  const locale = navigator.language;
  let root = $state<HTMLElement>();
  let titleField = $state<HTMLTextAreaElement>();
  let notesField = $state<HTMLTextAreaElement>();

  const draft = $derived(session.draft);
  const canRepeat = $derived(draft ? draft.parentId === null : !isSubtask(task));
  const listTitle = $derived(draft ? (getList(draft.listId)?.title ?? '') : '');

  const fieldOf = (): HTMLTextAreaElement | undefined => (session.field === 'notes' ? notesField : titleField);
  const mine = (): boolean => ui.edit === session;

  /**
   * true while a menu or a dialog has the focus. One that plays the motion of its close is
   * still in the stack, but it is inert: the person can type in the row again at once.
   */
  function overlayOpen(): boolean {
    return overlays.count > 0 && overlayRoot().querySelector(':is([role="dialog"], [role="menu"]):not([inert])') !== null;
  }

  function focusField(): void {
    const field = fieldOf();
    if (!field || !mine() || overlayOpen() || document.activeElement === field) return;
    field.focus({ preventScroll: true });
    if (session.selectAll) field.select();
    else if (session.caret) field.setSelectionRange(session.caret[0], session.caret[1]);
    else field.setSelectionRange(field.value.length, field.value.length);
    session.selectAll = false;
    field.closest('[data-row-id]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /**
   * The text gets the focus back: the browser moved the row, or a menu or a dialog closed and
   * gave the focus to the button that opened it.
   */
  function focusIfLost(): void {
    // After all effects of this change: a menu that closes gives the focus back in one of them.
    void tick().then(() => {
      const active = document.activeElement;
      if (mine() && !press.outside && active !== titleField && active !== notesField) focusField();
    });
  }

  // The fields are new elements: the row opened, or it came back at a new place.
  $effect(() => {
    if (!titleField || !notesField) return;
    untrack(() => {
      focusField();
      focusIfLost();
    });
  });

  // A menu or a dialog of the row closed.
  $effect(() => {
    void overlays.count;
    void ui.menuOpen;
    void ui.repeat;
    untrack(focusIfLost);
  });

  // A change from a different device shows in a field that the person did not change.
  $effect(() => {
    if (session.draft) return;
    const { title, notes } = task;
    untrack(() => {
      if (!session.dirtyTitle && session.title !== title) session.title = title;
      if (!session.dirtyNotes && session.notes !== notes) session.notes = notes;
    });
  });

  $effect(() => {
    if (AUTO_SIZE) return;
    void session.title;
    void session.notes;
    for (const field of [titleField, notesField]) {
      if (!field) continue;
      field.style.height = 'auto';
      field.style.height = `${field.scrollHeight}px`;
    }
  });

  function keepCaret(event: Event): void {
    const field = event.currentTarget as HTMLTextAreaElement;
    session.field = field === notesField ? 'notes' : 'title';
    session.caret = [field.selectionStart, field.selectionEnd];
  }

  function onfocusout(event: FocusEvent): void {
    const next = event.relatedTarget;
    const row = root?.closest('[data-row-id]');
    if (!(next instanceof Element) || next === row) return focusIfLost();
    if (row?.contains(next) || next.closest('.ui-overlays')) return;
    // A press on a different control: the click closes the row, when the rows can move.
    if (press.outside) return;
    // The Tab key took the focus to a control of a different row.
    if (mine()) closeEdit();
  }

  function sharedKey(event: KeyboardEvent): boolean {
    const mod = hasMod(event);
    if (event.key === 'Escape') {
      event.preventDefault();
      closeEdit({ select: true });
      return true;
    }
    if (mod && event.altKey && event.key === 'Enter') {
      event.preventDefault();
      flushEdit();
      const made = getTask(session.id);
      if (made) draftChild({ task: made, column: session.column });
      return true;
    }
    if (mod && !event.altKey && (event.key === ']' || event.key === '[')) {
      event.preventDefault();
      flushEdit();
      if (event.key === ']') actions.indentTask({ id: session.id });
      else actions.unindentTask({ id: session.id });
      return true;
    }
    return false;
  }

  function onTitleKey(event: KeyboardEvent): void {
    if (event.isComposing || sharedKey(event)) return;
    if (event.key === 'Enter') {
      // A title is one line.
      event.preventDefault();
      if (!event.repeat) enterEdit();
    } else if (event.key === 'Backspace' && session.draft && session.title === '' && session.notes === '') {
      event.preventDefault();
      dropDraft();
    }
  }

  function onNotesKey(event: KeyboardEvent): void {
    if (!event.isComposing) sharedKey(event);
  }

  async function openDate(): Promise<void> {
    const value = await pickDate({ value: { date: task.due, time: task.time, repeat: task.repeat }, allowRepeat: canRepeat });
    if (value && mine()) setEditDate(value);
    focusIfLost();
  }

  async function openDeadline(): Promise<void> {
    const result = await pickDeadline({ value: task.deadline });
    if (result && mine()) setEditDeadline(result.deadline);
    focusIfLost();
  }

  function endRepeat(): void {
    if (session.draft) setEditDate({ date: task.due, time: task.time, repeat: null });
    else void stopRepeat(task);
  }
</script>

<div class="editor" bind:this={root} {onfocusout}>
  <textarea
    bind:this={titleField}
    class="title"
    rows="1"
    placeholder="Title"
    aria-label="Title"
    maxlength={LIMITS.title}
    enterkeyhint="done"
    value={session.title}
    oninput={(event) => {
      const field = event.currentTarget;
      // A title is one line, also when the text comes from the clipboard.
      if (field.value.includes('\n')) field.value = field.value.replace(/\s*\n+\s*/g, ' ');
      session.title = field.value;
      session.dirtyTitle = true;
      keepCaret(event);
      touchEdit();
    }}
    onkeydown={onTitleKey}
    onkeyup={keepCaret}
    onpointerup={keepCaret}
    onselect={keepCaret}
    onfocus={keepCaret}
  ></textarea>
  <div class="details">
    <Icon name="notes" size={16} />
    <textarea
      bind:this={notesField}
      class="notes"
      rows="1"
      placeholder="Details"
      aria-label="Details"
      maxlength={LIMITS.notes}
      value={session.notes}
      oninput={(event) => {
        session.notes = event.currentTarget.value;
        session.dirtyNotes = true;
        keepCaret(event);
        touchEdit();
      }}
      onkeydown={onNotesKey}
      onkeyup={keepCaret}
      onpointerup={keepCaret}
      onselect={keepCaret}
      onfocus={keepCaret}
    ></textarea>
  </div>
  <div class="controls">
    {#if task.due === null}
      <Chip size="sm" label="Today" onclick={() => setEditDay(0)} />
      <Chip size="sm" label="Tomorrow" onclick={() => setEditDay(1)} />
      <IconButton icon="clock" label="Add date/time" size="sm" onclick={() => void openDate()} />
    {:else}
      <DateChip
        date={task.due}
        time={task.time}
        today={store.today}
        {locale}
        repeat={task.repeat !== null}
        onclick={() => void openDate()}
        onremove={() => setEditDate({ date: null, time: null, repeat: null })}
      />
    {/if}
    {#if task.deadline !== null}
      <DeadlineChip deadline={task.deadline} today={store.today} {locale} onclick={() => void openDeadline()} onremove={() => setEditDeadline(null)} />
    {/if}
    {#if pickList && draft}
      <Chip
        size="sm"
        icon="list"
        trailingIcon="caret"
        label={listTitle}
        onclick={(event) => openListPicker({ anchor: event.currentTarget as Element, value: draft.listId, onpick: setDraftList })}
      />
    {/if}
    {#if canRepeat}
      <span class="end"><IconButton icon="repeat" label="Repeat" size="sm" active={task.repeat !== null} onclick={openRepeat} /></span>
    {/if}
  </div>
  {#if task.repeat}
    <div class="rule">
      <Icon name="repeat" size={14} />
      <span class="rule-text">{describeRule({ rule: task.repeat, locale })}</span>
      <button class="stop ui-state" type="button" onclick={endRepeat}>Stop repeating</button>
    </div>
  {/if}
</div>

<style>
  .editor {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    padding: 8px 0 8px 2px;
  }
  textarea {
    display: block;
    width: 100%;
    field-sizing: content;
    color: var(--text);
    caret-color: var(--primary);
    overflow-wrap: anywhere;
  }
  .title {
    /* The three-dot button of the row is above the end of the first line. */
    width: calc(100% - 32px);
    font-size: var(--row-font, 14px);
    line-height: 20px;
  }
  .details {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin-top: 4px;
    color: var(--text-dim);
  }
  .details :global(svg) {
    margin-top: 1px;
  }
  .notes {
    max-height: 144px;
    overflow-y: auto;
    color: var(--text-dim);
    font-size: var(--row-notes-font, 13px);
    line-height: 18px;
  }
  .notes:focus {
    color: var(--text);
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    /* Up to the right edge of the row, so the repeat button is below the star. */
    margin: 6px -34px 0 0;
  }
  .end {
    display: flex;
    margin-left: auto;
  }
  .rule {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 2px -34px 0 0;
    color: var(--text-dim);
    font-size: 12px;
    line-height: 16px;
  }
  .rule-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .stop {
    flex: none;
    height: 28px;
    margin-left: auto;
    padding: 0 10px;
    border-radius: var(--radius-pill);
    color: var(--primary);
    font-size: 12px;
    font-weight: 500;
  }
</style>
