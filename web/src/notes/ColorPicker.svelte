<script lang="ts">
  import { NOTE_COLORS, type NoteColor } from '../../../shared/types.ts';
  import { Icon } from '../ui/index.ts';
  import { COLOR_NAMES, noteBackground } from './names.ts';

  // The 12 colors of a note as round buttons (SPEC section 8, "Color picker"). It is one radio
  // group: Tab goes to the current color, and the arrow keys choose the next one. A choice
  // changes the note at once, so there is no "Done".
  interface Props {
    value: NoteColor;
    onpick: (color: NoteColor) => void;
    /** The number of buttons in a row: 6 gives two rows, 12 gives one. */
    columns?: 6 | 12;
  }
  let { value, onpick, columns = 6 }: Props = $props();

  function onkeydown(event: KeyboardEvent): void {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    const index = NOTE_COLORS.indexOf(value);
    let next: number;
    if (step !== undefined) next = (index + step + NOTE_COLORS.length) % NOTE_COLORS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = NOTE_COLORS.length - 1;
    else return;
    event.preventDefault();
    const color = NOTE_COLORS[next]!;
    onpick(color);
    (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-color="${color}"]`)?.focus();
  }
</script>

<div class="picker" role="radiogroup" aria-label="Note color" tabindex="-1" style:--columns={columns} {onkeydown}>
  {#each NOTE_COLORS as color (color)}
    {@const checked = color === value}
    <button
      class="swatch"
      type="button"
      role="radio"
      aria-checked={checked}
      aria-label={COLOR_NAMES[color]}
      tabindex={checked ? 0 : -1}
      data-color={color}
      data-tip={COLOR_NAMES[color]}
      data-autofocus={checked ? '' : undefined}
      onclick={() => onpick(color)}
    >
      <span class={['dot', { checked, plain: color === 'default' }]} style:background={noteBackground(color)}>
        {#if checked}
          <Icon name="check" size={20} />
        {:else if color === 'default'}
          <Icon name="color-off" size={20} />
        {/if}
      </span>
    </button>
  {/each}
</div>

<style>
  .picker {
    display: grid;
    grid-template-columns: repeat(var(--columns), minmax(44px, 1fr));
    justify-items: center;
    gap: 4px 0;
    outline: none;
  }
  .swatch {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
  }
  .dot {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    /* The edge lets a light color show on a light sheet. */
    box-shadow: inset 0 0 0 1px var(--note-edge);
    color: var(--text);
    transition: transform var(--dur-fast) var(--ease);
  }
  .plain {
    color: var(--note-text-dim);
  }
  @media (hover: hover) {
    .swatch:hover .dot {
      box-shadow: inset 0 0 0 2px var(--text-dim);
    }
  }
  .swatch:active .dot {
    transform: scale(0.92);
  }
  .dot.checked,
  .swatch:hover .dot.checked {
    box-shadow: inset 0 0 0 2px var(--primary);
    color: var(--text);
  }
  .swatch:focus-visible {
    outline: none;
  }
  .swatch:focus-visible .dot {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }
</style>
