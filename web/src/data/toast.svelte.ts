import type { Env } from './env.ts';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  /** A new number for each message, so the screen can start its animation again. */
  id: number;
  message: string;
  /** true: the message is for the last action, and `undo()` takes that action back. */
  undoable: boolean;
  /** A button of the caller, for example "Reload" for a new version. */
  action: ToastAction | null;
}

export interface ToastInput {
  message: string;
  undoable?: boolean;
  action?: ToastAction | null;
  /** Milliseconds on the screen. 0: the message stays until it is dismissed or replaced. */
  duration?: number;
}

export interface ToastStore {
  readonly current: Toast | null;
  show(input: ToastInput): void;
  dismiss(): void;
}

const SHOW_MS = 6000;

/** The snackbar: one message at a time. A new message replaces the old one. */
export function createToast(env: Pick<Env, 'setTimeout' | 'clearTimeout'>): ToastStore {
  let current = $state.raw<Toast | null>(null);
  let serial = 0;
  let timer: unknown = null;

  function dismiss(): void {
    env.clearTimeout(timer);
    timer = null;
    current = null;
  }

  return {
    get current() {
      return current;
    },
    show({ message, undoable = false, action = null, duration = SHOW_MS }) {
      env.clearTimeout(timer);
      current = { id: ++serial, message, undoable, action };
      timer = duration > 0 ? env.setTimeout(dismiss, duration) : null;
    },
    dismiss,
  };
}
