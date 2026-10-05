<script lang="ts" generics="T extends string | number">
  import Icon from './Icon.svelte';
  import Menu from './Menu.svelte';
  import type { SelectOption } from './types.ts';

  // A button that shows the chosen option and opens a menu with all options.
  interface Props {
    value: T;
    options: readonly SelectOption<T>[];
    /** The accessible name, and the heading of the bottom sheet on a phone. */
    label: string;
    disabled?: boolean;
    onchange?: (value: T) => void;
  }
  let { value = $bindable(), options, label, disabled = false, onchange }: Props = $props();

  let open = $state(false);
  let button = $state<HTMLElement>();

  const current = $derived(options.find((option) => option.value === value));
  const items = $derived(
    options.map((option, i) => ({ id: String(i), label: option.label, icon: option.icon, checked: option.value === value })),
  );

  function onselect(id: string): void {
    const next = options[+id]!.value;
    if (next === value) return;
    value = next;
    onchange?.(next);
  }
</script>

<button
  class="select ui-state"
  type="button"
  aria-haspopup="menu"
  aria-expanded={open}
  aria-label="{label}: {current?.label ?? ''}"
  {disabled}
  bind:this={button}
  onclick={() => (open = true)}
>
  {#if current?.icon}<Icon name={current.icon} size={18} />{/if}
  <span class="value">{current?.label ?? ''}</span>
  <Icon name="caret" size={20} />
</button>

<Menu bind:open anchor={button} {items} {onselect} title={label} {label} />

<style>
  .select {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    height: 40px;
    padding: 0 8px 0 14px;
    border-radius: var(--radius-md);
    background: var(--field);
    color: var(--text);
    font-size: 14px;
  }
  .value {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .select :global(svg) {
    color: var(--text-dim);
  }
  .select:disabled {
    color: var(--text-off);
  }
</style>
