<script lang="ts">
  import type { NoteRow } from '../../../shared/types.ts';
  import { Icon, IconButton } from '../ui/index.ts';
  import { NOTES, notes, openMenu, openNote, phone, scrollMemory } from './phone.svelte.ts';

  // The page of the Notes tab (SPEC section 8, "Notes" > "Phone"): a search row that stays at the
  // top, then the grid of web/src/notes/. The search row shows at once. The grid comes when the
  // download of the notes parts is done.

  /** A page that comes back waits this long at most for the cards, before it goes to its old place. */
  const RESTORE_MS = 1000;

  const parts = $derived(notes.parts);

  let root = $state<HTMLElement>();
  /** The page scrolled, so cards go below the search row. */
  let scrolled = $state(false);

  function openCardMenu({ note }: { note: NoteRow }): void {
    const loaded = parts;
    if (!loaded) return;
    openMenu({
      // The heading of the sheet says which note the menu is for.
      title: loaded.noteName(note),
      label: 'Note options',
      items: loaded.noteMenuItems({ note }),
      run: (itemId) => void loaded.runNoteMenuItem({ note, itemId }),
    });
  }

  function toggleArchive(): void {
    phone.archive = !phone.archive;
    // The other view starts at its top.
    const scroller = root?.parentElement;
    if (scroller) scroller.scrollTop = 0;
  }

  function onSearchKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.isComposing) return;
    // The grid shows the result while the person types. Enter only puts the keyboard away.
    event.preventDefault();
    (event.currentTarget as HTMLElement).blur();
  }

  /** A press on the X must not take the focus out of the field: the keyboard would close. */
  function keepFocus(event: Event): void {
    event.preventDefault();
  }

  // ---- Scroll position ----

  // The cards get their places one frame after they come, so the old place can be below the end
  // of the page at first. Each frame checks again, until the page is long enough, a finger takes
  // over, or the time is up. A ResizeObserver on the page would fire in the same frame as the one
  // of the cards, which gives the browser an error about undelivered notifications.
  $effect(() => {
    const scroller = root?.parentElement;
    if (!scroller) return;
    let pending = scrollMemory.get(NOTES) ?? 0;
    const started = performance.now();
    let frame = 0;
    const restore = (): void => {
      frame = 0;
      if (pending <= 0) return;
      if (scroller.scrollHeight - scroller.clientHeight >= pending || performance.now() - started > RESTORE_MS) {
        scroller.scrollTop = pending;
        pending = 0;
        return;
      }
      frame = requestAnimationFrame(restore);
    };
    const stop = (): void => void (pending = 0);
    const remember = (): void => {
      scrolled = scroller.scrollTop > 0;
      if (pending === 0) scrollMemory.set(NOTES, scroller.scrollTop);
    };
    if (pending > 0) frame = requestAnimationFrame(restore);
    scroller.addEventListener('scroll', remember, { passive: true });
    scroller.addEventListener('touchstart', stop, { passive: true });
    scroller.addEventListener('wheel', stop, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', remember);
      scroller.removeEventListener('touchstart', stop);
      scroller.removeEventListener('wheel', stop);
    };
  });
</script>

<div class="content" bind:this={root}>
  <div class={['search-row', { scrolled }]}>
    <label class="search">
      <Icon name="search" size={20} />
      <input
        type="search"
        placeholder={phone.archive ? 'Search archive' : 'Search notes'}
        aria-label={phone.archive ? 'Search archive' : 'Search notes'}
        enterkeyhint="search"
        autocomplete="off"
        bind:value={phone.query}
        onkeydown={onSearchKey}
      />
      {#if phone.query}
        <IconButton
          class="tap"
          icon="close"
          label="Clear search"
          tooltip={false}
          onpointerdown={keepFocus}
          onmousedown={keepFocus}
          onclick={() => (phone.query = '')}
        />
      {/if}
    </label>
    <IconButton class="archive-toggle" icon="archive" label="Archive" tooltip={false} active={phone.archive} onclick={toggleArchive} />
  </div>

  {#if phone.archive}
    <!-- The grid has no headings in the archive. This one says where the person is. -->
    <h2 class="heading">Archive</h2>
  {/if}
  {#if parts}
    <div class="grid">
      <parts.NotesGrid archived={phone.archive} query={phone.query} hiddenId={null} onopen={openNote} onmenu={openCardMenu} />
    </div>
  {/if}
</div>

<style>
  .content {
    position: relative;
    min-height: 100%;
    animation: page-in var(--dur) var(--ease);
  }
  /* As the task pages: a page that the person jumped to comes in softly. */
  @keyframes page-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }

  /* The row stays at the top while the cards scroll below it. The page has no padding at the top
     for this row, so the row covers the full top edge. */
  .search-row {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 0;
    background: var(--bg);
  }
  /* The cards that scroll below the row fade out, and do not end at a hard line. */
  .search-row::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 100%;
    height: 12px;
    background: linear-gradient(var(--bg), transparent);
    opacity: 0;
    transition: opacity var(--dur-fast) linear;
    pointer-events: none;
  }
  .search-row.scrolled::after {
    opacity: 1;
  }

  .search {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 12px;
    min-width: 0;
    height: 48px;
    padding: 0 2px 0 16px;
    border-radius: var(--radius-pill);
    background: var(--surface);
    box-shadow: var(--shadow-1);
    color: var(--text-dim);
    cursor: text;
  }
  .search input {
    flex: 1;
    min-width: 0;
    height: 100%;
    color: var(--text);
    font-size: 16px;
    caret-color: var(--primary);
    -webkit-user-select: text;
    user-select: text;
  }
  /* The field has its own X. */
  .search input::-webkit-search-cancel-button,
  .search input::-webkit-search-decoration {
    display: none;
    -webkit-appearance: none;
  }
  /* The X is a 44 px press area at the end of the pill. */
  .search :global(.icon-btn) {
    color: var(--text-dim);
  }

  .search-row :global(.archive-toggle) {
    width: 48px;
    height: 48px;
    background: var(--surface);
    box-shadow: var(--shadow-1);
    color: var(--text-dim);
  }
  /* The tint of the pressed toggle fades in by opacity. */
  .search-row :global(.archive-toggle)::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: var(--primary-container);
    opacity: 0;
    transition: opacity var(--dur-fast) linear;
  }
  .search-row :global(.archive-toggle > svg) {
    position: relative;
  }
  .search-row :global(.archive-toggle.active) {
    color: var(--on-primary-container);
  }
  .search-row :global(.archive-toggle.active)::before {
    opacity: 1;
  }

  .grid {
    padding-top: 4px;
  }
  /* The same look as "Pinned" and "Others" of the grid. */
  .heading {
    padding: 4px 4px 4px;
    color: var(--text-dim);
    font-size: 11px;
    font-weight: 500;
    line-height: 16px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
</style>
