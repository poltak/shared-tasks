<script lang="ts">
  import type { NoteColor } from '../../../shared/types.ts';
  import { BottomSheet, Dialog, layout, pop, portal, pushOverlay, release, type MenuAnchor } from '../ui/index.ts';
  import ColorPicker from './ColorPicker.svelte';

  // The color picker in an overlay: a bottom sheet "Color" on a phone, a popover at the color
  // button on a wide screen, or a small dialog when there is no button to show it at. It stays
  // open after a choice, so the person can try colors on the note.
  interface Props {
    open?: boolean;
    value: NoteColor;
    onpick: (color: NoteColor) => void;
    /** Where the popover shows on a wide screen. */
    anchor?: MenuAnchor | null;
    /** Called one time for each close: Esc, Back, a press outside. */
    onclose?: () => void;
  }
  let { open = $bindable(false), value, onpick, anchor = null, onclose }: Props = $props();

  const GAP = 4;
  const EDGE = 8;

  const popover = $derived(layout.wide && anchor !== null);
  let panel = $state<HTMLElement>();

  function close(): void {
    if (!open) return;
    open = false;
    onclose?.();
  }

  /** Below the anchor, or above it if there is more room there, and inside the window. As the menus do. */
  function place(element: HTMLElement): void {
    const area = element.parentElement!.getBoundingClientRect();
    const box =
      anchor instanceof Element
        ? anchor.getBoundingClientRect()
        : { left: anchor?.x ?? 0, right: anchor?.x ?? 0, top: anchor?.y ?? 0, bottom: anchor?.y ?? 0 };
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const roomBelow = area.bottom - box.bottom - EDGE - GAP;
    const roomAbove = box.top - area.top - EDGE - GAP;
    const below = height <= roomBelow || roomBelow >= roomAbove;
    const y = below ? box.bottom + GAP : box.top - GAP - height;
    const left = Math.max(area.left + EDGE, Math.min(box.left, area.right - width - EDGE));
    const top = Math.max(area.top + EDGE, Math.min(y, area.bottom - height - EDGE));
    element.style.left = `${Math.round(left - area.left)}px`;
    element.style.top = `${Math.round(top - area.top)}px`;
    element.style.transformOrigin = `left ${below ? 'top' : 'bottom'}`;
  }

  $effect(() => {
    if (!open || !popover || !panel) return;
    const element = panel;
    place(element);
    const overlay = pushOverlay({ close, element: () => element });
    // The position is from the time of the open. After a change of the window it is not correct.
    window.addEventListener('resize', close);
    return () => {
      overlay.remove();
      window.removeEventListener('resize', close);
    };
  });
</script>

{#if layout.phone}
  <BottomSheet bind:open {onclose} title="Color">
    <div class="in-sheet"><ColorPicker {value} {onpick} /></div>
  </BottomSheet>
{:else if !popover}
  <Dialog bind:open {onclose} title="Color" width={344}>
    <div class="in-dialog"><ColorPicker {value} {onpick} /></div>
  </Dialog>
{:else if open}
  <div class="ui-layer" use:portal>
    <div
      class="backdrop"
      role="presentation"
      out:release
      onpointerdown={close}
      oncontextmenu={(event) => {
        event.preventDefault();
        close();
      }}
    ></div>
    <div class="popover" role="dialog" aria-label="Color" tabindex="-1" bind:this={panel} transition:pop|global={{ duration: 130, scale: 0.92 }}>
      <ColorPicker {value} {onpick} columns={12} />
    </div>
  </div>
{/if}

<style>
  .in-sheet {
    padding: 0 0 12px;
  }
  .in-dialog {
    padding: 0 0 8px;
  }
  .backdrop {
    position: fixed;
    inset: 0;
  }
  .popover {
    position: absolute;
    left: 0;
    top: 0;
    /* All twelve colors in one row. */
    width: calc(12 * 44px + 16px);
    max-width: calc(100% - 16px);
    padding: 6px 8px;
    border-radius: var(--radius-md);
    background: var(--popup);
    box-shadow: var(--shadow-2);
    outline: none;
  }
</style>
