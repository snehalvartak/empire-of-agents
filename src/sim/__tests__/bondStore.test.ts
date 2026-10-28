import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { DIRTY_BONDS_KEY, MAX_STORED_CHARS, browserBondStore, createBondStore, parseDirtyBonds, serializeDirtyBonds } from '../bondStore.ts';
import type { StorageLike } from '../bondStore.ts';
import { BondWriteError, MAX_DIRTY_ROWS, createBondWriter, isPermanentBondError, pairKey, preferBond, raiseBond, raiseBondsFromRows, recordBond, recoveryFor, sanitizePairRow } from '../bonds.ts';
import type { BondMap, BondStore, PairRow, RecordBondDeps } from '../bonds.ts';

/**
 * H4 / SPEC R7.1 across a page reload: the bond writer's dirty set is kept in a store (localStorage in
 * the browser) so a failed `relationships` write is still retried after the page is reloaded. Everything
 * here is pure: the database is a fake table, the browser storage a fake `Storage`, and "a reload" is a
 * NEW writer (and new in-memory bonds) built from the same store. Nothing imports Supabase.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ERA = uuid(900);
const A = { id: uuid(1), name: 'Alder' };
const B = { id: uuid(2), name: 'Bramble' };
const C = { id: uuid(3), name: 'Cedar' };
const row = (a: number, b: number, strength: number, extra: Partial<PairRow> = {}): PairRow => ({ a_id: uuid(a), b_id: uuid(b), strength, session_id: ERA, ...extra });
const keyOf = (a: number, b: number) => pairKey({ a_id: uuid(a), b_id: uuid(b) });

/** A fake Storage; `broken` makes the named calls throw like a full or disabled one. */
function fakeStorage(broken: Array<'get' | 'set' | 'remove'> = []) {
  const data = new Map<string, string>();
  const calls = { set: 0, remove: 0 };
  const storage: StorageLike = {
    getItem(k) {
      if (broken.includes('get')) throw new Error('SecurityError');
      return data.get(k) ?? null;
    },
    setItem(k, v) {
      calls.set++;
      if (broken.includes('set')) throw new Error('QuotaExceededError');
      data.set(k, v);
    },
    removeItem(k) {
      calls.remove++;
      if (broken.includes('remove')) throw new Error('SecurityError');
      data.delete(k);
    },
  };
  return { storage, data, calls };
}

/** A fake `relationships` table; `script` decides per call whether it rejects (with what), by 1-based call number. */
function fakeDb(script: (call: number, row: PairRow) => unknown = () => undefined) {
  const table = new Map<string, PairRow>();
  const calls: PairRow[] = [];
  const persist = async (r: PairRow) => {
    calls.push(r);
    const failure = script(calls.length, r);
    if (failure) throw failure;
    table.set(pairKey(r), r);
  };
  return { table, calls, persist };
}
const down = () => new BondWriteError('Failed to fetch', '', 0);

/** One page load: fresh in-memory bonds and a writer seeded from the store, like a new `Simulation`. */
function pageLoad(db: ReturnType<typeof fakeDb>, store: BondStore) {
  const rels = new Map<string, BondMap>();
  const writer = createBondWriter(db.persist, store);
  const deps: RecordBondDeps = {
    relsOf: (id) => {
      let m = rels.get(id);
      if (!m) rels.set(id, (m = new Map()));
      return m;
    },
    writer,
    sessionId: ERA,
    nowIso: () => '2026-10-27T12:00:00.000Z',
  };
  return { rels, writer, deps, strength: (who: { id: string }, withName: string) => deps.relsOf(who.id).get(withName)?.strength };
}

describe('H4 durable — row validation', () => {
  it('accepts exactly what pairRowFor produces and copies only the PairRow fields', () => {
    const r = sanitizePairRow({ ...row(1, 2, 5, { last_chat_at: '2026-10-27T12:00:00.000Z' }), extra: 'x', name: 'Alder' });
    expect(r).toEqual({ ...row(1, 2, 5), last_chat_at: '2026-10-27T12:00:00.000Z' });
    expect(sanitizePairRow(row(1, 2, 0, { session_id: null }))).toEqual(row(1, 2, 0, { session_id: null }));
  });

  it('rejects anything malformed', () => {
    const bad: unknown[] = [
      null, 'x', 7, [], {},
      { ...row(1, 2, 1), a_id: 'a-0000' }, { ...row(1, 2, 1), b_id: 5 }, { ...row(1, 2, 1), a_id: `${uuid(1)}'; drop table agents;--` },
      { ...row(1, 1, 1) },
      { ...row(1, 2, -1) }, { ...row(1, 2, 1.5) }, { ...row(1, 2, Number.NaN) }, { ...row(1, 2, Infinity) }, { ...row(1, 2, 2147483648) }, { ...row(1, 2, 1), strength: '3' },
      { ...row(1, 2, 1), session_id: 'era-1' }, { ...row(1, 2, 1), session_id: 4 },
      { ...row(1, 2, 1), last_chat_at: 'not a date' }, { ...row(1, 2, 1), last_chat_at: 5 }, { ...row(1, 2, 1), last_chat_at: `2026-10-27T12:00:00.000Z${' '.repeat(100)}` },
    ];
    for (const b of bad) expect(sanitizePairRow(b), JSON.stringify(b)).toBeNull();
  });
});

describe('H4 durable — parsing what a previous page stored', () => {
  it('round trips rows through the stored text', () => {
    const rows = [row(1, 2, 3), row(2, 3, 9, { last_chat_at: '2026-10-27T12:00:00.000Z' }), row(1, 3, 0, { session_id: null })];
    expect(parseDirtyBonds(serializeDirtyBonds(rows))).toEqual(rows);
    expect(JSON.parse(serializeDirtyBonds(rows))).toEqual({ v: 1, rows });
  });

  it('corrupt, foreign, oversized or empty content reads as nothing and never throws', () => {
    const garbage: Array<string | null | undefined> = [
      null, undefined, '', '{', 'null', '[]', '42', '"x"', 'true', '{}', '{"v":2,"rows":[]}', '{"v":1}', '{"v":1,"rows":"x"}', '{"v":1,"rows":{"a":1}}',
      '\u0000￿', '{"v":1,"rows":[1,null,"x",[],{}]}', 'x'.repeat(MAX_STORED_CHARS + 1),
      JSON.stringify({ v: 1, rows: [row(1, 2, 1)], pad: 'x'.repeat(MAX_STORED_CHARS) }),
    ];
    for (const g of garbage) expect(parseDirtyBonds(g), String(g).slice(0, 40)).toEqual([]);
  });

  it('drops only the malformed rows and keeps the good ones', () => {
    const text = JSON.stringify({ v: 1, rows: [row(1, 2, 4), { ...row(2, 3, 1), strength: -4 }, 'junk', row(1, 3, 2), { ...row(1, 2, 1), a_id: 'zzz' }] });
    expect(parseDirtyBonds(text)).toEqual([row(1, 2, 4), row(1, 3, 2)]);
  });

  it(`keeps at most ${MAX_DIRTY_ROWS} rows (the newest) and one row per pair`, () => {
    const many = Array.from({ length: 500 }, (_, i) => row(1000 + i, 5000 + i, i));
    const parsed = parseDirtyBonds(JSON.stringify({ v: 1, rows: many }));
    expect(parsed).toHaveLength(MAX_DIRTY_ROWS);
    expect(parsed[0]).toEqual(many[300]);
    expect(parsed[parsed.length - 1]).toEqual(many[499]);
    expect(serializeDirtyBonds(many)).toBe(JSON.stringify({ v: 1, rows: many.slice(-MAX_DIRTY_ROWS) }));
    expect(parseDirtyBonds(JSON.stringify({ v: 1, rows: [row(1, 2, 1), row(1, 2, 7)] }))).toEqual([row(1, 2, 7)]);
  });

  it('what is stored holds ids, strengths and timestamps only (nothing about names, messages or keys)', () => {
    const text = serializeDirtyBonds([row(1, 2, 3, { last_chat_at: '2026-10-27T12:00:00.000Z' })]);
    expect(Object.keys(JSON.parse(text).rows[0]).sort()).toEqual(['a_id', 'b_id', 'last_chat_at', 'session_id', 'strength']);
    expect(DIRTY_BONDS_KEY).toBe('empire:dirty-bonds:v1');
  });
});

describe('H4 durable — the storage adapter', () => {
  it('saves under the key and loads it back; an empty set removes the key', () => {
    const fs = fakeStorage();
    const store = createBondStore(() => fs.storage);
    expect(store.load()).toEqual([]);
    store.save([row(1, 2, 3)]);
    expect([...fs.data.keys()]).toEqual([DIRTY_BONDS_KEY]);
    expect(store.load()).toEqual([row(1, 2, 3)]);
    store.save([]);
    expect(fs.data.size).toBe(0);
  });

  it('with no storage at all it loads nothing and saves nothing, without throwing', () => {
    for (const none of [() => null, () => undefined, () => { throw new Error('SecurityError'); }]) {
      const store = createBondStore(none);
      expect(store.load()).toEqual([]);
      expect(() => store.save([row(1, 2, 3)])).not.toThrow();
    }
  });

  it('a storage whose reads throw loads nothing; one whose writes throw lets save() throw (the writer swallows it)', () => {
    expect(createBondStore(() => fakeStorage(['get']).storage).load()).toEqual([]);
    expect(() => createBondStore(() => fakeStorage(['set']).storage).save([row(1, 2, 3)])).toThrow();
  });

  describe('browserBondStore reads localStorage at call time, not at import', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    afterEach(() => {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    });
    const define = (get: () => unknown) => Object.defineProperty(globalThis, 'localStorage', { configurable: true, get });

    it('uses the global localStorage when there is one', () => {
      const fs = fakeStorage();
      define(() => fs.storage);
      const store = browserBondStore();
      store.save([row(1, 2, 3)]);
      expect(fs.data.get(DIRTY_BONDS_KEY)).toBe(serializeDirtyBonds([row(1, 2, 3)]));
      expect(store.load()).toEqual([row(1, 2, 3)]);
    });

    it('does not throw when the global is missing or its getter throws (blocked site data)', () => {
      define(() => undefined);
      expect(browserBondStore().load()).toEqual([]);
      define(() => { throw new Error('SecurityError: access is denied'); });
      const store = browserBondStore();
      expect(store.load()).toEqual([]);
      expect(() => store.save([row(1, 2, 3)])).not.toThrow();
    });
  });
});

describe('H4 durable — the writer and its store', () => {
  it('a failed write is saved; a NEW writer built from the same store (a reload) flushes it on the next write and empties the store', async () => {
    const fs = fakeStorage();
    const store = createBondStore(() => fs.storage);

    // page 1: the database is down for the exchange
    const db1 = fakeDb(() => down());
    const p1 = pageLoad(db1, store);
    await recordBond(p1.deps, A, B, 1, 'hello');
    expect(p1.writer.dirty()).toEqual([keyOf(1, 2)]);
    expect(parseDirtyBonds(fs.data.get(DIRTY_BONDS_KEY))).toEqual([{ a_id: A.id, b_id: B.id, strength: 1, session_id: ERA }]);

    // page 2: reloaded, the database is back; the writer knows the dirty pair from the store alone
    const db2 = fakeDb();
    const p2 = pageLoad(db2, store);
    expect(p2.writer.dirty()).toEqual([keyOf(1, 2)]);
    expect(db2.calls).toHaveLength(0); // building a writer writes nothing (a watcher never flushes)
    await recordBond(p2.deps, B, C, 1, 'a different pair writes'); // any bond write retries it
    expect(db2.table.get(keyOf(1, 2))?.strength).toBe(1);
    expect(db2.table.get(keyOf(2, 3))?.strength).toBe(1);
    expect(p2.writer.dirty()).toEqual([]);
    expect(fs.data.has(DIRTY_BONDS_KEY)).toBe(false);
    expect(createBondStore(() => fs.storage).load()).toEqual([]);
  });

  it('retry() flushes what was loaded without a new write, once, and the store is then empty', async () => {
    const fs = fakeStorage();
    const store = createBondStore(() => fs.storage);
    store.save([row(1, 2, 4), row(2, 3, 6)]);
    const db = fakeDb();
    const w = createBondWriter(db.persist, store);
    expect(w.pendingRows()).toEqual([row(1, 2, 4), row(2, 3, 6)]);
    await w.retry();
    expect(db.calls.map((r) => r.strength)).toEqual([4, 6]);
    expect(w.dirty()).toEqual([]);
    expect(fs.data.size).toBe(0);
    await w.retry();
    expect(db.calls).toHaveLength(2); // nothing left to retry
  });

  it('a success removes the row from the store; a write that keeps failing keeps it, at the latest strength', async () => {
    const fs = fakeStorage();
    const store = createBondStore(() => fs.storage);
    const db = fakeDb((n) => (n <= 2 ? down() : undefined));
    const w = createBondWriter(db.persist, store);
    await w.write(row(1, 2, 1));
    await w.write(row(1, 2, 2)); // still failing
    expect(parseDirtyBonds(fs.data.get(DIRTY_BONDS_KEY))).toEqual([row(1, 2, 2)]); // the newer row replaced the older
    await w.write(row(1, 2, 3)); // this one is call 4... the earlier row for the pair was replaced, so one write lands
    expect(db.table.get(keyOf(1, 2))?.strength).toBe(3);
    expect(fs.data.has(DIRTY_BONDS_KEY)).toBe(false);
  });

  it('the row is in the store BEFORE its request is answered (a page that unloads mid-request keeps it)', async () => {
    const fs = fakeStorage();
    const store = createBondStore(() => fs.storage);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let seenDuring: PairRow[] = [];
    const w = createBondWriter(async () => {
      seenDuring = parseDirtyBonds(fs.data.get(DIRTY_BONDS_KEY)); // what a reload at this instant would find
      await gate;
    }, store);
    const done = w.write(row(1, 2, 5));
    await Promise.resolve();
    await Promise.resolve();
    release();
    await done;
    expect(seenDuring).toEqual([row(1, 2, 5)]);
    expect(fs.data.has(DIRTY_BONDS_KEY)).toBe(false);
  });

  it('clear() empties the store too (a new era or a fork starts from its own bonds)', async () => {
    const fs = fakeStorage();
    const store = createBondStore(() => fs.storage);
    const w = createBondWriter(fakeDb(() => down()).persist, store);
    await w.write(row(1, 2, 1));
    expect(fs.data.has(DIRTY_BONDS_KEY)).toBe(true);
    w.clear();
    expect(w.dirty()).toEqual([]);
    expect(fs.data.has(DIRTY_BONDS_KEY)).toBe(false);
    expect(createBondWriter(fakeDb().persist, store).dirty()).toEqual([]); // a reload after the clear finds nothing
  });

  it('a row that arrives while clear() ran mid-flush is not written back or re-saved', async () => {
    const fs = fakeStorage();
    const store = createBondStore(() => fs.storage);
    store.save([row(1, 2, 1), row(2, 3, 1)]);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const calls: PairRow[] = [];
    const w = createBondWriter(async (r) => { calls.push(r); await gate; }, store);
    const flushing = w.retry();
    await Promise.resolve();
    await Promise.resolve();
    w.clear(); // an era change while the first row is in flight
    release();
    await flushing;
    expect(calls).toHaveLength(1); // the second row was cleared before it was tried
    expect(fs.data.has(DIRTY_BONDS_KEY)).toBe(false);
  });

  it('what the store hands over is validated again by the writer; garbage and a throwing load mean an empty start', () => {
    const junkStore: BondStore = { load: () => [row(1, 2, 3), { a_id: 'x', b_id: 'y', strength: 1, session_id: null }, null as unknown as PairRow, { ...row(2, 3, 1), strength: -1 }], save: () => {} };
    expect(createBondWriter(fakeDb().persist, junkStore).pendingRows()).toEqual([row(1, 2, 3)]);
    expect(createBondWriter(fakeDb().persist, { load: () => 'nope' as unknown as PairRow[], save: () => {} }).dirty()).toEqual([]);
    expect(createBondWriter(fakeDb().persist, { load: () => { throw new Error('boom'); }, save: () => {} }).dirty()).toEqual([]);
  });

  it(`holds at most ${MAX_DIRTY_ROWS} pending rows, dropping the oldest`, async () => {
    const store: BondStore = { load: () => Array.from({ length: 300 }, (_, i) => row(1000 + i, 5000 + i, 1)), save: () => {} };
    const w = createBondWriter(fakeDb().persist, store);
    expect(w.dirty()).toHaveLength(MAX_DIRTY_ROWS);
    expect(w.pendingRows()[0].a_id).toBe(uuid(1100));
    const failing = createBondWriter(fakeDb(() => down()).persist);
    for (let i = 0; i < 250; i++) await failing.write(row(1000 + i, 5000 + i, 1));
    expect(failing.dirty()).toHaveLength(MAX_DIRTY_ROWS);
  });

  it('a newer write for a pair replaces the stored row for it, never the other way round', async () => {
    const fs = fakeStorage();
    const store = createBondStore(() => fs.storage);
    store.save([row(1, 2, 5)]); // left by an earlier page
    const w = createBondWriter(fakeDb(() => down()).persist, store);
    await w.write(row(1, 2, 6)); // this page's newer exchange for the same pair
    expect(parseDirtyBonds(fs.data.get(DIRTY_BONDS_KEY))).toEqual([row(1, 2, 6)]);
    expect(w.pendingRows()).toEqual([row(1, 2, 6)]);
  });
});

describe('H4 durable — storage that fails degrades to memory-only', () => {
  it('a store that throws on save (quota, disabled, private mode) never reaches the caller and the in-memory retry still works', async () => {
    const fs = fakeStorage(['set', 'remove']);
    const store = createBondStore(() => fs.storage);
    const db = fakeDb((n) => (n === 1 ? down() : undefined));
    const p = pageLoad(db, store);
    await expect(recordBond(p.deps, A, B, 1, 'x')).resolves.toBeUndefined(); // write 1 fails, write 2 retries it
    expect(fs.calls.set).toBeGreaterThan(0); // it did try
    expect(p.writer.dirty()).toEqual([]); // the retry in memory worked
    expect(db.table.get(keyOf(1, 2))?.strength).toBe(1);
  });

  it('a store that throws on load starts empty, and one that throws on every call changes nothing about the writer', async () => {
    const hostile: BondStore = { load: () => { throw new Error('x'); }, save: () => { throw new Error('y'); } };
    const db = fakeDb((n) => (n <= 2 ? down() : undefined));
    const p = pageLoad(db, hostile);
    await recordBond(p.deps, A, B, 1, 'x');
    expect(p.writer.dirty()).toEqual([keyOf(1, 2)]);
    await recordBond(p.deps, A, B, 1, 'y');
    expect(p.writer.dirty()).toEqual([]);
    expect(db.table.get(keyOf(1, 2))?.strength).toBe(2);
  });

  it('a save that failed is tried again at the next change, so a storage that comes back catches up', async () => {
    const fs = fakeStorage();
    let broken = true;
    const store: BondStore = { load: () => [], save: (rows) => { if (broken) throw new Error('Quota'); createBondStore(() => fs.storage).save(rows); } };
    const w = createBondWriter(fakeDb(() => down()).persist, store);
    await w.write(row(1, 2, 1));
    expect(fs.data.size).toBe(0);
    broken = false;
    await w.write(row(1, 2, 2));
    expect(parseDirtyBonds(fs.data.get(DIRTY_BONDS_KEY))).toEqual([row(1, 2, 2)]);
  });
});

describe('H4 durable — permanent versus transient errors', () => {
  const err = (code: string, status = 400) => new BondWriteError('x', code, status);

  it('classifies by SQLSTATE: integrity (23xxx) and data (22xxx) errors are permanent, everything else is transient', () => {
    for (const code of ['23503', '23502', '23505', '23514', '22P02', '22003']) expect(isPermanentBondError(err(code)), code).toBe(true);
    for (const e of [
      err('', 0), err('', 503), err('ECONNREFUSED', 0), err('PGRST000', 503), err('PGRST301', 401), err('42501', 403), err('57014', 500), err('08006', 503), err('40001', 409), err('', 429), err('', 408),
      new Error('Failed to fetch'), new TypeError('NetworkError'), 'oops', null, undefined, { code: 23503 }, { code: '2350' }, { code: '235031' },
    ]) {
      expect(isPermanentBondError(e), String(e)).toBe(false);
    }
    expect(isPermanentBondError({ code: '23503' })).toBe(true); // a bare PostgrestError-shaped object works too
  });

  it('a write that fails with a foreign-key violation (the pair\'s villager no longer exists) is dropped from memory and from the store, not retried', async () => {
    const fs = fakeStorage();
    const store = createBondStore(() => fs.storage);
    const db = fakeDb(() => err('23503', 409));
    const w = createBondWriter(db.persist, store);
    await w.write(row(1, 2, 1));
    expect(w.dirty()).toEqual([]);
    expect(fs.data.has(DIRTY_BONDS_KEY)).toBe(false);
    await w.retry();
    expect(db.calls).toHaveLength(1); // never tried again
  });

  it('a stored row that turns out to be permanently unwritable is dropped on the first retry; transient failures keep their rows', async () => {
    const fs = fakeStorage();
    const store = createBondStore(() => fs.storage);
    store.save([row(1, 2, 1), row(2, 3, 2), row(1, 3, 3)]);
    const db = fakeDb((_n, r) => (r.a_id === uuid(1) && r.b_id === uuid(2) ? err('23503', 409) : r.strength === 2 ? err('', 503) : undefined));
    const w = createBondWriter(db.persist, store);
    await w.retry();
    expect(w.dirty()).toEqual([keyOf(2, 3)]); // 1|2 dropped for good, 1|3 written, 2|3 kept (503)
    expect(parseDirtyBonds(fs.data.get(DIRTY_BONDS_KEY))).toEqual([row(2, 3, 2)]);
    expect(db.table.has(keyOf(1, 3))).toBe(true);
    await w.retry(); // the 503 is still failing, still kept
    expect(w.dirty()).toEqual([keyOf(2, 3)]);
    expect(db.calls.filter((r) => r.a_id === uuid(1) && r.b_id === uuid(2))).toHaveLength(1);
  });

  it('a plain Error (no code) from persist is transient, as before', async () => {
    const w = createBondWriter(async () => { throw new Error('write 1 failed'); });
    await w.write(row(1, 2, 1));
    expect(w.dirty()).toEqual([keyOf(1, 2)]);
  });
});

describe('H4 durable — a leftover row versus what the database has now', () => {
  it('recoveryFor: write only when the database has no row or a strictly lower strength', () => {
    expect(recoveryFor({ strength: 5 }, null)).toBe('write');
    expect(recoveryFor({ strength: 5 }, 4)).toBe('write');
    expect(recoveryFor({ strength: 5 }, 0)).toBe('write');
    expect(recoveryFor({ strength: 5 }, 5)).toBe('drop'); // already there
    expect(recoveryFor({ strength: 5 }, 6)).toBe('drop'); // overtaken by a newer write
    expect(recoveryFor({ strength: 0 }, null)).toBe('write');
  });

  it('raiseBond only ever raises, creates a missing bond, and re-points a bond inherited from an earlier namesake', () => {
    const rels: BondMap = new Map([['Bramble', { withId: B.id, withName: 'Bramble', strength: 3, lastMessage: 'hi' }]]);
    expect(raiseBond(rels, B, 2)).toBe(false);
    expect(raiseBond(rels, B, 3)).toBe(false);
    expect(rels.get('Bramble')!.strength).toBe(3);
    expect(raiseBond(rels, B, 7)).toBe(true);
    expect(rels.get('Bramble')).toEqual({ withId: B.id, withName: 'Bramble', strength: 7, lastMessage: 'hi' });
    expect(raiseBond(rels, C, 4)).toBe(true);
    expect(rels.get('Cedar')).toEqual({ withId: C.id, withName: 'Cedar', strength: 4, lastMessage: null });
    // inherited from the table: the bond names an earlier era's Bramble; it is the same relationship, now with this Bramble
    const inherited: BondMap = new Map([['Bramble', { withId: uuid(77), withName: 'Bramble', strength: 2, lastMessage: null }]]);
    expect(raiseBond(inherited, B, 5)).toBe(true);
    expect(inherited.get('Bramble')).toEqual({ withId: B.id, withName: 'Bramble', strength: 5, lastMessage: null });
    const inheritedHigher: BondMap = new Map([['Bramble', { withId: uuid(77), withName: 'Bramble', strength: 9, lastMessage: null }]]);
    expect(raiseBond(inheritedHigher, B, 5)).toBe(true); // re-pointed, strength kept (never lowered)
    expect(inheritedHigher.get('Bramble')).toEqual({ withId: B.id, withName: 'Bramble', strength: 9, lastMessage: null });
  });

  it('raiseBondsFromRows raises BOTH sides, skips rows of other eras, never lowers, and works before or after the cache was loaded', () => {
    const maps = new Map<string, BondMap>();
    const relsOf = (id: string) => { let m = maps.get(id); if (!m) { m = new Map(); maps.set(id, m); } return m; };
    const roster = [A, B];
    const rows = [row(1, 2, 4), row(1, 99, 50), row(98, 99, 50)];
    // before the cache has anything: the maps are created
    expect(raiseBondsFromRows(rows, roster, relsOf)).toBe(1);
    expect(maps.get(A.id)!.get('Bramble')).toEqual({ withId: B.id, withName: 'Bramble', strength: 4, lastMessage: null });
    expect(maps.get(B.id)!.get('Alder')).toEqual({ withId: A.id, withName: 'Alder', strength: 4, lastMessage: null });
    expect(maps.size).toBe(2); // the rows of another era created nothing
    expect(raiseBondsFromRows(rows, roster, relsOf)).toBe(0); // idempotent
    // the cache is then (re)loaded from the stale table, replacing the maps: re-applying brings the bond back
    maps.set(A.id, new Map([['Bramble', { withId: uuid(77), withName: 'Bramble', strength: 2, lastMessage: null }]]));
    maps.set(B.id, new Map([['Alder', { withId: uuid(78), withName: 'Alder', strength: 2, lastMessage: null }]]));
    expect(raiseBondsFromRows(rows, roster, relsOf)).toBe(1);
    expect(maps.get(A.id)!.get('Bramble')).toEqual({ withId: B.id, withName: 'Bramble', strength: 4, lastMessage: null });
    expect(maps.get(B.id)!.get('Alder')).toEqual({ withId: A.id, withName: 'Alder', strength: 4, lastMessage: null });
    // a loaded value above the row stays
    maps.get(A.id)!.get('Bramble')!.strength = 6;
    raiseBondsFromRows(rows, roster, relsOf);
    expect(maps.get(A.id)!.get('Bramble')!.strength).toBe(6);
  });

  it('preferBond: the villager\'s own row beats an inherited one, then the stronger wins; the first candidate always wins', () => {
    expect(preferBond(undefined, { strength: 1, own: false })).toBe(true);
    expect(preferBond({ strength: 5, own: false }, { strength: 2, own: true })).toBe(true); // own era value, even if lower
    expect(preferBond({ strength: 2, own: true }, { strength: 5, own: false })).toBe(false);
    expect(preferBond({ strength: 2, own: false }, { strength: 5, own: false })).toBe(true);
    expect(preferBond({ strength: 5, own: false }, { strength: 2, own: false })).toBe(false);
    expect(preferBond({ strength: 3, own: true }, { strength: 3, own: true })).toBe(false);
  });

  it('an exchange of villagers whose bond was inherited from an earlier era writes ONE row, (self, other) of this era, from both sides', async () => {
    const db = fakeDb();
    const p = pageLoad(db, createBondStore(() => fakeStorage().storage));
    const oldA = uuid(61), oldB = uuid(62);
    p.deps.relsOf(A.id).set('Bramble', { withId: oldB, withName: 'Bramble', strength: 1, lastMessage: null }); // hydrated from the earlier era's row
    p.deps.relsOf(B.id).set('Alder', { withId: oldA, withName: 'Alder', strength: 1, lastMessage: null });
    await recordBond(p.deps, A, B, 1, 'hello');
    expect([...db.table.keys()]).toEqual([keyOf(1, 2)]);
    expect(db.table.get(keyOf(1, 2))?.strength).toBe(2);
    expect(p.strength(A, 'Bramble')).toBe(2);
    expect(p.strength(B, 'Alder')).toBe(2);
  });

  /**
   * The load-time recovery `Simulation.recoverBonds` performs, with the same pure functions: read the pair from
   * the "database", drop a stale row or raise the in-memory bonds and write once.
   */
  async function reload(db: ReturnType<typeof fakeDb>, store: BondStore, dbBonds: Array<[typeof A, typeof B, number]>) {
    const p = pageLoad(db, store);
    for (const [x, y, s] of dbBonds) {
      p.deps.relsOf(x.id).set(y.name, { withId: y.id, withName: y.name, strength: s, lastMessage: null }); // hydrated from the table
      p.deps.relsOf(y.id).set(x.name, { withId: x.id, withName: x.name, strength: s, lastMessage: null });
    }
    for (const r of p.writer.pendingRows()) {
      const stored = db.table.get(pairKey(r))?.strength ?? null;
      if (recoveryFor(r, stored) === 'drop') { p.writer.discard(pairKey(r)); continue; }
    }
    raiseBondsFromRows(p.writer.pendingRows(), [A, B, C], p.deps.relsOf);
    await p.writer.retry();
    return p;
  }

  it('SIMULATED RELOAD: the failed correction is not lost — memory and database both end at the true strength, and the next exchange builds on it', async () => {
    const fs = fakeStorage();
    const store = createBondStore(() => fs.storage);
    const db = fakeDb((n) => (n >= 5 ? down() : undefined)); // the first exchange lands, the second finds the database down
    const p1 = pageLoad(db, store);
    await recordBond(p1.deps, A, B, 1, 'one'); // calls 1, 2
    await recordBond(p1.deps, A, B, 1, 'two'); // calls 3, 4 (ok)... then
    await recordBond(p1.deps, A, B, 2, 'gift'); // calls 5, 6 fail
    expect(db.table.get(keyOf(1, 2))?.strength).toBe(2); // stale: the truth is 4
    expect(p1.strength(A, 'Bramble')).toBe(4);

    // reload: the villagers read the stale 2 from the table; the persisted row says 4
    db.calls.length = 0;
    const healthy = fakeDb();
    healthy.table.set(keyOf(1, 2), db.table.get(keyOf(1, 2))!);
    const p2 = await reload(healthy, store, [[A, B, 2]]);
    expect(healthy.table.get(keyOf(1, 2))?.strength).toBe(4); // converged
    expect(p2.strength(A, 'Bramble')).toBe(4);
    expect(p2.strength(B, 'Alder')).toBe(4);
    expect(fs.data.has(DIRTY_BONDS_KEY)).toBe(false);
    await recordBond(p2.deps, A, B, 1, 'after the reload');
    expect(healthy.table.get(keyOf(1, 2))?.strength).toBe(5); // no exchange lost
  });

  it('a stale persisted row never overwrites a higher database value (another window moved on, or it was already written)', async () => {
    const fs = fakeStorage();
    const store = createBondStore(() => fs.storage);
    store.save([row(1, 2, 3), row(2, 3, 6)]);
    const healthy = fakeDb();
    healthy.table.set(keyOf(1, 2), row(1, 2, 9)); // overtaken
    healthy.table.set(keyOf(2, 3), row(2, 3, 6)); // already persisted
    const p = await reload(healthy, store, [[A, B, 9]]);
    expect(healthy.calls).toHaveLength(0); // nothing written
    expect(healthy.table.get(keyOf(1, 2))?.strength).toBe(9);
    expect(p.strength(A, 'Bramble')).toBe(9); // memory not lowered either
    expect(p.writer.dirty()).toEqual([]);
    expect(fs.data.has(DIRTY_BONDS_KEY)).toBe(false);
  });

  it('the first exchange of a pair that never reached the database comes back from the store too (no row to compare with)', async () => {
    const fs = fakeStorage();
    const store = createBondStore(() => fs.storage);
    const db1 = fakeDb(() => down());
    await recordBond(pageLoad(db1, store).deps, A, B, 1, 'first ever');
    const healthy = fakeDb();
    const p = await reload(healthy, store, []);
    expect(healthy.table.get(keyOf(1, 2))?.strength).toBe(1);
    expect(p.strength(A, 'Bramble')).toBe(1);
    expect(p.strength(B, 'Alder')).toBe(1);
  });
});

describe('H4 durable — how simulation.ts wires it (source checks; it imports Supabase and is not run here)', () => {
  const source = readFileSync(new URL('../simulation.ts', import.meta.url), 'utf8');
  const bondsSource = readFileSync(new URL('../bonds.ts', import.meta.url), 'utf8');
  const storeSource = readFileSync(new URL('../bondStore.ts', import.meta.url), 'utf8');
  const body = (name: string) => {
    const at = source.search(new RegExp(`private (async )?${name}\\(`));
    return source.slice(at, source.indexOf('\n  }\n', at));
  };

  it('the writer is built with the browser store, and the recovery runs after the cache is hydrated, inside loadWorld', () => {
    expect(source).toContain('createBondWriter((row) => this.persistBond(row), browserBondStore())');
    expect(source).toMatch(/await this\.hydrateRelationships\(agents\);\s*await this\.recoverBonds\(agents\);/);
  });

  it('recovery never runs in a watching window (R7.6): the very first statement is the read-only guard', () => {
    expect(body('recoverBonds')).toMatch(/recoverBonds\(agents: AgentState\[\]\) \{\s*if \(this\.readOnly\) return;/);
    // a watcher that takes the lease over reloads the world, which is where it recovers
    expect(source).toMatch(/if \(wasWatching\) await this\.loadWorld\(true\);/);
  });

  it('recovery compares with the database, raises the in-memory bonds, and flushes through the writer', () => {
    const b = body('recoverBonds');
    expect(b).toContain('recoveryFor(row, stored)');
    expect(b).toContain('this.raiseBondsFromPending(agents)');
    expect(b).toContain('this.bondWriter.retry()');
    // the cache is re-raised after EVERY (re)load of it, so the order of flush and load does not matter
    expect(body('hydrateRelationships')).toContain('this.raiseBondsFromPending(agents)');
    expect(body('raiseBondsFromPending')).toContain('raiseBondsFromRows(');
    expect(source).toMatch(/throw new BondWriteError\(error\.message, error\.code, status\)/);
  });

  it('a new era, a fork and a reset still clear the writer (and so the store)', () => {
    expect(source.match(/this\.bondWriter\.clear\(\)/g)?.length).toBe(3);
  });

  it('the pure modules read no browser global at module level and no clock', () => {
    for (const text of [bondsSource, storeSource]) {
      expect(text).not.toMatch(/Date\.now|new Date\(|performance\.now/);
      expect(text).not.toMatch(/\bwindow\.|globalThis\./);
    }
    expect(bondsSource).not.toMatch(/localStorage/);
    // the only localStorage access is inside a function body
    expect(storeSource).toMatch(/export function browserBondStore\(\): BondStore \{\s*return createBondStore\(\(\) => \(typeof localStorage === 'undefined' \? null : localStorage\)\);/);
  });
});
