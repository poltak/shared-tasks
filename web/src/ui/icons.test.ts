import { describe, expect, it } from 'vitest';
import { FILLED_ICONS, ICON_NAMES, ICONS } from './icons.ts';

describe('icons', () => {
  it('has each icon that the screens use', () => {
    const wanted = [
      'check', 'check-small', 'circle', 'plus', 'add-task', 'star', 'star-filled', 'more', 'close', 'back', 'menu',
      'chevron-up', 'chevron-down', 'chevron-left', 'chevron-right', 'caret', 'clock', 'repeat', 'target', 'notes',
      'bin', 'drag', 'people', 'person', 'sort', 'list', 'list-add', 'print', 'settings', 'bell', 'cloud-off', 'sync',
      'calendar', 'indent', 'unindent', 'arrow-up', 'keyboard', 'help', 'logout', 'moon', 'sun', 'bulb', 'pin',
      'pin-filled', 'archive', 'unarchive', 'palette', 'search', 'color-off',
    ];
    for (const name of wanted) expect(ICON_NAMES, name).toContain(name);
  });

  it('gives each icon a path that starts with a move and has only path commands and numbers', () => {
    for (const name of ICON_NAMES) {
      expect(ICONS[name], name).toMatch(/^M[\d.\s\-a-zA-Z]+$/);
      expect(ICONS[name], name).not.toMatch(/NaN|undefined|e-\d/);
    }
  });

  it('keeps each icon on the 24 px grid', () => {
    // The first point of each part of a path is an absolute position.
    for (const name of ICON_NAMES) {
      for (const [, x, y] of ICONS[name].matchAll(/M(-?[\d.]+)[\s,]*(-?[\d.]+)/g)) {
        expect(+x!, name).toBeGreaterThanOrEqual(0);
        expect(+x!, name).toBeLessThanOrEqual(24);
        expect(+y!, name).toBeGreaterThanOrEqual(0);
        expect(+y!, name).toBeLessThanOrEqual(24);
      }
    }
  });

  it('marks only icons that are there as filled', () => {
    for (const name of FILLED_ICONS) expect(ICON_NAMES).toContain(name);
  });

  it('draws a filled icon with the same shape as its outline', () => {
    // A pinned note and a set star look like the outline icon, but filled.
    expect(FILLED_ICONS.has('pin-filled')).toBe(true);
    expect(FILLED_ICONS.has('pin')).toBe(false);
    expect(ICONS['pin-filled']).toBe(ICONS.pin);
    expect(ICONS['star-filled']).toBe(ICONS.star);
  });
});
