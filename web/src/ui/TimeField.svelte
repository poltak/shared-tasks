<script lang="ts" module>
  import { parseTime, timeText } from '../../../shared/dates.ts';
  import type { TimeStr } from '../../../shared/types.ts';

  /** Each half hour of the day. */
  const OPTIONS: TimeStr[] = Array.from({ length: 48 }, (_, i) => `${String(i >> 1).padStart(2, '0')}:${i & 1 ? '30' : '00'}`);

  /** The option at the time, or the last one before it. */
  function optionAt(time: TimeStr): number {
    return Math.min(47, Math.floor((+time.slice(0, 2) * 60 + +time.slice(3, 5)) / 30));
  }
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { portal } from './overlay.svelte.ts';

  interface Props {
    value?: TimeStr | null;
    locale?: string;
    placeholder?: string;
    /** The accessible name. */
    label?: string;
    onchange?: (value: TimeStr | null) => void;
  }
  let { value = $bindable(null), locale = navigator.language, placeholder = 'Set time', label = 'Time', onchange }: Props = $props();

  const uid = $props.id();
  const texts = $derived(OPTIONS.map((time) => timeText({ time, locale })));

  /** The text in the field. The person writes it, and a new value replaces it. */
  let text = $derived(value ? timeText({ time: value, locale }) : '');
  let listOpen = $state(false);
  /** The option that the arrow keys chose. -1: Enter reads the typed text. */
  let active = $state(-1);
  let field = $state<HTMLElement>();
  let list = $state<HTMLElement>();

  function commit(next: TimeStr | null): void {
    listOpen = false;
    active = -1;
    text = next ? timeText({ time: next, locale }) : '';
    if (next === value) return;
    value = next;
    onchange?.(next);
  }

  /** Text that is not a time brings the old value back. Empty text removes the time. */
  function commitText(): void {
    const typed = text.trim();
    commit(typed === '' ? null : (parseTime(typed) ?? value));
  }

  /** Puts the list below the field, or above it, with the option in the middle. -1: only the position. */
  function showOption(index: number): void {
    if (!list || !field) return;
    const box = field.getBoundingClientRect();
    const view = window.visualViewport;
    const top = view?.offsetTop ?? 0;
    const bottom = top + (view?.height ?? window.innerHeight);
    const below = bottom - box.bottom - 12;
    const above = box.top - top - 12;
    // Below the field, if four options fit there or if there is not more room above.
    const down = below >= 150 || below >= above;
    list.style.maxHeight = `${Math.min(264, down ? below : above)}px`;
    list.style.width = `${Math.max(box.width, 136)}px`;
    list.style.left = `${box.left}px`;
    list.style.top = `${down ? box.bottom + 4 : box.top - 4 - list.offsetHeight}px`;
    const option = list.children[index] as HTMLElement | undefined;
    if (option) list.scrollTop = option.offsetTop - (list.clientHeight - option.offsetHeight) / 2;
  }

  /** The time that the text gives now, or the value if the text is not a time. */
  function typedTime(): TimeStr | null {
    return parseTime(text.trim()) ?? value;
  }

  /** The option in the middle of the list. With no time yet, it is the next half hour of the day. */
  function startOption(): number {
    const time = typedTime();
    if (time) return optionAt(time);
    const now = new Date();
    return Math.min(47, now.getHours() * 2 + (now.getMinutes() < 30 ? 1 : 2));
  }

  async function openList(): Promise<void> {
    if (listOpen) return;
    listOpen = true;
    active = -1;
    await tick();
    showOption(startOption());
  }

  // The on-screen keyboard moves the field after the list opened.
  $effect(() => {
    if (!listOpen) return;
    const again = (): void => showOption(-1);
    window.visualViewport?.addEventListener('resize', again);
    window.addEventListener('resize', again);
    return () => {
      window.visualViewport?.removeEventListener('resize', again);
      window.removeEventListener('resize', again);
    };
  });

  async function oninput(): Promise<void> {
    active = -1;
    const typed = parseTime(text.trim());
    if (!listOpen) {
      listOpen = true;
      await tick();
    }
    if (typed) showOption(optionAt(typed));
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!listOpen) {
        void openList();
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      let next = active + step;
      if (active < 0) {
        // The first step goes from the typed time to the option next to it.
        const time = typedTime();
        const start = startOption();
        if (time && OPTIONS[start] === time) next = start + step;
        else next = step > 0 ? start + (time ? 1 : 0) : start - (time ? 0 : 1);
      }
      active = Math.max(0, Math.min(47, next));
      showOption(active);
    } else if (event.key === 'Enter') {
      if (event.isComposing) return;
      event.preventDefault();
      if (listOpen && active >= 0) commit(OPTIONS[active]!);
      else commitText();
    } else if (event.key === 'Escape' && listOpen) {
      // The overlay stack sees that the default is prevented, and keeps the dialog open.
      event.preventDefault();
      listOpen = false;
      active = -1;
      text = value ? timeText({ time: value, locale }) : '';
    }
  }
</script>

<span class="time" bind:this={field}>
  <Icon name="clock" size={20} />
  <input
    type="text"
    role="combobox"
    autocomplete="off"
    autocapitalize="off"
    spellcheck="false"
    enterkeyhint="done"
    aria-label={label}
    aria-expanded={listOpen}
    aria-controls="{uid}-list"
    aria-autocomplete="list"
    aria-activedescendant={active >= 0 ? `${uid}-${active}` : undefined}
    {placeholder}
    bind:value={text}
    {oninput}
    {onkeydown}
    onfocus={(event) => {
      event.currentTarget.select();
      void openList();
    }}
    onclick={openList}
    onblur={commitText}
  />
  {#if value}
    <button class="clear ui-state" type="button" aria-label="Remove time" onmousedown={(event) => event.preventDefault()} onclick={() => commit(null)}>
      <Icon name="close" size={16} />
    </button>
  {/if}
</span>

{#if listOpen}
  <!-- The list is outside the dialog, so the dialog does not clip it. A press on it must not take
       the focus from the field: the field closes the list when it loses the focus. -->
  <div class="ui-layer" use:portal>
    <div class="list" role="listbox" id="{uid}-list" aria-label={label} tabindex="-1" bind:this={list} onmousedown={(event) => event.preventDefault()}>
      {#each texts as optionText, i (i)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div class={['option', { active: i === active }]} role="option" id="{uid}-{i}" tabindex="-1" aria-selected={OPTIONS[i] === value} onclick={() => commit(OPTIONS[i]!)}>
          {optionText}
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .time {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    width: 168px;
    height: 40px;
    padding: 0 6px 0 12px;
    border-radius: var(--radius-pill);
    background: var(--field);
    color: var(--text-dim);
  }
  .time:focus-within {
    box-shadow: inset 0 0 0 2px var(--primary);
  }
  input {
    flex: 1;
    min-width: 0;
    height: 100%;
    color: var(--text);
    caret-color: var(--primary);
  }
  .clear {
    display: grid;
    flex: none;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    color: var(--text-dim);
  }
  .list {
    position: fixed;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 6px 0;
    border-radius: var(--radius-md);
    background: var(--popup);
    box-shadow: var(--shadow-2);
    color: var(--text);
  }
  .option {
    display: flex;
    align-items: center;
    height: 36px;
    padding: 0 16px;
    font-size: 14px;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
  }
  @media (hover: hover) {
    .option:hover {
      background: color-mix(in srgb, var(--text) 7%, transparent);
    }
  }
  .option.active {
    background: color-mix(in srgb, var(--text) 11%, transparent);
  }
  .option[aria-selected='true'] {
    color: var(--primary);
    font-weight: 600;
  }
  /* A finger needs higher rows. */
  @media (pointer: coarse) {
    .option {
      height: 44px;
      font-size: 16px;
    }
  }
</style>
