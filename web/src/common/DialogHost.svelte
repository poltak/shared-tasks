<script lang="ts">
  import { store } from '../data/index.ts';
  import { ConfirmDialog, DatePicker, DeadlinePicker, TextPromptDialog } from '../ui/index.ts';
  import { dialogs } from './dialogs.svelte.ts';

  // The shell mounts this one time. It shows the dialogs that dialogs.svelte.ts opened.
  // A request leaves the list when it has its result, and the part then plays its exit.
</script>

{#each dialogs.open as request (request.id)}
  {#if request.kind === 'date'}
    <DatePicker
      open
      value={request.input.value}
      today={store.today}
      allowTime={request.input.allowTime ?? true}
      allowRepeat={request.input.allowRepeat ?? true}
      title={request.input.title}
      ondone={(value) => request.settle(value)}
      oncancel={() => request.settle(null)}
    />
  {:else if request.kind === 'deadline'}
    <DeadlinePicker
      open
      value={request.input.value}
      today={store.today}
      title={request.input.title}
      ondone={(deadline) => request.settle({ deadline })}
      oncancel={() => request.settle(null)}
    />
  {:else if request.kind === 'prompt'}
    <TextPromptDialog
      open
      title={request.input.title}
      value={request.input.value ?? ''}
      placeholder={request.input.placeholder ?? 'Enter name'}
      doneLabel={request.input.confirmLabel ?? 'Done'}
      maxlength={request.input.maxlength}
      ondone={(text) => request.settle(text)}
      oncancel={() => request.settle(null)}
    />
  {:else}
    <ConfirmDialog
      open
      title={request.input.title}
      text={request.input.message}
      confirmLabel={request.input.confirmLabel ?? 'OK'}
      cancelLabel={request.input.cancelLabel ?? 'Cancel'}
      danger={request.input.danger ?? false}
      onconfirm={() => request.settle(true)}
      oncancel={() => request.settle(false)}
    />
  {/if}
{/each}
