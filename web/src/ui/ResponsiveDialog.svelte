<script lang="ts">
  import type { Snippet } from 'svelte';
  import BottomSheet from './BottomSheet.svelte';
  import Dialog from './Dialog.svelte';
  import { layout } from './layout.svelte.ts';

  // A dialog on a wide window and a bottom sheet on a phone, with the same content. The pickers use it.
  interface Props {
    open?: boolean;
    onclose?: () => void;
    title?: string;
    /** The accessible name, if there is no title. */
    label?: string;
    /** The largest width of the dialog in px. */
    width?: number;
    children: Snippet;
    /** The buttons at the bottom, in a row at the right. */
    actions?: Snippet;
  }
  let { open = $bindable(false), onclose, title, label, width, children, actions }: Props = $props();
</script>

{#if layout.phone}
  <BottomSheet bind:open {onclose} {title} {label}>
    {@render children()}
    {#if actions}<footer class="actions">{@render actions()}</footer>{/if}
  </BottomSheet>
{:else}
  <Dialog bind:open {onclose} {title} {label} {width} {actions}>
    {@render children()}
  </Dialog>
{/if}

<style>
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 8px 0 4px;
  }
</style>
