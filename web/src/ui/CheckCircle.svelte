<script lang="ts">
  interface Props {
    checked: boolean;
    /**
     * 'circle': the circle of an open task. It fills and a check mark draws when `checked` becomes true.
     * 'check': a check mark with no circle, for a row in "Completed".
     */
    variant?: 'circle' | 'check';
    /** The accessible name and the tooltip. Default: "Mark completed" or "Mark uncompleted". */
    label?: string;
    /** Width and height of the area that takes the press, in px. The circle is 20 px. */
    size?: number;
    disabled?: boolean;
    onchange?: (checked: boolean, event: MouseEvent) => void;
  }
  let { checked, variant = 'circle', label, size = 40, disabled = false, onchange }: Props = $props();

  const text = $derived(label ?? (checked ? 'Mark uncompleted' : 'Mark completed'));
</script>

<!-- A list has one of these for each row, so the part has few elements: the ring is a border and
     the fill is a pseudo-element. -->
<button
  class={['cc ui-state', { checked, plain: variant === 'check' }]}
  type="button"
  role="checkbox"
  aria-checked={checked}
  aria-label={text}
  data-tip={text}
  style:width="{size}px"
  style:height="{size}px"
  {disabled}
  onclick={(event) => onchange?.(!checked, event)}
>
  <span class="ring">
    <!-- The window moves to the right and its content moves to the left by the same distance, so
         the check mark stays in its place and shows from left to right, as a pen draws it. -->
    <span class="window"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 12.5l3.4 3.4L17 8.75" /></svg></span>
  </span>
</button>

<style>
  .cc {
    display: inline-grid;
    flex: none;
    place-items: center;
    border-radius: 50%;
    color: var(--text-dim);
  }
  .ring {
    position: relative;
    box-sizing: border-box;
    width: 20px;
    height: 20px;
    border: 2px solid currentColor;
    border-radius: 50%;
  }
  .ring::before,
  .window {
    position: absolute;
    inset: -2px;
  }
  .ring::before {
    content: '';
    border-radius: 50%;
    background: var(--primary);
    opacity: 0;
    transform: scale(0.3);
    transition:
      transform var(--dur) var(--ease),
      opacity var(--dur-fast) linear;
  }
  .window {
    overflow: hidden;
    color: var(--on-primary);
    transform: translateX(-100%);
  }
  svg {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.6;
    stroke-linecap: round;
    stroke-linejoin: round;
    transform: translateX(100%);
  }
  .window,
  svg {
    transition: transform 140ms linear 40ms;
  }

  .checked .ring {
    border-color: var(--primary);
  }
  .checked .ring::before {
    opacity: 1;
    transform: none;
  }
  .checked .window,
  .checked svg {
    transform: none;
  }

  .plain.checked .ring {
    border-color: transparent;
  }
  .plain .ring::before {
    display: none;
  }
  .plain .window {
    color: var(--primary);
  }

  /* A mouse over the circle of an open task shows what a press does. */
  @media (hover: hover) {
    .cc:hover:not(.checked):not(:disabled),
    .cc:hover:not(.checked):not(:disabled) .window {
      color: var(--primary);
    }
    .cc:hover:not(.checked):not(:disabled) .window,
    .cc:hover:not(.checked):not(:disabled) svg {
      transform: none;
      transition-delay: 0s;
    }
  }
  .cc:disabled {
    opacity: 0.45;
  }
</style>
