<script lang="ts">
  import { untrack } from 'svelte';
  import Button from './Button.svelte';
  import Dialog from './Dialog.svelte';
  import TextField from './TextField.svelte';

  // Asks for one line of text: "Create new list" and "Rename list".
  interface Props {
    open?: boolean;
    title: string;
    /** The text in the field when the dialog opens. */
    value?: string;
    placeholder?: string;
    doneLabel?: string;
    maxlength?: number;
    /** Gets the text with no spaces at its ends. Never empty. */
    ondone?: (text: string) => void;
    /** Also for Esc, Back, and a press outside. */
    oncancel?: () => void;
  }
  let { open = $bindable(false), title, value = '', placeholder = 'Enter name', doneLabel = 'Done', maxlength, ondone, oncancel }: Props = $props();

  let text = $state('');

  // Each open starts from the value of the owner.
  $effect.pre(() => {
    if (open) text = untrack(() => value);
  });

  function cancel(): void {
    open = false;
    oncancel?.();
  }

  function done(): void {
    const result = text.trim();
    if (!result) return;
    open = false;
    ondone?.(result);
  }
</script>

<Dialog bind:open onclose={oncancel} {title} width={328}>
  <div class="field">
    <TextField bind:value={text} {placeholder} {maxlength} aria-label={title} autofocus="select" autocomplete="off" enterkeyhint="done" onenter={done} />
  </div>
  {#snippet actions()}
    <Button onclick={cancel}>Cancel</Button>
    <Button onclick={done} disabled={!text.trim()}>{doneLabel}</Button>
  {/snippet}
</Dialog>

<style>
  .field {
    padding: 4px 0 8px;
  }
</style>
