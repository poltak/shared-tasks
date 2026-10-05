<script lang="ts">
  import type { Snippet } from 'svelte';
  import { fade, rise } from './motion.ts';
  import { portal, pushOverlay } from './overlay.svelte.ts';

  interface Props {
    open?: boolean;
    /** Called one time for each close: Esc, Back, a press outside, a drag down. */
    onclose?: () => void;
    /** A heading at the top of the sheet. */
    title?: string;
    /** The accessible name, if there is no title. */
    label?: string;
    /** false: no bar at the top, and no drag down to close. */
    handle?: boolean;
    /** false: a press outside does not close the sheet. */
    dismissable?: boolean;
    /** false: the content has no padding at the sides. */
    padded?: boolean;
    children: Snippet;
  }
  let { open = $bindable(false), onclose, title, label, handle = true, dismissable = true, padded = true, children }: Props = $props();

  let sheet = $state<HTMLElement>();
  let scrim = $state<HTMLElement>();
  /** How far the finger moved the sheet down, in px. The exit transition starts from there. */
  const drag = { offset: 0 };

  function close(): void {
    if (!open) return;
    open = false;
    onclose?.();
  }

  $effect(() => {
    if (!open || !sheet) return;
    const element = sheet;
    drag.offset = 0;
    const overlay = pushOverlay({ close, element: () => element });
    const stopDrag = handle ? dragToClose(element) : undefined;
    return () => {
      overlay.remove();
      stopDrag?.();
    };
  });

  /** A drag is a touch that starts on the sheet with its content at the top, or a mouse on the bar. */
  function dragToClose(element: HTMLElement): () => void {
    let startY = 0;
    let startX = 0;
    let lastY = 0;
    let lastTime = 0;
    let speed = 0;
    /** 'wait': the direction is not known yet. 'no': this touch scrolls the content. */
    let state: 'idle' | 'wait' | 'drag' | 'no' = 'idle';

    const begin = (at: { clientX: number; clientY: number }, time: number): void => {
      startX = at.clientX;
      startY = lastY = at.clientY;
      lastTime = time;
      speed = 0;
    };
    const move = (y: number, time: number): void => {
      // A movement up has no effect: the sheet does not leave the bottom edge.
      const offset = (drag.offset = Math.max(0, y - startY));
      if (time > lastTime) speed = (y - lastY) / (time - lastTime);
      lastY = y;
      lastTime = time;
      element.style.transition = 'none';
      element.style.transform = `translateY(${offset}px)`;
      if (scrim) scrim.style.opacity = String(1 - Math.min(1, offset / element.offsetHeight) * 0.7);
    };
    const end = (time: number): void => {
      state = 'idle';
      const offset = drag.offset;
      const far = offset > Math.min(140, element.offsetHeight * 0.35);
      // A finger that stopped before it left the screen did not throw the sheet.
      const thrown = time - lastTime < 80 && speed > 0.5;
      if (far || (offset > 12 && thrown)) {
        close();
        return;
      }
      drag.offset = 0;
      element.style.transition = 'transform var(--dur) var(--ease)';
      element.style.transform = '';
      if (scrim) scrim.style.opacity = '';
    };

    const onTouchStart = (event: TouchEvent): void => {
      const touch = event.touches[0]!;
      state = event.touches.length > 1 ? 'no' : 'wait';
      // Content that is not at its top scrolls first.
      for (let node = event.target as HTMLElement | null; node && node !== element; node = node.parentElement) {
        if (node.scrollTop > 0) state = 'no';
      }
      begin(touch, event.timeStamp);
    };
    const onTouchMove = (event: TouchEvent): void => {
      if (state === 'idle' || state === 'no') return;
      const touch = event.touches[0]!;
      if (state === 'wait') {
        const dy = touch.clientY - startY;
        // The browser asks one time. The answer must come with the first movement, before a scroll starts.
        state = dy > 0 && dy > Math.abs(touch.clientX - startX) ? 'drag' : 'no';
        if (state === 'no') return;
        // The movement counts from here, so the sheet does not jump.
        begin(touch, event.timeStamp);
      }
      if (event.cancelable) event.preventDefault();
      move(touch.clientY, event.timeStamp);
    };
    const onTouchEnd = (event: TouchEvent): void => {
      if (state === 'drag') end(event.timeStamp);
      else state = 'idle';
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (event.pointerType === 'touch' || event.button !== 0) return;
      if (!(event.target instanceof Element) || !event.target.closest('[data-sheet-grab]')) return;
      element.setPointerCapture(event.pointerId);
      state = 'drag';
      begin(event, event.timeStamp);
      event.preventDefault();
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (state === 'drag' && event.pointerType !== 'touch') move(event.clientY, event.timeStamp);
    };
    const onPointerUp = (event: PointerEvent): void => {
      if (state === 'drag' && event.pointerType !== 'touch') end(event.timeStamp);
    };

    const stop = new AbortController();
    const signal = stop.signal;
    element.addEventListener('touchstart', onTouchStart, { signal, passive: true });
    // Not passive: the handler stops the scroll of the browser when the touch is a drag of the sheet.
    element.addEventListener('touchmove', onTouchMove, { signal, passive: false });
    element.addEventListener('touchend', onTouchEnd, { signal });
    element.addEventListener('touchcancel', onTouchEnd, { signal });
    element.addEventListener('pointerdown', onPointerDown, { signal });
    element.addEventListener('pointermove', onPointerMove, { signal });
    element.addEventListener('pointerup', onPointerUp, { signal });
    element.addEventListener('pointercancel', onPointerUp, { signal });
    return () => stop.abort();
  }
</script>

{#if open}
  <div class="ui-layer" use:portal>
    <div
      class="ui-scrim"
      role="presentation"
      bind:this={scrim}
      in:fade|global={{ duration: 180 }}
      out:fade|global={{ duration: 180, to: 1 - Math.min(1, drag.offset / (sheet?.offsetHeight || 1)) * 0.7 }}
      onclick={() => dismissable && close()}
    ></div>
    <div
      class="sheet"
      role="dialog"
      aria-modal="true"
      aria-label={label ?? title}
      tabindex="-1"
      bind:this={sheet}
      in:rise|global
      out:rise|global={{ duration: 180, from: drag.offset }}
    >
      {#if handle}<div class="grab" data-sheet-grab><span class="bar"></span></div>{/if}
      {#if title}<h2 class="title" data-sheet-grab>{title}</h2>{/if}
      <div class={['body', { padded, bare: !handle && !title }]}>
        {@render children()}
      </div>
    </div>
  </div>
{/if}

<style>
  .sheet {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    max-width: 640px;
    max-height: calc(100% - max(24px, env(safe-area-inset-top)));
    margin: 0 auto;
    padding-bottom: env(safe-area-inset-bottom);
    border-radius: var(--radius-popup) var(--radius-popup) 0 0;
    background: var(--popup);
    box-shadow: var(--shadow-3);
    color: var(--text);
    outline: none;
    will-change: transform;
  }
  /* The color of the sheet goes on below its edge. When the keyboard closes, the window grows
     before the sheet moves, and the page must not show below the sheet. */
  .sheet::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 100%;
    height: 40px;
    background: inherit;
  }
  .grab {
    display: grid;
    flex: none;
    place-items: center;
    height: 22px;
    cursor: grab;
    touch-action: none;
  }
  .bar {
    width: 32px;
    height: 4px;
    border-radius: 2px;
    background: var(--outline);
  }
  .title {
    flex: none;
    padding: 6px 20px 10px;
    font-size: 16px;
    font-weight: 500;
    line-height: 24px;
    touch-action: none;
  }
  .body {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }
  .padded {
    padding: 0 16px 8px;
  }
  .bare {
    padding-top: 16px;
  }
</style>
