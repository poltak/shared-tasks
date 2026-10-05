<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import type { IconName } from './icons.ts';

  interface Props {
    label?: string;
    icon?: IconName;
    /** A second icon after the text. */
    trailingIcon?: IconName;
    tone?: 'normal' | 'danger' | 'primary';
    /** sm: 26 px, for a task row. md: 32 px. */
    size?: 'sm' | 'md';
    /** With a handler the chip is a button. */
    onclick?: (event: MouseEvent) => void;
    /** With a handler the chip has an X button. */
    onremove?: () => void;
    removeLabel?: string;
    disabled?: boolean;
    class?: string;
    /** In place of `label`. */
    children?: Snippet;
  }
  let {
    label,
    icon,
    trailingIcon,
    tone = 'normal',
    size = 'md',
    onclick,
    onremove,
    removeLabel = 'Remove',
    disabled = false,
    class: cls,
    children,
  }: Props = $props();

  const iconSize = $derived(size === 'sm' ? 14 : 18);
</script>

{#snippet content()}
  {#if icon}<Icon name={icon} size={iconSize} />{/if}
  <span class="label">{#if children}{@render children()}{:else}{label}{/if}</span>
  {#if trailingIcon}<Icon name={trailingIcon} size={iconSize} />{/if}
{/snippet}

<span class={['chip', tone, size, { removable: onremove, disabled }, cls]}>
  {#if onclick}
    <button class="main ui-state" type="button" {onclick} {disabled}>{@render content()}</button>
  {:else}
    <span class="main">{@render content()}</span>
  {/if}
  {#if onremove}
    <button class="remove ui-state" type="button" aria-label={removeLabel} onclick={onremove} {disabled}>
      <Icon name="close" size={size === 'sm' ? 14 : 16} />
    </button>
  {/if}
</span>

<style>
  .chip {
    display: inline-flex;
    flex: none;
    align-items: stretch;
    max-width: 100%;
    height: 32px;
    border: 1px solid var(--outline);
    border-radius: var(--radius-pill);
    color: var(--text);
    font-size: 13px;
    font-weight: 500;
    line-height: 18px;
    vertical-align: middle;
  }
  .sm {
    height: 26px;
    font-size: 12px;
    line-height: 16px;
  }
  .main {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 0 12px;
    border-radius: var(--radius-pill);
    color: inherit;
    font: inherit;
  }
  .sm .main {
    gap: 4px;
    padding: 0 9px;
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .normal .main :global(svg) {
    color: var(--text-dim);
  }
  .removable .main {
    padding-right: 4px;
    border-radius: var(--radius-pill) 0 0 var(--radius-pill);
  }
  .remove {
    display: grid;
    flex: none;
    place-items: center;
    width: 28px;
    margin: 1px 1px 1px 0;
    border-radius: 50%;
    color: var(--text-dim);
  }
  .sm .remove {
    width: 22px;
  }
  .danger {
    color: var(--danger);
  }
  .danger .remove {
    color: var(--danger);
  }
  .primary {
    border-color: transparent;
    background: var(--primary-container);
    color: var(--on-primary-container);
  }
  .primary .remove {
    color: inherit;
  }
  .disabled {
    color: var(--text-off);
  }
</style>
