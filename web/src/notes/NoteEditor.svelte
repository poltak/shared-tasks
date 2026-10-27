<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { editedText } from '../../../shared/dates.ts';
  import { LIMITS, type ID } from '../../../shared/types.ts';
  import { actions, prefs, session, store, toast } from '../data/index.ts';
  import { Button, Icon, IconButton, layout, TextArea, type MenuAnchor } from '../ui/index.ts';
  import ColorPopup from './ColorPopup.svelte';
  import { NoteDraft, type NoteField } from './draft.svelte.ts';
  import { noteBackground, personName, sharedText } from './names.ts';

  // The fields and the controls of one note (SPEC section 8, "Note editor"). The layout gives the
  // frame: the full screen of the phone, or a 600 px dialog on a wide screen. The editor paints
  // the note color over all of that frame. Its close rules run when it leaves the screen, so a
  // close by Back, by Esc, or by a press outside follows them too.
  interface Props {
    id: ID;
    /** A note that has no row yet. It gets its row at the first key that is not a space. */
    isNew: boolean;
    /** Asks the layout to close the frame. */
    onclose: () => void;
    /** The three-dot button: the layout shows `noteMenuItems` at the anchor. */
    onmenu: (anchor: MenuAnchor) => void;
  }
  const props: Props = $props();
  // One editor is for one note. The values of the owner can go away before the close rules run.
  const draft = new NoteDraft(untrack(() => ({ id: props.id, isNew: props.isNew })));
  const isNew = untrack(() => props.isNew);

  const locale = navigator.language;
  const phone = $derived(layout.phone);

  let root = $state<HTMLElement>();
  let titleField = $state<HTMLTextAreaElement | null>(null);
  let bodyField = $state<HTMLTextAreaElement | null>(null);
  let paletteButton = $state<HTMLButtonElement | null>(null);
  let colorOpen = $state(false);

  const note = $derived(draft.note);
  /** "Edited 14:30", with " by Sam" when the other person made the last edit. */
  const edited = $derived.by(() => {
    if (!note) return '';
    const text = editedText({ at: note.editedAt, today: store.today, locale });
    return note.editedBy && note.editedBy !== session.me?.id ? `${text} by ${personName(note.editedBy)}` : text;
  });
  const shared = $derived(note ? sharedText(note) : null);

  $effect(() => draft.follow());

  // The note went away: "Delete" of the note menu, or the owner deleted it or stopped the sharing.
  $effect(() => {
    if (!draft.gone) return;
    untrack(() => {
      const message = draft.goneMessage();
      if (message) toast.show({ message });
      colorOpen = false;
      props.onclose();
    });
  });

  onDestroy(() => draft.finish());

  /**
   * Puts the focus in a field, with the caret at the end. It works in the handler of a tap, so
   * the phone can call it right after `flushSync` and iOS shows the keyboard.
   */
  export function focus(field: NoteField = 'body'): void {
    const element = field === 'title' ? titleField : bodyField;
    if (!element) return;
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
  }

  /**
   * Runs the close rules now, and not when the editor leaves the screen. A layout that closes
   * the frame with an exit motion calls it first, so an emptied note does not show as an "Empty
   * note" card while the frame goes away. More than one call does no harm.
   */
  export function finish(): void {
    draft.finish();
  }

  /** The Back button and "Close" run the close rules first. A note that goes away then makes no flash in the grid. */
  function close(): void {
    draft.finish();
    props.onclose();
  }

  /** As in Google Keep, the archive button puts the note away and closes it. */
  function toggleArchive(): void {
    if (draft.exists) actions.setNoteArchived({ id: draft.id, archived: !draft.archived });
    close();
  }

  function onTitleKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.isComposing) return;
    // The title is one line. Enter goes on in the body, as at the end of a heading.
    event.preventDefault();
    bodyField?.focus();
    bodyField?.setSelectionRange(0, 0);
  }

  function onKey(event: KeyboardEvent): void {
    // Ctrl+Enter or Command+Enter: done, as in Google Keep.
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      close();
    }
  }

  // An installed app on a phone colors the status bar with the theme color. It takes the note
  // color while the editor is open, and gets its old values back at the close.
  $effect(() => {
    if (!phone || !root) return;
    void draft.color;
    void prefs.theme;
    const metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
    const old = metas.map((meta) => meta.content);
    const color = getComputedStyle(root).backgroundColor;
    for (const meta of metas) meta.content = color;
    return () => metas.forEach((meta, i) => (meta.content = old[i]!));
  });
</script>

{#snippet pinButton()}
  <IconButton
    icon={draft.pinned ? 'pin-filled' : 'pin'}
    label={draft.pinned ? 'Unpin note' : 'Pin note'}
    tooltip={!phone}
    onclick={() => draft.togglePin()}
  />
{/snippet}

{#snippet archiveButton()}
  <IconButton
    icon={draft.archived ? 'unarchive' : 'archive'}
    label={draft.archived ? 'Unarchive' : 'Archive'}
    tooltip={!phone}
    onclick={toggleArchive}
  />
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class={['editor', phone ? 'phone' : 'wide']} style:--note-bg={noteBackground(draft.color)} bind:this={root} onkeydown={onKey}>
  {#if phone}
    <header class="bar">
      <IconButton icon="back" label="Back" tooltip={false} onclick={close} />
      <span class="grow"></span>
      {@render pinButton()}
      {@render archiveButton()}
    </header>
  {/if}

  <div class="page">
    <TextArea
      class="title-field"
      variant="plain"
      placeholder="Title"
      aria-label="Title"
      enterkeyhint="next"
      autocomplete="off"
      maxlength={LIMITS.noteTitle}
      maxRows={8}
      bind:ref={titleField}
      bind:value={() => draft.title, (value) => draft.type('title', value)}
      onfocus={() => draft.focus('title')}
      onblur={() => draft.blur('title')}
      onkeydown={onTitleKey}
    />
    <!-- After the title in the order of Tab, at the top right for the eye. -->
    {#if !phone}<div class="pin">{@render pinButton()}</div>{/if}
    <TextArea
      class="body-field"
      variant="plain"
      placeholder="Note"
      aria-label="Note"
      maxlength={LIMITS.noteBody}
      maxRows={100000}
      data-autofocus={isNew ? '' : undefined}
      bind:ref={bodyField}
      bind:value={() => draft.body, (value) => draft.type('body', value)}
      onfocus={() => draft.focus('body')}
      onblur={() => draft.blur('body')}
    />
    {#if shared || (!phone && edited)}
      <div class="meta">
        {#if shared}<span class="shared"><Icon name="people" size={16} />{shared}</span>{/if}
        {#if !phone && edited}<span class="edited">{edited}</span>{/if}
      </div>
    {/if}
  </div>

  <footer class="tools">
    <IconButton icon="palette" label="Change color" tooltip={!phone} bind:ref={paletteButton} onclick={() => (colorOpen = true)} />
    {#if phone}
      <span class="edited">{edited}</span>
    {:else}
      {@render archiveButton()}
    {/if}
    <IconButton
      icon="more"
      label="Note options"
      tooltip={!phone}
      aria-haspopup="menu"
      disabled={!draft.exists}
      onclick={(event) => props.onmenu(event.currentTarget)}
    />
    {#if !phone}
      <span class="grow"></span>
      <Button onclick={close}>Close</Button>
    {/if}
  </footer>
</div>

<ColorPopup bind:open={colorOpen} value={draft.color} anchor={paletteButton} onpick={(color) => draft.setColor(color)} />

<style>
  .editor {
    position: relative;
    display: flex;
    flex-direction: column;
    background: var(--note-bg);
    color: var(--text);
  }
  .editor :global(.icon-btn) {
    color: var(--note-text-dim);
  }
  .editor :global(.icon-btn:disabled) {
    color: color-mix(in srgb, var(--note-text-dim) 45%, transparent);
  }
  .grow {
    flex: 1;
  }

  .page {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .page :global(textarea) {
    caret-color: var(--text);
  }
  .page :global(textarea::placeholder) {
    color: var(--note-text-dim);
  }
  .page :global(.title-field textarea) {
    font-size: 22px;
    font-weight: 500;
    line-height: 28px;
    letter-spacing: -0.01em;
  }
  .page :global(.body-field) {
    flex: 1;
  }
  .page :global(.body-field textarea) {
    flex: 1;
    font-size: 16px;
    line-height: 24px;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 4px 16px;
    color: var(--note-text-dim);
    font-size: 12px;
    line-height: 16px;
  }
  .shared {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 500;
  }
  .edited {
    margin-left: auto;
  }

  /* ---- Phone: the full screen ---- */

  .phone {
    height: 100%;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);
  }
  /* The press area of a finger. */
  .phone :global(.icon-btn) {
    width: 44px;
    height: 44px;
  }
  .phone .bar {
    display: flex;
    flex: none;
    align-items: center;
    gap: 4px;
    height: 56px;
    padding: 0 8px;
  }
  .phone .page {
    flex: 1;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 4px 20px 16px;
  }
  .phone .page :global(.title-field) {
    padding: 4px 0 12px;
  }
  .phone .page :global(.body-field textarea) {
    /* A tap below the text puts the caret at the end, as in a page of paper. */
    min-height: 100%;
  }
  .phone .meta {
    padding-top: 12px;
  }
  .phone .tools {
    display: flex;
    flex: none;
    align-items: center;
    gap: 4px;
    min-height: 52px;
    padding: 4px 8px calc(4px + env(safe-area-inset-bottom));
  }
  .phone .tools .edited {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    margin: 0;
    color: var(--note-text-dim);
    font-size: 12px;
    line-height: 16px;
    text-align: center;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ---- Wide: the content of a dialog ---- */

  .wide {
    min-height: 100%;
  }
  .wide .pin {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 1;
  }
  .wide .page {
    padding: 18px 24px 12px;
  }
  .wide .page :global(.title-field) {
    /* Room for the pin button. */
    padding: 0 40px 12px 0;
  }
  .wide .page :global(.body-field textarea) {
    min-height: 96px;
  }
  .wide .meta {
    padding-top: 12px;
  }
  .wide .tools {
    position: sticky;
    bottom: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 12px 10px;
    background: var(--note-bg);
  }
  /* A long text fades out where it goes below the buttons. Over a short text it covers only the
     free room below the text. */
  .wide .tools::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: 100%;
    height: 12px;
    background: linear-gradient(transparent, var(--note-bg));
    pointer-events: none;
  }
</style>
