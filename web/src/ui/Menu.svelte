<script lang="ts">
  import BottomSheet from './BottomSheet.svelte';
  import Icon from './Icon.svelte';
  import { layout } from './layout.svelte.ts';
  import { pop, release } from './motion.ts';
  import { keyboardUsed, portal, pushOverlay } from './overlay.svelte.ts';
  import type { MenuAnchor, MenuItem } from './types.ts';

  interface Props {
    open?: boolean;
    /** Where the popover shows. Not used for a bottom sheet. */
    anchor?: MenuAnchor | null;
    items: readonly MenuItem[];
    /** Called after the menu closed, so the handler can open a dialog. */
    onselect?: (id: string, item: MenuItem) => void;
    /** Called one time for each close, also after a selection. */
    onclose?: () => void;
    /** 'end': the right edge of the popover is at the right edge of the anchor. */
    align?: 'start' | 'end';
    /** A heading of the bottom sheet. The popover does not show it. */
    title?: string;
    /** The accessible name. */
    label?: string;
    /** 'auto': a popover on a wide window and a bottom sheet on a phone. */
    mode?: 'auto' | 'popover' | 'sheet';
  }
  let { open = $bindable(false), anchor = null, items, onselect, onclose, align = 'start', title, label, mode = 'auto' }: Props = $props();

  const GAP = 4;
  const EDGE = 8;

  const sheet = $derived(mode === 'sheet' || (mode === 'auto' && layout.phone));
  const lead = $derived(items.some((item) => item.icon !== undefined || item.checked !== undefined));
  let menu = $state<HTMLElement>();
  let typed = '';
  let typedAt = 0;

  function close(): void {
    if (!open) return;
    open = false;
    onclose?.();
  }

  function select(item: MenuItem): void {
    if (item.disabled) return;
    close();
    onselect?.(item.id, item);
  }

  /** Puts the popover below the anchor, or above it if there is more room, and inside the window. */
  function place(element: HTMLElement): void {
    const area = element.parentElement!.getBoundingClientRect();
    const box =
      anchor instanceof Element
        ? anchor.getBoundingClientRect()
        : { left: anchor?.x ?? 0, right: anchor?.x ?? 0, top: anchor?.y ?? 0, bottom: anchor?.y ?? 0 };
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const roomBelow = area.bottom - box.bottom - EDGE - GAP;
    const roomAbove = box.top - area.top - EDGE - GAP;
    const below = height <= roomBelow || roomBelow >= roomAbove;
    const x = align === 'end' ? box.right - width : box.left;
    const y = below ? box.bottom + GAP : box.top - GAP - height;
    const left = Math.max(area.left + EDGE, Math.min(x, area.right - width - EDGE));
    const top = Math.max(area.top + EDGE, Math.min(y, area.bottom - height - EDGE));
    element.style.left = `${Math.round(left - area.left)}px`;
    element.style.top = `${Math.round(top - area.top)}px`;
    // The popover grows from the corner that is at the anchor.
    element.style.transformOrigin = `${align === 'end' ? 'right' : 'left'} ${below ? 'top' : 'bottom'}`;
  }

  function buttons(): HTMLElement[] {
    return menu ? [...menu.querySelectorAll<HTMLElement>('[data-item]')] : [];
  }

  $effect(() => {
    if (!open || !menu) return;
    if (!sheet) place(menu);
    // A long list of options starts with the chosen one in view. The scroll area is the popover
    // itself, or the body of the bottom sheet.
    const checked = menu.querySelector<HTMLElement>('[aria-checked="true"]');
    const area = sheet ? menu.parentElement : menu;
    if (!checked || !area) return;
    const top = checked.offsetTop - (sheet ? area.offsetTop : 0);
    if (top + checked.offsetHeight > area.clientHeight) area.scrollTop = top - (area.clientHeight - checked.offsetHeight) / 2;
  });

  // The popover is an overlay of its own. The bottom sheet brings its overlay with it.
  $effect(() => {
    if (!open || sheet || !menu) return;
    const element = menu;
    const overlay = pushOverlay({ close, element: () => element });
    // The position is from the time of the open. After a change of the window it is not correct.
    window.addEventListener('resize', close);
    return () => {
      overlay.remove();
      window.removeEventListener('resize', close);
    };
  });

  // A person who opened the menu with a key continues with the keys: the focus goes to an item.
  // This effect is after the overlay effects, which put the focus on the menu.
  $effect(() => {
    if (!open || !menu || !keyboardUsed()) return;
    const all = buttons();
    (all.find((button) => button.getAttribute('aria-checked') === 'true') ?? all[0])?.focus();
  });

  function onkeydown(event: KeyboardEvent): void {
    const all = buttons();
    const current = all.indexOf(document.activeElement as HTMLElement);
    const last = all.length - 1;
    let next = -1;
    if (event.key === 'ArrowDown') next = current >= last ? 0 : current + 1;
    else if (event.key === 'ArrowUp') next = current <= 0 ? last : current - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Typed letters go to the next item that starts with them.
      typed = event.timeStamp - typedAt > 600 ? event.key : typed + event.key;
      typedAt = event.timeStamp;
      const text = typed.toLowerCase();
      const start = typed.length === 1 ? current + 1 : Math.max(current, 0);
      for (let k = 0; k < items.length; k++) {
        const i = (start + k) % items.length;
        if (items[i]!.label.toLowerCase().startsWith(text)) {
          next = i;
          break;
        }
      }
      if (next < 0) return;
    } else return;
    event.preventDefault();
    all[next]?.focus();
  }
</script>

{#snippet list()}
  {#each items as item (item.id)}
    {#if item.separatorBefore}<div class="separator" role="separator"></div>{/if}
    {#if item.sectionLabel}<div class="section" role="presentation">{item.sectionLabel}</div>{/if}
    <button
      class={['item ui-state', { danger: item.danger }]}
      type="button"
      role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={item.checked}
      aria-disabled={item.disabled ? true : undefined}
      tabindex="-1"
      data-item={item.id}
      onclick={() => select(item)}
    >
      {#if lead}
        <span class="lead">
          {#if item.checked}
            <span class="mark"><Icon name="check" size={20} /></span>
          {:else if item.icon}
            <Icon name={item.icon} size={20} />
          {/if}
        </span>
      {/if}
      <span class="text">
        <span class="label">{item.label}</span>
        {#if item.hint}<span class="hint">{item.hint}</span>{/if}
      </span>
    </button>
  {/each}
{/snippet}

{#if sheet}
  <BottomSheet {open} onclose={close} {title} label={title ?? label ?? 'Menu'} padded={false}>
    <div class="menu in-sheet" role="menu" aria-label={label ?? title} tabindex="-1" data-autofocus {onkeydown} bind:this={menu}>{@render list()}</div>
  </BottomSheet>
{:else if open}
  <div class="ui-layer" use:portal>
    <div
      class="backdrop"
      role="presentation"
      out:release
      onpointerdown={close}
      oncontextmenu={(event) => {
        event.preventDefault();
        close();
      }}
    ></div>
    <div class="menu popover" role="menu" aria-label={label ?? title} tabindex="-1" bind:this={menu} {onkeydown} transition:pop|global={{ duration: 130, scale: 0.9 }}>
      {@render list()}
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
  }
  .menu {
    color: var(--text);
    outline: none;
  }
  .popover {
    position: absolute;
    left: 0;
    top: 0;
    min-width: 200px;
    max-width: min(320px, calc(100% - 16px));
    max-height: calc(100% - 16px);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 8px 0;
    border-radius: var(--radius-md);
    background: var(--popup);
    box-shadow: var(--shadow-2);
  }
  .in-sheet {
    padding-bottom: 8px;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 36px;
    padding: 6px 20px 6px 14px;
    color: inherit;
    font-size: 14px;
    line-height: 20px;
    text-align: left;
  }
  .in-sheet .item {
    gap: 16px;
    min-height: 52px;
    padding: 8px 24px 8px 20px;
    font-size: 16px;
    line-height: 22px;
  }
  /* The veil of the state layer shows the focus. A ring would touch the edges of the menu. */
  .item:focus-visible {
    outline: none;
  }
  .lead {
    display: grid;
    flex: none;
    place-items: center;
    width: 20px;
    height: 20px;
    color: var(--text-dim);
  }
  .mark {
    color: var(--primary);
  }
  .text {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .label,
  .hint {
    display: block;
  }
  .hint {
    color: var(--text-dim);
    font-size: 12px;
    line-height: 16px;
  }
  .in-sheet .hint {
    font-size: 13px;
    line-height: 18px;
  }
  .danger,
  .danger .lead {
    color: var(--danger);
  }
  .item[aria-disabled='true'],
  .item[aria-disabled='true'] .lead,
  .item[aria-disabled='true'] .mark {
    color: var(--text-off);
  }
  .item[aria-disabled='true'] .hint {
    color: var(--text-dim);
  }
  /* A disabled item has no hover veil, but a person with a keyboard must see where the focus is. */
  .item[aria-disabled='true']:focus-visible::after {
    opacity: 0.1;
  }
  .separator {
    height: 1px;
    margin: 8px 0;
    background: var(--divider);
  }
  .section {
    padding: 8px 16px 4px;
    color: var(--text-dim);
    font-size: 12px;
    font-weight: 500;
    line-height: 16px;
  }
  .in-sheet .section {
    padding: 8px 20px 4px;
    font-size: 13px;
  }
</style>
