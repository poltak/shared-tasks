<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    checked?: boolean;
    /** The text next to the box. Without it, give `ariaLabel`. */
    label?: string;
    ariaLabel?: string;
    disabled?: boolean;
    onchange?: (checked: boolean) => void;
    /** In place of `label`. */
    children?: Snippet;
  }
  let { checked = $bindable(false), label, ariaLabel, disabled = false, onchange, children }: Props = $props();
</script>

<label class={['checkbox', { disabled }]}>
  <span class="control">
    <input type="checkbox" aria-label={ariaLabel} bind:checked {disabled} onchange={() => onchange?.(checked)} />
    <span class="box">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M6 12.5l4 4 8-8.5" />
      </svg>
    </span>
  </span>
  {#if children}{@render children()}{:else if label}<span>{label}</span>{/if}
</label>

<style>
  .checkbox {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    min-height: 32px;
    cursor: pointer;
  }
  .control {
    position: relative;
    display: grid;
    flex: none;
    place-items: center;
    width: 18px;
    height: 18px;
  }
  input {
    position: absolute;
    /* The area that takes the press is larger than the box. */
    inset: -9px;
    width: 36px;
    height: 36px;
    margin: 0;
    opacity: 0;
    cursor: inherit;
  }
  .box {
    position: relative;
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border: 2px solid var(--text-dim);
    border-radius: 4px;
    color: var(--on-primary);
    pointer-events: none;
  }
  .box::before {
    content: '';
    position: absolute;
    inset: -2px;
    border-radius: inherit;
    background: var(--primary);
    opacity: 0;
    transition: opacity var(--dur-fast) linear;
  }
  svg {
    /* The mark is as large as the box with its border. In the flow it would start inside the
       border and sit 2px low and to the right, so it is placed over the border like the fill. */
    position: absolute;
    inset: -2px;
    transform: scale(0);
    transition: transform var(--dur-fast) var(--ease);
  }
  input:checked + .box::before {
    opacity: 1;
  }
  input:checked + .box svg {
    transform: scale(1);
  }
  input:focus-visible + .box {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }
  .disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
