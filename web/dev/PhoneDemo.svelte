<script lang="ts">
  // A page to try the phone layout against a development server with the seed data, with no
  // sign-in screen. Address values:
  //   ?user=sam     the second test account
  //   ?fill=500     makes the list "Long list" with this number of tasks, if it is not there
  //   ?done=120     completes this number of the tasks of the new "Long list"
  //   ?theme=dark   or light
  import fixtures from '../../e2e/fixtures/users.json';
  import DialogHost from '../src/common/DialogHost.svelte';
  import { actions, listsOrdered, login, prefs, session } from '../src/data/index.ts';
  import PhoneLayout from '../src/phone/PhoneLayout.svelte';
  import { app } from '../src/shell/app.svelte.ts';
  import Settings from '../src/shell/Settings.svelte';
  import SnackbarHost from '../src/shell/SnackbarHost.svelte';
  import '../src/ui/index.ts';

  const query = new URLSearchParams(location.search);
  const account = fixtures.users[query.get('user') === 'sam' ? 1 : 0]!;
  const fill = Number(query.get('fill')) || 0;
  const done = Number(query.get('done')) || 0;
  const theme = query.get('theme');
  if (theme === 'dark' || theme === 'light') prefs.theme = theme;

  $effect(() => {
    if (session.status === 'signedOut') void login(account);
  });

  const NOTES = ['', '', 'Check the price first.', '', 'Ask Sam about this.\nThen send the answer.'];

  let filled = false;
  $effect(() => {
    if (session.status !== 'signedIn' || fill === 0 || filled) return;
    filled = true;
    if (listsOrdered().some((list) => list.title === 'Long list')) return;
    const listId = actions.createList({ title: 'Long list' }).puts[0]?.id;
    if (!listId) return;
    for (let i = fill; i >= 1; i--) {
      const id = actions.createTask({ listId, title: `Task number ${i}`, notes: NOTES[i % NOTES.length], starred: i % 17 === 0 }).puts[0]?.id;
      if (id && i > fill - done) actions.completeTask({ id });
    }
  });
</script>

{#if session.status === 'signedIn'}
  <PhoneLayout />
  <DialogHost />
  {#if app.settingsOpen}<Settings />{/if}
{/if}
<SnackbarHost />
