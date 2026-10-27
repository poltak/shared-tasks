<script lang="ts">
  import { NOTE_SHORTCUTS, SHORTCUTS, shortcutKeys, type Shortcut } from '../common/shortcuts.ts';
  import { prefs } from '../data/index.ts';
  import { Button, Dialog } from '../ui/index.ts';
  import { app } from './app.svelte.ts';

  let notes = $state<HTMLElement>();

  // In the Notes and Archive views only the keys of the notes work, and a low window has them
  // below the fold. The list then opens with them in view.
  $effect(() => {
    if (notes && prefs.lastTab === 'notes') notes.scrollIntoView({ block: 'nearest' });
  });
</script>

{#snippet table(shortcuts: readonly Shortcut[], caption?: string)}
  <table>
    {#if caption}<caption>{caption}</caption>{/if}
    <thead>
      <tr>
        <th scope="col">Action</th>
        <th scope="col">Keys</th>
      </tr>
    </thead>
    <tbody>
      {#each shortcuts as shortcut (shortcut.action)}
        <tr>
          <th scope="row">{shortcut.action}</th>
          <td>
            {#each shortcutKeys(shortcut) as combo, index (index)}
              {#if index > 0}<span class="joiner">{shortcut.joiner}</span>{/if}
              <span class="combo">
                {#each combo as key (key)}<kbd>{key}</kbd>{/each}
              </span>
            {/each}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
{/snippet}

<Dialog bind:open={app.shortcutsOpen} title="Keyboard shortcuts" width={520} padded={false}>
  {@render table(SHORTCUTS)}
  <div bind:this={notes}>{@render table(NOTE_SHORTCUTS, 'Notes')}</div>
  {#snippet actions()}
    <Button data-autofocus onclick={() => (app.shortcutsOpen = false)}>Close</Button>
  {/snippet}
</Dialog>

<style>
  table {
    width: 100%;
    border-collapse: collapse;
    border-spacing: 0;
  }
  /* The heading of the second table: the keys of the Notes and Archive views. */
  caption {
    padding: 20px 24px 4px;
    color: var(--text-dim);
    font-size: 12px;
    font-weight: 500;
    line-height: 16px;
    letter-spacing: 0.06em;
    text-align: left;
    text-transform: uppercase;
  }
  /* The two headings are for a screen reader. The title of the dialog tells the same to the eye. */
  thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  th,
  td {
    height: 40px;
    padding: 4px 24px;
    vertical-align: middle;
  }
  tbody tr + tr th,
  tbody tr + tr td {
    border-top: 1px solid var(--divider);
  }
  tbody th {
    padding-right: 12px;
    color: var(--text);
    font-size: 14px;
    font-weight: 400;
    line-height: 20px;
    text-align: left;
  }
  td {
    padding-left: 0;
    text-align: right;
    white-space: nowrap;
  }
  .combo {
    display: inline-flex;
    gap: 4px;
    vertical-align: middle;
  }
  .joiner {
    margin: 0 6px;
    color: var(--text-dim);
    font-size: 12px;
    vertical-align: middle;
  }
  kbd {
    display: inline-grid;
    place-items: center;
    min-width: 26px;
    height: 26px;
    padding: 0 7px;
    border-radius: 7px;
    background: var(--field);
    box-shadow: inset 0 -1px 0 var(--outline);
    color: var(--text);
    font: 500 12px/1 var(--font);
  }
</style>
