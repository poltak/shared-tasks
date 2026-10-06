<script lang="ts">
  import { syncBadge, type SyncBadge } from '../common/sync-badge.svelte.ts';
  import { prefs, session, sync } from '../data/index.ts';
  import { openSettings, openShortcuts } from '../shell/app.svelte.ts';
  import Icon from '../ui/Icon.svelte';
  import IconButton from '../ui/IconButton.svelte';
  import type { IconName } from '../ui/icons.ts';

  // The bar at the top: the sidebar button, the name of the app, the sync state, and the account.
  const BADGES: Readonly<Record<SyncBadge, { icon: IconName; text: string }>> = {
    offline: { icon: 'cloud-off', text: 'Offline. Changes are saved on this device' },
    pending: { icon: 'sync', text: 'Changes are not on the server yet' },
    error: { icon: 'cloud-off', text: 'The sync has a problem. The app tries again' },
  };

  const badge = $derived(syncBadge.current);
  const name = $derived(session.me?.name ?? '');
  const letter = $derived([...name.trim()][0]?.toUpperCase() ?? '?');
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
  <h1 class="name">Tasks</h1>
  <span class="grow"></span>
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
