<script lang="ts">
  // A page to work on the wide layout against a development server with the seed data, with
  // no sign-in screen. Address values:
  //   ?user=sam     the second test account
  //   ?theme=dark   or light
  //   ?fill=2000    adds 20 lists with this number of tasks in total, one time for each database
  //   ?task=ID, ?list=ID, ?new=1   as in the real app
  import fixtures from '../../e2e/fixtures/users.json';
  import DialogHost from '../src/common/DialogHost.svelte';
  import { actions, listsOrdered, login, prefs, session, undo } from '../src/data/index.ts';
  import { readLaunchParams } from '../src/pwa/launch.ts';
  import { app, setLaunch } from '../src/shell/app.svelte.ts';
  import Settings from '../src/shell/Settings.svelte';
  import ShortcutsHelp from '../src/shell/ShortcutsHelp.svelte';
  import SnackbarHost from '../src/shell/SnackbarHost.svelte';
  import { overlays } from '../src/ui/overlay.svelte.ts';
  import WideLayout from '../src/wide/WideLayout.svelte';

  const query = new URLSearchParams(location.search);
  const account = fixtures.users[query.get('user') === 'sam' ? 1 : 0]!;
  const theme = query.get('theme');
  if (theme === 'dark' || theme === 'light') prefs.theme = theme;
  const fill = Number(query.get('fill') ?? 0);
  setLaunch(readLaunchParams());

  $effect(() => {
    if (session.status === 'signedOut') void login(account);
  });

  // Many lists and tasks, to see the speed of the layout.
  let filled = false;
  $effect(() => {
    if (session.status !== 'signedIn' || filled || fill <= 0) return;
    filled = true;
    if (listsOrdered().length >= 20) return;
    const lists = 20;
    const each = Math.ceil(fill / lists);
    for (let l = 0; l < lists; l++) {
      const listId = actions.createList({ title: `List ${l + 1}` }).puts[0]!.id;
      for (let t = each; t >= 1; t--) {
        const id = actions.createTask({
          listId,
          title: `Task ${t} of list ${l + 1}`,
          notes: t % 5 === 0 ? 'Some details for this task, to make the row higher.' : '',
          starred: t % 17 === 0,
        }).puts[0]!.id;
        if (t % 9 === 0) actions.completeTask({ id });
      }
    }
  });

  function onkeydown(event: KeyboardEvent): void {
    // The shell has this shortcut in the real app.
    if (event.key.toLowerCase() !== 'z' || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
    const target = event.target;
    if (overlays.count > 0 || target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return;
    event.preventDefault();
    undo();
  }
</script>

<svelte:window {onkeydown} />

{#if session.status === 'signedIn'}
  <div data-testid="app-ready" style="display: contents">
    <WideLayout />
    <DialogHost />
    {#if app.settingsOpen}<Settings />{/if}
    {#if app.shortcutsOpen}<ShortcutsHelp />{/if}
  </div>
{/if}
<SnackbarHost />
