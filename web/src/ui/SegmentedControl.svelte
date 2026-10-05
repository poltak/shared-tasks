<script lang="ts" generics="T extends string">
  import Icon from './Icon.svelte';
  import type { SelectOption } from './types.ts';

  interface Props {
    value: T;
    options: readonly SelectOption<T>[];
    /** The accessible name of the group. */
    label: string;
    onchange?: (value: T) => void;
  }
  let { value = $bindable(), options, label, onchange }: Props = $props();

  const index = $derived(Math.max(0, options.findIndex((option) => option.value === value)));

  function pick(next: T): void {
    if (next === value) return;
    value = next;
    onchange?.(next);
  }

  function onkeydown(event: KeyboardEvent): void {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    pick(options[next]!.value);
    const buttons = (event.currentTarget as HTMLElement).querySelectorAll('button');
    buttons[next]?.focus();
  }
</script>

<div class="segments" role="radiogroup" tabindex="-1" aria-label={label} style:--count={options.length} style:--index={index} {onkeydown}>
  <span class="thumb"></span>
  {#each options as option (option.value)}
    <button type="button" role="radio" aria-checked={option.value === value} tabindex={option.value === value ? 0 : -1} onclick={() => pick(option.value)}>
      {#if option.icon}<Icon name={option.icon} size={18} />{/if}
      {option.label}
    </button>
  {/each}
</div>

<style>
  .segments {
    position: relative;
    display: inline-grid;
    grid-template-columns: repeat(var(--count), minmax(0, 1fr));
    padding: 3px;
    border-radius: var(--radius-pill);
    background: var(--field);
  }
  /* One pill that moves below the chosen segment. All segments have the same width. */
  .thumb {
    position: absolute;
    left: 3px;
    top: 3px;
    bottom: 3px;
    width: calc((100% - 6px) / var(--count));
    border-radius: var(--radius-pill);
    background: var(--field-on);
    box-shadow: var(--shadow-1);
    transform: translateX(calc(var(--index) * 100%));
    transition: transform var(--dur) var(--ease);
  }
  button {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 34px;
    padding: 0 16px;
    border-radius: var(--radius-pill);
    color: var(--text-dim);
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
  }
  button[aria-checked='true'] {
    color: var(--text);
  }
</style>
