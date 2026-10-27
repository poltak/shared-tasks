<script lang="ts">
  import { store, toast } from '../data/index.ts';
  import { ConfirmDialog, DatePicker, DeadlinePicker, TextPromptDialog } from '../ui/index.ts';
  import { dialogs, type DialogRequest } from './dialogs.svelte.ts';

  // The shell mounts this one time. It shows the dialogs that dialogs.svelte.ts opened.
  // A request leaves the list when it has its result, and the part then plays its exit.

  type NotesParts = typeof import('../notes/index.ts');

  // The color picker and the "Make tasks" dialog of a note are in the notes download. The same
  // import as the layouts' gives the same file, so it is one download, and it is there already
  // when a note menu can open.
  let notes = $state.raw<NotesParts | null>(null);
  let loading = false;
  type NoteRequest = Extract<DialogRequest, { kind: 'noteColor' | 'makeTasks' }>;
  const isNoteDialog = (request: DialogRequest): request is NoteRequest => request.kind === 'noteColor' || request.kind === 'makeTasks';

  $effect(() => {
    if (notes || loading || !dialogs.open.some(isNoteDialog)) return;
    loading = true;
    import('../notes/index.ts').then(
      (parts) => (notes = parts),
      () => {
        loading = false;
        for (const request of dialogs.open) if (isNoteDialog(request)) request.settle(null);
        toast.show({ message: 'The notes could not load. Check the connection', action: { label: 'Reload', run: () => location.reload() } });
      },
    );
  });
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
  {:else if request.kind === 'noteColor'}
    {#if notes}
      <notes.NoteColorDialog id={request.input.id} anchor={request.input.anchor} onclose={() => request.settle(null)} />
    {/if}
  {:else if request.kind === 'makeTasks'}
    {#if notes}
      <notes.MakeTasksDialog id={request.input.id} ondone={(result) => request.settle(result)} oncancel={() => request.settle(null)} />
    {/if}
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
