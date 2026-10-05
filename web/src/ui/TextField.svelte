<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import Icon from './Icon.svelte';
  import type { IconName } from './icons.ts';

  interface Props extends Omit<HTMLInputAttributes, 'value' | 'size' | 'autofocus'> {
    value?: string;
    /** A text above the field. Without it, give `aria-label`. */
    label?: string;
    /** A text below the field in the danger color. The field then shows as not valid. */
    error?: string | null;
    /** A text below the field. `error` replaces it. */
    hint?: string;
    icon?: IconName;
    /** The field gets the focus when it shows. 'select' also selects its text. */
    autofocus?: boolean | 'select';
    onenter?: () => void;
    /** The input element, for `bind:ref`. */
    ref?: HTMLInputElement | null;
  }
  let {
    value = $bindable(''),
    label,
    error = null,
    hint,
    icon,
    autofocus = false,
    onenter,
    ref = $bindable(null),
    class: cls,
    type = 'text',
    onkeydown,
    ...rest
  }: Props = $props();

  // In an overlay, the stack gives the focus: it must first record the element that had it.
  $effect(() => {
    if (!autofocus || !ref || ref.closest('.ui-layer')) return;
    ref.focus();
    if (autofocus === 'select') ref.select();
  });
</script>

<label class={['field', { invalid: error }, cls]}>
  {#if label}<span class="label">{label}</span>{/if}
  <span class="box">
    {#if icon}<Icon name={icon} size={20} />{/if}
    <input
      bind:this={ref}
      bind:value
      {type}
      aria-invalid={error ? true : undefined}
      data-autofocus={autofocus === 'select' ? 'select' : autofocus ? '' : undefined}
      onkeydown={(event) => {
        onkeydown?.(event);
        if (event.key !== 'Enter' || event.isComposing || event.defaultPrevented || !onenter) return;
        // The handler can close a dialog, and the focus then goes to a button. Without this, the
        // browser would give the same key press to that button.
        event.preventDefault();
        onenter();
      }}
      {...rest}
    />
  </span>
  {#if error}
    <span class="message" role="alert">{error}</span>
  {:else if hint}
    <span class="message">{hint}</span>
  {/if}
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
  .box {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 48px;
    padding: 0 14px;
    border-radius: var(--radius-md);
    background: var(--field);
    /* The ring is a shadow, so the size of the box is the same with and without the focus. */
    box-shadow: inset 0 0 0 1px transparent;
    color: var(--text-dim);
  }
  .box:focus-within {
    box-shadow: inset 0 0 0 2px var(--primary);
  }
  .invalid .box {
    box-shadow: inset 0 0 0 2px var(--danger);
  }
  input {
    flex: 1;
    min-width: 0;
    height: 100%;
    color: var(--text);
    caret-color: var(--primary);
  }
  .message {
    padding: 0 2px;
    color: var(--text-dim);
    font-size: 12px;
    line-height: 16px;
  }
  .invalid .message {
    color: var(--danger);
  }
</style>
