import { MAX_DIRTY_ROWS, sanitizePairRow } from './bonds.ts';
import type { BondStore, PairRow } from './bonds.ts';

/**
 * The browser side of the durable bond-retry set (SPEC R7.1, bonds.ts): the rows whose `relationships`
 * write has not been confirmed, kept in `localStorage` so a page reload does not lose them. No clock, no
 * module-level browser access: the storage is looked up at call time, and every failure (no storage,
 * blocked, quota, corrupt content) is swallowed so the writer falls back to memory.
 *
 * The key holds villager and era ids and bond strengths only: no names, no messages, no keys.
 */
export const DIRTY_BONDS_KEY = 'empire:dirty-bonds:v1';
/** A stored value larger than this is not ours (200 rows are about 50 KB) and is ignored. */
export const MAX_STORED_CHARS = 128 * 1024;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The stored text as clean rows: anything malformed is dropped, the newest MAX_DIRTY_ROWS are kept; never throws. */
export function parseDirtyBonds(raw: string | null | undefined): PairRow[] {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_STORED_CHARS) return [];
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof doc !== 'object' || doc === null || (doc as { v?: unknown }).v !== 1) return [];
  const rows = (doc as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return [];
  const byPair = new Map<string, PairRow>();
  for (const candidate of rows.slice(-MAX_DIRTY_ROWS)) {
    const row = sanitizePairRow(candidate);
    if (row) byPair.set(`${row.a_id}|${row.b_id}`, row);
  }
  return [...byPair.values()];
}

export function serializeDirtyBonds(rows: PairRow[]): string {
  return JSON.stringify({ v: 1, rows: rows.slice(-MAX_DIRTY_ROWS) });
}

/** A BondStore over any Storage-like object, or over whatever `getStorage` returns at call time (null: none). */
export function createBondStore(getStorage: () => StorageLike | null | undefined, key: string = DIRTY_BONDS_KEY): BondStore {
  const storage = (): StorageLike | null => {
    try {
      return getStorage() ?? null;
    } catch {
      return null; // reading the global itself can throw (blocked site data)
    }
  };
  return {
    load() {
      try {
        return parseDirtyBonds(storage()?.getItem(key));
      } catch {
        return [];
      }
    },
    save(rows) {
      const s = storage();
      if (!s) return; // no storage: memory-only
      if (rows.length === 0) s.removeItem(key);
      else s.setItem(key, serializeDirtyBonds(rows));
    },
  };
}

/** The store `simulation.ts` uses: `localStorage` when the page has one, otherwise nothing persists. */
export function browserBondStore(): BondStore {
  return createBondStore(() => (typeof localStorage === 'undefined' ? null : localStorage));
}
