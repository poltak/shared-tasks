<script lang="ts">
  // The empty states of the notes grid, in the style of web/src/ui/EmptyState.svelte: a soft
  // blob, a sheet in the card color, and a round badge in the primary color.
  interface Props {
    /** 'notes': no notes yet. 'archive': no archived notes. 'search': no note matches. */
    kind: 'notes' | 'archive' | 'search';
    title: string;
    text?: string;
  }
  let { kind, title, text }: Props = $props();
</script>

<div class="empty">
  {#if kind === 'notes'}
    <!-- A note with lines of text, and a light bulb for the idea that goes on it. -->
    <svg viewBox="0 0 200 140" width="200" height="140" aria-hidden="true">
      <ellipse class="blob" cx="100" cy="76" rx="84" ry="54" />
      <circle class="dot" cx="30" cy="40" r="4" />
      <circle class="dot soft" cx="176" cy="104" r="5" />
      <circle class="dot soft" cx="22" cy="100" r="3" />
      <g transform="rotate(-6 70 78)">
        <rect class="paper" x="34" y="34" width="72" height="90" rx="12" />
        <rect class="line strong" x="46" y="48" width="38" height="8" rx="4" />
        <rect class="line" x="46" y="66" width="48" height="6" rx="3" />
        <rect class="line" x="46" y="80" width="40" height="6" rx="3" />
        <rect class="line" x="46" y="94" width="28" height="6" rx="3" />
      </g>
      <g transform="translate(142 32)">
        <path class="ray" d="M0 -12v-6M-25 -2l-4.5-4.5M25 -2l4.5-4.5M33 22h6" />
        <path class="badge" d="M0 -4a26 26 0 0 0-15.3 47c2.7 2 4.3 4.9 4.3 8.2v1.8h22v-1.8c0-3.3 1.6-6.2 4.3-8.2A26 26 0 0 0 0 -4z" />
        <path class="on-badge" d="M-11 20a11 11 0 0 1 11-11" />
        <rect class="base" x="-11" y="57" width="22" height="7" rx="3.5" />
        <rect class="base" x="-7" y="67" width="14" height="6" rx="3" />
      </g>
    </svg>
  {:else if kind === 'archive'}
    <!-- A box with its lid open and a note that goes into it. -->
    <svg viewBox="0 0 200 140" width="200" height="140" aria-hidden="true">
      <ellipse class="blob" cx="100" cy="76" rx="84" ry="54" />
      <circle class="dot" cx="172" cy="36" r="4" />
      <circle class="dot soft" cx="28" cy="44" r="5" />
      <circle class="dot soft" cx="178" cy="98" r="3" />
      <g transform="rotate(8 100 46)">
        <rect class="paper" x="74" y="14" width="52" height="62" rx="9" />
        <rect class="line strong" x="83" y="25" width="26" height="6" rx="3" />
        <rect class="line" x="83" y="38" width="32" height="5" rx="2.5" />
        <rect class="line" x="83" y="49" width="22" height="5" rx="2.5" />
      </g>
      <rect class="box" x="48" y="66" width="104" height="58" rx="10" />
      <rect class="lid" x="40" y="54" width="120" height="22" rx="8" />
      <rect class="slot" x="84" y="84" width="32" height="8" rx="4" />
      <circle class="badge" cx="150" cy="108" r="17" />
      <path class="on-badge" d="M150 100v15M144 109.5l6 6 6-6" />
    </svg>
  {:else}
    <!-- A note and a magnifier that finds nothing on it. -->
    <svg viewBox="0 0 200 140" width="200" height="140" aria-hidden="true">
      <ellipse class="blob" cx="100" cy="76" rx="84" ry="54" />
      <circle class="dot" cx="166" cy="34" r="4" />
      <circle class="dot soft" cx="30" cy="102" r="5" />
      <g transform="rotate(-4 88 76)">
        <rect class="paper" x="46" y="26" width="84" height="100" rx="12" />
        <rect class="line strong" x="58" y="40" width="44" height="8" rx="4" />
        <rect class="line" x="58" y="58" width="56" height="6" rx="3" />
        <rect class="line" x="58" y="72" width="48" height="6" rx="3" />
        <rect class="line" x="58" y="86" width="36" height="6" rx="3" />
      </g>
      <circle class="lens" cx="132" cy="84" r="22" />
      <path class="handle" d="M148 100l16 16" />
      <path class="on-lens" d="M125 77l14 14M139 77l-14 14" />
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
    padding: 32px 24px 40px;
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
    max-width: 280px;
    margin-top: 2px;
    color: var(--text-dim);
    font-size: 14px;
    line-height: 20px;
  }

  .blob {
    fill: var(--primary-container);
    opacity: 0.55;
  }
  .paper,
  .box {
    fill: var(--surface);
    stroke: var(--outline);
    stroke-width: 1.5;
  }
  .lid {
    fill: var(--surface-2);
    stroke: var(--outline);
    stroke-width: 1.5;
  }
  .slot {
    fill: var(--surface-3);
  }
  .line {
    fill: var(--surface-3);
  }
  .line.strong {
    fill: var(--outline);
  }
  .badge {
    fill: var(--primary);
  }
  .base {
    fill: var(--text-dim);
  }
  .on-badge {
    fill: none;
    stroke: var(--on-primary);
    stroke-width: 3.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .ray {
    fill: none;
    stroke: var(--primary);
    stroke-width: 3.5;
    stroke-linecap: round;
    opacity: 0.6;
  }
  .lens {
    fill: color-mix(in srgb, var(--surface) 70%, transparent);
    stroke: var(--primary);
    stroke-width: 6;
  }
  .handle {
    fill: none;
    stroke: var(--primary);
    stroke-width: 9;
    stroke-linecap: round;
  }
  .on-lens {
    fill: none;
    stroke: var(--text-dim);
    stroke-width: 3.5;
    stroke-linecap: round;
  }
  .dot {
    fill: var(--primary);
  }
  .soft {
    opacity: 0.4;
  }
</style>
