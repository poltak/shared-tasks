// Pickers and dialogs that any code can open with one call. Each call gives a promise.
// DialogHost.svelte, which the shell mounts one time, renders what is open.

import type { DateStr } from '../../../shared/types.ts';
import type { DateValue } from '../ui/index.ts';

export interface PickDateInput {
  value: DateValue;
  /** false: no "Set time". Default true. */
  allowTime?: boolean;
  /** false: no "Repeat". Default true. A subtask cannot repeat. */
  allowRepeat?: boolean;
  title?: string;
}

export interface PickDeadlineInput {
  value: DateStr | null;
  title?: string;
}

export interface DeadlineResult {
  deadline: DateStr | null;
}

export interface PromptTextInput {
  title: string;
  /** The text in the field at the start. */
  value?: string;
  /** Default 'Enter name'. */
  placeholder?: string;
  /** Default 'Done'. */
  confirmLabel?: string;
  maxlength?: number;
}

export interface ConfirmInput {
  title: string;
  message?: string;
  /** Default 'OK'. */
  confirmLabel?: string;
  /** Default 'Cancel'. */
  cancelLabel?: string;
  /** The confirm button is red, and the focus starts on "Cancel". */
  danger?: boolean;
}

interface Base<Kind extends string, Input, Result> {
  id: number;
  kind: Kind;
  input: Input;
  /** Closes the dialog and gives the result to the caller. A second call does nothing. */
  settle: (result: Result) => void;
}

export type DialogRequest =
  | Base<'date', PickDateInput, DateValue | null>
  | Base<'deadline', PickDeadlineInput, DeadlineResult | null>
  | Base<'prompt', PromptTextInput, string | null>
  | Base<'confirm', ConfirmInput, boolean>;

let open = $state.raw<readonly DialogRequest[]>([]);
let serial = 0;

/** For DialogHost: the open dialogs, the oldest first. */
export const dialogs = {
  get open(): readonly DialogRequest[] {
    return open;
  },
};

function ask<Kind extends DialogRequest['kind'], Result>(kind: Kind, input: unknown): Promise<Result> {
  return new Promise<Result>((resolve) => {
    const id = ++serial;
    const settle = (result: Result): void => {
      if (!open.some((request) => request.id === id)) return;
      open = open.filter((request) => request.id !== id);
      resolve(result);
    };
    open = [...open, { id, kind, input, settle } as unknown as DialogRequest];
  });
}

/** The date picker. Gives the new values, or null when the person cancels. `date` is never null in the result. */
export function pickDate(input: PickDateInput): Promise<DateValue | null> {
  return ask('date', input);
}

/** The deadline picker. Gives null when the person cancels. */
export function pickDeadline(input: PickDeadlineInput): Promise<DeadlineResult | null> {
  return ask('deadline', input);
}

/** One line of text. Gives the text with no spaces at its ends (never empty), or null when the person cancels. */
export function promptText(input: PromptTextInput): Promise<string | null> {
  return ask('prompt', input);
}

/** A question with two buttons. Gives true only for the confirm button. */
export function confirmDialog(input: ConfirmInput): Promise<boolean> {
  return ask('confirm', input);
}

/** Closes each open dialog as if the person cancelled it. For a sign-out. */
export function cancelDialogs(): void {
  for (const request of open) {
    if (request.kind === 'confirm') request.settle(false);
    else request.settle(null);
  }
}
