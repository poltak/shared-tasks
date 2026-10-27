<script lang="ts">
  import { flushSync, onDestroy, tick, untrack } from 'svelte';
  import { newId } from '../../../shared/ids.ts';
  import { LIMITS, type ID } from '../../../shared/types.ts';
  import { otherUser, toast } from '../data/index.ts';
  import { Button, fade, IconButton, TextArea } from '../ui/index.ts';
  import ColorPopup from './ColorPopup.svelte';
  import { NoteDraft } from './draft.svelte.ts';
  import { noteBackground } from './names.ts';

  // "Take a note…" at the top of the notes board of a wide screen (SPEC section 8, "Wide"). A
  // click opens it in place. The note gets its row at the first key and stays out of the grid
  // until the composer closes: give `noteId` to the grid as `hiddenId`. Esc, "Close", and a
  // press outside close it, with the close rules of the note editor.
  interface Props {
    /** Called after each close, when the note (if any) is in the grid. */
    onclose?: () => void;
    /** true while the composer is open. Set it to open or close the composer. */
    open?: boolean;
    /** The note of the open composer, or null. Read only. */
    noteId?: ID | null;
  }
  let { onclose, open = $bindable(false), noteId = $bindable(null) }: Props = $props();

  let draft = $state.raw<NoteDraft | null>(null);
  let root = $state<HTMLElement>();
  let collapsed = $state<HTMLButtonElement>();
  let bodyField = $state<HTMLTextAreaElement | null>(null);
  let paletteButton = $state<HTMLButtonElement | null>(null);
  let colorOpen = $state(false);

  const other = $derived(otherUser());

  function begin(): void {
    if (draft) return;
    draft = new NoteDraft({ id: newId(), isNew: true });
    noteId = draft.id;
    open = true;
  }

  /** Closes with the close rules. `refocus`: the focus was in the composer, so it goes to "Take a note…". */
  function end({ refocus = false }: { refocus?: boolean } = {}): void {
    const current = draft;
    if (!current) return;
    current.finish();
    draft = null;
    noteId = null;
    open = false;
    colorOpen = false;
    onclose?.();
    if (refocus) {
      flushSync();
      collapsed?.focus();
    }
  }

  // The owner can open or close the composer with `open`. It opens with the focus in the body.
  $effect.pre(() => {
    if (open && !draft) {
      untrack(begin);
      void tick().then(() => bodyField?.focus({ preventScroll: true }));
    } else if (!open && draft) untrack(() => end());
  });

  /**
   * Opens the composer and puts the focus in the body, in the same call: for "Take a note…", the
   * "Create" button, the keys n and c, and /?new=note.
   */
  export function focus(): void {
    begin();
    flushSync();
    bodyField?.focus({ preventScroll: true });
  }

  $effect(() => {
    if (draft) draft.follow();
  });

  // Only the owner, from a different device, can delete a note that is still in the composer.
  $effect(() => {
    if (!draft?.gone) return;
    untrack(() => {
      const message = draft?.goneMessage();
      if (message) toast.show({ message });
      end();
    });
  });

  // A press outside closes the composer. A press in a menu, a dialog, or a popover of the
  // composer (the color picker) is not outside. The close waits for the click: the grid moves when
  // the composer gets smaller, and the click must still reach the card that was under the pointer.
  $effect(() => {
    if (!draft) return;
    let fromInside = false;
    const inside = (target: EventTarget | null): boolean =>
      target instanceof Node && (root?.contains(target) === true || (target instanceof Element && target.closest('.ui-overlays, .ui-tooltip') !== null));
    const onPointerDown = (event: PointerEvent): void => {
      fromInside = inside(event.target);
    };
    const onClick = (event: MouseEvent): void => {
      // A selection of text that starts in a field and ends outside is not a press outside.
      if (!fromInside && !inside(event.target)) end();
      fromInside = false;
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('click', onClick, true);
    };
  });

  onDestroy(() => draft?.finish());

  function onkeydown(event: KeyboardEvent): void {
    if (event.isComposing || event.defaultPrevented) return;
    if (event.key === 'Escape' || (event.key === 'Enter' && (event.ctrlKey || event.metaKey))) {
      event.preventDefault();
      // The board must not use the same Esc for its own close.
      event.stopPropagation();
      end({ refocus: true });
    }
  }

  function onTitleKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.isComposing || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    bodyField?.focus();
    bodyField?.setSelectionRange(0, 0);
  }
</script>

{#if draft}
  <!-- A close removes this block while a field has the focus, so the browser then sends a blur.
       The blur handlers read `draft`, which is null by then, and not `note` of the old block. -->
  {@const note = draft}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class={['composer', { plain: note.color === 'default' }]} style:background={noteBackground(note.color)} bind:this={root} {onkeydown}>
    <div class="top" in:fade={{ duration: 120 }}>
      <TextArea
        class="title-field"
        variant="plain"
        placeholder="Title"
        aria-label="Title"
        autocomplete="off"
        maxlength={LIMITS.noteTitle}
        maxRows={6}
        bind:value={() => note.title, (value) => note.type('title', value)}
        onfocus={() => note.focus('title')}
        onblur={() => draft?.blur('title')}
        onkeydown={onTitleKey}
      />
      <IconButton icon={note.pinned ? 'pin-filled' : 'pin'} label={note.pinned ? 'Unpin note' : 'Pin note'} onclick={() => note.togglePin()} />
    </div>
    <TextArea
      class="body-field"
      variant="plain"
      placeholder="Take a note…"
      aria-label="Note"
      maxlength={LIMITS.noteBody}
      maxRows={20}
      bind:ref={bodyField}
      bind:value={() => note.body, (value) => note.type('body', value)}
      onfocus={() => note.focus('body')}
      onblur={() => draft?.blur('body')}
    />
    <footer class="tools" in:fade={{ duration: 120 }}>
      <IconButton icon="palette" label="Change color" bind:ref={paletteButton} onclick={() => (colorOpen = true)} />
      {#if other}
        <IconButton icon="people" label="Share with {other.name}" active={note.shared} disabled={!note.owned} onclick={() => note.toggleShare()} />
      {:else}
        <IconButton icon="people" label="Share note" tooltip="No other person has an account yet" disabled />
      {/if}
      <span class="grow"></span>
      <Button onclick={() => end({ refocus: true })}>Close</Button>
    </footer>
  </div>
  <ColorPopup bind:open={colorOpen} value={note.color} anchor={paletteButton} onpick={(color) => note.setColor(color)} />
{:else}
  <button class="collapsed ui-state" type="button" bind:this={collapsed} onclick={focus}>Take a note…</button>
{/if}

<style>
  .collapsed,
  .composer {
    width: 100%;
    max-width: 600px;
    margin: 0 auto;
    border-radius: var(--radius-md);
    background: var(--surface);
    box-shadow: var(--shadow-2);
    color: var(--text);
  }
  .collapsed {
    display: flex;
    align-items: center;
    height: 48px;
    padding: 0 18px;
    color: var(--text-dim);
    font-size: 16px;
    font-weight: 500;
    text-align: left;
  }
  .composer {
    position: relative;
    display: flex;
    flex-direction: column;
  }
  .plain {
    box-shadow: var(--shadow-2), inset 0 0 0 1px var(--note-edge);
  }
  .top {
    display: flex;
    align-items: flex-start;
    gap: 4px;
    padding: 6px 6px 0 18px;
  }
  .top :global(.title-field) {
    flex: 1;
    padding-top: 8px;
  }
  .composer :global(textarea) {
    caret-color: var(--text);
  }
  .composer :global(textarea::placeholder) {
    color: var(--note-text-dim);
  }
  .top :global(.title-field textarea) {
    font-size: 16px;
    font-weight: 500;
    line-height: 24px;
  }
  .composer :global(.body-field) {
    padding: 6px 18px 4px;
  }
  .composer :global(.body-field textarea) {
    min-height: 24px;
    font-size: 16px;
    line-height: 24px;
  }
  .composer :global(.icon-btn) {
    color: var(--note-text-dim);
  }
  .composer :global(.icon-btn.active) {
    color: var(--primary);
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px 8px;
  }
  .grow {
    flex: 1;
  }
</style>
