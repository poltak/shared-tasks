import { describe, expect, it } from 'vitest';
import type { Op, Put } from '../../../shared/types.ts';
import { createOutbox } from './outbox.ts';

const task = (id: string, fields: Put['fields']): Put => ({ kind: 'task', id, fields }) as Put;
const list = (id: string, fields: Put['fields']): Put => ({ kind: 'list', id, fields }) as Put;

/** Adds puts with the timestamps t01, t02, ... and the op ids op1, op2, ... */
function filled(puts: Put[]) {
  const outbox = createOutbox();
  let n = 0;
  const add = (put: Put): Op => {
    n += 1;
    return outbox.add({ put, ts: `t${String(n).padStart(2, '0')}`, opId: `op${n}` });
  };
  puts.forEach(add);
  return { outbox, add };
}

describe('merge of puts', () => {
  it('merges puts on the same row into one op with the newest timestamp', () => {
    const { outbox } = filled([task('a', { title: 'one', notes: 'n' }), task('a', { title: 'two' }), task('a', { due: '2026-10-07' })]);
    expect(outbox.all()).toEqual([
      { kind: 'task', id: 'a', fields: { title: 'two', notes: 'n', due: '2026-10-07' }, opId: 'op1', ts: 't03' },
    ]);
    expect(outbox.size).toBe(1);
  });

  it('keeps the place of the first put, so the put that makes a row stays first', () => {
    const { outbox } = filled([task('a', { title: 'a', listId: 'l' }), task('b', { title: 'b', listId: 'l' }), task('a', { starred: true })]);
    expect(outbox.all().map((op) => [op.id, op.ts])).toEqual([
      ['a', 't03'],
      ['b', 't02'],
    ]);
  });

  it('does not merge a list and a task with the same id', () => {
    const { outbox } = filled([task('x', { title: 't' }), list('x', { title: 'l' })]);
    expect(outbox.all().map((op) => op.kind)).toEqual(['task', 'list']);
  });

  it('gives the op that holds the put', () => {
    const { outbox, add } = filled([task('a', { title: 'one' })]);
    const op = add(task('a', { notes: 'two' }));
    expect(op).toEqual({ kind: 'task', id: 'a', fields: { title: 'one', notes: 'two' }, opId: 'op1', ts: 't02' });
    expect(outbox.all()[0]).toBe(op);
  });

  it('does not change an op object, so a request in flight keeps its content', () => {
    const { outbox, add } = filled([task('a', { title: 'one' })]);
    const first = outbox.all()[0]!;
    add(task('a', { title: 'two' }));
    expect(first.fields).toEqual({ title: 'one' });
    expect(first.ts).toBe('t01');
  });
});

describe('ops in a request', () => {
  it('makes a new op for a put on a row whose op is frozen', () => {
    const { outbox, add } = filled([task('a', { title: 'one' }), task('b', { title: 'b' })]);
    outbox.freeze(outbox.all());
    add(task('a', { title: 'two' }));
    add(task('a', { notes: 'n' }));
    expect(outbox.all()).toEqual([
      { kind: 'task', id: 'a', fields: { title: 'one' }, opId: 'op1', ts: 't01' },
      { kind: 'task', id: 'b', fields: { title: 'b' }, opId: 'op2', ts: 't02' },
      { kind: 'task', id: 'a', fields: { title: 'two', notes: 'n' }, opId: 'op3', ts: 't04' },
    ]);
  });

  it('removes the ops of an answer and keeps the ops that came in the flight', () => {
    const { outbox, add } = filled([task('a', { title: 'one' }), task('b', { title: 'b' })]);
    outbox.freeze(outbox.all());
    add(task('a', { title: 'two' }));
    expect(outbox.remove(['op1', 'op2', 'not-there'])).toEqual(['op1', 'op2']);
    expect(outbox.all().map((op) => op.opId)).toEqual(['op3']);
    // The op that is left is open: the next put merges into it.
    add(task('a', { notes: 'n' }));
    expect(outbox.all()).toEqual([{ kind: 'task', id: 'a', fields: { title: 'two', notes: 'n' }, opId: 'op3', ts: 't04' }]);
  });

  it('sends an op again that the answer did not name', () => {
    const { outbox, add } = filled([task('a', { title: 'one' }), task('b', { title: 'b' })]);
    outbox.freeze(outbox.all());
    outbox.remove(['op1']);
    add(task('b', { notes: 'n' }));
    expect(outbox.all()).toEqual([{ kind: 'task', id: 'b', fields: { title: 'b', notes: 'n' }, opId: 'op2', ts: 't03' }]);
  });

  it('after a request with no answer, merges into the newest op of the row and keeps the order', () => {
    const { outbox, add } = filled([task('a', { title: 'one', listId: 'l' })]);
    outbox.freeze(outbox.all());
    add(task('a', { title: 'two' }));
    outbox.release();
    add(task('a', { notes: 'n' }));
    expect(outbox.all()).toEqual([
      { kind: 'task', id: 'a', fields: { title: 'one', listId: 'l' }, opId: 'op1', ts: 't01' },
      { kind: 'task', id: 'a', fields: { title: 'two', notes: 'n' }, opId: 'op2', ts: 't03' },
    ]);
  });

  it('after a request with no answer, an op with no newer op of its row is open again', () => {
    const { outbox, add } = filled([task('a', { title: 'one' })]);
    outbox.freeze(outbox.all());
    outbox.release();
    add(task('a', { notes: 'n' }));
    expect(outbox.all()).toEqual([{ kind: 'task', id: 'a', fields: { title: 'one', notes: 'n' }, opId: 'op1', ts: 't02' }]);
  });

  it('freezes only the ops of the request', () => {
    const { outbox, add } = filled([task('a', { title: 'a' }), task('b', { title: 'b' })]);
    outbox.freeze([outbox.all()[0]!]);
    add(task('b', { notes: 'n' }));
    add(task('a', { notes: 'n' }));
    expect(outbox.all().map((op) => [op.opId, op.id, Object.keys(op.fields)])).toEqual([
      ['op1', 'a', ['title']],
      ['op2', 'b', ['title', 'notes']],
      ['op4', 'a', ['notes']],
    ]);
  });
});

describe('ops from the local database', () => {
  it('puts the ops in the order of their timestamps and merges into them', () => {
    const { outbox, add } = filled([]);
    outbox.load([
      { kind: 'task', id: 'a', fields: { notes: 'later' }, opId: 'x2', ts: 's2' },
      { kind: 'list', id: 'l', fields: { title: 'L' }, opId: 'x3', ts: 's3' },
      { kind: 'task', id: 'a', fields: { title: 'first', listId: 'l' }, opId: 'x1', ts: 's1' },
    ]);
    expect(outbox.all().map((op) => op.opId)).toEqual(['x1', 'x2', 'x3']);
    add(task('a', { starred: true }));
    expect(outbox.all().map((op) => [op.opId, Object.keys(op.fields)])).toEqual([
      ['x1', ['title', 'listId']],
      ['x2', ['notes', 'starred']],
      ['x3', ['title']],
    ]);
  });

  it('replaces the content', () => {
    const { outbox } = filled([task('a', { title: 'a' })]);
    outbox.freeze(outbox.all());
    outbox.load([]);
    expect(outbox.size).toBe(0);
    expect(outbox.all()).toEqual([]);
  });
});
