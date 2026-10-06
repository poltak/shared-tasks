<script lang="ts">
  import { tick } from 'svelte';
  import { dateChipText, todayOf } from '../../../shared/dates.ts';
  import { LIMITS } from '../../../shared/types.ts';
  import { changePassword, logout, prefs, push, rename, session, store, sync, toast, type Theme } from '../data/index.ts';
  import { isIos, isStandalone } from '../pwa/install.ts';
  import {
    Button,
    ConfirmDialog,
    Dialog,
    Icon,
    IconButton,
    layout,
    SegmentedControl,
    Switch,
    TextField,
    type IconName,
    type SelectOption,
  } from '../ui/index.ts';
  import { app, update } from './app.svelte.ts';

  const locale = navigator.language;

  // A sign-out empties the session while this screen fades out. The screen keeps the last values.
  let account = $state.raw({ me: session.me, users: session.users });
  $effect.pre(() => {
    if (session.me) account = { me: session.me, users: session.users };
  });
  const me = $derived(account.me);

  // ---- Account: the name ----

  let editing = $state(false);
  let newName = $state('');
  let nameError = $state<string | null>(null);
  let nameBusy = $state(false);
  let nameInput = $state<HTMLInputElement | null>(null);
  let editButton = $state<HTMLButtonElement | null>(null);

  async function startEdit(): Promise<void> {
    newName = me?.name ?? '';
    nameError = null;
    editing = true;
    await tick();
    nameInput?.focus();
    nameInput?.select();
  }

  async function endEdit(): Promise<void> {
    editing = false;
    await tick();
    editButton?.focus();
  }

  async function saveName(): Promise<void> {
    const name = newName.trim();
    if (nameBusy) return;
    if (!name) {
      nameError = 'Enter a name';
      return;
    }
    if (name === me?.name) return endEdit();
    nameBusy = true;
    const result = await rename({ name });
    nameBusy = false;
    if (result.ok) return endEdit();
    nameError = result.message;
    nameInput?.focus();
  }

  // ---- Account: the password ----

  type PasswordField = 'current' | 'next' | 'again';
  let passwordOpen = $state(false);
  let secret = $state<Record<PasswordField, string>>({ current: '', next: '', again: '' });
  let secretErrors = $state<Partial<Record<PasswordField | 'form', string>>>({});
  let secretBusy = $state(false);
  const secretInputs = $state<Record<PasswordField, HTMLInputElement | null>>({ current: null, next: null, again: null });

  function openPassword(): void {
    secret = { current: '', next: '', again: '' };
    secretErrors = {};
    passwordOpen = true;
  }

  async function savePassword(): Promise<void> {
    if (secretBusy) return;
    const found: typeof secretErrors = {};
    if (!secret.current) found.current = 'Enter your current password';
    if (secret.next.length < LIMITS.passwordMin) found.next = `Use at least ${LIMITS.passwordMin} characters`;
    else if (secret.again !== secret.next) found.again = 'The two passwords are not the same';
    secretErrors = found;
    const first = (['current', 'next', 'again'] as const).find((field) => found[field]);
    if (first) {
      secretInputs[first]?.focus();
      return;
    }
    secretBusy = true;
    const result = await changePassword({ current: secret.current, next: secret.next });
    secretBusy = false;
    if (result.ok) {
      passwordOpen = false;
      toast.show({ message: 'Password changed' });
      return;
    }
    if (/current/i.test(result.message)) {
      secretErrors = { current: result.message };
      secretInputs.current?.focus();
      secretInputs.current?.select();
    } else {
      secretErrors = { form: result.message };
    }
  }

  // ---- Account: sign-out ----

  let leaving = $state(false);
  let warnOpen = $state(false);
  let unsent = $state(0);

  function signOut(): void {
    // The sign-out deletes the local data. Without the server, the changes that wait go with it.
    const cut = sync.status === 'offline' || sync.status === 'error' || !navigator.onLine;
    if (sync.pending > 0 && cut) {
      unsent = sync.pending;
      warnOpen = true;
    } else {
      void leave();
    }
  }

  async function leave(): Promise<void> {
    if (leaving) return;
    leaving = true;
    // The app closes this screen when the session ends.
    await logout();
  }

  // ---- Appearance ----

  const themes: SelectOption<Theme>[] = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light', icon: 'sun' },
    { value: 'dark', label: 'Dark', icon: 'moon' },
  ];

  // ---- Notifications ----

  // An iPhone gives notifications only to an app on the Home Screen.
  const mustInstall = isIos() && !isStandalone();
  const canNotify = push.supported && !mustInstall;
  let notifyOn = $state(push.enabled);
  let notifyBusy = $state(false);
  let testBusy = $state(false);
  let notifyNote = $state<{ ok: boolean; text: string } | null>(null);

  // The data layer learns the state of the device after the start.
  $effect(() => {
    if (!notifyBusy) notifyOn = push.enabled;
  });

  async function setNotify(on: boolean): Promise<void> {
    notifyBusy = true;
    notifyNote = null;
    const result = on ? await push.enable() : await push.disable();
    notifyBusy = false;
    notifyOn = push.enabled;
    notifyNote = { ok: result.ok, text: result.message };
  }

  async function testNotify(): Promise<void> {
    testBusy = true;
    notifyNote = null;
    const result = await push.test();
    testBusy = false;
    notifyNote = { ok: result.ok, text: result.message };
  }

  // ---- Sync ----

  let syncBusy = $state(false);
  let syncNote = $state<string | null>(null);

  const syncState = $derived.by((): { icon: IconName; title: string; text: string | null } => {
    if (syncBusy) return { icon: 'sync', title: 'Syncing…', text: null };
    if (sync.status === 'offline') {
      return { icon: 'cloud-off', title: 'Offline', text: 'Your changes are safe on this device. They sync when the connection is back.' };
    }
    if (sync.status === 'error') {
      return { icon: 'cloud-off', title: 'Sync problem', text: 'The server gave an error. The app tries again by itself.' };
    }
    // The data layer says 'syncing' for each small request. Only changes that wait are news.
    if (sync.pending > 0) return { icon: 'sync', title: 'Syncing…', text: null };
    return { icon: 'cloud-done', title: 'Up to date', text: null };
  });

  const pendingText = $derived(sync.pending === 0 ? 'No pending changes' : sync.pending === 1 ? '1 pending change' : `${sync.pending} pending changes`);

  const lastSync = $derived.by(() => {
    const at = sync.lastSyncedAt;
    if (at === null) return 'Not yet';
    const date = new Date(at);
    const two = (value: number): string => String(value).padStart(2, '0');
    return dateChipText({ date: todayOf(date), time: `${two(date.getHours())}:${two(date.getMinutes())}`, today: store.today, locale });
  });

  async function syncNow(): Promise<void> {
    if (syncBusy) return;
    syncBusy = true;
    syncNote = null;
    // A fast answer must not make the state text flash.
    const [ok] = await Promise.all([sync.now(), new Promise((resolve) => setTimeout(resolve, 500))]);
    syncBusy = false;
    if (!ok) syncNote = 'No answer from the server';
  }

  // ---- About ----

  const people = $derived(
    account.users.map((user) => (user.id === me?.id ? `${user.name} (you)` : user.name)).join(' and ') || (me?.name ?? ''),
  );

  function onEditKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    // Esc ends the edit of the name. It must not also close Settings.
    event.preventDefault();
    void endEdit();
  }
</script>

<Dialog bind:open={app.settingsOpen} title="Settings" fullscreen width={480} padded={false} actions={layout.wide ? done : undefined}>
  <div class={['settings', { cards: layout.phone }]} data-testid="settings">
    <section aria-labelledby="st-account">
      <h3 id="st-account">Account</h3>
      <div class="group">
        {#if editing}
          <form
            class="edit"
            novalidate
            onsubmit={(event) => {
              event.preventDefault();
              void saveName();
            }}
          >
            <TextField
              label="Name"
              name="username"
              bind:value={newName}
              bind:ref={nameInput}
              error={nameError}
              hint="You also sign in with this name"
              autocomplete="username"
              autocapitalize="words"
              autocorrect="off"
              spellcheck={false}
              maxlength={LIMITS.name}
              enterkeyhint="done"
              readonly={nameBusy}
              oninput={() => (nameError = null)}
              onkeydown={onEditKey}
              onenter={() => void saveName()}
            />
            <div class="edit-actions">
              <Button onclick={() => void endEdit()}>Cancel</Button>
              <Button variant="tonal" type="submit" disabled={nameBusy}>Save</Button>
            </div>
          </form>
        {:else}
          <div class="row">
            <span class="avatar" aria-hidden="true">{(me?.name ?? '?').trim().charAt(0).toUpperCase()}</span>
            <span class="text">
              <span class="sub">Name</span>
              <span class="title" data-testid="account-name">{me?.name}</span>
            </span>
            <IconButton icon="edit" label="Edit name" bind:ref={editButton} onclick={() => void startEdit()} />
          </div>
        {/if}
        <button type="button" class="row ui-state" onclick={openPassword}>
          <Icon name="lock" />
          <span class="text"><span class="title">Change password</span></span>
          <Icon name="chevron-right" size={20} class="more" />
        </button>
        <button type="button" class="row ui-state" disabled={leaving} onclick={signOut}>
          <Icon name="logout" />
          <span class="text"><span class="title">{leaving ? 'Signing out…' : 'Sign out'}</span></span>
        </button>
      </div>
    </section>

    <section aria-labelledby="st-appearance">
      <h3 id="st-appearance">Appearance</h3>
      <div class="group">
        <div class="theme">
          <SegmentedControl value={prefs.theme} options={themes} label="Theme" onchange={(theme) => (prefs.theme = theme)} />
        </div>
      </div>
    </section>

    <section aria-labelledby="st-notifications">
      <h3 id="st-notifications">Notifications</h3>
      <div class="group">
        <div class="row">
          <Icon name="bell" />
          <span class="text">
            <span class="title">Reminders on this device</span>
            <span class="sub">For tasks with a date or a deadline</span>
          </span>
          <Switch bind:checked={notifyOn} label="Notifications" disabled={!canNotify || notifyBusy} onchange={(on) => void setNotify(on)} />
        </div>
        {#if mustInstall}
          <p class="note" data-testid="install-note">
            On an iPhone or iPad, notifications work only in the installed app. Open the Share menu, select “Add to Home Screen”, and then
            open Shared Tasks from the Home Screen.
          </p>
        {:else if !push.supported}
          <p class="note">This browser cannot show notifications.</p>
        {/if}
        <div class="row tools">
          <Button variant="tonal" disabled={testBusy} onclick={() => void testNotify()}>Send test notification</Button>
        </div>
        <!-- Always there, so a screen reader gets the new text. -->
        <p class={['note', { bad: notifyNote && !notifyNote.ok, empty: !notifyNote }]} role="status" data-testid="notify-result">
          {notifyNote?.text}
        </p>
      </div>
    </section>

    <section aria-labelledby="st-sync">
      <h3 id="st-sync">Sync</h3>
      <div class="group">
        <div class="row">
          <Icon name={syncState.icon} />
          <span class="text">
            <span class="title" data-testid="sync-state">{syncState.title}</span>
            <span class="sub" data-testid="sync-pending">{pendingText}</span>
            <span class="sub" data-testid="sync-last">Last sync: {lastSync}</span>
          </span>
          <Button variant="tonal" disabled={syncBusy} onclick={() => void syncNow()}>Sync now</Button>
        </div>
        <p class={['note', { bad: syncNote, empty: !syncNote && !syncState.text }]} role="status">{syncNote ?? syncState.text}</p>
      </div>
    </section>

    <section aria-labelledby="st-about">
      <h3 id="st-about">About</h3>
      <div class="group">
        <div class="row">
          <img src="/icons/icon.svg" width="40" height="40" alt="" />
          <span class="text">
            <span class="title">Shared Tasks</span>
            <span class="sub" data-testid="version">{session.version ? `Version ${session.version}` : 'Version not known'}</span>
            <span class="sub" data-testid="accounts">{account.users.length > 1 ? 'Accounts' : 'Account'}: {people}</span>
          </span>
        </div>
        {#if update.apply}
          <div class="row tools">
            <Button variant="tonal" onclick={update.apply}>Reload for the new version</Button>
          </div>
        {/if}
      </div>
    </section>
  </div>
</Dialog>

{#snippet done()}
  <Button onclick={() => (app.settingsOpen = false)}>Done</Button>
{/snippet}

<Dialog bind:open={passwordOpen} title="Change password" width={400}>
  <form
    id="st-password"
    class="secret"
    novalidate
    onsubmit={(event) => {
      event.preventDefault();
      void savePassword();
    }}
  >
    <!-- A password manager needs the name to know which entry it must change. -->
    <input class="for-manager" type="text" name="username" autocomplete="username" value={me?.name ?? ''} readonly tabindex="-1" aria-hidden="true" />
    <TextField
      label="Current password"
      name="current-password"
      type="password"
      bind:value={secret.current}
      bind:ref={secretInputs.current}
      error={secretErrors.current}
      autofocus
      autocomplete="current-password"
      enterkeyhint="next"
      oninput={() => (secretErrors = { ...secretErrors, current: undefined, form: undefined })}
      onenter={() => (secret.next ? void savePassword() : secretInputs.next?.focus())}
    />
    <TextField
      label="New password"
      name="new-password"
      type="password"
      bind:value={secret.next}
      bind:ref={secretInputs.next}
      error={secretErrors.next}
      hint={`At least ${LIMITS.passwordMin} characters`}
      autocomplete="new-password"
      enterkeyhint="next"
      oninput={() => (secretErrors = { ...secretErrors, next: undefined, form: undefined })}
      onenter={() => (secret.again ? void savePassword() : secretInputs.again?.focus())}
    />
    <TextField
      label="New password again"
      name="new-password-again"
      type="password"
      bind:value={secret.again}
      bind:ref={secretInputs.again}
      error={secretErrors.again}
      autocomplete="new-password"
      enterkeyhint="done"
      oninput={() => (secretErrors = { ...secretErrors, again: undefined, form: undefined })}
      onenter={() => void savePassword()}
    />
    {#if secretErrors.form}<p class="secret-error" role="alert">{secretErrors.form}</p>{/if}
    <p class="secret-note">Your other devices are signed out.</p>
  </form>
  {#snippet actions()}
    <Button onclick={() => (passwordOpen = false)}>Cancel</Button>
    <Button type="submit" form="st-password" disabled={secretBusy}>Save</Button>
  {/snippet}
</Dialog>

<ConfirmDialog
  bind:open={warnOpen}
  title="Sign out and lose changes?"
  text={`${unsent === 1 ? '1 change is' : `${unsent} changes are`} not on the server yet, and this device has no connection. If you sign out now, ${unsent === 1 ? 'that change is' : 'those changes are'} lost.`}
  confirmLabel="Sign out"
  danger
  onconfirm={() => void leave()}
/>

<style>
  .settings {
    padding: 0 0 4px;
  }
  section + section {
    margin-top: 4px;
    border-top: 1px solid var(--divider);
  }
  h3 {
    padding: 12px 24px 4px;
    color: var(--primary);
    font-size: 13px;
    font-weight: 600;
    line-height: 20px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 16px;
    width: 100%;
    min-height: var(--row, 48px);
    padding: 6px 24px;
    color: var(--text);
    text-align: left;
  }
  .row > :global(svg) {
    color: var(--text-dim);
  }
  .row > :global(svg.more) {
    color: var(--text-off);
  }
  .row:disabled {
    color: var(--text-off);
  }
  .text {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }
  .title {
    overflow: hidden;
    font-size: 15px;
    line-height: 22px;
    text-overflow: ellipsis;
  }
  .sub {
    color: var(--text-dim);
    font-size: 13px;
    line-height: 18px;
  }
  .avatar {
    display: grid;
    flex: none;
    place-items: center;
    width: 40px;
    height: 40px;
    /* The icon column of the other rows is 24 px wide. The circle is in line with its centre. */
    margin: 0 -8px;
    border-radius: 50%;
    background: var(--primary-container);
    color: var(--on-primary-container);
    font-size: 17px;
    font-weight: 500;
  }
  .row img {
    flex: none;
    margin: 0 -8px;
    border-radius: 10px;
  }
  /* The edit button is 40 px in a row with 24 px of padding. Its icon is then in line with the other controls. */
  .row > :global(.icon-btn) {
    margin-right: -8px;
  }

  .edit {
    display: grid;
    gap: 8px;
    padding: 12px 24px 8px;
  }
  .edit-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .theme {
    padding: 8px 24px 12px;
  }
  .theme :global(.segments) {
    display: grid;
  }

  .tools {
    min-height: 0;
    padding-top: 2px;
    padding-bottom: 10px;
    /* In line with the text of the row above: the padding, the icon, and the gap. */
    padding-left: 64px;
  }
  .note {
    padding: 2px 24px 12px 64px;
    color: var(--text-dim);
    font-size: 13px;
    line-height: 18px;
  }
  .note.bad {
    color: var(--danger);
  }
  .note.empty {
    display: none;
  }

  /* The phone: a full screen in the page color, with one card for each part. */
  .cards {
    --row: 56px;
    padding: 0 16px 24px;
  }
  .cards section + section {
    margin-top: 12px;
    border-top: 0;
  }
  .cards h3 {
    padding: 12px 8px 8px;
  }
  .cards .group {
    overflow: hidden;
    border-radius: var(--radius-card);
    background: var(--surface);
    box-shadow: var(--shadow-1);
  }
  .cards .row {
    padding-right: 16px;
    padding-left: 16px;
  }
  .cards .edit {
    padding: 16px 16px 8px;
  }
  .cards .theme {
    padding: 12px 16px;
  }
  .cards .tools {
    padding-left: 56px;
  }
  .cards .note {
    padding: 2px 16px 12px 56px;
  }

  .secret {
    display: grid;
    gap: 14px;
    padding: 4px 0 0;
  }
  .for-manager {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    opacity: 0;
    pointer-events: none;
  }
  .secret-error {
    color: var(--danger);
    font-size: 13px;
    line-height: 18px;
  }
  .secret-note {
    color: var(--text-dim);
    font-size: 13px;
    line-height: 18px;
  }
</style>
