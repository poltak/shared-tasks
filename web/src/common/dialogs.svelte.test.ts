import { afterEach, describe, expect, it } from 'vitest';
import { askMakeTasks, cancelDialogs, confirmDialog, dialogs, pickDate, pickDeadline, pickNoteColor, promptText } from './dialogs.svelte.ts';

afterEach(() => {
  cancelDialogs();
});

describe('dialog requests', () => {
  it('stays open until the host gives the result', async () => {
    const value = { date: '2026-10-09', time: null, repeat: null };
    const result = pickDate({ value, allowRepeat: false });
    expect(dialogs.open).toHaveLength(1);
    const request = dialogs.open[0]!;
    expect(request).toMatchObject({ kind: 'date', input: { value, allowRepeat: false } });
    if (request.kind !== 'date') throw new Error('wrong kind');
    request.settle({ date: '2026-10-10', time: '09:00', repeat: null });
    expect(dialogs.open).toHaveLength(0);
    expect(await result).toEqual({ date: '2026-10-10', time: '09:00', repeat: null });
  });

  it('ignores a second result for the same dialog', async () => {
    const result = promptText({ title: 'Create new list' });
    const request = dialogs.open[0]!;
    if (request.kind !== 'prompt') throw new Error('wrong kind');
    request.settle('Home');
    request.settle(null);
    expect(await result).toBe('Home');
  });

  it('keeps more than one dialog, the oldest first, with an id of its own', async () => {
    const first = confirmDialog({ title: 'First?' });
    const second = pickDeadline({ value: null });
    expect(dialogs.open.map((request) => request.kind)).toEqual(['confirm', 'deadline']);
    expect(new Set(dialogs.open.map((request) => request.id)).size).toBe(2);
    const [a, b] = dialogs.open;
    if (a?.kind !== 'confirm' || b?.kind !== 'deadline') throw new Error('wrong kind');
    b.settle({ deadline: '2026-10-20' });
    expect(dialogs.open.map((request) => request.kind)).toEqual(['confirm']);
    a.settle(true);
    expect(await first).toBe(true);
    expect(await second).toEqual({ deadline: '2026-10-20' });
  });

  it('cancelDialogs answers each open dialog as a cancel', async () => {
    const results = [
      confirmDialog({ title: 'Sure?' }),
      promptText({ title: 'Name' }),
      pickDate({ value: { date: null, time: null, repeat: null } }),
      pickDeadline({ value: null }),
      askMakeTasks({ id: 'n1' }),
      pickNoteColor({ id: 'n1' }),
    ];
    cancelDialogs();
    expect(dialogs.open).toHaveLength(0);
    expect(await Promise.all(results)).toEqual([false, null, null, null, null, undefined]);
  });

  it('opens the color picker of a note at its anchor, and ends when the picker closes', async () => {
    const anchor = { x: 4, y: 8 };
    let ended = false;
    const result = pickNoteColor({ id: 'n1', anchor }).then(() => (ended = true));
    const request = dialogs.open[0]!;
    expect(request).toMatchObject({ kind: 'noteColor', input: { id: 'n1', anchor } });
    if (request.kind !== 'noteColor') throw new Error('wrong kind');
    await Promise.resolve();
    expect(ended).toBe(false);
    request.settle(null);
    await result;
    expect(ended).toBe(true);
  });

  it('gives the choice of the "Make tasks" dialog', async () => {
    const result = askMakeTasks({ id: 'n1' });
    const request = dialogs.open[0]!;
    if (request.kind !== 'makeTasks') throw new Error('wrong kind');
    request.settle({ listId: 'l1', mode: 'lines', archive: true });
    expect(await result).toEqual({ listId: 'l1', mode: 'lines', archive: true });
  });
});
