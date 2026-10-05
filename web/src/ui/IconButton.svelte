<script lang="ts">
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import Icon from './Icon.svelte';
  import type { IconName } from './icons.ts';

  interface Props extends HTMLButtonAttributes {
    icon: IconName;
    /** The accessible name. It is also the tooltip text. */
    label: string;
    /** md: 40 px. sm: 32 px. */
    size?: 'md' | 'sm';
    /** false: no tooltip. A string: that text in place of the label. */
    tooltip?: boolean | string;
    /** A toggle that is on. */
    active?: boolean;
    /** The button element, for `bind:ref`. */
    ref?: HTMLButtonElement | null;
  }
  let { icon, label, size = 'md', tooltip = true, active, ref = $bindable(null), class: cls, type = 'button', ...rest }: Props = $props();
</script>

<button
  bind:this={ref}
  class={['icon-btn ui-state', size, { active }, cls]}
  {type}
  aria-label={label}
  aria-pressed={active}
  data-tip={tooltip === false ? undefined : tooltip === true ? label : tooltip}
  {...rest}
>
  <Icon name={icon} size={size === 'sm' ? 20 : 24} />
</button>

<style>
  .icon-btn {
    display: inline-grid;
    flex: none;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    color: var(--text-dim);
  }
  .sm {
    width: 32px;
    height: 32px;
  }
  .active {
    color: var(--primary);
  }
  .icon-btn:disabled {
    color: var(--text-off);
  }
</style>
