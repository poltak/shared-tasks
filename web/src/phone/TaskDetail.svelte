<script lang="ts">
  import { flushSync, untrack } from 'svelte';
  import { describeRule } from '../../../shared/recurrence.ts';
  import { LIMITS, type ID, type TaskRow } from '../../../shared/types.ts';
  import { isResting } from '../../../shared/view.ts';
  import CompletedMeta from '../common/CompletedMeta.svelte';
  import { runTaskMenuItem, taskMenuItems, type TaskMenuHooks } from '../common/menus.ts';
  import { clearDate, clearDeadline, editDate, editDeadline, isSubtask, stopRepeat } from '../common/task-ops.ts';
  import { actions, getList, getTask, store, subtasksOf } from '../data/index.ts';
  import {
    Button,
    CheckCircle,
    DateChip,
    DeadlineChip,
    Icon,
    IconButton,
    portal,
    pushOverlay,
    RepeatDialog,
    slide,
    Star,
    TextArea,
    type RepeatResult,
  } from '../ui/index.ts';
  import { openMenu, openTask, phone } from './phone.svelte.ts';
  import SubtaskField from './SubtaskField.svelte';

  // The full screen of one task. It is an overlay, so the Back action of the browser closes it.
  interface Props {
    id: ID;
  }
  const props: Props = $props();
  // One screen is for one task. The value of the owner goes away when the screen closes, and
  // the code of the close still needs the id.
  const id = untrack(() => props.id);

  const locale = navigator.language;

  // The screen plays its exit after the task went away (Delete, or the other person deleted it).
  // So it keeps the last row that it saw.
  let seen: TaskRow | undefined;
  const task = $derived.by(() => {
    const now = getTask(id);
    if (now) seen = now;
    return now ?? seen;
  });
  const gone = $derived(getTask(id) === undefined);

  const list = $derived(task ? getList(task.listId) : undefined);
  /** A repeating task that rests until its next date shows as completed too. */
  const done = $derived(task !== undefined && (task.completed || isResting({ task, today: store.today })));
  const parent = $derived(task && task.parentId !== null && isSubtask(task) ? getTask(task.parentId) : undefined);
  const subtasks = $derived(task && !parent ? subtasksOf(task.id) : []);
  const openSubtasks = $derived(subtasks.filter((each) => !each.completed));
  const doneSubtasks = $derived(subtasks.filter((each) => each.completed));
  /** A subtask has no subtasks, and a completed task gets no new ones. */
  const canAddSubtask = $derived(task !== undefined && !done && !parent);

  let screen = $state<HTMLElement>();

  function close(): void {
    if (editing === 'title') leaveTitle();
    if (phone.detailId === id) phone.detailId = null;
  }

  $effect(() => {
    if (gone) untrack(close);
  });

  $effect(() => {
    if (!screen) return;
    const element = screen;
    return pushOverlay({ close, element: () => element }).remove;
  });

  // ---- Title and details: each key saves ----

  let title = $state(untrack(() => task?.title ?? ''));
  let notes = $state(untrack(() => task?.notes ?? ''));
  let editing: 'title' | 'notes' | null = null;

  // A change from the other person shows in a field that this person does not edit now.
  $effect(() => {
    const next = task?.title ?? '';
    if (editing !== 'title') title = next;
  });
  $effect(() => {
    const next = task?.notes ?? '';
    if (editing !== 'notes') notes = next;
  });

  function typeTitle(next: string): void {
    // A title is one line. Text from the clipboard can have more.
    title = next.replace(/\s*\n\s*/g, ' ');
    actions.updateTask({ id, title });
  }

  function leaveTitle(): void {
    editing = null;
    const now = getTask(id);
    if (!now) return;
    const clean = title.trim();
    // An empty field is not a title. The task keeps the title that it had.
    if (clean && clean !== now.title) actions.updateTask({ id, title: clean });
    title = clean || now.title;
  }

  function onTitleKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).blur();
  }

  function typeNotes(next: string): void {
    notes = next;
    actions.updateTask({ id, notes: next });
  }

  // ---- Completed, star, menus ----

  function toggleDone(): void {
    const wasDone = done;
    // SPEC section 8: the button closes the screen. The list then shows the row as it leaves.
    close();
    if (wasDone) actions.uncompleteTask({ id });
    else actions.completeTask({ id });
  }

  const hooks: TaskMenuHooks = { addSubtask: () => startSubtask(), afterDelete: close };

  function menuItems(row: TaskRow) {
    return taskMenuItems({ task: row, layout: 'phone' });
  }
  const isListItem = (itemId: string): boolean => itemId.startsWith('list:') || itemId === 'new-list';

  /** The list selector: a different list moves the task there. */
  function openLists(): void {
    const row = task;
    if (!row) return;
    const items = menuItems(row).filter((item) => isListItem(item.id));
    if (items[0]) items[0] = { ...items[0], separatorBefore: false };
    openMenu({ title: 'Move to list', items, run: (itemId) => void runTaskMenuItem({ task: row, itemId, hooks }) });
  }

  /** The three-dot menu. The lists are in the list selector, and the deadline has its own row. */
  function openMore(): void {
    const row = task;
    if (!row) return;
    const items = menuItems(row).filter((item) => (done ? item.id === 'delete' : !isListItem(item.id) && item.id !== 'deadline'));
    openMenu({ items, run: (itemId) => void runTaskMenuItem({ task: row, itemId, hooks }) });
  }

  // ---- Repeat ----

  let repeatOpen = $state(false);

  function applyRepeat({ rule, time }: RepeatResult): void {
    actions.setRepeat({ id, rule });
    // The rule gives the date. The time of the dialog goes with it.
    const now = getTask(id);
    if (now && now.time !== time) actions.setDate({ id, due: now.due, time });
  }

  // ---- Subtasks ----

  let adding = $state(false);
  let draft = $state('');
  let draftField = $state<HTMLInputElement | null>(null);

  function startSubtask(): void {
    if (!canAddSubtask) return;
    adding = true;
    // The focus must come in the handler of the tap, or iOS does not show the keyboard.
    flushSync();
    draftField?.focus();
  }

  function addDraft(): boolean {
    const text = draft.trim();
    if (!text || !task) return false;
    actions.createTask({ listId: task.listId, title: text, position: { parentId: id, at: 'end' } });
    draft = '';
    return true;
  }

  function onDraftKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    // Enter adds the subtask, and the field stays for the next one. Enter in the empty field ends the entry.
    if (addDraft()) {
      flushSync();
      draftField?.scrollIntoView({ block: 'nearest' });
    } else draftField?.blur();
  }

  function leaveDraft(): void {
    addDraft();
    adding = false;
  }

  function removeSubtask(subtask: TaskRow, byKey: boolean): void {
    let next: HTMLInputElement | undefined;
    if (byKey && screen) {
      const fields = [...screen.querySelectorAll<HTMLInputElement>('input[data-subtask]')];
      const index = fields.findIndex((field) => field.dataset.subtask === subtask.id);
      next = fields[index - 1] ?? fields[index + 1];
    }
    actions.deleteTask({ id: subtask.id });
    next?.focus();
  }
</script>

{#if task}
  <div class="ui-layer" use:portal>
    <div
      class={['screen', { done }]}
      role="dialog"
      aria-modal="true"
      aria-label="Task details"
      tabindex="-1"
      bind:this={screen}
      in:slide|global
      out:slide|global={{ duration: 180 }}
    >
      <header class="bar">
        <IconButton class="tap" icon="back" label="Back" tooltip={false} onclick={close} />
        <button class="where ui-state" type="button" aria-label="List: {list?.title ?? ''}" aria-haspopup="menu" onclick={openLists}>
          <span class="where-name">{list?.title ?? ''}</span>
          <Icon name="caret" size={20} />
        </button>
        <span class="grow"></span>
        <Star starred={task.starred} size={44} onchange={(starred) => actions.setStar({ id, starred })} />
        <IconButton class="tap" icon="more" label="Task options" tooltip={false} onclick={openMore} />
      </header>

      <div class="body">
        {#if parent}
          <button class="parent ui-state" type="button" onclick={() => openTask(parent.id)}>
            <Icon name="subtask" size={16} />
            <span>{parent.title}</span>
          </button>
        {/if}

        <TextArea
          class="title-field"
          variant="plain"
          placeholder="Enter title"
          aria-label="Title"
          enterkeyhint="done"
          maxlength={LIMITS.title}
          maxRows={8}
          bind:value={() => title, typeTitle}
          onfocus={() => (editing = 'title')}
          onblur={leaveTitle}
          onkeydown={onTitleKey}
        />
        {#if done}
          <div class="completed"><CompletedMeta {task} /></div>
        {/if}

        <div class="line top">
          <span class="lead"><Icon name="notes" /></span>
          <TextArea
            class="notes-field"
            variant="plain"
            placeholder="Add details"
            aria-label="Details"
            maxlength={LIMITS.notes}
            maxRows={10}
            bind:value={() => notes, typeNotes}
            onfocus={() => (editing = 'notes')}
            onblur={() => (editing = null)}
          />
        </div>

        {#if task.due}
          <div class="line">
            <span class="lead"><Icon name="clock" /></span>
            <DateChip
              date={task.due}
              time={task.time}
              today={store.today}
              {locale}
              repeat={task.repeat !== null}
              size="md"
              onclick={() => void editDate(task)}
              onremove={() => clearDate(task)}
            />
          </div>
        {:else}
          <button class="line ui-state" type="button" onclick={() => void editDate(task)}>
            <span class="lead"><Icon name="clock" /></span>
            <span>Add date/time</span>
          </button>
        {/if}

        {#if task.deadline}
          <div class="line">
            <span class="lead"><Icon name="target" /></span>
            <DeadlineChip
              deadline={task.deadline}
              today={store.today}
              {locale}
              size="md"
              onclick={() => void editDeadline(task)}
              onremove={() => clearDeadline(task)}
            />
          </div>
        {:else}
          <button class="line ui-state" type="button" onclick={() => void editDeadline(task)}>
            <span class="lead"><Icon name="target" /></span>
            <span>Add deadline</span>
          </button>
        {/if}

        {#if task.repeat}
          <div class="line pair">
            <button class="rule ui-state" type="button" aria-label="Repeats: {describeRule({ rule: task.repeat, locale })}" onclick={() => (repeatOpen = true)}>
              <span class="lead"><Icon name="repeat" /></span>
              <span class="rule-text">{describeRule({ rule: task.repeat, locale })}</span>
            </button>
            <IconButton class="tap" icon="close" label="Stop repeating" tooltip={false} onclick={() => void stopRepeat(task)} />
          </div>
        {/if}

        {#if subtasks.length > 0 || adding}
          <ul class="subtasks">
            {#each openSubtasks as subtask (subtask.id)}
              <SubtaskField task={subtask} onnext={startSubtask} onremove={removeSubtask} />
            {/each}
            {#if adding}
              <li class="draft">
                <CheckCircle checked={false} size={44} disabled />
                <input
                  type="text"
                  placeholder="Enter title"
                  aria-label="New subtask"
                  enterkeyhint="next"
                  autocomplete="off"
                  maxlength={LIMITS.title}
                  bind:value={draft}
                  bind:this={draftField}
                  onkeydown={onDraftKey}
                  onblur={leaveDraft}
                />
              </li>
            {/if}
            {#each doneSubtasks as subtask (subtask.id)}
              <li class="done-sub" data-testid="subtask-done">
                <CheckCircle checked variant="check" size={44} onchange={() => actions.uncompleteTask({ id: subtask.id })} />
                <span>{subtask.title}</span>
              </li>
            {/each}
          </ul>
        {/if}

        {#if canAddSubtask && !adding}
          <button class="line ui-state" type="button" onclick={startSubtask}>
            <span class="lead"><Icon name="subtask" /></span>
            <span>Add subtasks</span>
          </button>
        {/if}
      </div>

      <footer class="foot">
        <Button variant={done ? 'tonal' : 'filled'} onclick={toggleDone}>{done ? 'Mark uncompleted' : 'Mark completed'}</Button>
      </footer>
    </div>
  </div>

  <RepeatDialog bind:open={repeatOpen} rule={task.repeat} time={task.time} date={task.due} today={store.today} {locale} ondone={applyRepeat} />
{/if}

<style>
  .screen {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);
    background: var(--bg);
    color: var(--text);
    outline: none;
    touch-action: manipulation;
  }

  .bar {
    display: flex;
    flex: none;
    align-items: center;
    height: 56px;
    padding: 0 6px;
  }
  .grow {
    flex: 1;
  }
  .where {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
    height: 40px;
    margin-left: 4px;
    padding: 0 6px 0 14px;
    border-radius: var(--radius-pill);
    background: var(--surface-2);
    color: var(--text);
    font-size: 14px;
    font-weight: 500;
  }
  /* The pill is 40 px high. Its press area is 44 px. */
  .where::before {
    content: '';
    position: absolute;
    inset: -2px 0;
  }
  .where-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 4px 0 24px;
  }

  .parent {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: calc(100% - 32px);
    height: 32px;
    margin: 0 12px 2px;
    padding: 0 10px 0 8px;
    border-radius: var(--radius-pill);
    color: var(--text-dim);
    font-size: 13px;
    font-weight: 500;
  }
  .parent span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .body :global(.title-field) {
    padding: 6px 20px 10px;
  }
  .body :global(.title-field textarea) {
    font-size: 22px;
    line-height: 28px;
    letter-spacing: -0.01em;
  }
  .done :global(.title-field textarea) {
    color: var(--text-dim);
    text-decoration: line-through;
  }
  .completed {
    padding: 0 20px 10px;
  }

  .line {
    display: flex;
    align-items: center;
    gap: 16px;
    width: 100%;
    min-height: 52px;
    padding: 0 8px 0 20px;
    color: var(--text-dim);
    font-size: 16px;
    line-height: 22px;
    text-align: left;
  }
  .lead {
    display: grid;
    flex: none;
    place-items: center;
    width: 24px;
    height: 24px;
    color: var(--text-dim);
  }
  /* The icon stays at the first line of a text that grows. */
  .line.top {
    align-items: flex-start;
  }
  .line.top .lead {
    margin-top: 14px;
  }
  .line :global(.notes-field) {
    flex: 1;
    padding: 15px 12px 15px 0;
  }
  /* The row has the icon of the chip already. */
  .line :global(.chip .main > svg:first-child) {
    display: none;
  }
  /* A chip is 32 px high. The press areas of its text and of its X are 44 px. */
  .line :global(.chip button)::before {
    content: '';
    position: absolute;
    inset: -6px 0;
  }
  .line :global(.chip .remove)::before {
    inset: -8px -10px -8px 0;
  }

  .pair {
    gap: 0;
    padding: 0 8px 0 0;
  }
  .rule {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 16px;
    min-width: 0;
    min-height: 52px;
    padding: 0 8px 0 20px;
    color: var(--text);
    font-size: 16px;
    line-height: 22px;
    text-align: left;
  }
  .rule-text {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .subtasks {
    /* The middle of a 44 px circle is in line with the icons of the rows above. */
    padding: 4px 8px 4px 10px;
  }
  .draft,
  .done-sub {
    display: flex;
    align-items: center;
    min-height: 48px;
  }
  .draft input {
    flex: 1;
    min-width: 0;
    height: 44px;
    padding: 0 6px;
    color: var(--text);
    caret-color: var(--primary);
    outline: none;
  }
  .done-sub span {
    flex: 1;
    min-width: 0;
    padding: 0 6px;
    overflow: hidden;
    color: var(--text-dim);
    font-size: 16px;
    text-decoration: line-through;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .foot {
    display: grid;
    flex: none;
    padding: 8px 16px calc(12px + env(safe-area-inset-bottom));
  }
  .foot :global(.btn) {
    height: 48px;
    font-size: 15px;
  }
</style>
