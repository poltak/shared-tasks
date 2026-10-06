<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { LIMITS, type TaskRow } from '../../../shared/types.ts';
  import { actions } from '../data/index.ts';
  import { CheckCircle, IconButton } from '../ui/index.ts';

  // One subtask in the detail screen: its circle, its title as a field, and a delete button.
  interface Props {
    task: TaskRow;
    /** Enter in the field: the person wants the next subtask. */
    onnext: () => void;
    /** `byKey`: the person deleted with the keyboard, so the focus must stay in the list. */
    onremove: (task: TaskRow, byKey: boolean) => void;
  }
  let { task, onnext, onremove }: Props = $props();

  const COMPLETE_MS = 300;

  let title = $state(untrack(() => task.title));
  let editing = false;
  let checked = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  // A change from the other person shows when this person does not type in the field.
  $effect(() => {
    const next = task.title;
    if (!editing) title = next;
  });

  function type(next: string): void {
    title = next;
    actions.updateTask({ id: task.id, title: next });
  }

  function leave(): void {
    editing = false;
    const clean = title.trim();
    // An empty field is not a title. The task keeps the title that it had.
    if (clean && clean !== task.title) actions.updateTask({ id: task.id, title: clean });
    title = clean || task.title;
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      onnext();
    } else if (event.key === 'Backspace' && title === '') {
      event.preventDefault();
      onremove(task, true);
    }
  }

  function toggle(next: boolean): void {
    clearTimeout(timer);
    timer = undefined;
    checked = next;
    if (!next) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (actions.completeTask({ id: task.id }).puts.length === 0) checked = false;
    }, COMPLETE_MS);
  }

  onDestroy(() => {
    if (timer === undefined) return;
    clearTimeout(timer);
    // The screen closed before the time was over. The press must not be lost.
    const id = task.id;
    queueMicrotask(() => actions.completeTask({ id }));
  });
</script>

<li class={['sub', { checked }]} data-testid="subtask">
  <CheckCircle {checked} size={44} onchange={toggle} />
  <input
    type="text"
    aria-label="Subtask"
    enterkeyhint="next"
    autocomplete="off"
    maxlength={LIMITS.title}
    data-subtask={task.id}
    bind:value={() => title, type}
    onfocus={() => (editing = true)}
    onblur={leave}
    {onkeydown}
  />
  <IconButton class="tap" icon="close" label="Delete subtask" tooltip={false} onclick={() => onremove(task, false)} />
</li>

<style>
  .sub {
    display: flex;
    align-items: center;
    min-height: 48px;
  }
  input {
    flex: 1;
    min-width: 0;
    height: 44px;
    /* The text is in line with the text of the rows above. */
    padding: 0 6px;
    color: var(--text);
    caret-color: var(--primary);
    outline: none;
    text-overflow: ellipsis;
  }
  .checked input {
    color: var(--text-dim);
    text-decoration: line-through;
  }
  .sub :global(.icon-btn) {
    color: var(--text-off);
  }
</style>
