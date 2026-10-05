<script lang="ts">
  import { fade, pop } from './motion.ts';

  // Only the looks. The owner decides when the message shows and for how long.
  interface Props {
    message: string;
    /** The text of the button, for example "Undo". No text: no button. */
    actionLabel?: string;
    onaction?: () => void;
    /**
     * false: the snackbar is in the flow of the page. true: it is fixed at the bottom left of a
     * wide window, and above the add button on a phone (set --snackbar-bottom to move it).
     */
    fixed?: boolean;
  }
  let { message, actionLabel, onaction, fixed = true }: Props = $props();
</script>

<div class={['snackbar', { fixed }]} role="status" aria-live="polite" in:pop|global={{ y: 12, scale: 0.98 }} out:fade|global={{ duration: 120 }}>
  <span class="message">{message}</span>
  {#if actionLabel}
    <button class="action ui-state" type="button" onclick={onaction}>{actionLabel}</button>
  {/if}
</div>

<style>
  .snackbar {
    display: flex;
    align-items: center;
    gap: 8px;
    box-sizing: border-box;
    width: fit-content;
    min-width: min(288px, 100%);
    max-width: min(560px, 100%);
    min-height: 48px;
    padding: 6px 8px 6px 16px;
    border-radius: var(--radius-md);
    background: var(--inverse-surface);
    box-shadow: var(--shadow-2);
    color: var(--inverse-text);
    font-size: 14px;
    line-height: 20px;
  }
  .message {
    flex: 1;
    min-width: 0;
    padding: 8px 8px 8px 0;
    overflow-wrap: anywhere;
  }
  .action {
    flex: none;
    height: 36px;
    padding: 0 12px;
    border-radius: var(--radius-pill);
    color: var(--inverse-primary);
    font-weight: 600;
  }
  .fixed {
    position: fixed;
    left: 24px;
    bottom: calc(24px + env(safe-area-inset-bottom));
    z-index: var(--z-snackbar);
    max-width: min(560px, calc(100vw - 48px));
  }
  /* The phone layout of SPEC section 8 */
  @media (max-width: 839.98px) {
    .fixed {
      left: 12px;
      right: 12px;
      bottom: calc(var(--snackbar-bottom, 88px) + env(safe-area-inset-bottom));
      width: auto;
      max-width: none;
    }
  }
</style>
