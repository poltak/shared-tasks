<script lang="ts">
  import { LIMITS } from '../../../shared/types.ts';
  import type { ID } from '../../../shared/types.ts';
  import { pickDate } from '../common/dialogs.svelte.ts';
  import { isOwner } from '../common/task-ops.ts';
  // The snippet with the buttons of the dialog has the name `actions`.
  import { actions as data, getList, listsOrdered, store } from '../data/index.ts';
  import Button from '../ui/Button.svelte';
  import Chip from '../ui/Chip.svelte';
  import DateChip from '../ui/DateChip.svelte';
  import Dialog from '../ui/Dialog.svelte';
  import Select from '../ui/Select.svelte';
  import TextArea from '../ui/TextArea.svelte';
  import TextField from '../ui/TextField.svelte';
  import type { DateValue } from '../ui/types.ts';
  import { currentColumn, select, showList, STARRED, ui } from './state.svelte.ts';

  // The dialog of the "Create" button: a new task with its details, its date, and its list.
  // The layout mounts it for each open, so each open starts with empty fields.
  const lists = listsOrdered();
  const column = currentColumn();
  const first = (column !== null && column !== STARRED ? getList(column) : undefined) ?? lists.find((list) => list.isDefault && isOwner(list)) ?? lists[0];

  let title = $state('');
  let notes = $state('');
  let listId = $state<ID>(first?.id ?? '');
  let date = $state.raw<DateValue>({ date: null, time: null, repeat: null });

  const options = $derived(listsOrdered().map((list) => ({ value: list.id, label: list.title })));
  const ready = $derived(title.trim() !== '' && getList(listId) !== undefined);

  function close(): void {
    ui.createOpen = false;
  }

  async function pick(): Promise<void> {
    const value = await pickDate({ value: date });
    if (value) date = value;
  }

  function save(): void {
    if (!ready) return;
    // In the Starred view a task with no star would not show.
    const made = data.createTask({ listId, title, notes, due: date.date, time: date.time, repeat: date.repeat, starred: ui.starred });
    const id = made.puts[0]?.id;
    close();
    if (id === undefined) return;
    if (!ui.starred) showList(listId);
    select(id);
  }
</script>

<Dialog open onclose={close} title="Create a task" width={440}>
  <div class="form">
    <TextField label="Title" bind:value={title} autofocus maxlength={LIMITS.title} autocomplete="off" enterkeyhint="done" onenter={save} />
    <TextArea label="Details" bind:value={notes} maxRows={6} maxlength={LIMITS.notes} />
    <div class="line">
      <span class="label">Date</span>
      {#if date.date}
        <DateChip
          size="md"
          date={date.date}
          time={date.time}
          today={store.today}
          repeat={date.repeat !== null}
          onclick={() => void pick()}
          onremove={() => (date = { date: null, time: null, repeat: null })}
        />
      {:else}
        <Chip size="md" icon="clock" label="Add date/time" onclick={() => void pick()} />
      {/if}
    </div>
    <div class="line">
      <span class="label">List</span>
      <Select label="List" bind:value={listId} {options} />
    </div>
  </div>
  {#snippet actions()}
    <Button onclick={close}>Cancel</Button>
    <Button variant="filled" disabled={!ready} onclick={save}>Save</Button>
  {/snippet}
</Dialog>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 4px 0 8px;
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
