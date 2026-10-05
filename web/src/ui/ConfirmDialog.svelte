<script lang="ts">
  import type { Snippet } from 'svelte';
  import Button from './Button.svelte';
  import Dialog from './Dialog.svelte';

  interface Props {
    open?: boolean;
    title: string;
    text?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    /** The confirm button is in the danger color, for an action that deletes. */
    danger?: boolean;
    onconfirm?: () => void;
    /** Also for Esc, Back, and a press outside. */
    oncancel?: () => void;
    /** In place of `text`. */
    children?: Snippet;
  }
  let { open = $bindable(false), title, text, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false, onconfirm, oncancel, children }: Props = $props();
</script>

<Dialog bind:open onclose={oncancel} {title} width={328}>
  <div class="text">
    {#if children}{@render children()}{:else}{text}{/if}
  </div>
  {#snippet actions()}
    <!-- Enter presses the button with the focus. For an action that deletes, that is "Cancel". -->
    <Button
      data-autofocus={danger ? '' : undefined}
      onclick={() => {
        open = false;
        oncancel?.();
      }}
    >
      {cancelLabel}
    </Button>
    <Button
      variant={danger ? 'danger' : 'text'}
      data-autofocus={danger ? undefined : ''}
      onclick={() => {
        open = false;
        onconfirm?.();
      }}
    >
      {confirmLabel}
    </Button>
  {/snippet}
</Dialog>

<style>
  .text {
    padding-bottom: 8px;
    color: var(--text-dim);
    font-size: 14px;
    line-height: 20px;
  }
</style>
