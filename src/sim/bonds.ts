import type { ActionResult } from './world.ts';

/**
 * Villager bonds, pure (SPEC section 7, R7.1): how much a chat or a gift deepens a bond, how both
 * sides are bumped together, and how a failed write is kept and retried. No database, no clock:
 * `simulation.ts` supplies the persist callback and the timestamp.
 */

/** How far each exchange deepens the bond of *both* villagers (section 4 social, section 7). */
export const BOND_DELTA = { chat: 1, gift: 2 } as const;

/** One villager's view of a bond, held per villager and keyed by the other villager's name. */
export interface Bond {
  withId: string;
  withName: string;
  strength: number;
  lastMessage: string | null;
}
export type BondMap = Map<string, Bond>;

export interface Villager {
  id: string;
  name: string;
}

/** What the exchange left on each side: `a` is the villager who acted, `b` the one they acted on. */
export interface BondExchange {
  withId: string;
  delta: number;
  lastMessage: { a: string; b: string };
}

/** The bond change a successful chat or gift result calls for; null for every other result. */
export function bondExchange(result: ActionResult): BondExchange | null {
  if (!result.ok) return null;
  if (result.chat) {
    return { withId: result.chat.withId, delta: BOND_DELTA.chat, lastMessage: { a: result.chat.message, b: result.chat.message } };
  }
  if (result.gift) {
    return {
      withId: result.gift.withId,
      delta: BOND_DELTA.gift,
      lastMessage: { a: `gave ${result.gift.item}`, b: `received ${result.gift.item}` },
    };
  }
  return null;
}

/** One side of the bond after a bump, and whether this bump created it. */
export interface BumpedSide {
  /** The villager whose bond this is. */
  self: Villager;
  bond: Bond;
  created: boolean;
}

function bump(rels: BondMap, self: Villager, other: Villager, delta: number, lastMessage: string): BumpedSide {
  const existing = rels.get(other.name);
  if (existing) {
    existing.strength += delta;
    existing.lastMessage = lastMessage;
    return { self, bond: existing, created: false };
  }
  const bond: Bond = { withId: other.id, withName: other.name, strength: delta, lastMessage };
  rels.set(other.name, bond);
  return { self, bond, created: true };
}

/**
 * Deepens the bond between `a` and `b` by `delta` on BOTH sides, in memory, and keeps the last
 * exchange text on both (R7.1: symmetric). Only the two villagers' own maps are touched; any third
 * villager's bonds are left alone. `lastMessage` is one text for both sides, or one per side.
 * Returns the two sides after the bump, `a` first.
 */
export function applyBondDelta(
  relsA: BondMap,
  relsB: BondMap,
  a: Villager,
  b: Villager,
  delta: number,
  lastMessage: string | { a: string; b: string }
): [BumpedSide, BumpedSide] {
  const text = typeof lastMessage === 'string' ? { a: lastMessage, b: lastMessage } : lastMessage;
  return [bump(relsA, a, b, delta, text.a), bump(relsB, b, a, delta, text.b)];
}

/** The `relationships` row for a pair; ids are sorted so both sides write the same row. */
export interface PairRow {
  a_id: string;
  b_id: string;
  strength: number;
  last_chat_at?: string;
  session_id: string | null;
}

export function pairKey(row: Pick<PairRow, 'a_id' | 'b_id'>): string {
  return `${row.a_id}|${row.b_id}`;
}

/** The row to upsert for one side of a bump. A bond's first write carries no `last_chat_at`, as before. */
export function pairRowFor(side: BumpedSide, sessionId: string | null, nowIso: string): PairRow {
  const [a_id, b_id] = [side.self.id, side.bond.withId].sort();
  return {
    a_id,
    b_id,
    strength: side.bond.strength,
    ...(side.created ? {} : { last_chat_at: nowIso }),
    session_id: sessionId,
  };
}

/** How many pending rows a writer (and its store) keeps; the oldest are dropped first. A world has far fewer pairs. */
export const MAX_DIRTY_ROWS = 200;
const MAX_STRENGTH = 2147483647; // a Postgres integer
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Strict validation of a row that comes from outside (a store that outlived the page): returns a clean
 * copy holding exactly the PairRow fields, or null if anything is off. Both ids must be uuids, the
 * strength a non-negative integer a Postgres `integer` can hold, `session_id` a uuid or null,
 * `last_chat_at` (when present) a timestamp string. Extra fields are not copied.
 */
export function sanitizePairRow(raw: unknown): PairRow | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.a_id !== 'string' || !UUID.test(r.a_id) || typeof r.b_id !== 'string' || !UUID.test(r.b_id)) return null;
  if (r.a_id === r.b_id) return null;
  if (typeof r.strength !== 'number' || !Number.isInteger(r.strength) || r.strength < 0 || r.strength > MAX_STRENGTH) return null;
  const session = r.session_id ?? null;
  if (session !== null && (typeof session !== 'string' || !UUID.test(session))) return null;
  const row: PairRow = { a_id: r.a_id, b_id: r.b_id, strength: r.strength, session_id: session };
  if (r.last_chat_at !== undefined) {
    if (typeof r.last_chat_at !== 'string' || r.last_chat_at.length > 40 || Number.isNaN(Date.parse(r.last_chat_at))) return null;
    row.last_chat_at = r.last_chat_at;
  }
  return row;
}

/**
 * Where a writer keeps its pending rows so they outlive the page (R7.1 across a reload). Synchronous, so
 * it works in `pagehide`. The writer never lets a store failure through: it wraps every call and, on a
 * failure, simply carries on from memory.
 */
export interface BondStore {
  load(): PairRow[];
  save(rows: PairRow[]): void;
}

/** A failed `relationships` write, with what the database said. `code` is the SQLSTATE; `status` the HTTP status (0: no response). */
export class BondWriteError extends Error {
  constructor(message: string, readonly code: string = '', readonly status: number = 0) {
    super(message);
    this.name = 'BondWriteError';
  }
}

/**
 * True when retrying `err` can never succeed, so the row must be dropped: a PostgreSQL integrity
 * violation (SQLSTATE class 23: 23503 a foreign key whose agent no longer exists, 23502, 23514 ...) or
 * data exception (class 22: 22P02 a malformed uuid, 22003 an out-of-range integer). PostgREST passes the
 * SQLSTATE through as `error.code`. Everything else is transient and keeps the row: no response / network
 * failure (code '' or a Node/browser error code, status 0), 5xx, 408, 429, PostgREST's own PGRST codes,
 * and permission errors (42501 is a deployment problem that a fix makes succeed, so the correction is worth keeping).
 */
export function isPermanentBondError(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^(22|23)[0-9A-Z]{3}$/.test(code);
}

/**
 * What to do with a row left over from an earlier page load, given the strength the database holds for
 * that pair now (null: no row). A bond only ever grows (chat +1, gift +2, nothing subtracts), so the
 * larger strength is the later one and needs no clock: the leftover row is written only if it is
 * strictly higher than what the database has, otherwise it is stale (already persisted, or overtaken by
 * a newer write from this or another window) and is dropped, never written over a higher value.
 */
export function recoveryFor(row: Pick<PairRow, 'strength'>, stored: number | null): 'write' | 'drop' {
  return stored === null || row.strength > stored ? 'write' : 'drop';
}

/**
 * Brings one side's in-memory bond up to a recovered strength (never down). `rels` is that villager's map and `other` the one it is with; the
 * bond is created if it is missing. A bond that already points at a different villager of the same name
 * (an earlier era's namesake) is left alone. Returns whether anything changed.
 */
export function raiseBond(rels: BondMap, other: Villager, strength: number): boolean {
  const existing = rels.get(other.name);
  if (!existing) {
    rels.set(other.name, { withId: other.id, withName: other.name, strength, lastMessage: null });
    return true;
  }
  if (existing.withId !== other.id || existing.strength >= strength) return false;
  existing.strength = strength;
  return true;
}

export interface BondWriter {
  /** Persists `row`, after retrying every earlier row that failed. Never throws. */
  write(row: PairRow): Promise<void>;
  /** Retries every pending row without a new one (e.g. rows a store handed back after a reload). Never throws. */
  retry(): Promise<void>;
  /** Pairs whose latest strength is not yet persisted. */
  dirty(): string[];
  /** The pending rows themselves (copies), oldest first. */
  pendingRows(): PairRow[];
  /** Gives up on one pending pair (its row is stale or can never be written). */
  discard(key: string): void;
  /** Forgets pending retries (a new era starts from its own bonds), in memory and in the store. */
  clear(): void;
}

/**
 * Atomic-ish bond persistence (R7.1): the in-memory bond is the truth and is already updated when
 * `write` is called. If `persist` rejects, the pair is remembered as dirty with its latest row (a
 * newer write for the same pair replaces it, so a retry never writes a stale strength) and is
 * flushed on the next write for that pair or for any pair. A failure never reaches the caller. Writes are
 * serialized, so a slow older write cannot land after a newer one.
 *
 * With a `store` the pending set survives a page reload: it is loaded (validated, capped) when the
 * writer is built and saved on every change. A row is saved BEFORE its write is attempted and removed
 * when the write succeeds, so a page that unloads while a request is in flight still has the row on
 * its next load (the retry is an idempotent upsert). A row whose write fails with a permanent error
 * (`isPermanentBondError`) is dropped instead of retried forever. The store can fail in any way
 * (quota, disabled, corrupt) without ever reaching the caller: the writer then runs from memory.
 */
export function createBondWriter(persist: (row: PairRow) => Promise<void>, store?: BondStore): BondWriter {
  const pending = new Map<string, PairRow>();
  if (store) {
    try {
      const loaded = store.load();
      if (Array.isArray(loaded)) {
        for (const raw of loaded) {
          const row = sanitizePairRow(raw);
          if (!row) continue;
          const key = pairKey(row);
          const had = pending.get(key);
          if (!had || row.strength >= had.strength) pending.set(key, row); // two rows for a pair: the higher is the later
        }
      }
    } catch {
      // unreadable store: start empty
    }
    trim();
  }
  function trim() {
    while (pending.size > MAX_DIRTY_ROWS) pending.delete(pending.keys().next().value as string);
  }
  let savedAs: string | null = null;
  function save() {
    if (!store) return;
    const rows = [...pending.values()];
    const sig = JSON.stringify(rows);
    if (sig === savedAs) return;
    try {
      store.save(rows.map((r) => ({ ...r })));
      savedAs = sig;
    } catch {
      // storage refused (quota, disabled, private mode): memory-only from here on, retried at the next change
    }
  }
  // writes run one at a time, in call order, so an older row can never land after a newer one
  let tail: Promise<void> = Promise.resolve();
  async function flush(row?: PairRow): Promise<void> {
    if (row) {
      pending.set(pairKey(row), row); // a newer write for the pair replaces its old row
      trim();
      save();
    }
    for (const [key, latest] of [...pending]) {
      if (pending.get(key) !== latest) continue; // cleared, discarded or replaced while an earlier row was in flight
      try {
        await persist(latest);
        if (pending.get(key) === latest) pending.delete(key);
      } catch (err) {
        if (isPermanentBondError(err) && pending.get(key) === latest) pending.delete(key); // can never succeed
        // otherwise it stays dirty; retried on the next write
      }
      save();
    }
  }
  const queue = (row?: PairRow) => {
    tail = tail.then(() => flush(row));
    return tail;
  };
  return {
    write: (row) => queue(row),
    retry: () => queue(),
    dirty: () => [...pending.keys()],
    pendingRows: () => [...pending.values()].map((r) => ({ ...r })),
    discard(key) {
      if (pending.delete(key)) save();
    },
    clear() {
      pending.clear();
      save();
    },
  };
}

export interface RecordBondDeps {
  relsOf(villagerId: string): BondMap;
  writer: BondWriter;
  sessionId: string | null;
  /** ISO timestamp for `last_chat_at`; injected so this module reads no clock. */
  nowIso(): string;
}

/** Applies the delta to both villagers in memory, then persists each side's row through the writer. */
export async function recordBond(
  deps: RecordBondDeps,
  a: Villager,
  b: Villager,
  delta: number,
  lastMessage: string | { a: string; b: string }
): Promise<void> {
  const sides = applyBondDelta(deps.relsOf(a.id), deps.relsOf(b.id), a, b, delta, lastMessage);
  for (const side of sides) await deps.writer.write(pairRowFor(side, deps.sessionId, deps.nowIso()));
}
