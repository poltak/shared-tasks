import { describe, expect, it } from 'vitest';
import { SHORTCUTS } from './shortcuts.ts';

const text = (keys: readonly (readonly string[])[], joiner: string): string => keys.map((combo) => combo.join('+')).join(` ${joiner} `);

describe('SHORTCUTS', () => {
  it('has the rows of the SPEC table in order', () => {
    expect(SHORTCUTS.map((shortcut) => [shortcut.action, text(shortcut.keys, shortcut.joiner)])).toEqual([
      ['Edit the selected task', 'Enter'],
      ['Add a task below, while in a title', 'Enter'],
      ['Finish editing', 'Esc'],
      ['Mark complete', 'Space'],
      ['Indent, remove indent', 'Ctrl+] and Ctrl+['],
      ['Add a subtask', 'Ctrl+Alt+Enter'],
      ['Open the task menu', '. or v'],
      ['Move up, move down', 'Ctrl+↑ and Ctrl+↓'],
      ['Move to top, move to bottom', 'Ctrl+Shift+↑ and Ctrl+Shift+↓'],
      ['Star', 's'],
      ['Delete', 'Delete or Backspace'],
      ['Select first, select last', 'Home and End'],
      ['New task in the selected list', 'n'],
      ['Print the list', 'Ctrl+P'],
      ['Show the shortcut list', '? or Ctrl+/'],
      ['Undo', 'Ctrl+Z'],
    ]);
  });

  it('uses Command for Ctrl, Option for Alt, and the Shift sign on a Mac', () => {
    const mac = Object.fromEntries(SHORTCUTS.map((shortcut) => [shortcut.action, text(shortcut.macKeys, shortcut.joiner)]));
    expect(mac['Add a subtask']).toBe('⌘+⌥+Enter');
    expect(mac['Move to top, move to bottom']).toBe('⌘+⇧+↑ and ⌘+⇧+↓');
    expect(mac['Delete']).toBe('Delete or Backspace');
    for (const shortcut of SHORTCUTS) {
      expect(shortcut.macKeys).toHaveLength(shortcut.keys.length);
      expect(shortcut.macKeys.flat().some((key) => key === 'Ctrl' || key === 'Alt' || key === 'Shift')).toBe(false);
    }
  });
});
