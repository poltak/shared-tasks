<script lang="ts">
  import type { ID, NoteRow } from '../../../shared/types.ts';
  import { pickNoteColor } from '../common/dialogs.svelte.ts';
  import { actions } from '../data/index.ts';
  import { Icon, IconButton, layout, type MenuAnchor } from '../ui/index.ts';
  import { isEmptyNote, noteBackground, noteName, sharedText } from './names.ts';

  // One note in the grid (SPEC section 8, "Note card"). The open control is a button that covers
  // the card. The other controls come after it, never inside it, so each is a button of its own.
  // The text is plain text: Svelte sets it as text, never as HTML.
  interface Props {
    note: NoteRow;
    onopen: (id: ID) => void;
    onmenu: (input: { note: NoteRow; anchor: MenuAnchor }) => void;
  }
  let { note, onopen, onmenu }: Props = $props();

  /** A note with no title and a short body shows the body in larger text, as Google Keep does. */
  const SHORT = 40;

  const title = $derived(note.title.trim());
  // Blank lines at the ends of the body take room and tell nothing.
  const body = $derived(note.body.replace(/^\s*\n/, '').trimEnd());
  const big = $derived(!title && body.trim().length <= SHORT);
  const empty = $derived(isEmptyNote(note));
  const shared = $derived(sharedText(note));
  /** The controls of a wide screen. A phone has the editor and its menu for them. */
  const tools = $derived(layout.wide);

  function oncontextmenu(event: MouseEvent): void {
    event.preventDefault();
    // The context menu key gives no point: the menu then opens at the card.
    const byKey = event.button !== 2 && event.clientX === 0 && event.clientY === 0;
    onmenu({ note, anchor: byKey ? (event.currentTarget as Element) : { x: event.clientX, y: event.clientY } });
  }
</script>

<article
  class={['card', { plain: note.color === 'default', tools, always: tools && !layout.hover }]}
  style:background={noteBackground(note.color)}
  data-note-id={note.id}
  {oncontextmenu}
>
  <button class="open" type="button" aria-label={noteName(note)} onclick={() => onopen(note.id)}></button>
  {#if title}<h3 class="title">{title}</h3>{/if}
  {#if body}<p class={['body', { big }]}>{body}</p>{/if}
  {#if empty}<p class="empty">Empty note</p>{/if}
  {#if shared}
    <p class="shared"><Icon name="people" size={16} /><span>{shared}</span></p>
  {/if}
  {#if tools}
    <div class="pin">
      <IconButton
        size="sm"
        icon={note.pinned ? 'pin-filled' : 'pin'}
        label={note.pinned ? 'Unpin note' : 'Pin note'}
        onclick={() => actions.setNotePinned({ id: note.id, pinned: !note.pinned })}
      />
    </div>
    <div class="bar">
      <IconButton size="sm" icon="palette" label="Change color" onclick={(event) => void pickNoteColor({ id: note.id, anchor: event.currentTarget })} />
      <IconButton
        size="sm"
        icon={note.archived ? 'unarchive' : 'archive'}
        label={note.archived ? 'Unarchive' : 'Archive'}
        onclick={() => actions.setNoteArchived({ id: note.id, archived: !note.archived })}
      />
      <IconButton size="sm" icon="more" label="Note options" aria-haspopup="menu" onclick={(event) => onmenu({ note, anchor: event.currentTarget })} />
    </div>
  {/if}
</article>

<style>
  .card {
    position: relative;
    isolation: isolate;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 48px;
    padding: 12px 14px 14px;
    border-radius: var(--radius-card);
    color: var(--text);
    /* A colored card has an edge that is nearly invisible, so the cards of the grid line up. */
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--note-edge) 40%, transparent);
    overflow-wrap: anywhere;
  }
  .plain {
    box-shadow: inset 0 0 0 1px var(--note-edge);
  }
  /* The shadow of a card under the pointer. It fades in by opacity, so it costs no paint of the card. */
  .card::after {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    box-shadow: var(--shadow-2);
    opacity: 0;
    transition: opacity var(--dur-fast) linear;
    pointer-events: none;
  }
  @media (hover: hover) {
    .card:hover::after {
      opacity: 1;
    }
  }

  .open {
    position: absolute;
    inset: 0;
    z-index: 0;
    border-radius: inherit;
  }
  .open:focus-visible {
    outline-offset: 2px;
  }
  /* The text is above the open button for the eye, and a press goes through it to the button. */
  .title,
  .body,
  .empty,
  .shared {
    position: relative;
    pointer-events: none;
  }
  .title {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    font-size: 16px;
    font-weight: 500;
    line-height: 22px;
  }
  .body {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: var(--body-lines, 10);
    line-clamp: var(--body-lines, 10);
    font-size: 14px;
    line-height: 20px;
    white-space: pre-wrap;
  }
  .body.big {
    font-size: 20px;
    line-height: 28px;
  }
  .empty {
    color: var(--note-text-dim);
    font-size: 20px;
    line-height: 28px;
  }
  .shared {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    margin-top: 4px;
    color: var(--note-text-dim);
    font-size: 12px;
    font-weight: 500;
    line-height: 16px;
  }
  .shared span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ---- The controls of a wide screen ---- */

  .tools {
    --body-lines: 16;
    /* The card keeps the room of the controls at the bottom free, so nothing moves when they show. */
    padding: 12px 16px 40px;
  }
  .tools .title {
    /* Room for the pin button. */
    padding-right: 24px;
  }
  .pin {
    position: absolute;
    top: 6px;
    right: 6px;
  }
  .bar {
    position: absolute;
    left: 8px;
    bottom: 4px;
    display: flex;
    gap: 4px;
  }
  .pin,
  .bar {
    z-index: 1;
    opacity: 0;
    transition: opacity var(--dur-fast) linear;
  }
  .card:hover .pin,
  .card:hover .bar,
  .card:focus-within .pin,
  .card:focus-within .bar,
  .always .pin,
  .always .bar {
    opacity: 1;
  }
  .card :global(.icon-btn) {
    color: var(--note-text-dim);
  }
</style>
