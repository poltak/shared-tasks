<script lang="ts">
  import { toast, undo } from '../data/index.ts';
  import Snackbar from '../ui/Snackbar.svelte';

  // The data layer owns the message and its time on the screen. This part only shows it.
  // The Snackbar part has the two places: bottom left on a wide window, and 88 px plus the safe
  // area above the bottom edge of a phone, which is above the add button.
  const current = $derived(toast.current);

  function act(): void {
    const shown = current;
    if (!shown) return;
    if (shown.action) {
      toast.dismiss();
      shown.action.run();
    } else {
      // The undo dismisses the message itself.
      undo();
    }
  }
</script>

<!-- The mark keeps a message that shows at that moment off a printed list (web/src/common/print.css). -->
<div class="host" data-print-hide>
  {#if current}
    {#key current.id}
      <Snackbar message={current.message} actionLabel={current.action?.label ?? (current.undoable ? 'Undo' : undefined)} onaction={act} />
    {/key}
  {/if}
</div>

<style>
  .host {
    display: contents;
  }
</style>
