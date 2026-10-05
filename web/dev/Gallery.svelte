<script lang="ts">
  // A page with each UI part in its states, and the target of e2e/dev/gallery.spec.ts.
  // Query values: today=YYYY-MM-DD and locale=xx-XX give fixed dates and texts, theme=light|dark sets the theme.
  import { addDays, todayOf } from '../../shared/dates.ts';
  import type { DateStr, RepeatRule, TimeStr } from '../../shared/types.ts';
  import {
    BottomSheet,
    Button,
    CheckCircle,
    Checkbox,
    Chip,
    ConfirmDialog,
    DateChip,
    DatePicker,
    DeadlineChip,
    DeadlinePicker,
    Dialog,
    EmptyState,
    Icon,
    IconButton,
    ICON_NAMES,
    layout,
    Menu,
    MonthGrid,
    overlays,
    Radio,
    RepeatDialog,
    SegmentedControl,
    Select,
    Snackbar,
    Star,
    Switch,
    TextArea,
    TextField,
    TextPromptDialog,
    TimeField,
    type DateValue,
    type MenuAnchor,
    type MenuItem,
  } from '../src/ui/index.ts';

  const params = new URLSearchParams(location.search);
  const today: DateStr = params.get('today') ?? todayOf(Date.now());
  const locale = params.get('locale') ?? navigator.language;

  type Theme = 'system' | 'light' | 'dark';
  let theme = $state<Theme>((params.get('theme') as Theme | null) ?? 'system');
  $effect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  });

  const swatches = [
    'bg',
    'surface',
    'surface-2',
    'surface-3',
    'popup',
    'field',
    'field-on',
    'text',
    'text-dim',
    'text-off',
    'outline',
    'divider',
    'primary',
    'on-primary',
    'primary-container',
    'on-primary-container',
    'danger',
    'danger-container',
    'inverse-surface',
  ];

  // ---- Fields ----
  let name = $state('Shopping');
  let password = $state('abc');
  let notes = $state('Two seats, before Friday.\nAsk for the window.');
  let notify = $state(true);
  let showList = $state(true);
  let fruit = $state<'apple' | 'pear' | 'plum'>('pear');
  let sort = $state<'my' | 'date' | 'title'>('my');
  let listChoice = $state('home');

  // ---- Task parts ----
  let tasks = $state([
    { id: 't1', title: 'Buy milk', notes: '', done: false, starred: false, due: today as DateStr | null, time: '14:30' as TimeStr | null, repeat: false, deadline: null as DateStr | null },
    { id: 't2', title: 'Call the bank', notes: 'Ask about the new card and the limit', done: false, starred: true, due: addDays(today, -3), time: null, repeat: true, deadline: addDays(today, 1) },
    { id: 't3', title: 'Book the train', notes: '', done: false, starred: false, due: addDays(today, 1), time: null, repeat: false, deadline: addDays(today, -2) },
    { id: 't4', title: 'Water the plants', notes: '', done: true, starred: false, due: null, time: null, repeat: false, deadline: null },
  ]);

  // ---- Menus ----
  const listMenu: MenuItem[] = [
    { id: 'sort-my', label: 'My order', checked: true, sectionLabel: 'Sort by' },
    { id: 'sort-date', label: 'Date', checked: false },
    { id: 'sort-deadline', label: 'Deadline', checked: false },
    { id: 'sort-starred', label: 'Starred recently', checked: false },
    { id: 'sort-title', label: 'Title', checked: false },
    { id: 'rename', label: 'Rename list', separatorBefore: true },
    { id: 'share', label: 'Share with Minh' },
    { id: 'delete', label: 'Delete list', disabled: true, hint: "The default list can't be deleted" },
    { id: 'first', label: 'Move list to first position' },
    { id: 'print', label: 'Print list', separatorBefore: true },
    { id: 'clear', label: 'Delete all completed tasks', danger: true },
  ];
  const taskMenu: MenuItem[] = [
    { id: 'top', label: 'Move to top', icon: 'to-top' },
    { id: 'deadline', label: 'Add deadline', icon: 'target' },
    { id: 'subtask', label: 'Add a subtask', icon: 'subtask' },
    { id: 'indent', label: 'Indent', icon: 'indent' },
    { id: 'delete', label: 'Delete', icon: 'bin', danger: true },
    { id: 'list-1', label: 'My Tasks', checked: true, separatorBefore: true },
    { id: 'list-2', label: 'Home', checked: false },
    { id: 'list-3', label: 'Work', checked: false },
    { id: 'new-list', label: 'New list', icon: 'list-add', separatorBefore: true },
  ];
  let menu = $state<{ items: MenuItem[]; anchor: MenuAnchor; align: 'start' | 'end'; title?: string } | null>(null);
  let menuResult = $state('none');
  let menuCloses = $state(0);

  function openMenu(event: MouseEvent, { items, align = 'start', title }: { items: MenuItem[]; align?: 'start' | 'end'; title?: string }): void {
    menu = { items, anchor: event.currentTarget as Element, align, title };
  }

  // ---- Overlays ----
  let dialogOpen = $state(false);
  let fullOpen = $state(false);
  let nestedOpen = $state(false);
  let innerConfirmOpen = $state(false);
  let confirmOpen = $state(false);
  let promptOpen = $state(false);
  let renameOpen = $state(false);
  let sheetOpen = $state(false);
  let addOpen = $state(false);
  let overlayResult = $state('none');
  let promptResult = $state('none');
  let listName = $state('Groceries');
  let addTitle = $state('');
  let snack = $state<{ id: number; message: string } | null>(null);
  let snackCount = 0;

  // ---- Pickers ----
  let dateOpen = $state(false);
  let dateValue = $state<DateValue>({ date: null, time: null, repeat: null });
  let dateResult = $state('none');
  let plainDateOpen = $state(false);
  let plainDate = $state<DateValue>({ date: addDays(today, 2), time: null, repeat: null });
  let deadlineOpen = $state(false);
  let deadline = $state<DateStr | null>(null);
  let deadlineResult = $state('none');
  let repeatOpen = $state(false);
  let repeatRule = $state<RepeatRule | null>(null);
  let repeatResult = $state('none');
  let gridDate = $state<DateStr | null>(addDays(today, 4));
  let fieldTime = $state<TimeStr | null>(null);
</script>

<div class="page">
  <header class="top">
    <h1>UI gallery</h1>
    <span class="meta" data-testid="layout">{layout.mode}</span>
    <span class="meta" data-testid="overlay-count">{overlays.count}</span>
    <SegmentedControl
      bind:value={theme}
      label="Theme"
      options={[
        { value: 'system', label: 'System' },
        { value: 'light', label: 'Light', icon: 'sun' },
        { value: 'dark', label: 'Dark', icon: 'moon' },
      ]}
    />
  </header>

  <section class="card" data-testid="section-tokens">
    <h2>Colors</h2>
    <div class="swatches">
      {#each swatches as swatch (swatch)}
        <div class="swatch"><span style:background="var(--{swatch})"></span>{swatch}</div>
      {/each}
    </div>
  </section>

  <section class="card" data-testid="section-icons">
    <h2>Icons</h2>
    <div class="icons">
      {#each ICON_NAMES as icon (icon)}
        <div class="icon"><Icon name={icon} /><span>{icon}</span></div>
      {/each}
    </div>
    <div class="row sizes">
      <Icon name="clock" size={14} /><Icon name="clock" size={16} /><Icon name="clock" size={18} /><Icon name="clock" size={20} /><Icon name="clock" size={24} />
      <Icon name="star" size={16} /><Icon name="star-filled" size={16} /><Icon name="star" size={20} /><Icon name="star-filled" size={20} />
      <Icon name="repeat" size={14} /><Icon name="target" size={14} /><Icon name="people" size={16} /><Icon name="more" size={20} /><Icon name="drag" size={20} />
    </div>
  </section>

  <section class="card" data-testid="section-buttons">
    <h2>Buttons</h2>
    <div class="row">
      <Button variant="filled">Save</Button>
      <Button variant="filled" icon="plus">Create</Button>
      <Button variant="tonal">Sync now</Button>
      <Button variant="tonal" icon="bell">Send test notification</Button>
      <Button>Cancel</Button>
      <Button icon="list-add">Create new list</Button>
      <Button variant="danger">Delete</Button>
    </div>
    <div class="row">
      <Button variant="filled" disabled>Save</Button>
      <Button variant="tonal" disabled>Sync now</Button>
      <Button disabled>Cancel</Button>
      <Button variant="danger" disabled>Delete</Button>
      <Button variant="filled" size="sm">Small</Button>
      <Button variant="tonal" size="sm" icon="check-small">Small</Button>
      <Button size="sm">Small</Button>
    </div>
    <div class="row">
      <IconButton icon="menu" label="Main menu" data-testid="tip-button" />
      <IconButton icon="more" label="List options" />
      <IconButton icon="sort" label="Sort" />
      <IconButton icon="help" label="Keyboard shortcuts" />
      <IconButton icon="bin" label="Delete task" />
      <IconButton icon="sync" label="Sync" active />
      <IconButton icon="cloud-off" label="Offline" disabled />
      <IconButton icon="more" label="Task options" size="sm" />
      <IconButton icon="close" label="Close" size="sm" />
    </div>
  </section>

  <section class="card" data-testid="section-chips">
    <h2>Chips</h2>
    <div class="row">
      <Chip label="Today" onclick={() => {}} />
      <Chip label="Tomorrow" onclick={() => {}} />
      <Chip icon="clock" label="Add date/time" onclick={() => {}} />
      <Chip icon="calendar" label="Tue 6 Oct" onclick={() => {}} onremove={() => {}} />
      <Chip tone="primary" icon="people" label="Shared" />
      <Chip tone="primary" label="Filter" onclick={() => {}} onremove={() => {}} />
      <Chip tone="danger" icon="clock" label="3 days ago" onclick={() => {}} onremove={() => {}} />
      <Chip label="Disabled" onclick={() => {}} disabled />
    </div>
    <div class="row">
      <DateChip date={today} {today} {locale} />
      <DateChip date={today} time="14:30" {today} {locale} />
      <DateChip date={addDays(today, 1)} {today} {locale} repeat />
      <DateChip date={addDays(today, -3)} {today} {locale} />
      <DateChip date={addDays(today, -16)} {today} {locale} repeat onclick={() => {}} />
      <DateChip date={addDays(today, 30)} {today} {locale} onclick={() => {}} onremove={() => {}} />
      <DateChip date={addDays(today, 400)} {today} {locale} prefix="Next:" />
      <DeadlineChip deadline={today} {today} {locale} />
      <DeadlineChip deadline={addDays(today, 1)} {today} {locale} onclick={() => {}} />
      <DeadlineChip deadline={addDays(today, -2)} {today} {locale} />
      <DeadlineChip deadline={addDays(today, 9)} {today} {locale} onclick={() => {}} onremove={() => {}} />
    </div>
    <div class="row">
      <DateChip date={today} time="09:00" {today} {locale} size="md" onclick={() => {}} onremove={() => {}} />
      <DateChip date={addDays(today, -1)} {today} {locale} size="md" repeat onclick={() => {}} onremove={() => {}} />
      <DeadlineChip deadline={addDays(today, 3)} {today} {locale} size="md" onclick={() => {}} onremove={() => {}} />
    </div>
  </section>

  <section class="card" data-testid="section-fields">
    <h2>Fields and controls</h2>
    <div class="fields">
      <TextField bind:value={name} label="Name" placeholder="Enter name" data-testid="field-name" />
      <TextField bind:value={password} type="password" label="Password" error={password.length < 8 ? 'Use 8 characters or more' : null} />
      <TextField value="" icon="person" placeholder="With an icon and a hint" hint="A name has 1 to 40 characters" aria-label="Demo" />
      <TextArea bind:value={notes} label="Details" placeholder="Details" />
    </div>
    <div class="row">
      <Switch bind:checked={notify} label="Notifications" />
      <Switch checked={false} label="Off" />
      <Switch checked label="Disabled" disabled />
      <Checkbox bind:checked={showList} label="My Tasks" />
      <Checkbox checked={false} label="Home" />
      <Checkbox checked label="Disabled" disabled />
    </div>
    <div class="row">
      <Radio bind:group={fruit} value="apple" name="fruit" label="Apple" />
      <Radio bind:group={fruit} value="pear" name="fruit" label="Pear" />
      <Radio bind:group={fruit} value="plum" name="fruit" label="Plum" />
      <Radio group="x" value="y" label="Disabled" disabled />
    </div>
    <div class="row">
      <SegmentedControl
        bind:value={sort}
        label="Sort"
        options={[
          { value: 'my', label: 'My order' },
          { value: 'date', label: 'Date' },
          { value: 'title', label: 'Title' },
        ]}
      />
      <Select
        bind:value={listChoice}
        label="List"
        options={[
          { value: 'my', label: 'My Tasks' },
          { value: 'home', label: 'Home' },
          { value: 'work', label: 'Work', icon: 'people' },
        ]}
      />
      <span class="meta" data-testid="select-value">{listChoice}</span>
    </div>
  </section>

  <section class="card" data-testid="section-task">
    <h2>Task parts</h2>
    <div class="tasks">
      {#each tasks as task (task.id)}
        <div class={['task', { done: task.done }]} data-testid="task-{task.id}">
          <CheckCircle checked={task.done} variant={task.id === 't4' ? 'check' : 'circle'} onchange={(checked) => (task.done = checked)} />
          <div class="task-main">
            <div class="task-title">{task.title}</div>
            {#if task.notes}<div class="task-notes">{task.notes}</div>{/if}
            {#if task.due || task.deadline}
              <div class="task-chips">
                {#if task.due}<DateChip date={task.due} time={task.time} {today} {locale} repeat={task.repeat} onclick={() => {}} />{/if}
                {#if task.deadline}<DeadlineChip deadline={task.deadline} {today} {locale} onclick={() => {}} />{/if}
              </div>
            {/if}
          </div>
          <IconButton icon="more" label="Task options" size="sm" onclick={(event) => openMenu(event, { items: taskMenu, align: 'end' })} />
          <Star starred={task.starred} onchange={(starred) => (task.starred = starred)} />
        </div>
      {/each}
    </div>
  </section>

  <section class="card" data-testid="section-menu">
    <h2>Menus</h2>
    <div class="row">
      <Button variant="tonal" icon="more" data-testid="open-list-menu" onclick={(event) => openMenu(event, { items: listMenu, title: 'List options' })}>List menu</Button>
      <Button variant="tonal" icon="more" data-testid="open-task-menu" onclick={(event) => openMenu(event, { items: taskMenu })}>Task menu</Button>
      <Button variant="tonal" data-testid="open-end-menu" onclick={(event) => openMenu(event, { items: taskMenu, align: 'end' })}>Aligned at the end</Button>
    </div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="context"
      data-testid="context-area"
      oncontextmenu={(event) => {
        event.preventDefault();
        menu = { items: taskMenu, anchor: { x: event.clientX, y: event.clientY }, align: 'start' };
      }}
    >
      Right click here
    </div>
    <p class="meta">Selected: <span data-testid="menu-result">{menuResult}</span> · closes: <span data-testid="menu-closes">{menuCloses}</span></p>
  </section>

  <section class="card" data-testid="section-overlays">
    <h2>Dialogs and sheets</h2>
    <div class="row">
      <Button variant="tonal" data-testid="open-dialog" onclick={() => (dialogOpen = true)}>Dialog</Button>
      <Button variant="tonal" data-testid="open-full" onclick={() => (fullOpen = true)}>Full screen on a phone</Button>
      <Button variant="tonal" data-testid="open-nested" onclick={() => (nestedOpen = true)}>Nested</Button>
      <Button variant="tonal" data-testid="open-confirm" onclick={() => (confirmOpen = true)}>Confirm</Button>
      <Button variant="tonal" data-testid="open-prompt" onclick={() => (promptOpen = true)}>Create new list</Button>
      <Button variant="tonal" data-testid="open-rename" onclick={() => (renameOpen = true)}>Rename list</Button>
      <Button variant="tonal" data-testid="open-sheet" onclick={() => (sheetOpen = true)}>Bottom sheet</Button>
      <Button variant="tonal" data-testid="open-add" onclick={() => (addOpen = true)}>Add sheet</Button>
    </div>
    <p class="meta">
      Result: <span data-testid="overlay-result">{overlayResult}</span> · prompt: <span data-testid="prompt-result">{promptResult}</span> · list:
      <span data-testid="list-name">{listName}</span>
    </p>
  </section>

  <section class="card" data-testid="section-snackbar">
    <h2>Snackbar</h2>
    <div class="stack">
      <Snackbar fixed={false} message="Task completed" actionLabel="Undo" />
      <Snackbar fixed={false} message="New version ready" actionLabel="Reload" />
      <Snackbar fixed={false} message="5 completed tasks deleted" />
      <Snackbar fixed={false} message="Task completed. It comes back on Wed 7 Oct, and this text is long to show a second line" actionLabel="Undo" />
    </div>
    <div class="row">
      <Button variant="tonal" data-testid="show-snackbar" onclick={() => (snack = { id: ++snackCount, message: `Task deleted (${snackCount})` })}>Show at its place</Button>
      <Button onclick={() => (snack = null)}>Hide</Button>
    </div>
  </section>

  <section class="card" data-testid="section-empty">
    <h2>Empty states</h2>
    <div class="empties">
      <div class="inner"><EmptyState kind="empty" title="No tasks yet" text="Add your to-dos and keep track of them here" /></div>
      <div class="inner"><EmptyState kind="done" title="All tasks complete" text="Nice work!" /></div>
    </div>
  </section>

  <section class="card" data-testid="section-pickers">
    <h2>Pickers</h2>
    <div class="row">
      <Button variant="tonal" icon="clock" data-testid="open-date" onclick={() => (dateOpen = true)}>Date picker</Button>
      <Button variant="tonal" data-testid="open-plain-date" onclick={() => (plainDateOpen = true)}>Date only, not in the past</Button>
      <Button variant="tonal" icon="target" data-testid="open-deadline" onclick={() => (deadlineOpen = true)}>Deadline picker</Button>
      <Button variant="tonal" icon="repeat" data-testid="open-repeat" onclick={() => (repeatOpen = true)}>Repeat dialog</Button>
      <Button
        data-testid="reset-pickers"
        onclick={() => {
          dateValue = { date: null, time: null, repeat: null };
          repeatRule = null;
          deadline = null;
        }}>Reset</Button
      >
    </div>
    <p class="meta">Date: <code data-testid="date-result">{dateResult}</code></p>
    <p class="meta">Deadline: <code data-testid="deadline-result">{deadlineResult}</code></p>
    <p class="meta">Repeat: <code data-testid="repeat-result">{repeatResult}</code></p>
    <div class="inline-pickers">
      <div class="inner grid"><MonthGrid value={gridDate} {today} {locale} onpick={(date) => (gridDate = date)} /></div>
      <div>
        <TimeField bind:value={fieldTime} {locale} />
        <p class="meta">Time: <code data-testid="time-result">{fieldTime ?? 'none'}</code></p>
      </div>
    </div>
  </section>
</div>

<!-- A menu button at the corner of the window, to see that the menu stays inside. -->
<div class="corner">
  <IconButton icon="more" label="Corner menu" data-testid="open-corner-menu" onclick={(event) => openMenu(event, { items: listMenu })} />
</div>

{#if menu}
  <Menu
    open
    anchor={menu.anchor}
    items={menu.items}
    align={menu.align}
    title={menu.title}
    label="Options"
    onselect={(id) => {
      menuResult = id;
      if (id === 'rename') renameOpen = true;
      if (id === 'new-list') promptOpen = true;
    }}
    onclose={() => {
      menu = null;
      menuCloses++;
    }}
  />
{/if}

<Dialog bind:open={dialogOpen} title="Keyboard shortcuts" onclose={() => (overlayResult = 'dialog closed')}>
  <p class="text">A dialog is a card in the centre. Esc, the Back action, and a press outside close it.</p>
  <div class="fields">
    <TextField value="" placeholder="First field" aria-label="First field" data-testid="dialog-first" />
    <TextField value="" placeholder="Second field" aria-label="Second field" />
  </div>
  {#snippet actions()}
    <Button onclick={() => (dialogOpen = false)}>Cancel</Button>
    <Button variant="filled" data-testid="dialog-ok" onclick={() => ((dialogOpen = false), (overlayResult = 'dialog ok'))}>OK</Button>
  {/snippet}
</Dialog>

<Dialog bind:open={fullOpen} title="Settings" fullscreen width={480} onclose={() => (overlayResult = 'full closed')}>
  <div class="settings">
    <div class="setting"><span>Notifications</span><Switch bind:checked={notify} label="Notifications" /></div>
    <div class="setting">
      <span>Appearance</span>
      <SegmentedControl
        bind:value={theme}
        label="Appearance"
        options={[
          { value: 'system', label: 'System' },
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ]}
      />
    </div>
    <div class="setting"><span>Signed in as Minh</span><Button icon="logout">Sign out</Button></div>
  </div>
  {#snippet headerActions()}
    <IconButton icon="help" label="Help" />
  {/snippet}
</Dialog>

<Dialog bind:open={nestedOpen} title="Create a task" width={400} onclose={() => (overlayResult = 'nested closed')}>
  <div class="fields">
    <TextField value="" placeholder="Title" aria-label="Title" autofocus />
    <div class="row">
      <Select
        bind:value={listChoice}
        label="List"
        options={[
          { value: 'my', label: 'My Tasks' },
          { value: 'home', label: 'Home' },
          { value: 'work', label: 'Work' },
        ]}
      />
      <Button data-testid="open-inner-confirm" onclick={() => (innerConfirmOpen = true)}>Discard…</Button>
    </div>
  </div>
  {#snippet actions()}
    <Button onclick={() => (nestedOpen = false)}>Cancel</Button>
    <Button variant="filled" onclick={() => (nestedOpen = false)}>Save</Button>
  {/snippet}
</Dialog>
<ConfirmDialog
  bind:open={innerConfirmOpen}
  title="Discard the task?"
  text="The text that you typed is lost."
  confirmLabel="Discard"
  danger
  onconfirm={() => {
    nestedOpen = false;
    overlayResult = 'discarded';
  }}
  oncancel={() => (overlayResult = 'kept')}
/>

<ConfirmDialog
  bind:open={confirmOpen}
  title="Delete this list?"
  text="The list and its 12 tasks are deleted for all people."
  confirmLabel="Delete"
  danger
  onconfirm={() => (overlayResult = 'confirmed')}
  oncancel={() => (overlayResult = 'cancelled')}
/>

<TextPromptDialog bind:open={promptOpen} title="Create new list" ondone={(text) => (promptResult = text)} oncancel={() => (promptResult = 'cancelled')} />
<TextPromptDialog bind:open={renameOpen} title="Rename list" value={listName} ondone={(text) => (listName = text)} />

<BottomSheet bind:open={sheetOpen} title="Move to list" onclose={() => (overlayResult = 'sheet closed')}>
  <div class="sheet-list" data-testid="sheet-content">
    {#each Array.from({ length: 30 }, (_, i) => i + 1) as n (n)}
      <button class="sheet-row ui-state" type="button" onclick={() => ((sheetOpen = false), (overlayResult = `row ${n}`))}>List number {n}</button>
    {/each}
  </div>
</BottomSheet>

<BottomSheet bind:open={addOpen} label="New task" handle={false} onclose={() => (overlayResult = 'add closed')}>
  <div class="add">
    <input class="add-title" placeholder="New task" aria-label="Title" data-autofocus bind:value={addTitle} />
    <div class="add-row">
      <IconButton icon="notes" label="Add details" />
      <IconButton icon="clock" label="Set date and time" />
      <IconButton icon="star" label="Add to Starred" />
      <span class="grow"></span>
      <Button disabled={!addTitle.trim()} onclick={() => (addTitle = '')}>Save</Button>
    </div>
  </div>
</BottomSheet>

{#if snack}
  {#key snack.id}
    <Snackbar message={snack.message} actionLabel="Undo" onaction={() => (snack = null)} />
  {/key}
{/if}

<DatePicker
  bind:open={dateOpen}
  value={dateValue}
  {today}
  {locale}
  ondone={(value) => {
    dateValue = value;
    dateResult = JSON.stringify(value);
  }}
  oncancel={() => (dateResult = 'cancelled')}
/>
<DatePicker
  bind:open={plainDateOpen}
  value={plainDate}
  {today}
  {locale}
  allowTime={false}
  allowRepeat={false}
  minDate={today}
  title="Start date"
  ondone={(value) => {
    plainDate = value;
    dateResult = JSON.stringify(value);
  }}
/>
<DeadlinePicker
  bind:open={deadlineOpen}
  value={deadline}
  {today}
  {locale}
  ondone={(date) => {
    deadline = date;
    deadlineResult = date;
  }}
  oncancel={() => (deadlineResult = 'cancelled')}
/>
<RepeatDialog
  bind:open={repeatOpen}
  rule={repeatRule}
  {today}
  {locale}
  ondone={(result) => {
    repeatRule = result.rule;
    repeatResult = JSON.stringify(result);
  }}
  oncancel={() => (repeatResult = 'cancelled')}
/>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 16px;
    max-width: 1120px;
    margin: 0 auto;
    padding: 16px 16px 96px;
  }
  .top {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
  }
  h1 {
    flex: 1;
    font-size: 22px;
    font-weight: 500;
  }
  h2 {
    margin-bottom: 12px;
    font-size: 16px;
    font-weight: 500;
  }
  .card {
    padding: 16px 20px 20px;
    border-radius: var(--radius-card);
    background: var(--surface);
    box-shadow: var(--shadow-1);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-top: 12px;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .meta {
    margin-top: 12px;
    color: var(--text-dim);
    font-size: 13px;
  }
  .top .meta {
    margin: 0;
  }
  code {
    overflow-wrap: anywhere;
    font-size: 12px;
  }
  .text {
    margin-bottom: 12px;
    color: var(--text-dim);
  }
  .swatches {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 8px;
  }
  .swatch {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }
  .swatch span {
    width: 32px;
    height: 32px;
    border: 1px solid var(--outline);
    border-radius: 8px;
  }
  .icons {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
    gap: 4px;
  }
  .icon {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 10px 2px;
    border-radius: 8px;
    color: var(--text);
    font-size: 11px;
  }
  .icon span {
    color: var(--text-dim);
  }
  .sizes {
    color: var(--text-dim);
  }
  .fields {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 16px;
  }
  .tasks {
    max-width: 360px;
    padding: 4px 0;
    border: 1px solid var(--divider);
    border-radius: var(--radius-card);
  }
  .task {
    display: flex;
    align-items: flex-start;
    padding: 2px 4px 2px 6px;
  }
  .task-main {
    flex: 1;
    min-width: 0;
    padding: 10px 4px;
  }
  .task-title {
    font-size: 14px;
    line-height: 20px;
  }
  .task.done .task-title {
    color: var(--text-dim);
    text-decoration: line-through;
  }
  .task-notes {
    color: var(--text-dim);
    font-size: 12px;
    line-height: 16px;
  }
  .task-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }
  .task :global(.icon-btn) {
    margin-top: 4px;
  }
  .context {
    display: grid;
    place-items: center;
    height: 96px;
    margin-top: 12px;
    border: 1px dashed var(--outline);
    border-radius: var(--radius-md);
    color: var(--text-dim);
  }
  .empties {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 16px;
  }
  .inner {
    border: 1px solid var(--divider);
    border-radius: var(--radius-card);
  }
  .inline-pickers {
    display: flex;
    flex-wrap: wrap;
    gap: 24px;
    margin-top: 16px;
  }
  .grid {
    width: 328px;
    max-width: 100%;
    padding: 12px 24px;
  }
  .corner {
    position: fixed;
    right: 4px;
    bottom: 4px;
    border-radius: 50%;
    background: var(--surface);
    box-shadow: var(--shadow-1);
  }
  .settings {
    display: flex;
    flex-direction: column;
  }
  .setting {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 56px;
  }
  .sheet-list {
    margin: 0 -16px;
  }
  .sheet-row {
    display: block;
    width: 100%;
    padding: 14px 20px;
    font-size: 16px;
    text-align: left;
  }
  .add {
    padding-bottom: 4px;
  }
  .add-title {
    width: 100%;
    height: 40px;
    padding: 0 4px;
    color: var(--text);
  }
  .add-row {
    display: flex;
    align-items: center;
    margin: 4px -8px 0;
  }
  .grow {
    flex: 1;
  }
</style>
