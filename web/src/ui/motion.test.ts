import { describe, expect, it } from 'vitest';
import { fade, pop, rise, slide } from './motion.ts';

// The transitions do not use the element, so a plain object can stand for it.
const node = {} as Element;

describe('motion', () => {
  it('uses only opacity and transform', () => {
    for (const config of [fade(node), pop(node), rise(node), slide(node)]) {
      for (const t of [0, 0.5, 1]) {
        const names = config.css!(t, 1 - t).split(';').map((part) => part.split(':')[0]);
        for (const name of names) expect(['opacity', 'transform']).toContain(name);
      }
    }
  });

  it('keeps the durations between 120 ms and 220 ms', () => {
    for (const config of [fade(node), pop(node), rise(node), slide(node)]) {
      expect(config.duration).toBeGreaterThanOrEqual(120);
      expect(config.duration).toBeLessThanOrEqual(220);
    }
  });

  it('ends at rest', () => {
    expect(fade(node).css!(1, 0)).toBe('opacity:1');
    expect(fade(node, { to: 0.4 }).css!(1, 0)).toBe('opacity:0.4');
    expect(pop(node, { y: 8 }).css!(1, 0)).toBe('opacity:1;transform:translateY(0px) scale(1)');
    expect(slide(node).css!(1, 0)).toBe('opacity:1;transform:translateX(0%)');
  });

  it('starts the exit of a sheet from the place where the finger left it', () => {
    // t goes from 1 to 0 on the way out. At the start the sheet is 120 px down, at the end fully out.
    expect(rise(node, { from: 120 }).css!(1, 0)).toBe('transform:translateY(calc(120px + 0 * (100% - 120px)))');
    expect(rise(node, { from: 120 }).css!(0, 1)).toBe('transform:translateY(calc(120px + 1 * (100% - 120px)))');
  });
});
