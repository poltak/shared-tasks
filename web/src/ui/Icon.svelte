<script lang="ts">
  import { FILLED_ICONS, ICONS, type IconName } from './icons.ts';

  interface Props {
    name: IconName;
    /** Width and height in px. */
    size?: number;
    class?: string;
  }
  let { name, size = 24, class: cls }: Props = $props();

  const filled = $derived(FILLED_ICONS.has(name));
</script>

<svg
  class={cls}
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill={filled ? 'currentColor' : 'none'}
  stroke="currentColor"
  stroke-width={size < 20 ? 2 : 1.75}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d={ICONS[name]} />
</svg>
