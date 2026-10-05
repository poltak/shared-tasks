// Types that more than one part uses. They are in a .ts file so that `tsc` can read them: it
// knows only the default export of a .svelte file.

import type { DateStr, RepeatRule, TimeStr } from '../../../shared/types.ts';
import type { IconName } from './icons.ts';

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName;
  /** true shows a check mark. If one item of a menu has a value here, all items get the space for the mark. */
  checked?: boolean;
  /** The item shows and can get the focus, but a press does nothing. */
  disabled?: boolean;
  /** A second line below the label, for example the reason why the item is disabled. */
  hint?: string;
  danger?: boolean;
  /** A line above the item. */
  separatorBefore?: boolean;
  /** A small heading above the item. */
  sectionLabel?: string;
}

/** An element, or a point of the window (the position of a right click). */
export type MenuAnchor = Element | { x: number; y: number };

export interface SelectOption<T extends string | number = string> {
  value: T;
  label: string;
  icon?: IconName;
}

/** The value of the date picker. */
export interface DateValue {
  date: DateStr | null;
  time: TimeStr | null;
  repeat: RepeatRule | null;
}

/** The result of the repeat dialog. */
export interface RepeatResult {
  rule: RepeatRule;
  time: TimeStr | null;
}
