<script lang="ts">
  // A page to try the notes parts of web/src/notes/ against a development server with the seed
  // data, in the frame that each layout gives them. It shows how a layout mounts the parts. The
  // width of the window selects the frame, as in the app. Address values:
  //   ?user=sam        the second test account
  //   ?theme=dark      or light
  //   ?archive=1       the archive
  //   ?q=WORDS         a search
  //   ?open=TITLE      opens the first note whose title or body starts with this text
  //   ?menu=TITLE      opens the note menu of that note
  //   ?color=TITLE     opens the color picker of that note
  //   ?tasks=TITLE     opens "Make tasks" for that note
  //   ?new=1           a new note: the editor on a phone, the composer on a wide screen
  //   ?fill=1          adds sample notes of each color and length, one time for each database
  import { flushSync } from 'svelte';
  import { newId } from '../../shared/ids.ts';
  import type { ID, NoteColor, NoteRow } from '../../shared/types.ts';
  import fixtures from '../../e2e/fixtures/users.json';
  import DialogHost from '../src/common/DialogHost.svelte';
  import { askMakeTasks, pickNoteColor } from '../src/common/dialogs.svelte.ts';
  import { actions, getNote, login, notesView, prefs, session } from '../src/data/index.ts';
  import SnackbarHost from '../src/shell/SnackbarHost.svelte';
  import { Dialog, Icon, IconButton, layout, Menu, portal, pushOverlay, slide, type MenuAnchor, type MenuItem } from '../src/ui/index.ts';

  type NotesParts = typeof import('../src/notes/index.ts');

  const query = new URLSearchParams(location.search);
  const account = fixtures.users[query.get('user') === 'sam' ? 1 : 0]!;
  const theme = query.get('theme');
  if (theme === 'dark' || theme === 'light') prefs.theme = theme;

  $effect(() => {
    if (session.status === 'signedOut') void login(account);
  });

  // The layouts load the parts in the same way: one import of index.ts.
  let parts = $state.raw<NotesParts | null>(null);
  void import('../src/notes/index.ts').then((loaded) => (parts = loaded));

  // Notes of each color and length, to see the clamps, the large text, and the masonry.
  const SAMPLES: { title: string; body: string; color: NoteColor; pinned?: boolean }[] = [
    { title: 'A title that is long enough to need more than four lines in a card of the grid, so it is cut', body: 'Short body.', color: 'red' },
    { title: '', body: 'Call Mum', color: 'yellow' },
    { title: 'Long note', body: Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long note`).join('\n'), color: 'teal' },
    { title: 'Recipe', body: '200 g flour\n2 eggs\n300 ml milk\nA pinch of salt\n\nMix, rest for 30 minutes, and fry thin.', color: 'brown', pinned: true },
    { title: 'Wi-Fi', body: 'Network: lakehouse-5G\nPassword: correct horse battery staple', color: 'blue' },
    { title: '', body: 'A note with no title and a body that is longer than forty characters shows at the normal size.', color: 'purple' },
    { title: 'Packing', body: '- [ ] Passport\n- [ ] Charger\n- [x] Tickets', color: 'darkblue' },
    { title: 'Ideas', body: 'Paint the fence\nNew shelves for the hall', color: 'pink' },
    { title: 'Plain', body: 'A default note in the card color.', color: 'default' },
    { title: 'Gray', body: 'A gray note.', color: 'gray' },
    { title: 'Green', body: 'A green note.', color: 'green' },
    { title: 'Orange', body: 'An orange note with a longer body that wraps over more than one line of the card.', color: 'orange' },
  ];
  let filled = false;
  $effect(() => {
    if (filled || query.get('fill') !== '1' || session.status !== 'signedIn' || notesView({ archived: false, query: '' }).others.length === 0) return;
    filled = true;
    if (find('Long note')) return;
    for (const sample of SAMPLES) actions.createNote(sample);
    // An empty note of the person: the card says "Empty note".
    const empty = actions.createNote({ title: 'x' }).puts[0]?.id;
    if (empty) actions.updateNote({ id: empty, title: '' });
  });

  let archived = $state(query.get('archive') === '1');
  let search = $state(query.get('q') ?? '');

  // ---- The editor ----

  interface Open {
    id: ID;
    isNew: boolean;
  }
  let editor = $state.raw<Open | null>(null);
  let editorPart = $state<{ focus: (field?: 'title' | 'body') => void; finish: () => void } | null>(null);
  let screen = $state<HTMLElement>();

  function openNote(id: ID): void {
    editor = { id, isNew: false };
  }

  /** The add button of the phone. The focus must come in the handler of the tap, or iOS shows no keyboard. */
  function newNote(): void {
    editor = { id: newId(), isNew: true };
    flushSync();
    editorPart?.focus('body');
  }

  /** The close rules run now, so an emptied note does not show as a card during the exit motion. */
  function closeEditor(): void {
    editorPart?.finish();
    editor = null;
  }

  // The full screen of the phone is an overlay, so Back and Esc close it.
  $effect(() => {
    if (!screen) return;
    const element = screen;
    return pushOverlay({ close: closeEditor, element: () => element }).remove;
  });

  // ---- The composer of the wide screen ----

  let composer = $state<{ focus: () => void } | null>(null);
  let composing = $state<ID | null>(null);

  // ---- The note menu ----

  interface OpenMenu {
    note: NoteRow;
    anchor: MenuAnchor;
    items: MenuItem[];
  }
  let menu = $state.raw<OpenMenu | null>(null);
  let menuOpen = $state(false);

  function openMenu({ note, anchor }: { note: NoteRow; anchor: MenuAnchor }): void {
    if (!parts) return;
    menu = { note, anchor, items: parts.noteMenuItems({ note }) };
    menuOpen = true;
  }

  function editorMenu(anchor: MenuAnchor): void {
    const note = editor && getNote(editor.id);
    if (note) openMenu({ note, anchor });
  }

  // ---- Address values, for screenshots ----

  function find(text: string | null): NoteRow | undefined {
    if (!text) return undefined;
    const all = [...notesView({ archived: false, query: '' }).pinned, ...notesView({ archived: false, query: '' }).others, ...notesView({ archived: true, query: '' }).others];
    const lower = text.toLowerCase();
    return all.find((note) => note.title.toLowerCase().startsWith(lower) || note.body.toLowerCase().startsWith(lower));
  }

  let asked = false;
  $effect(() => {
    if (asked || !parts || session.status !== 'signedIn' || notesView({ archived: false, query: '' }).others.length === 0) return;
    asked = true;
    // The cards need a frame to get their places, and a menu or a picker opens at a card.
    setTimeout(actOnAddress, 300);
  });

  function actOnAddress(): void {
    const open = find(query.get('open'));
    if (open) openNote(open.id);
    const forMenu = find(query.get('menu'));
    if (forMenu) {
      const card = document.querySelector(`[data-note-id="${forMenu.id}"]`);
      openMenu({ note: forMenu, anchor: card ?? { x: 200, y: 200 } });
    }
    const forColor = find(query.get('color'));
    if (forColor) void pickNoteColor({ id: forColor.id, anchor: document.querySelector(`[data-note-id="${forColor.id}"]`) });
    const forTasks = find(query.get('tasks'));
    if (forTasks) void askMakeTasks({ id: forTasks.id }).then((choice) => choice && actions.noteToTasks({ id: forTasks.id, ...choice }));
    if (query.get('new') === '1') {
      if (layout.phone) newNote();
      else composer?.focus();
    }
  }
</script>

{#if session.status === 'signedIn' && parts}
  {#if layout.phone}
    <div class="phone" data-testid="app-ready">
      <header class="top"><h1>Notes</h1></header>
      <main class="page">
        <div class="search-row">
          <label class="search">
            <Icon name="search" size={20} />
            <input type="search" placeholder={archived ? 'Search archive' : 'Search notes'} enterkeyhint="search" bind:value={search} />
            {#if search}<IconButton icon="close" label="Clear search" size="sm" tooltip={false} onclick={() => (search = '')} />{/if}
          </label>
          <IconButton icon="archive" label="Archive" active={archived} tooltip={false} onclick={() => (archived = !archived)} />
        </div>
        <parts.NotesGrid {archived} query={search} hiddenId={null} onopen={openNote} onmenu={openMenu} />
      </main>
      {#if !archived}
        <button class="fab ui-state" type="button" aria-label="New note" onclick={newNote}><Icon name="plus" /></button>
      {/if}
    </div>

    {#if editor}
      <div class="ui-layer" use:portal>
        <div
          class="screen"
          role="dialog"
          aria-modal="true"
          aria-label={editor.isNew ? 'New note' : 'Note'}
          tabindex="-1"
          bind:this={screen}
          in:slide|global
          out:slide|global={{ duration: 180 }}
        >
          <parts.NoteEditor bind:this={editorPart} id={editor.id} isNew={editor.isNew} onclose={closeEditor} onmenu={editorMenu} />
        </div>
      </div>
    {/if}
  {:else}
    <div class="wide" data-testid="app-ready">
      <header class="bar">
        <IconButton icon="menu" label="Main menu" />
        <Icon name="bulb" />
        <span class="name">{archived ? 'Archive' : 'Notes'}</span>
        <label class="search wide-search">
          <Icon name="search" size={20} />
          <input type="search" placeholder={archived ? 'Search archive' : 'Search notes'} bind:value={search} />
          {#if search}<IconButton icon="close" label="Clear search" size="sm" onclick={() => (search = '')} />{/if}
        </label>
        <IconButton icon="archive" label="Archive" active={archived} onclick={() => (archived = !archived)} />
      </header>
      <main class="board">
        {#if !archived}
          <div class="composer"><parts.NoteComposer bind:this={composer} bind:noteId={composing} /></div>
        {/if}
        <parts.NotesGrid {archived} query={search} hiddenId={composing} onopen={openNote} onmenu={openMenu} />
      </main>
    </div>

    {#if editor}
      <Dialog open width={600} padded={false} label="Note" onclose={closeEditor}>
        <parts.NoteEditor bind:this={editorPart} id={editor.id} isNew={editor.isNew} onclose={closeEditor} onmenu={editorMenu} />
      </Dialog>
    {/if}
  {/if}

  <Menu
    bind:open={menuOpen}
    anchor={menu?.anchor}
    items={menu?.items ?? []}
    title={menu ? (menu.note.title.trim() || 'Note') : undefined}
    label="Note options"
    onselect={(itemId) => menu && parts && void parts.runNoteMenuItem({ note: menu.note, itemId, anchor: menu.anchor })}
  />
  <DialogHost />
{/if}
<SnackbarHost />

<style>
  .phone {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }
  .top {
    display: flex;
    flex: none;
    align-items: center;
    height: 56px;
    padding: 0 20px;
  }
  h1 {
    font-size: 22px;
    font-weight: 500;
    line-height: 28px;
  }
  .page {
    flex: 1;
    overflow-y: auto;
    padding: 4px 12px 96px;
  }
  .search-row {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 16px;
  }
  .search {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 10px;
    height: 48px;
    padding: 0 6px 0 16px;
    border-radius: var(--radius-pill);
    background: var(--surface);
    box-shadow: var(--shadow-1);
    color: var(--text-dim);
  }
  .search input {
    flex: 1;
    min-width: 0;
    height: 100%;
    color: var(--text);
  }
  .fab {
    position: fixed;
    right: 16px;
    bottom: 16px;
    display: grid;
    place-items: center;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: var(--primary);
    box-shadow: var(--shadow-2);
    color: var(--on-primary);
  }
  .screen {
    width: 100%;
    height: 100%;
    outline: none;
  }

  .wide {
    min-height: 100vh;
    background: var(--bg);
  }
  .bar {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 12px;
    height: 64px;
    padding: 0 16px 0 8px;
    background: var(--bg);
    color: var(--text-dim);
  }
  .name {
    color: var(--text);
    font-size: 20px;
    font-weight: 500;
  }
  .wide-search {
    max-width: 720px;
    margin: 0 auto;
    background: var(--surface-2);
    box-shadow: none;
  }
  .board {
    padding: 24px 24px 64px 280px;
  }
  .composer {
    margin-bottom: 32px;
  }
</style>
