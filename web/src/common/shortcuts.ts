// The keyboard shortcuts of the wide layout (SPEC.md section 8), as data for the help dialog.
// The rows and their order are the rows of the two SPEC tables: the tasks, then the notes.

/** One key press: the keys that go down together, for example ['Ctrl', 'Shift', '↑']. */
export type KeyCombo = readonly string[];

export interface Shortcut {
  action: string;
  /** One combo for each part of the action ("Indent, remove indent"), or the keys that do the same ("Delete or Backspace"). */
  keys: readonly KeyCombo[];
  /** The same on a Mac: Command replaces Ctrl, and Option replaces Alt. */
  macKeys: readonly KeyCombo[];
  /** The word between the combos. */
  joiner: 'or' | 'and';
}

const MAC_NAMES: Readonly<Record<string, string>> = { Ctrl: '⌘', Alt: '⌥', Shift: '⇧' };

function row(action: string, keys: readonly KeyCombo[], joiner: 'or' | 'and' = 'or'): Shortcut {
  return { action, keys, macKeys: keys.map((combo) => combo.map((key) => MAC_NAMES[key] ?? key)), joiner };
}

export const SHORTCUTS: readonly Shortcut[] = [
  row('Edit the selected task', [['Enter']]),
  row('Add a task below, while in a title', [['Enter']]),
  row('Finish editing', [['Esc']]),
  row('Mark complete', [['Space']]),
  row('Indent, remove indent', [['Ctrl', ']'], ['Ctrl', '[']], 'and'),
  row('Add a subtask', [['Ctrl', 'Alt', 'Enter']]),
  row('Open the task menu', [['.'], ['v']]),
  row('Move up, move down', [['Ctrl', '↑'], ['Ctrl', '↓']], 'and'),
  row('Move to top, move to bottom', [['Ctrl', 'Shift', '↑'], ['Ctrl', 'Shift', '↓']], 'and'),
  row('Star', [['s']]),
  row('Delete', [['Delete'], ['Backspace']]),
  row('Select first, select last', [['Home'], ['End']], 'and'),
  row('New task in the selected list', [['n']]),
  row('Print the list', [['Ctrl', 'P']]),
  row('Show the shortcut list', [['?'], ['Ctrl', '/']]),
  row('Undo', [['Ctrl', 'Z']]),
];

/** The keys of the Notes view and of the Archive view. The help dialog shows them below the heading "Notes". */
export const NOTE_SHORTCUTS: readonly Shortcut[] = [
  row('New note', [['n'], ['c']]),
  row('Search the notes', [['/']]),
  row('Close the composer or the editor', [['Esc']]),
];

/** true on a Mac, an iPhone, or an iPad: the keyboard has Command and Option. */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** The combos of a shortcut for this device. */
export function shortcutKeys(shortcut: Shortcut): readonly KeyCombo[] {
  return isMac() ? shortcut.macKeys : shortcut.keys;
}

/** true if the main modifier of this device is down: Command on a Mac, Ctrl on other devices. */
export function hasMod(event: KeyboardEvent | MouseEvent): boolean {
  return isMac() ? event.metaKey : event.ctrlKey;
}
