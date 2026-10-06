import { afterEach, describe, expect, it } from 'vitest';
import { cancelDialogs, confirmDialog, dialogs, pickDate, pickDeadline, promptText } from './dialogs.svelte.ts';

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
    const results = [confirmDialog({ title: 'Sure?' }), promptText({ title: 'Name' }), pickDate({ value: { date: null, time: null, repeat: null } }), pickDeadline({ value: null })];
    cancelDialogs();
    expect(dialogs.open).toHaveLength(0);
    expect(await Promise.all(results)).toEqual([false, null, null, null]);
  });
});
