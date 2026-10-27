<script lang="ts">
  import { untrack } from 'svelte';
  import { LIMITS, type ID, type NoteRow } from '../../../shared/types.ts';
  import { noteTaskTitles } from '../../../shared/view.ts';
  import type { MakeTasksResult } from '../common/dialogs.svelte.ts';
  import { getNote, listsOrdered, session } from '../data/index.ts';
  import { Button, Checkbox, Radio, ResponsiveDialog, Select } from '../ui/index.ts';

  // "Make tasks" of the note menu (SPEC section 8, "'Make tasks' dialog"). The dialog host of
  // web/src/common/ shows it, and the menu flow makes the tasks with the choice.
  interface Props {
    id: ID;
    ondone: (result: MakeTasksResult) => void;
    oncancel: () => void;
  }
  let { id, ondone, oncancel }: Props = $props();

  let open = $state(true);
  // The dialog keeps the last row while it plays its exit after the note went away.
  let seen: NoteRow | undefined;
  const note = $derived.by(() => (seen = getNote(id) ?? seen));
  /** The number of tasks of "A task for each line": the number that noteToTasks makes. */
  const lines = $derived(note ? Math.min(noteTaskTitles(note.body).length, LIMITS.noteTasks) : 0);

  let mode = $state<MakeTasksResult['mode']>(untrack(() => (lines >= 2 ? 'lines' : 'one')));
  let archive = $state(false);

  const lists = $derived(listsOrdered());
  const options = $derived(lists.map((list) => ({ value: list.id, label: list.title })));
  let listId = $state(
    untrack(() => {
      const mine = lists.find((list) => list.isDefault && list.owner === session.me?.id);
      return mine?.id ?? lists[0]?.id ?? '';
    }),
  );
  // The other person can delete the chosen list while the dialog is open.
  const listThere = $derived(lists.some((list) => list.id === listId));
  const count = $derived(mode === 'lines' ? lines : 1);

  $effect(() => {
    if (lines === 0 && mode === 'lines') mode = 'one';
  });

  // The note went away (the owner deleted it or stopped the sharing).
  $effect(() => {
    if (getNote(id) || !open) return;
    untrack(cancel);
  });

  function cancel(): void {
    open = false;
    oncancel();
  }

  function done(): void {
    if (!listThere || count === 0) return;
    open = false;
    ondone({ listId, mode, archive: archive && note?.archived !== true });
  }
</script>

<ResponsiveDialog bind:open onclose={oncancel} title="Make tasks" width={400}>
  <div class="form">
    <div class="choices" role="radiogroup" aria-label="Tasks">
      <Radio name="note-tasks-{id}" bind:group={mode} value="lines" label="A task for each line ({lines})" disabled={lines === 0} />
      <Radio name="note-tasks-{id}" bind:group={mode} value="one" label="One task" />
    </div>
    <div class="line">
      <span class="label">List</span>
      <Select label="List" bind:value={listId} {options} />
    </div>
    {#if note && !note.archived}
      <Checkbox bind:checked={archive} label="Archive the note" />
    {/if}
  </div>
  {#snippet actions()}
    <Button onclick={cancel}>Cancel</Button>
    <Button variant="filled" data-autofocus disabled={!listThere} onclick={done}>{count === 1 ? 'Add task' : `Add ${count} tasks`}</Button>
  {/snippet}
</ResponsiveDialog>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 0 0 8px;
    font-size: 14px;
  }
  .choices {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 40px;
  }
  .label {
    flex: none;
    width: 48px;
    color: var(--text-dim);
    font-size: 12px;
    font-weight: 500;
  }
</style>
