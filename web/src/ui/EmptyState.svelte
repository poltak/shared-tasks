<script lang="ts">
  interface Props {
    /** 'empty': a list with no tasks yet. 'done': all tasks are completed. */
    kind?: 'empty' | 'done';
    title: string;
    text?: string;
  }
  let { kind = 'empty', title, text }: Props = $props();
</script>

<div class="empty">
  {#if kind === 'empty'}
    <!-- A sheet of paper with three open tasks, and a plus sign that asks for the first one. -->
    <svg viewBox="0 0 200 140" width="200" height="140" aria-hidden="true">
      <ellipse class="blob" cx="100" cy="76" rx="84" ry="54" />
      <circle class="dot" cx="34" cy="38" r="4" />
      <circle class="dot soft" cx="170" cy="32" r="6" />
      <circle class="dot soft" cx="24" cy="104" r="3" />
      <g transform="rotate(-5 100 72)">
        <rect class="paper" x="56" y="18" width="88" height="108" rx="12" />
        <circle class="ring" cx="74" cy="46" r="6.5" />
        <rect class="line" x="88" y="42" width="42" height="8" rx="4" />
        <circle class="ring" cx="74" cy="72" r="6.5" />
        <rect class="line" x="88" y="68" width="32" height="8" rx="4" />
        <circle class="ring" cx="74" cy="98" r="6.5" />
        <rect class="line" x="88" y="94" width="38" height="8" rx="4" />
      </g>
      <circle class="badge" cx="146" cy="104" r="19" />
      <path class="on-badge" d="M146 95v18M137 104h18" />
    </svg>
  {:else}
    <!-- The same sheet with all tasks done, a large check mark, and small stars. -->
    <svg viewBox="0 0 200 140" width="200" height="140" aria-hidden="true">
      <ellipse class="blob" cx="100" cy="76" rx="84" ry="54" />
      <g transform="rotate(4 100 72)">
        <rect class="paper" x="50" y="18" width="88" height="108" rx="12" />
        <circle class="done" cx="68" cy="46" r="7" />
        <path class="tick" d="M64.6 46.2l2.4 2.4 4.4-4.9" />
        <rect class="line faint" x="82" y="42" width="42" height="8" rx="4" />
        <circle class="done" cx="68" cy="72" r="7" />
        <path class="tick" d="M64.6 72.2l2.4 2.4 4.4-4.9" />
        <rect class="line faint" x="82" y="68" width="32" height="8" rx="4" />
        <circle class="done" cx="68" cy="98" r="7" />
        <path class="tick" d="M64.6 98.2l2.4 2.4 4.4-4.9" />
        <rect class="line faint" x="82" y="94" width="38" height="8" rx="4" />
      </g>
      <circle class="badge" cx="146" cy="96" r="24" />
      <path class="on-badge wide" d="M135 96.5l7.5 7.5 14-15" />
      <path class="spark" d="M162 30c1 6 3 8 9 9-6 1-8 3-9 9-1-6-3-8-9-9 6-1 8-3 9-9z" />
      <path class="spark small" d="M34 44c.7 4 2 5.3 6 6-4 .7-5.3 2-6 6-.7-4-2-5.3-6-6 4-.7 5.3-2 6-6z" />
      <circle class="dot" cx="178" cy="64" r="3" />
      <circle class="dot soft" cx="28" cy="100" r="4" />
    </svg>
  {/if}
  <p class="title">{title}</p>
  {#if text}<p class="text">{text}</p>{/if}
</div>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 24px 24px 32px;
    text-align: center;
  }
  svg {
    max-width: 100%;
    height: auto;
    margin-bottom: 12px;
  }
  .title {
    color: var(--text);
    font-size: 16px;
    font-weight: 500;
    line-height: 24px;
  }
  .text {
    max-width: 260px;
    margin-top: 2px;
    color: var(--text-dim);
    font-size: 14px;
    line-height: 20px;
  }

  .blob {
    fill: var(--primary-container);
    opacity: 0.55;
  }
  .paper {
    fill: var(--surface);
    stroke: var(--outline);
    stroke-width: 1.5;
  }
  .ring {
    fill: none;
    stroke: var(--text-dim);
    stroke-width: 2;
  }
  .line {
    fill: var(--surface-3);
  }
  .line.faint {
    opacity: 0.7;
  }
  .done,
  .badge {
    fill: var(--primary);
  }
  .tick,
  .on-badge {
    fill: none;
    stroke: var(--on-primary);
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .tick {
    stroke-width: 2;
  }
  .on-badge {
    stroke-width: 3.5;
  }
  .on-badge.wide {
    stroke-width: 4.5;
  }
  .dot,
  .spark {
    fill: var(--primary);
  }
  .soft {
    opacity: 0.4;
  }
  .spark.small {
    opacity: 0.6;
  }
</style>
