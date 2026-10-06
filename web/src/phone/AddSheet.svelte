<script lang="ts">
  import { tick } from 'svelte';
  import { LIMITS, type ID } from '../../../shared/types.ts';
  import { pickDate } from '../common/dialogs.svelte.ts';
  import { actions, getList, listsOrdered, store } from '../data/index.ts';
  import { BottomSheet, Button, DateChip, Icon, IconButton, Star, TextArea, type DateValue } from '../ui/index.ts';
  import { addField, openMenu, phone, STARRED } from './phone.svelte.ts';

  const NO_DATE: DateValue = { date: null, time: null, repeat: null };

  // The sheet keeps what the person typed when a tap outside closes it. Only "Save" clears it.
  let title = $state('');
  let notes = $state('');
  let detailsOpen = $state(false);
  let date = $state.raw<DateValue>(NO_DATE);
  let star = $state(false);
  /** The list for a task from the star tab. */
  let chosenList = $state<ID | null>(null);
  let notesField = $state<HTMLTextAreaElement | null>(null);

  const onStarTab = $derived(phone.tab === STARRED);
  const lists = $derived(listsOrdered());
  const target = $derived(onStarTab ? (lists.find((list) => list.id === chosenList) ?? lists[0]) : getList(phone.tab));
  const canSave = $derived(title.trim() !== '' && target !== undefined);

  function save(): void {
    if (!canSave || !target) return;
    actions.createTask({
      listId: target.id,
      title,
      notes: notes.trim(),
      due: date.date,
      time: date.time,
      repeat: date.repeat,
      // SPEC section 8: a task from the star tab gets a star.
      starred: star || onStarTab,
      position: { at: 'top' },
    });
    title = '';
    notes = '';
    detailsOpen = false;
    date = NO_DATE;
    star = false;
    // The sheet stays open for the next task.
    addField.input?.focus();
  }

  function onTitleKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    save();
  }

  async function toggleDetails(): Promise<void> {
    if (detailsOpen && notes.trim() === '') {
      detailsOpen = false;
      addField.input?.focus();
      return;
    }
    detailsOpen = true;
    await tick();
    notesField?.focus();
  }

  async function chooseDate(): Promise<void> {
    const value = await pickDate({ value: date });
    if (value) date = value;
    await tick();
    addField.input?.focus();
  }

  function chooseList(): void {
    const current = target?.id;
    openMenu({
      title: 'Add to list',
      items: lists.map((list) => ({ id: list.id, label: list.title, checked: list.id === current })),
      run: (id) => (chosenList = id),
    });
  }

  /** A press on a button of the sheet must not take the focus out of the field: the keyboard would close. */
  function keepFocus(event: Event): void {
    event.preventDefault();
  }
</script>

<BottomSheet bind:open={phone.addOpen} label="New task" handle={false} padded={false}>
  <div class="add">
    {#if onStarTab && target}
      <button class="where ui-state" type="button" aria-label="List: {target.title}" aria-haspopup="menu" onclick={chooseList}>
        <span class="where-name">{target.title}</span>
        <Icon name="caret" size={20} />
      </button>
    {/if}

    <input
      class="title"
      type="text"
      placeholder="New task"
      aria-label="New task"
      enterkeyhint="done"
      autocomplete="off"
      autocapitalize="sentences"
      maxlength={LIMITS.title}
      data-autofocus
      bind:value={title}
      bind:this={addField.input}
      onkeydown={onTitleKey}
    />

    {#if detailsOpen}
      <div class="details">
        <TextArea variant="plain" bind:value={notes} bind:ref={notesField} placeholder="Add details" aria-label="Details" maxlength={LIMITS.notes} maxRows={4} />
      </div>
    {/if}

    {#if date.date}
      <div class="chips">
        <DateChip
          date={date.date}
          time={date.time}
          today={store.today}
          repeat={date.repeat !== null}
          size="md"
          onclick={() => void chooseDate()}
          onremove={() => (date = NO_DATE)}
        />
      </div>
    {/if}

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="tools" onpointerdown={keepFocus} onmousedown={keepFocus}>
      <IconButton class="tap" icon="notes" label="Add details" tooltip={false} active={detailsOpen} onclick={() => void toggleDetails()} />
      <IconButton class="tap" icon="clock" label="Add date/time" tooltip={false} active={date.date !== null} onclick={() => void chooseDate()} />
      <Star starred={star || onStarTab} size={44} disabled={onStarTab} onchange={(next) => (star = next)} />
      <span class="grow"></span>
      <Button disabled={!canSave} onclick={save}>Save</Button>
    </div>
  </div>
</BottomSheet>

<style>
  .add {
    display: flex;
    flex-direction: column;
    padding: 4px 8px 4px;
  }
  .where {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    gap: 2px;
    max-width: 100%;
    height: 36px;
    margin: 0 4px 2px;
    padding: 0 6px 0 12px;
    border-radius: var(--radius-pill);
    background: var(--field);
    color: var(--text);
    font-size: 14px;
    font-weight: 500;
  }
  /* The pill is 36 px high. Its press area is 44 px. */
  .where::before {
    content: '';
    position: absolute;
    inset: -4px 0;
  }
  .where-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title {
    width: 100%;
    height: 48px;
    padding: 0 16px;
    color: var(--text);
    font-size: 18px;
    caret-color: var(--primary);
    outline: none;
  }
  .details {
    padding: 0 16px 8px;
  }
  .details :global(textarea) {
    color: var(--text-dim);
    font-size: 16px;
  }
  .chips {
    display: flex;
    padding: 0 16px 8px;
  }
  /* A chip is 32 px high. The press areas of its text and of its X are 44 px. */
  .chips :global(.chip button)::before {
    content: '';
    position: absolute;
    inset: -6px 0;
  }
  .chips :global(.chip .remove)::before {
    inset: -8px -10px -8px 0;
  }
  .tools {
    display: flex;
    align-items: center;
    padding-right: 8px;
  }
  .grow {
    flex: 1;
  }
  .tools :global(.btn) {
    height: 44px;
    padding: 0 16px;
    font-size: 15px;
  }
</style>
