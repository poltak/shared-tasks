<script lang="ts">
  interface Props {
    checked?: boolean;
    /** The accessible name. */
    label: string;
    disabled?: boolean;
    onchange?: (checked: boolean) => void;
  }
  let { checked = $bindable(false), label, disabled = false, onchange }: Props = $props();
</script>

<label class={['switch', { disabled }]}>
  <input type="checkbox" role="switch" aria-label={label} bind:checked {disabled} onchange={() => onchange?.(checked)} />
  <span class="track"><span class="thumb"></span></span>
</label>

<style>
  .switch {
    position: relative;
    display: inline-flex;
    flex: none;
    width: 44px;
    height: 26px;
    cursor: pointer;
  }
  input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: inherit;
  }
  .track {
    position: relative;
    width: 100%;
    height: 100%;
    border: 1.5px solid var(--outline);
    border-radius: var(--radius-pill);
    background: var(--surface-3);
    pointer-events: none;
  }
  /* The "on" color is a layer that fades in. A change of the background color would paint each frame. */
  .track::before {
    content: '';
    position: absolute;
    inset: -1.5px;
    border-radius: inherit;
    background: var(--primary);
    opacity: 0;
    transition: opacity var(--dur-fast) linear;
  }
  .thumb {
    position: absolute;
    left: 2.5px;
    top: 2.5px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--text-dim);
    transform: scale(0.72);
    transition: transform var(--dur) var(--ease);
  }
  /* The thumb changes its color with the same trick as the track. */
  .thumb::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: var(--on-primary);
    opacity: 0;
    transition: opacity var(--dur-fast) linear;
  }
  input:checked + .track::before,
  input:checked + .track .thumb::before {
    opacity: 1;
  }
  input:checked + .track .thumb {
    transform: translateX(18px);
  }
  input:focus-visible + .track {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }
  .disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
