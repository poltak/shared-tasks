<script lang="ts">
  import type { ListRow } from '../../../shared/types.ts';
  import { createListFlow } from '../common/task-ops.ts';
  import { actions, listsOrdered, listView } from '../data/index.ts';
  import Checkbox from '../ui/Checkbox.svelte';
  import Icon from '../ui/Icon.svelte';
  import { closeEdit, showAll, showList, showStarred, ui } from './state.svelte.ts';

  // The sidebar: "Create", the two views, and the lists with a check box that shows or hides
  // the column of each list.
  let listsOpen = $state(true);

  function setShown(list: ListRow, shown: boolean): void {
    // The open row can be in the column that goes away.
    if (!shown && ui.edit?.column === list.id) closeEdit();
    actions.setListHidden({ id: list.id, hidden: !shown });
    if (shown && !ui.starred) ui.reveal = list.id;
  }

  async function newList(): Promise<void> {
    const id = await createListFlow();
    if (id !== null) showList(id);
  }
</script>

<div class="side">
  <button class="create ui-state" type="button" onclick={() => (ui.createOpen = true)}>
    <Icon name="plus" size={24} />
    <span>Create</span>
  </button>

  <nav class="views" aria-label="Views">
    <button class="item ui-state" type="button" aria-current={ui.starred ? undefined : 'page'} onclick={showAll}>
      <Icon name="add-task" size={20} />
      <span class="text">All tasks</span>
    </button>
    <button class="item ui-state" type="button" aria-current={ui.starred ? 'page' : undefined} onclick={showStarred}>
      <Icon name={ui.starred ? 'star-filled' : 'star'} size={20} />
      <span class="text">Starred</span>
    </button>
  </nav>

  <section class="lists" aria-label="Lists">
    <button class="heading ui-state" type="button" aria-expanded={listsOpen} onclick={() => (listsOpen = !listsOpen)}>
      <span class="text">Lists</span>
      <span class={['arrow', { open: listsOpen }]}><Icon name="chevron-down" size={20} /></span>
    </button>
    {#if listsOpen}
      <ul>
        {#each listsOrdered() as list (list.id)}
          {@const count = listView(list.id).openCount}
          <li class="list ui-state">
            <Checkbox checked={!list.hidden} onchange={(shown) => setShown(list, shown)}>
              <span class="text">{list.title}</span>
              {#if list.shared}<span class="shared" aria-label="Shared" role="img"><Icon name="people" size={16} /></span>{/if}
              {#if count > 0}<span class="count" aria-label="{count} open {count === 1 ? 'task' : 'tasks'}">{count}</span>{/if}
            </Checkbox>
          </li>
        {/each}
      </ul>
      <button class="item ui-state" type="button" onclick={() => void newList()}>
        <Icon name="plus" size={20} />
        <span class="text">Create new list</span>
      </button>
    {/if}
  </section>
</div>

<style>
  .side {
    display: flex;
    flex-direction: column;
    gap: 16px;
    height: 100%;
    padding: 8px 12px 24px;
    overflow-y: auto;
    scrollbar-width: thin;
  }
  .create {
    display: inline-flex;
    flex: none;
    align-items: center;
    align-self: flex-start;
    gap: 12px;
    height: 56px;
    padding: 0 24px 0 16px;
    border-radius: 16px;
    background: var(--surface);
    box-shadow: var(--shadow-2);
    color: var(--text);
    font-size: 14px;
    font-weight: 500;
  }
  .create :global(svg) {
    color: var(--primary);
  }
  .views,
  .lists {
    display: flex;
    flex: none;
    flex-direction: column;
  }
  .item,
  .heading {
    display: flex;
    align-items: center;
    gap: 16px;
    height: 40px;
    padding: 0 16px;
    border-radius: var(--radius-pill);
    color: var(--text);
    font-size: 14px;
    text-align: left;
  }
  .item :global(svg) {
    color: var(--text-dim);
  }
  .item[aria-current='page'] {
    background: var(--primary-container);
    color: var(--on-primary-container);
    font-weight: 500;
  }
  .item[aria-current='page'] :global(svg) {
    color: inherit;
  }
  .text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .heading {
    font-weight: 500;
  }
  .arrow {
    display: flex;
    color: var(--text-dim);
    transition: transform var(--dur) var(--ease);
  }
  .arrow.open {
    transform: rotate(180deg);
  }
  .list {
    display: flex;
    height: 40px;
    border-radius: var(--radius-pill);
    font-size: 14px;
  }
  /* The label takes the full row, so a click on the name works too. */
  .list :global(.checkbox) {
    flex: 1;
    gap: 17px;
    min-width: 0;
    padding: 0 16px 0 17px;
  }
  .shared {
    display: flex;
    flex: none;
    color: var(--text-dim);
  }
  .count {
    flex: none;
    min-width: 16px;
    color: var(--text-dim);
    font-size: 12px;
    text-align: right;
  }
</style>
