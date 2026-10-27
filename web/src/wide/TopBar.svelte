<script lang="ts">
  import { syncBadge, type SyncBadge } from '../common/sync-badge.svelte.ts';
  import { prefs, session, sync } from '../data/index.ts';
  import { openSettings, openShortcuts } from '../shell/app.svelte.ts';
  import Icon from '../ui/Icon.svelte';
  import IconButton from '../ui/IconButton.svelte';
  import type { IconName } from '../ui/icons.ts';
  import { NOTES_SEARCH_ID, ui } from './state.svelte.ts';

  // The bar at the top: the sidebar button, the name of the app, the sync state, and the account.
  // In the notes views it has the search field of the notes in the middle.
  const BADGES: Readonly<Record<SyncBadge, { icon: IconName; text: string }>> = {
    offline: { icon: 'cloud-off', text: 'Offline. Changes are saved on this device' },
    pending: { icon: 'sync', text: 'Changes are not on the server yet' },
    error: { icon: 'cloud-off', text: 'The sync has a problem. The app tries again' },
  };

  const badge = $derived(syncBadge.current);
  const name = $derived(session.me?.name ?? '');
  const letter = $derived([...name.trim()][0]?.toUpperCase() ?? '?');

  let search = $state<HTMLInputElement>();

  function clearSearch(): void {
    ui.noteQuery = '';
    search?.focus();
  }

  function onSearchKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.isComposing) return;
    // Esc clears the words first, then leaves the field. The browser would only clear them.
    event.preventDefault();
    if (ui.noteQuery) ui.noteQuery = '';
    else search?.blur();
  }
</script>

<header class="bar" data-print-hide>
  <IconButton
    icon="menu"
    label={prefs.sidebarOpen ? 'Hide the sidebar' : 'Show the sidebar'}
    aria-expanded={prefs.sidebarOpen}
    aria-controls="wide-sidebar"
    onclick={() => (prefs.sidebarOpen = !prefs.sidebarOpen)}
  />
  <img class="logo" src="/icons/icon.svg" alt="" width="32" height="32" />
  <h1 class="name">{ui.notes ? 'Notes' : 'Tasks'}</h1>
  {#if ui.notes}
    <div class="middle">
      <div class="search" role="search">
        <!-- A press on the icon puts the focus in the field, as a press on the rest of the pill does. -->
        <label class="lens" for={NOTES_SEARCH_ID}><Icon name="search" size={20} /></label>
        <input
          id={NOTES_SEARCH_ID}
          type="search"
          placeholder={ui.view === 'archive' ? 'Search archive' : 'Search notes'}
          aria-label={ui.view === 'archive' ? 'Search archive' : 'Search notes'}
          autocomplete="off"
          spellcheck="false"
          enterkeyhint="search"
          bind:this={search}
          bind:value={ui.noteQuery}
          onkeydown={onSearchKey}
        />
        {#if ui.noteQuery}
          <IconButton icon="close" label="Clear search" size="sm" tooltip={false} onclick={clearSearch} />
        {/if}
      </div>
    </div>
  {:else}
    <span class="grow"></span>
  {/if}
  {#if badge}
    <button
      class={['sync ui-state', badge]}
      type="button"
      aria-label={BADGES[badge].text}
      data-tip={BADGES[badge].text}
      data-testid="sync-badge"
      onclick={() => void sync.now()}
    >
      <Icon name={BADGES[badge].icon} size={20} />
    </button>
  {/if}
  <IconButton icon="help" label="Keyboard shortcuts" onclick={openShortcuts} />
  <button class="account ui-state" type="button" aria-label="Settings of {name}" data-tip="Settings" onclick={openSettings}>{letter}</button>
</header>

<style>
  .bar {
    display: flex;
    flex: none;
    align-items: center;
    gap: 4px;
    height: 64px;
    padding: 0 16px 0 12px;
  }
  .logo {
    flex: none;
    margin-left: 8px;
    border-radius: 8px;
  }
  .name {
    margin-left: 8px;
    color: var(--text);
    font-size: 22px;
    font-weight: 400;
    line-height: 28px;
  }
  .grow {
    flex: 1;
  }
  .middle {
    display: flex;
    flex: 1;
    justify-content: center;
    min-width: 0;
    padding: 0 24px;
  }
  /* As in Google Keep: a quiet pill that lifts and turns to the card color with the focus. */
  .search {
    position: relative;
    isolation: isolate;
    display: flex;
    flex: 1;
    align-items: center;
    max-width: 720px;
    height: 48px;
    padding: 0 6px 0 4px;
    border-radius: var(--radius-pill);
    /* A veil of the text color: a little darker than the page in the light theme and a little
       lighter in the dark one, so the focus lifts the pill in both. */
    background: color-mix(in srgb, var(--text) 6%, transparent);
    color: var(--text-dim);
  }
  /* The lifted look is a layer that fades in, so only its opacity changes. */
  .search::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    background: var(--popup);
    box-shadow: var(--shadow-2);
    opacity: 0;
    transition: opacity var(--dur) var(--ease);
  }
  .search:focus-within::before {
    opacity: 1;
  }
  .lens {
    display: grid;
    flex: none;
    place-items: center;
    width: 44px;
    height: 44px;
    cursor: text;
  }
  .search input {
    flex: 1;
    min-width: 0;
    height: 100%;
    color: var(--text);
    font-size: 16px;
  }
  .search input::placeholder {
    color: var(--text-dim);
  }
  /* The pill has its own X. */
  .search input::-webkit-search-cancel-button {
    appearance: none;
  }
  .sync {
    display: grid;
    flex: none;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    color: var(--text-dim);
  }
  .sync.error {
    color: var(--danger);
  }
  .sync.pending :global(svg) {
    animation: sync-turn 1.2s linear infinite;
  }
  @keyframes sync-turn {
    to {
      transform: rotate(360deg);
    }
  }
  .account {
    display: grid;
    flex: none;
    place-items: center;
    width: 36px;
    height: 36px;
    margin-left: 6px;
    border-radius: 50%;
    background: var(--primary);
    color: var(--on-primary);
    font-size: 16px;
    font-weight: 500;
    line-height: 1;
  }
</style>
