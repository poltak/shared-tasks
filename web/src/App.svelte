<script lang="ts" module>
  import { untrack, type Component } from 'svelte';
  import { layout, type LayoutMode } from './ui/layout.svelte.ts';

  type Part = Promise<{ default: Component }>;

  // Each screen is a file of its own. The first download has only what each start needs: the
  // data, this file, and the snackbar.
  const LAYOUTS: Record<LayoutMode, () => Part> = {
    wide: () => import('./wide/WideLayout.svelte'),
    phone: () => import('./phone/PhoneLayout.svelte'),
  };

  // The download of the layout starts when this file runs, at the same time as the local
  // database opens. A person who is signed out gets it while they type their password.
  const firstMode = layout.mode;
  const firstLayout = LAYOUTS[firstMode]().catch(() => null);
</script>

<script lang="ts">
  import { cancelDialogs } from './common/dialogs.svelte.ts';
  import { prefs, session, toast, undo } from './data/index.ts';
  import { readLaunchParams } from './pwa/launch.ts';
  import { app, closeShell, setLaunch } from './shell/app.svelte.ts';
  import SnackbarHost from './shell/SnackbarHost.svelte';
  import { closeAllOverlays, overlays } from './ui/overlay.svelte.ts';

  setLaunch(readLaunchParams());

  /** A screen that downloads at its first use. `get` starts the download and gives the screen when it is there. */
  function lazy(load: () => Part): { readonly part: Component | null; get(): Promise<boolean> } {
    let part = $state.raw<Component | null>(null);
    let pending: Promise<boolean> | null = null;
    return {
      get part() {
        return part;
      },
      get() {
        pending ??= load().then(
          (module) => {
            part = module.default;
            return true;
          },
          () => {
            // The next call tries again, for a browser that then asks the server again.
            pending = null;
            return false;
          },
        );
        return pending;
      },
    };
  }

  const signIn = lazy(() => import('./shell/SignIn.svelte'));
  const dialogHost = lazy(() => import('./common/DialogHost.svelte'));
  const settings = lazy(() => import('./shell/Settings.svelte'));
  const shortcuts = lazy(() => import('./shell/ShortcutsHelp.svelte'));

  let Layout = $state.raw<Component | null>(null);
  // The screen that must show now could not download.
  let layoutFailed = $state(false);
  let signInFailed = $state(false);

  // After a change of the window width, the old layout stays until the new one is there.
  $effect(() => {
    const mode = layout.mode;
    let current = true;
    const pending = mode === firstMode ? firstLayout : LAYOUTS[mode]().catch(() => null);
    void pending.then((module) => {
      if (!current) return;
      if (module) Layout = module.default;
      else layoutFailed = Layout === null;
    });
    return () => (current = false);
  });

  const signedIn = $derived(session.status === 'signedIn');

  $effect(() => {
    if (session.status === 'signedOut') void signIn.get().then((ok) => (signInFailed = !ok));
  });

  // The pickers and the shell screens come after the task screen is on the screen. They are
  // there before a person can ask for them, so they open in the frame of the click.
  $effect(() => {
    if (!signedIn || !Layout) return;
    void dialogHost.get();
    const later = () => {
      void settings.get();
      if (layout.wide) void shortcuts.get();
    };
    if (typeof requestIdleCallback === 'function') {
      const handle = requestIdleCallback(later, { timeout: 3000 });
      return () => cancelIdleCallback(handle);
    }
    const timer = setTimeout(later, 1500);
    return () => clearTimeout(timer);
  });

  // A request before the download is done (a click in the first second, or no network).
  function need({ part, close, name }: { part: { get(): Promise<boolean> }; close: () => void; name: string }): void {
    void part.get().then((ok) => {
      if (ok) return;
      close();
      // A browser keeps a failed download of a script for the life of the page, so a second
      // try in this page fails too. A reload loses nothing: the data is on the device.
      toast.show({ message: `${name} could not load. Check the connection`, action: { label: 'Reload', run: () => location.reload() } });
    });
  }
  $effect(() => {
    if (app.settingsOpen) need({ part: settings, close: () => (app.settingsOpen = false), name: 'Settings' });
  });
  $effect(() => {
    if (app.shortcutsOpen) need({ part: shortcuts, close: () => (app.shortcutsOpen = false), name: 'The shortcut list' });
  });

  // The address /#settings opens Settings: for a bookmark, and for a test that must not know a layout.
  const SETTINGS_HASH = '#settings';
  let settingsAsked = false;
  function readHash(): void {
    if (location.hash !== SETTINGS_HASH) return;
    // Without this, a reload opens Settings again. The state has the overlay count of web/src/ui.
    history.replaceState(history.state, '', location.pathname + location.search);
    if (signedIn) app.settingsOpen = true;
    else settingsAsked = session.status === 'loading';
  }
  readHash();
  $effect(() => {
    if (!signedIn || !settingsAsked) return;
    settingsAsked = false;
    app.settingsOpen = true;
  });

  // A sign-out, in this tab or by the server, must leave no dialog of the account open.
  $effect(() => {
    if (signedIn) return;
    if (session.status === 'signedOut') settingsAsked = false;
    untrack(() => {
      closeShell();
      cancelDialogs();
      closeAllOverlays();
    });
  });

  // The browser bar has the color of the page. web/index.html sets it for the first paint.
  $effect(() => {
    const forced = prefs.theme === 'dark' ? '#111318' : prefs.theme === 'light' ? '#f6f8fc' : null;
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      meta.content = forced ?? (meta.media.includes('dark') ? '#111318' : '#f6f8fc');
    }
  });

  function inTextField(): boolean {
    const element = document.activeElement;
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
    if (element instanceof HTMLInputElement) return !['checkbox', 'radio', 'button', 'submit', 'range'].includes(element.type);
    return element instanceof HTMLElement && element.isContentEditable;
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key !== 'z' && event.key !== 'Z') return;
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.repeat) return;
    // In a text field, the keys take back the typing. With a dialog open, the last action is not in view.
    if (event.defaultPrevented || !signedIn || overlays.count > 0 || inTextField()) return;
    event.preventDefault();
    // The shell owns these keys. A key handler of a layout that comes after this one must not undo a second action.
    event.stopImmediatePropagation();
    undo();
  }
</script>

<svelte:window {onkeydown} onhashchange={readHash} />

{#if signedIn}
  {#if Layout}
    <div class="app" data-testid="app-ready">
      <Layout />
      {#if dialogHost.part}<dialogHost.part />{/if}
      {#if app.settingsOpen && settings.part}<settings.part />{/if}
      {#if app.shortcutsOpen && shortcuts.part}<shortcuts.part />{/if}
    </div>
  {:else if layoutFailed}
    {@render cannotLoad()}
  {/if}
{:else if session.status === 'signedOut'}
  {#if signIn.part}
    <signIn.part />
  {:else if signInFailed}
    {@render cannotLoad()}
  {/if}
{/if}

{#snippet cannotLoad()}
  <div class="failed" role="alert">
    <p>The app could not load. Check the connection.</p>
    <button type="button" class="ui-state" onclick={() => location.reload()}>Try again</button>
  </div>
{/snippet}

<SnackbarHost />

<style>
  /* No box of its own: the layout is a child of #app for the browser, and #app fills the window. */
  .app {
    display: contents;
  }
  .failed {
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 16px;
    min-height: 100dvh;
    padding: 24px;
    color: var(--text-dim);
    font-size: 15px;
    text-align: center;
  }
  .failed button {
    height: 40px;
    padding: 0 24px;
    border-radius: var(--radius-pill);
    background: var(--primary);
    color: var(--on-primary);
    font-weight: 500;
  }
</style>
