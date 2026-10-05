import type { HLC, ID, Op, Put } from '../../../shared/types.ts';

/**
 * The changes that the server does not have yet, from the oldest to the newest.
 *
 * Puts on the same row merge into one op while that op is not sent. An op that is in a request is
 * frozen: the server answers for exactly the fields that it got, so a later put makes a new op.
 */
export interface Outbox {
  readonly size: number;
  all(): Op[];
  /** Replaces the content with the ops that the local database had. */
  load(ops: readonly Op[]): void;
  /** Gives the op that holds the put now: the open op of the row with the new fields, or a new op. */
  add(input: { put: Put; ts: HLC; opId: ID }): Op;
  /** The ops go into a request. */
  freeze(ops: readonly Op[]): void;
  /** The request got no answer. All ops can merge again. */
  release(): void;
  /** The server answered for these ops. Gives the ids that were in the outbox. */
  remove(opIds: Iterable<ID>): ID[];
}

const rowKey = (put: Put): string => `${put.kind}:${put.id}`;

export function createOutbox(): Outbox {
  // A Map keeps the order of the first insert, and a merged op keeps its place: the put that
  // makes a row stays before each later op on that row.
  const ops = new Map<ID, Op>();
  const frozen = new Set<ID>();
  /** The newest op of each row, if a put can merge into it. */
  const open = new Map<string, ID>();

  function reindex(): void {
    open.clear();
    for (const op of ops.values()) {
      if (frozen.has(op.opId)) open.delete(rowKey(op));
      else open.set(rowKey(op), op.opId);
    }
  }

  return {
    get size() {
      return ops.size;
    },

    all: () => [...ops.values()],

    load(saved) {
      ops.clear();
      frozen.clear();
      // A merge gives an op the newest timestamp, so this order has the first op of a row first.
      for (const op of [...saved].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))) ops.set(op.opId, op);
      reindex();
    },

    add({ put, ts, opId }) {
      const key = rowKey(put);
      const last = ops.get(open.get(key) ?? '');
      const op = (last ? { ...last, fields: { ...last.fields, ...put.fields }, ts } : { ...put, opId, ts }) as Op;
      ops.set(op.opId, op);
      open.set(key, op.opId);
      return op;
    },

    freeze(sent) {
      for (const op of sent) {
        frozen.add(op.opId);
        if (open.get(rowKey(op)) === op.opId) open.delete(rowKey(op));
      }
    },

    release() {
      frozen.clear();
      reindex();
    },

    remove(opIds) {
      const removed: ID[] = [];
      for (const id of opIds) if (ops.delete(id)) removed.push(id);
      // An op that the answer did not name goes into the next request.
      frozen.clear();
      reindex();
      return removed;
    },
  };
}
