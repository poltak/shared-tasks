<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import Icon from './Icon.svelte';
  import type { IconName } from './icons.ts';

  interface Props extends HTMLButtonAttributes {
    variant?: 'filled' | 'tonal' | 'text' | 'danger';
    size?: 'md' | 'sm';
    icon?: IconName;
    /** The button element, for `bind:ref`. */
    ref?: HTMLButtonElement | null;
    children: Snippet;
  }
  let { variant = 'text', size = 'md', icon, ref = $bindable(null), children, class: cls, type = 'button', ...rest }: Props = $props();
</script>

<button bind:this={ref} class={['btn ui-state', variant, size, { icon }, cls]} {type} {...rest}>
  {#if icon}<Icon name={icon} size={18} />{/if}
  {@render children()}
</button>

<style>
  .btn {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    gap: 8px;
    height: 40px;
    padding: 0 24px;
    border-radius: var(--radius-pill);
    color: var(--primary);
    font-size: 14px;
    font-weight: 500;
    line-height: 20px;
    white-space: nowrap;
  }
  .sm {
    height: 32px;
    padding: 0 16px;
    font-size: 13px;
  }
  .text {
    padding: 0 12px;
  }
  .filled {
    background: var(--primary);
    color: var(--on-primary);
  }
  .tonal {
    background: var(--primary-container);
    color: var(--on-primary-container);
  }
  .danger {
    background: var(--danger);
    color: var(--on-danger);
  }
  /* The icon is nearer to the edge than the text, so the two look centred. */
  .icon:not(.text) {
    padding-left: 16px;
  }
  .btn:disabled {
    color: color-mix(in srgb, var(--text) 38%, transparent);
  }
  .btn:disabled:not(.text) {
    background: color-mix(in srgb, var(--text) 10%, transparent);
  }
</style>
