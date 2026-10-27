// The note colors of tokens.css against the rule of SPEC section 8: --text and --note-text-dim
// have a contrast of at least 4.5:1 on each note color, in the light theme and in the two blocks
// of the dark theme.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOTE_COLORS } from '../../../shared/types.ts';

const css = readFileSync(path.join(import.meta.dirname, 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

type Vars = Record<string, string>;

/** The custom properties of the first rule block that starts with the selector. */
function block(selector: string): Vars {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no block ${selector}`);
  const end = css.indexOf('}', start);
  const vars: Vars = {};
  for (const [, name, value] of css.slice(start, end).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[name!] = value!.trim();
  return vars;
}

const light = block(':root');
const themes: Record<string, Vars> = {
  light,
  // A dark block lists only what differs. The other values come from :root.
  'dark (system)': { ...light, ...block(":root:not([data-theme='light'])") },
  'dark (forced)': { ...light, ...block(":root[data-theme='dark']") },
};

type Rgba = [number, number, number, number];

function color(vars: Vars, value: string, depth = 0): Rgba {
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  if (ref) {
    if (depth > 5 || vars[ref[1]!] === undefined) throw new Error(`cannot read ${value}`);
    return color(vars, vars[ref[1]!]!, depth + 1);
  }
  const hex = /^#([\da-f]{6})$/i.exec(value);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)).concat(1) as Rgba;
  const rgb = /^rgb\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/.exec(value);
  if (rgb) return [+rgb[1]!, +rgb[2]!, +rgb[3]!, rgb[4] === undefined ? 1 : +rgb[4]];
  throw new Error(`unknown color ${value}`);
}

/** A transparent color as it shows on the background. */
function over(top: Rgba, below: Rgba): Rgba {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i]! * a + below[i]! * (1 - a)).concat(1) as Rgba;
}

function luminance([r, g, b]: Rgba): number {
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(text: Rgba, background: Rgba): number {
  const [high, low] = [luminance(over(text, background)), luminance(background)].sort((a, b) => b - a);
  return (high! + 0.05) / (low! + 0.05);
}

describe('note colors', () => {
  for (const [theme, vars] of Object.entries(themes)) {
    it(`gives --text and --note-text-dim a contrast of 4.5:1 on each note color (${theme})`, () => {
      for (const name of NOTE_COLORS) {
        const background = color(vars, `var(--note-${name})`);
        expect(background[3], name).toBe(1);
        for (const text of ['--text', '--note-text-dim']) {
          expect(contrast(color(vars, `var(${text})`), background), `${text} on ${name}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }

  it('has each note color in the light block and in both dark blocks, with the same dark values', () => {
    const names = [...NOTE_COLORS.map((name) => `--note-${name}`), '--note-text-dim', '--note-edge'];
    const system = block(":root:not([data-theme='light'])");
    const forced = block(":root[data-theme='dark']");
    for (const name of names) {
      expect(light[name], name).toBeDefined();
      expect(system[name], name).toBeDefined();
      expect(system[name], name).toBe(forced[name]);
    }
    expect(light['--note-default']).toBe('var(--surface)');
  });

  it('gives a dark value that differs from the light value', () => {
    const dark = themes['dark (forced)']!;
    for (const name of NOTE_COLORS.filter((each) => each !== 'default')) {
      expect(dark[`--note-${name}`], name).not.toBe(light[`--note-${name}`]);
    }
  });
});
