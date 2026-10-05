<script lang="ts">
  import Icon from './Icon.svelte';

  interface Props {
    starred: boolean;
    /** The accessible name and the tooltip. Default: "Add to Starred" or "Remove from Starred". */
    label?: string;
    /** Width and height of the area that takes the press, in px. */
    size?: number;
    disabled?: boolean;
    onchange?: (starred: boolean, event: MouseEvent) => void;
  }
  let { starred, label, size = 40, disabled = false, onchange }: Props = $props();

  const text = $derived(label ?? (starred ? 'Remove from Starred' : 'Add to Starred'));
  /** The small jump shows only after a press, not for a star that is set when the row shows. */
  let pop = $state(false);
</script>

<button
  class={['star ui-state', { on: starred, pop }]}
  type="button"
  aria-pressed={starred}
  aria-label={text}
  data-tip={text}
  style:width="{size}px"
  style:height="{size}px"
  {disabled}
  onclick={(event) => {
    pop = !starred;
    onchange?.(!starred, event);
  }}
  onanimationend={() => (pop = false)}
>
  <Icon name={starred ? 'star-filled' : 'star'} size={20} />
</button>

<style>
  .star {
    display: inline-grid;
    flex: none;
    place-items: center;
    border-radius: 50%;
    color: var(--text-dim);
  }
  .on {
    color: var(--star);
  }
  .pop :global(svg) {
    animation: star-pop var(--dur-slow) var(--ease);
  }
  @keyframes star-pop {
    0% {
      transform: scale(0.6);
    }
    55% {
      transform: scale(1.3);
    }
    100% {
      transform: scale(1);
    }
  }
  .star:disabled {
    opacity: 0.45;
  }
</style>
