<script lang="ts" generics="T extends string | number">
  import type { Snippet } from 'svelte';

  interface Props {
    /** The value of the group. All radios of one group bind the same variable. */
    group: T;
    /** The value that this radio stands for. */
    value: T;
    /** The text next to the circle. Without it, give `ariaLabel`. */
    label?: string;
    ariaLabel?: string;
    /** Radios with the same name are one group for the arrow keys. */
    name?: string;
    disabled?: boolean;
    onchange?: (value: T) => void;
    /** In place of `label`. */
    children?: Snippet;
  }
  let { group = $bindable(), value, label, ariaLabel, name, disabled = false, onchange, children }: Props = $props();
</script>

<label class={['radio', { disabled }]}>
  <span class="control">
    <input type="radio" {name} {value} aria-label={ariaLabel} bind:group {disabled} onchange={() => onchange?.(value)} />
    <span class="circle"></span>
  </span>
  {#if children}{@render children()}{:else if label}<span>{label}</span>{/if}
</label>

<style>
  .radio {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    min-height: 36px;
    cursor: pointer;
  }
  .control {
    position: relative;
    display: grid;
    flex: none;
    place-items: center;
    width: 20px;
    height: 20px;
  }
  input {
    position: absolute;
    inset: -8px;
    width: 36px;
    height: 36px;
    margin: 0;
    opacity: 0;
    cursor: inherit;
  }
  .circle {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border: 2px solid var(--text-dim);
    border-radius: 50%;
    pointer-events: none;
  }
  .circle::before {
    content: '';
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--primary);
    transform: scale(0);
    transition: transform var(--dur-fast) var(--ease);
  }
  input:checked + .circle {
    border-color: var(--primary);
  }
  input:checked + .circle::before {
    transform: scale(1);
  }
  input:focus-visible + .circle {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }
  .disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
