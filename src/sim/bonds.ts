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

export interface BondWriter {
  /** Persists `row`, after retrying every earlier row that failed. Never throws. */
  write(row: PairRow): Promise<void>;
  /** Pairs whose latest strength is not yet persisted. */
  dirty(): string[];
  /** Forgets pending retries (a new era starts from its own bonds). */
  clear(): void;
}

/**
 * Atomic-ish bond persistence (R7.1): the in-memory bond is the truth and is already updated when
 * `write` is called. If `persist` rejects, the pair is remembered as dirty with its latest row (a
 * newer write for the same pair replaces it, so a retry never writes a stale strength) and is
 * flushed on the next write for that pair or for any pair. A failure never reaches the caller. Writes are
 * serialized, so a slow older write cannot land after a newer one.
 */
export function createBondWriter(persist: (row: PairRow) => Promise<void>): BondWriter {
  const pending = new Map<string, PairRow>();
  // writes run one at a time, in call order, so an older row can never land after a newer one
  let tail: Promise<void> = Promise.resolve();
  async function flush(row: PairRow): Promise<void> {
    pending.set(pairKey(row), row);
    for (const [key, latest] of [...pending]) {
      try {
        await persist(latest);
        pending.delete(key);
      } catch {
        // stays dirty; retried on the next write
      }
    }
  }
  return {
    write(row) {
      tail = tail.then(() => flush(row));
      return tail;
    },
    dirty: () => [...pending.keys()],
    clear: () => pending.clear(),
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
