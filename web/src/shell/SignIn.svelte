<script lang="ts">
  import { tick } from 'svelte';
  import { LIMITS } from '../../../shared/types.ts';
  import { login, register, session } from '../data/index.ts';
  import { Button, fade, layout, SegmentedControl, TextField } from '../ui/index.ts';

  type Mode = 'signIn' | 'create';
  type Field = 'name' | 'password' | 'again';
  type Errors = Partial<Record<Field | 'form', string>>;

  let mode = $state<Mode>('signIn');
  let name = $state('');
  let password = $state('');
  let again = $state('');
  let errors = $state<Errors>({});
  let busy = $state(false);

  const inputs = $state<Record<Field, HTMLInputElement | null>>({ name: null, password: null, again: null });

  // Sign-up closes when the last account is made. That can occur while this screen shows.
  const create = $derived(mode === 'create' && session.canRegister);

  function setMode(next: Mode): void {
    mode = next;
    errors = {};
    again = '';
  }

  function check(): Errors {
    const found: Errors = {};
    if (!name.trim()) found.name = create ? 'Enter a name' : 'Enter your name';
    if (!create) {
      if (!password) found.password = 'Enter your password';
    } else if (password.length < LIMITS.passwordMin) {
      found.password = `Use at least ${LIMITS.passwordMin} characters`;
    } else if (again !== password) {
      found.again = 'The two passwords are not the same';
    }
    return found;
  }

  /** The server gives one text. It goes below the field that it is about. */
  function place(message: string): Errors {
    if (/password/i.test(message)) return { password: message };
    if (/\bname\b/i.test(message)) return { name: message };
    return { form: message };
  }

  async function show(found: Errors): Promise<boolean> {
    errors = found;
    const first = (['name', 'password', 'again'] as const).find((field) => found[field]);
    if (!first) return found.form === undefined;
    await tick();
    inputs[first]?.focus();
    // A wrong password is typed again from its start.
    if (first !== 'name') inputs[first]?.select();
    return false;
  }

  async function submit(): Promise<void> {
    if (busy || !(await show(check()))) return;
    busy = true;
    const input = { name, password };
    const result = create ? await register(input) : await login(input);
    busy = false;
    // After a success, the app replaces this screen.
    if (!result.ok) void show(place(result.message));
  }

  function clear(field: Field): void {
    if (errors[field] || errors.form) errors = { ...errors, [field]: undefined, form: undefined };
  }
</script>

<main class="page" in:fade|global={{ duration: 160 }} out:fade|global={{ duration: 120 }}>
  <div class={['card', { busy }]}>
    <div class="progress" aria-hidden="true"><span></span></div>

    <header>
      <img src="/icons/icon.svg" width="56" height="56" alt="" />
      <h1>Shared Tasks</h1>
      <p>{create ? 'Make your account' : 'Sign in to see your tasks'}</p>
    </header>

    {#if session.canRegister}
      <div class="modes">
        <SegmentedControl
          value={mode}
          label="Sign in or create an account"
          options={[
            { value: 'signIn', label: 'Sign in' },
            { value: 'create', label: 'Create account' },
          ]}
          onchange={setMode}
        />
      </div>
    {/if}

    <form
      novalidate
      onsubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <TextField
        label="Name"
        name="username"
        bind:value={name}
        bind:ref={inputs.name}
        error={errors.name}
        autofocus={layout.hover}
        autocomplete="username"
        autocapitalize="words"
        autocorrect="off"
        spellcheck={false}
        maxlength={LIMITS.name}
        enterkeyhint="next"
        readonly={busy}
        oninput={() => clear('name')}
        onenter={() => (password ? void submit() : inputs.password?.focus())}
      />
      <TextField
        label="Password"
        name="password"
        type="password"
        bind:value={password}
        bind:ref={inputs.password}
        error={errors.password}
        hint={create ? `At least ${LIMITS.passwordMin} characters` : undefined}
        autocomplete={create ? 'new-password' : 'current-password'}
        enterkeyhint={create ? 'next' : 'go'}
        readonly={busy}
        oninput={() => clear('password')}
        onenter={() => (create && !again ? inputs.again?.focus() : void submit())}
      />
      {#if create}
        <TextField
          label="Password again"
          name="password-again"
          type="password"
          bind:value={again}
          bind:ref={inputs.again}
          error={errors.again}
          autocomplete="new-password"
          enterkeyhint="go"
          readonly={busy}
          oninput={() => clear('again')}
          onenter={() => void submit()}
        />
      {/if}

      {#if errors.form}<p class="form-error" role="alert">{errors.form}</p>{/if}

      <div class="submit">
        <Button variant="filled" type="submit" disabled={busy}>{create ? 'Create account' : 'Sign in'}</Button>
      </div>
    </form>
  </div>
</main>

<style>
  /* Fixed, so the task screen can come in below this screen while it fades out. */
  .page {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: grid;
    grid-template-columns: minmax(0, 400px);
    align-content: start;
    justify-content: center;
    overflow-y: auto;
    overscroll-behavior: contain;
    /* The card keeps its top edge when the second mode adds a field. */
    padding: calc(clamp(24px, 14vh, 160px) + env(safe-area-inset-top)) max(16px, env(safe-area-inset-right))
      calc(32px + env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
    background: var(--bg);
  }
  .card {
    position: relative;
    overflow: hidden;
    padding: 36px 32px 32px;
    border-radius: 28px;
    background: var(--surface);
    box-shadow: var(--shadow-1);
  }

  header {
    display: grid;
    justify-items: center;
    gap: 4px;
    margin-bottom: 24px;
    text-align: center;
  }
  header img {
    margin-bottom: 12px;
    border-radius: 14px;
  }
  h1 {
    font-size: 24px;
    font-weight: 500;
    line-height: 32px;
    letter-spacing: -0.01em;
  }
  header p {
    color: var(--text-dim);
    font-size: 15px;
    line-height: 20px;
  }

  .modes {
    display: flex;
    justify-content: center;
    margin-bottom: 20px;
  }

  form {
    display: grid;
    gap: 16px;
  }
  .form-error {
    padding: 0 2px;
    color: var(--danger);
    font-size: 13px;
    line-height: 18px;
  }
  .submit {
    display: grid;
    margin-top: 8px;
  }
  .submit :global(.btn) {
    height: 48px;
    font-size: 15px;
  }

  /* A request that takes time shows a line at the top edge. A fast one shows nothing. */
  .progress {
    position: absolute;
    inset: 0 0 auto;
    height: 3px;
    overflow: hidden;
    opacity: 0;
    transition: opacity var(--dur-fast) linear;
  }
  .busy .progress {
    opacity: 1;
    transition-delay: 300ms;
  }
  .progress span {
    display: block;
    width: 40%;
    height: 100%;
    border-radius: var(--radius-pill);
    background: var(--primary);
    transform: translateX(-100%);
  }
  .busy .progress span {
    animation: run 1.1s var(--ease) infinite;
  }
  @keyframes run {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(250%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .busy .progress span {
      width: 100%;
      animation: none;
      transform: none;
    }
  }

  @media (max-width: 480px) {
    .card {
      padding: 28px 20px 24px;
      border-radius: 24px;
    }
  }
</style>
