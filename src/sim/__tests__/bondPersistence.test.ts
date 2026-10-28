import { describe, expect, it } from 'vitest';
import { createBondWriter, pairKey, recordBond } from '../bonds.ts';
import type { BondMap, PairRow, RecordBondDeps } from '../bonds.ts';

/**
 * H4 / SPEC R7.1 — "atomic-ish": if one side fails to persist, the in-memory bond still reflects
 * reality and the write is retried on the next write. `persist` is a stand-in for the database: it
 * keeps the row each pair currently holds, and a script decides which calls reject. Nothing here
 * touches a real database or `simulation.ts`.
 */

const A = { id: 'a-0000', name: 'Alder' };
const B = { id: 'b-0000', name: 'Bramble' };
const C = { id: 'c-0000', name: 'Cedar' };

/** A fake `relationships` table; `failing` lists the 1-based persist calls that reject. */
function fakeDb(failing: number[] = []) {
  const table = new Map<string, PairRow>();
  const calls: PairRow[] = [];
  const persist = async (row: PairRow) => {
    calls.push(row);
    if (failing.includes(calls.length)) throw new Error(`write ${calls.length} failed`);
    table.set(pairKey(row), row); // an upsert: the row for the pair is replaced
  };
  return { table, calls, persist };
}

function setup(failing: number[] = []) {
  const db = fakeDb(failing);
  const rels = new Map<string, BondMap>();
  const writer = createBondWriter(db.persist);
  const deps: RecordBondDeps = {
    relsOf: (id) => {
      let m = rels.get(id);
      if (!m) rels.set(id, (m = new Map()));
      return m;
    },
    writer,
    sessionId: 'era-1',
    nowIso: () => 'T',
  };
  const strength = (who: { id: string }, withName: string) => deps.relsOf(who.id).get(withName)?.strength;
  const stored = (x: { id: string }, y: { id: string }) => db.table.get(pairKey({ a_id: [x.id, y.id].sort()[0], b_id: [x.id, y.id].sort()[1] }))?.strength;
  return { db, deps, writer, strength, stored };
}

describe('H4 / R7.1 — one side fails to persist', () => {
  it('H4: the first side\'s write rejects, the second succeeds: both in-memory bonds are right and the database holds the latest strength', async () => {
    const s = setup([1]); // Alder's side fails once
    await recordBond(s.deps, A, B, 1, 'hello');
    expect(s.strength(A, 'Bramble')).toBe(1);
    expect(s.strength(B, 'Alder')).toBe(1);
    expect(s.db.calls).toHaveLength(2);
    expect(s.stored(A, B)).toBe(1);
    expect(s.writer.dirty()).toEqual([]); // the next write (Bramble's side) retried and cleared it
  });

  it('H4: in-memory bonds on BOTH sides are already correct while the write is failing', async () => {
    const s = setup([1, 2]); // both sides fail
    await recordBond(s.deps, A, B, 2, { a: 'gave wood', b: 'received wood' });
    expect(s.strength(A, 'Bramble')).toBe(2);
    expect(s.strength(B, 'Alder')).toBe(2);
    expect(s.deps.relsOf(A.id).get('Bramble')!.lastMessage).toBe('gave wood');
    expect(s.deps.relsOf(B.id).get('Alder')!.lastMessage).toBe('received wood');
    expect(s.stored(A, B)).toBeUndefined(); // nothing reached the database yet
    expect(s.writer.dirty()).toEqual([pairKey({ a_id: A.id, b_id: B.id })]);
  });

  it('H4: the next successful write persists the LATEST strength, not the stale one that failed', async () => {
    const s = setup([1, 2]);
    await recordBond(s.deps, A, B, 1, 'first'); // strength 1, both writes fail
    await recordBond(s.deps, A, B, 2, 'second'); // strength 3
    const retried = s.db.calls.slice(2).map((r) => r.strength);
    expect(retried).not.toContain(1); // the stale row was never written
    expect(s.stored(A, B)).toBe(3);
    expect(s.strength(A, 'Bramble')).toBe(3);
    expect(s.strength(B, 'Alder')).toBe(3);
  });

  it('H4: nothing stays dirty afterwards', async () => {
    const s = setup([1, 2]);
    await recordBond(s.deps, A, B, 1, 'first');
    expect(s.writer.dirty()).toHaveLength(1);
    await recordBond(s.deps, A, B, 1, 'second');
    expect(s.writer.dirty()).toEqual([]);
    await recordBond(s.deps, A, B, 1, 'third');
    expect(s.writer.dirty()).toEqual([]);
    expect(s.db.calls.length).toBe(6); // failed, failed, then one write per side each time: no endless retries
  });

  it('H4: a failure is retried on the next bond write of ANY pair, not only the same one', async () => {
    const s = setup([1, 2]);
    await recordBond(s.deps, A, B, 1, 'a to b'); // the Alder-Bramble pair is dirty at strength 1
    expect(s.stored(A, B)).toBeUndefined();
    await recordBond(s.deps, B, C, 2, 'b to c'); // a different pair writes
    expect(s.stored(A, B)).toBe(1); // flushed by that write
    expect(s.stored(B, C)).toBe(2);
    expect(s.writer.dirty()).toEqual([]);
  });

  it('H4: while the database stays down the retries keep failing quietly, the bonds keep growing in memory, and the first success writes the latest', async () => {
    const s = setup([1, 2, 3, 4, 5, 6]);
    for (let i = 0; i < 3; i++) await recordBond(s.deps, A, B, 1, `m${i}`); // 3 exchanges, 6 writes (+ retries) all failing
    expect(s.strength(A, 'Bramble')).toBe(3);
    expect(s.strength(B, 'Alder')).toBe(3);
    expect(s.writer.dirty()).toHaveLength(1);
    expect(s.stored(A, B)).toBeUndefined();
    await recordBond(s.deps, A, B, 2, 'back up'); // strength 5; the database is reachable again
    expect(s.stored(A, B)).toBe(5);
    expect(s.writer.dirty()).toEqual([]);
  });

  it('H4: a failing write never throws into the turn that caused it', async () => {
    const s = setup([1, 2]);
    await expect(recordBond(s.deps, A, B, 1, 'hello')).resolves.toBeUndefined();
    const sync = createBondWriter(() => {
      throw new Error('synchronous failure');
    });
    await expect(sync.write({ a_id: 'x', b_id: 'y', strength: 1, session_id: null })).resolves.toBeUndefined();
    expect(sync.dirty()).toEqual(['x|y']);
  });

  it('H4: a newer row for the pair written while an older one is in flight is not lost', async () => {
    const written: PairRow[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const writer = createBondWriter(async (row) => {
      if (first) {
        first = false;
        await gate; // the first write hangs, then succeeds
      }
      written.push(row);
    });
    const row = (strength: number): PairRow => ({ a_id: 'x', b_id: 'y', strength, session_id: null });
    const slow = writer.write(row(1));
    const fast = writer.write(row(2)); // arrives while the first is still in flight
    release();
    await Promise.all([slow, fast]);
    expect(written[written.length - 1]?.strength).toBe(2); // the latest strength is what the database ends with
    expect(writer.dirty()).toEqual([]);
  });

  it('H4: clear() forgets pending retries (a new era starts from its own bonds)', async () => {
    const s = setup([1, 2]);
    await recordBond(s.deps, A, B, 1, 'x');
    expect(s.writer.dirty()).toHaveLength(1);
    s.writer.clear();
    expect(s.writer.dirty()).toEqual([]);
  });
});

describe('H4 — the happy path is unchanged', () => {
  it('H4: with a healthy database each exchange is exactly two upserts (one per side), in the order actor then target', async () => {
    const s = setup();
    await recordBond(s.deps, A, B, 1, 'hello');
    expect(s.db.calls).toHaveLength(2);
    expect(s.db.calls.every((r) => r.a_id === A.id && r.b_id === B.id && r.strength === 1 && r.session_id === 'era-1')).toBe(true);
    expect(s.writer.dirty()).toEqual([]);
  });

  it('H4: simulation.ts persists bonds through the writer with the existing upsert on (a_id, b_id)', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../simulation.ts', import.meta.url), 'utf8');
    expect(source).toContain('createBondWriter((row) => this.persistBond(row), browserBondStore())'); // the store argument was added by the durable retry set (bondStore.test.ts)
    expect(source).toMatch(/from\('relationships'\)\.upsert\(row, \{ onConflict: 'a_id,b_id' \}\)/);
    expect(source.match(/from\('relationships'\)\s*\.(upsert|update|insert)/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });
});
