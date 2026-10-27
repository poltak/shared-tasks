<script lang="ts">
  import type { Snippet } from 'svelte';
  import IconButton from './IconButton.svelte';
  import { layout } from './layout.svelte.ts';
  import { fade, pop, slide } from './motion.ts';
  import { portal, pushOverlay } from './overlay.svelte.ts';

  interface Props {
    open?: boolean;
    /** Called one time for each close: Esc, Back, a press outside, the Back button of a full screen. */
    onclose?: () => void;
    title?: string;
    /** The accessible name, if there is no title. */
    label?: string;
    /** The largest width of the card in px. */
    width?: number;
    /** On a phone the dialog fills the screen and has a bar with a Back button at the top. */
    fullscreen?: boolean;
    /** false: a press outside does not close the dialog. */
    dismissable?: boolean;
    /** false: the content has no padding. */
    padded?: boolean;
    children: Snippet;
    /** The buttons at the bottom, in a row at the right. */
    actions?: Snippet;
    /** Full screen only: controls at the right of the top bar. */
    headerActions?: Snippet;
    /** Full screen only: content of the top bar in place of the title, for example a list selector. */
    heading?: Snippet;
  }
  let {
    open = $bindable(false),
    onclose,
    title,
    label,
    width = 360,
    fullscreen = false,
    dismissable = true,
    padded = true,
    children,
    actions,
    headerActions,
    heading,
  }: Props = $props();

  const full = $derived(fullscreen && layout.phone);
  let card = $state<HTMLElement>();

  function close(): void {
    if (!open) return;
    open = false;
    onclose?.();
  }

  $effect(() => {
    if (!open || !card) return;
    const element = card;
    return pushOverlay({ close, element: () => element }).remove;
  });
</script>

{#if open}
  <div class={['ui-layer layer', { full }]} use:portal>
    {#if full}
      <div
        class="screen"
        role="dialog"
        aria-modal="true"
        aria-label={label ?? title}
        tabindex="-1"
        bind:this={card}
        in:slide|global
        out:slide|global={{ duration: 180 }}
      >
        <header class="bar">
          <IconButton icon="back" label="Back" onclick={close} />
          {#if heading}
            <div class="bar-heading">{@render heading()}</div>
          {:else}
            <h2 class="bar-title">{title}</h2>
          {/if}
          {#if headerActions}{@render headerActions()}{/if}
        </header>
        <div class={['body', { padded }]}>{@render children()}</div>
        {#if actions}<footer class="actions">{@render actions()}</footer>{/if}
      </div>
    {:else}
      <div class="ui-scrim" role="presentation" transition:fade|global={{ duration: 180 }} onclick={() => dismissable && close()}></div>
      <div
        class="card"
        role="dialog"
        aria-modal="true"
        aria-label={label ?? title}
        tabindex="-1"
        style:--width="{width}px"
        bind:this={card}
        in:pop|global={{ y: 8 }}
        out:pop|global={{ duration: 120, scale: 0.97 }}
      >
        {#if title}<h2 class="title">{title}</h2>{/if}
        <div class={['body', { padded, top: !title, bare: !title && !actions && !padded }]}>{@render children()}</div>
        {#if actions}<footer class="actions">{@render actions()}</footer>{/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .layer {
    display: grid;
    /* A track with a fixed size, so the card cannot be higher than the free part of the window. */
    grid-template: minmax(0, 1fr) / minmax(0, 1fr);
    place-items: center;
    padding: 16px;
  }
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    width: min(100%, var(--width));
    max-height: 100%;
    border-radius: var(--radius-popup);
    background: var(--popup);
    box-shadow: var(--shadow-3);
    color: var(--text);
    /* The card has the focus when the dialog opens. A ring around the full card tells nothing. */
    outline: none;
  }
  .title {
    flex: none;
    padding: 20px 24px 12px;
    font-size: 18px;
    font-weight: 500;
    line-height: 24px;
  }
  .body {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .padded {
    padding: 0 24px 8px;
  }
  .padded.top {
    padding-top: 20px;
  }
  /* A content with no title, no buttons, and no padding fills the card, and it can paint its own
     background: the note editor has the color of the note. The scroll area then has the round
     corners of the card. */
  .bare {
    border-radius: inherit;
  }
  .actions {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
    padding: 8px 12px 12px;
  }

  .full {
    padding: 0;
  }
  .screen {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
    background: var(--bg);
    color: var(--text);
    outline: none;
  }
  .bar {
    display: flex;
    flex: none;
    align-items: center;
    gap: 4px;
    height: 56px;
    padding: 0 8px;
  }
  .bar-heading {
    display: flex;
    flex: 1;
    align-items: center;
    min-width: 0;
  }
  .bar-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    padding: 0 8px;
    font-size: 18px;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .screen .body {
    flex: 1;
  }
  .screen .padded {
    padding: 8px 16px 16px;
  }
</style>
