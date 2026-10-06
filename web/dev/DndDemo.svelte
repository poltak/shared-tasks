<script lang="ts">
  // A page to try the drag and drop engine with plain arrays, and the target of e2e/dev/dnd.spec.ts.
  import { dnd, dndContainer, dndItem, type DndDrop, type DndOptions } from '../src/dnd/index.ts';

  interface Task {
    id: string;
    title: string;
    depth: number;
    note?: string;
    link?: boolean;
    picture?: boolean;
  }
  interface Column {
    id: string;
    title: string;
    done: number;
    tasks: Task[];
  }

  const picture =
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" rx="8" fill="#3b5bdb"/><circle cx="20" cy="20" r="9" fill="#fff"/></svg>',
    );

  let columns = $state<Column[]>([
    {
      id: 'a',
      title: 'My Tasks',
      done: 3,
      tasks: [
        { id: 'a1', title: 'Buy milk', depth: 0, picture: true },
        { id: 'a2', title: 'Call the bank', depth: 0 },
        { id: 'a2x', title: 'Find the card', depth: 1 },
        { id: 'a2y', title: 'Write down the questions', depth: 1 },
        { id: 'a3', title: 'Book the train', depth: 0, note: 'Two seats, before Friday', link: true },
        { id: 'a4', title: 'Write the report', depth: 0 },
        { id: 'a5', title: 'Water the plants', depth: 0 },
        { id: 'a6', title: 'Send the photos', depth: 0 },
      ],
    },
    {
      id: 'b',
      title: 'Home',
      done: 1,
      tasks: [
        { id: 'b1', title: 'Fix the door', depth: 0 },
        { id: 'b2', title: 'Clean the kitchen', depth: 0 },
        { id: 'b2x', title: 'Empty the fridge', depth: 1 },
        { id: 'b3', title: 'Pay the rent', depth: 0 },
      ],
    },
    {
      id: 'c',
      title: 'Long list',
      done: 12,
      tasks: Array.from({ length: 30 }, (_, i) => ({ id: `c${i + 1}`, title: `Long list row ${i + 1}`, depth: 0 })),
    },
    { id: 'd', title: 'Empty list', done: 0, tasks: [] },
  ]);

  let tabs = $state([
    { id: 't1', title: 'My Tasks' },
    { id: 't2', title: 'Home' },
    { id: 't3', title: 'Long list' },
    { id: 't4', title: 'Empty list' },
    { id: 't5', title: 'Work' },
    { id: 't6', title: 'Travel' },
    { id: 't7', title: 'Books to read' },
  ]);

  let last = $state<DndDrop | null>(null);
  let check = $state('none');
  let clicks = $state(0);
  let log = $state('');

  function hasSubtasks(id: string): boolean {
    for (const column of columns) {
      const i = column.tasks.findIndex((task) => task.id === id);
      if (i >= 0) return column.tasks[i]!.depth === 0 && column.tasks[i + 1]?.depth === 1;
    }
    return false;
  }

  /** Compares the parent and the neighbors in the result with the true order after the move. */
  function verify(drop: DndDrop, tasks: Task[]): string {
    const i = tasks.findIndex((task) => task.id === drop.id);
    const depth = tasks[i]!.depth;
    let parent: string | null = null;
    let after: string | null = null;
    for (let k = i - 1; k >= 0; k--) {
      const task = tasks[k]!;
      if (task.depth < depth) {
        parent = task.id;
        break;
      }
      if (task.depth === depth) {
        after ??= task.id;
        if (depth === 0) break;
      }
    }
    let before: string | null = null;
    for (let k = i + 1; k < tasks.length; k++) {
      const task = tasks[k]!;
      if (task.depth > depth) continue;
      if (task.depth === depth) before = task.id;
      break;
    }
    const got = JSON.stringify([drop.parentId, drop.afterId, drop.beforeId, drop.depth, drop.index]);
    const want = JSON.stringify([parent, after, before, depth, i]);
    return got === want ? 'ok' : `want ${want} got ${got}`;
  }

  const taskOptions: DndOptions = {
    group: 'tasks',
    autoScroll: 'both',
    // On a phone the row stays in its list and shows the depth by its indent.
    lockAxis: matchMedia('(pointer: coarse)').matches,
    // A row with subtasks cannot become a subtask. The engine adds: depth 1 needs a row above.
    maxDepthAt: ({ id }) => (hasSubtasks(id) ? 0 : 1),
    onDragStart: ({ id }) => (log = `start ${id}`),
    onDragEnd: ({ id, dropped }) => (log = `end ${id} ${dropped}`),
    onDrop(drop) {
      const from = columns.find((column) => column.id === drop.fromContainerId)!;
      const to = columns.find((column) => column.id === drop.toContainerId)!;
      const i = from.tasks.findIndex((task) => task.id === drop.id);
      let count = 1;
      while (i + count < from.tasks.length && from.tasks[i + count]!.depth > from.tasks[i]!.depth) count++;
      const block = from.tasks.splice(i, count);
      block[0]!.depth = drop.depth;
      to.tasks.splice(drop.index, 0, ...block);
      last = drop;
      check = verify(drop, to.tasks);
    },
  };

  function reorder<T extends { id: string }>(list: T[], drop: DndDrop): void {
    const [item] = list.splice(
      list.findIndex((entry) => entry.id === drop.id),
      1,
    );
    list.splice(drop.index, 0, item!);
    last = drop;
    check = list[drop.index - 1]?.id === (drop.afterId ?? undefined) && list[drop.index + 1]?.id === (drop.beforeId ?? undefined) ? 'ok' : 'wrong neighbors';
  }

  const tasksDnd = dnd(taskOptions);
  const columnsDnd = dnd({
    axis: 'x',
    group: 'columns',
    handle: '[data-dnd-handle]',
    onDrop: (drop) => reorder(columns, drop),
  });
  // For the tests: a change of the data that is not immediate. The engine waits for the promise.
  const demo = { slow: false };
  const tabsDnd = dnd({
    axis: 'x',
    group: 'tabs',
    lockAxis: true,
    canDrag: (id) => id !== 't7',
    onDrop(drop) {
      if (!demo.slow) return reorder(tabs, drop);
      return new Promise<void>((done) => {
        setTimeout(() => {
          reorder(tabs, drop);
          done();
        }, 150);
      });
    },
  });

  // For the tests: a change of the data while a drag is active, as a sync does in the app.
  Object.assign(window, {
    demo: Object.assign(demo, {
      addTop(columnId: string) {
        const column = columns.find((entry) => entry.id === columnId)!;
        column.tasks.unshift({ id: `new${column.tasks.length}`, title: 'A row from a sync', depth: 0 });
      },
      remove(id: string) {
        for (const column of columns) column.tasks = column.tasks.filter((task) => task.id !== id);
      },
      /** A list of any length, to measure the speed. */
      fill(columnId: string, count: number) {
        const column = columns.find((entry) => entry.id === columnId)!;
        column.tasks = Array.from({ length: count }, (_, i) => ({ id: `${columnId}${i + 1}`, title: `Row ${i + 1}`, depth: i % 4 === 1 ? 1 : 0 }));
      },
    }),
  });
</script>

<div class="demo">
  <nav class="tabs" aria-label="Lists" {...dndContainer({ id: 'tabs', group: 'tabs' })} {@attach tabsDnd}>
    {#each tabs as tab (tab.id)}
      <button class="tab" type="button" {...dndItem({ id: tab.id })} onclick={() => clicks++}>{tab.title}</button>
    {/each}
  </nav>

  <main class="board" {...dndContainer({ id: 'board', group: 'columns' })} {@attach columnsDnd} {@attach tasksDnd}>
    {#each columns as column (column.id)}
      <section class="column" {...dndItem({ id: column.id })}>
        <h2 class="head" data-dnd-handle>{column.title}</h2>
        <div class="scroll" data-testid="scroll-{column.id}">
          <ul class="rows" {...dndContainer({ id: column.id, group: 'tasks' })}>
            {#each column.tasks as task (task.id)}
              <li class="row" class:sub={task.depth === 1} {...dndItem({ id: task.id, depth: task.depth })}>
                <button class="circle" type="button" aria-label="Mark completed" data-dnd-ignore></button>
                <button class="body" type="button" onclick={() => clicks++}>
                  <span class="title">{task.title}</span>
                  {#if task.note}
                    <span class="note">
                      {task.note}
                      {#if task.link}<a href="https://example.com/">example.com</a>{/if}
                    </span>
                  {/if}
                </button>
                {#if task.picture}<img class="picture" src={picture} alt="" />{/if}
              </li>
            {/each}
          </ul>
          {#if column.tasks.length === 0}
            <p class="empty">Nothing here yet</p>
          {/if}
          <p class="done">Completed ({column.done})</p>
        </div>
      </section>
    {/each}
  </main>

  <footer class="status">
    <span>check: <b data-testid="check">{check}</b></span>
    <span>clicks: <b data-testid="clicks">{clicks}</b></span>
    <span>log: <b data-testid="log">{log}</b></span>
    <code data-testid="last-drop">{last ? JSON.stringify(last) : 'null'}</code>
  </footer>
</div>

<style>
  :global(body) {
    background: #f0f4f9;
    color: #1f1f1f;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    font-size: 15px;
    -webkit-tap-highlight-color: transparent;
  }
  .demo {
    height: 100dvh;
    display: flex;
    flex-direction: column;
    --dnd-accent: #3b5bdb;
  }
  .tabs {
    flex: none;
    display: flex;
    gap: 8px;
    padding: 12px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tab {
    flex: none;
    border: 0;
    border-radius: 999px;
    padding: 9px 16px;
    background: #fff;
    color: #444746;
    font: inherit;
    font-weight: 500;
    white-space: nowrap;
  }
  .board {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 4px 12px 12px;
    overflow-x: auto;
  }
  .column {
    flex: 0 0 300px;
    max-height: 100%;
    display: flex;
    flex-direction: column;
    background: #fff;
    border-radius: 16px;
  }
  .head {
    flex: none;
    margin: 0;
    padding: 16px 20px 10px;
    font-size: 16px;
    font-weight: 500;
    cursor: grab;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    border-radius: 0 0 16px 16px;
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0 6px;
  }
  .row {
    display: flex;
    align-items: flex-start;
    border-radius: 10px;
    padding: 0 8px;
    /* An app has transitions of its own on a row. The engine must not start them. */
    transition:
      opacity 300ms,
      transform 300ms;
  }
  .row.sub {
    padding-left: 36px;
  }
  @media (hover: hover) {
    .row:hover {
      background: #f2f2f2;
    }
  }
  .circle {
    flex: none;
    width: 20px;
    height: 20px;
    margin: 12px 10px 12px 4px;
    padding: 0;
    border: 2px solid #5f6368;
    border-radius: 50%;
    background: none;
  }
  .body {
    flex: 1;
    min-width: 0;
    padding: 12px 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
  }
  .title,
  .note {
    display: block;
  }
  .note {
    margin-top: 2px;
    color: #5f6368;
    font-size: 13px;
  }
  .picture {
    flex: none;
    width: 28px;
    height: 28px;
    margin: 8px 2px;
  }
  .empty,
  .done {
    margin: 0;
    padding: 12px 20px;
    color: #5f6368;
    font-size: 14px;
  }
  .done {
    border-top: 1px solid #e3e3e3;
  }
  .status {
    flex: none;
    display: flex;
    flex-wrap: wrap;
    gap: 2px 12px;
    height: 44px;
    overflow: auto;
    padding: 6px 12px;
    background: #fff;
    border-top: 1px solid #e3e3e3;
    font: 11px/1.3 ui-monospace, Menlo, monospace;
  }
</style>
