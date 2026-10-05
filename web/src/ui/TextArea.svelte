<script lang="ts" module>
  /** The browser can make a text area as high as its text. If not, the component sets the height. */
  const AUTO_SIZE = typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content');
</script>

<script lang="ts">
  import type { HTMLTextareaAttributes } from 'svelte/elements';

  interface Props extends Omit<HTMLTextareaAttributes, 'value'> {
    value?: string;
    /** A text above the field. Without it, give `aria-label`. */
    label?: string;
    /** 'plain': no box, for a field that is part of a row or a screen. */
    variant?: 'box' | 'plain';
    /** The field grows with its text up to this number of lines, then it scrolls. */
    maxRows?: number;
    /** The textarea element, for `bind:ref`. */
    ref?: HTMLTextAreaElement | null;
  }
  let { value = $bindable(''), label, variant = 'box', maxRows = 12, ref = $bindable(null), class: cls, rows = 1, ...rest }: Props = $props();

  $effect(() => {
    if (AUTO_SIZE || !ref) return;
    void value;
    ref.style.height = 'auto';
    ref.style.height = `${ref.scrollHeight}px`;
  });
</script>

<label class={['field', variant, cls]}>
  {#if label}<span class="label">{label}</span>{/if}
  <textarea bind:this={ref} bind:value {rows} style:--max-rows={maxRows} {...rest}></textarea>
</label>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .label {
    padding: 0 2px;
    color: var(--text-dim);
    font-size: 12px;
    font-weight: 500;
    line-height: 16px;
  }
  textarea {
    display: block;
    width: 100%;
    max-height: calc(var(--max-rows) * 22px + 26px);
    field-sizing: content;
    line-height: 22px;
    color: var(--text);
    caret-color: var(--primary);
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .box textarea {
    min-height: 48px;
    padding: 13px 14px;
    border-radius: var(--radius-md);
    background: var(--field);
  }
  .box textarea:focus {
    box-shadow: inset 0 0 0 2px var(--primary);
  }
  .plain textarea {
    max-height: calc(var(--max-rows) * 22px);
  }
</style>
