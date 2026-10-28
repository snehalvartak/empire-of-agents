/**
 * The pure rules behind keeping the Chronicle / Records panels and a watching window current when Supabase
 * Realtime is not delivering. No Supabase, no clock, no DOM: WorldApp owns the timers and the queries and asks
 * these functions what to do. Tested in __tests__/feed.test.ts.
 */

/** Poll cadence while Realtime is down, and the slowest it backs off to when the database does not answer. */
export const FEED_POLL_MS = 3000;
export const FEED_POLL_MAX_MS = 30000;
/** How often a watching window (another window drives the era) re-reads the era. */
export const WATCH_REFRESH_MS = 5000;

/** Rows the panels keep (newest first); a poll asks for the same number, so a long gap can never leave a hole. */
export const EVENT_LIMIT = 100;
export const MEMORY_LIMIT = 120;

export type PollPlan = 'off' | 'paused' | 'poll';

/**
 * What the feed should do right now. `status` is the last value the Realtime channel reported (null: nothing
 * reported yet): only SUBSCRIBED means rows are being delivered, so every other state, including "not heard yet",
 * polls. A hidden tab pauses (and resumes on visibilitychange) whatever the status.
 */
export function pollPlan(status: string | null, hidden: boolean): PollPlan {
  if (status === 'SUBSCRIBED') return 'off';
  return hidden ? 'paused' : 'poll';
}

/** What a watching window should do: refresh while it watches and the tab is visible. */
export function watchRefreshPlan(watching: boolean, hidden: boolean): 'off' | 'paused' | 'refresh' {
  if (!watching) return 'off';
  return hidden ? 'paused' : 'refresh';
}

/** Delay before the next poll: the normal cadence, doubling after each failed poll up to the cap. */
export function pollDelay(failures: number): number {
  const n = Number.isFinite(failures) ? Math.max(0, Math.floor(failures)) : 0;
  return Math.min(FEED_POLL_MAX_MS, FEED_POLL_MS * 2 ** Math.min(n, 10));
}

export interface FeedRow {
  id: string;
  created_at: string;
}

/** Milliseconds, and the microseconds past them that Postgres keeps ("...12:00:00.123456+00:00"), for an exact order. */
function timeOf(row: FeedRow): [number, number] {
  const ms = Date.parse(row.created_at);
  const frac = /\.(\d+)/.exec(row.created_at)?.[1] ?? '';
  return [Number.isNaN(ms) ? 0 : ms, Number(frac.padEnd(6, '0').slice(3, 6))];
}

function newestFirst(a: FeedRow, b: FeedRow): number {
  const [ams, aus] = timeOf(a);
  const [bms, bus] = timeOf(b);
  return bms - ams || bus - aus;
}

/**
 * Folds rows from any source (the first load, a Realtime INSERT, a poll) into the rows shown: a row that is
 * already shown (same id) is never added again, the result is newest first by `created_at` (rows with the same
 * time keep the order they arrive in, newer arrivals ahead of what is held) and holds at most `limit` rows.
 * Returns `prev` itself when nothing new came in, so a poll that finds nothing causes no re-render.
 */
export function mergeRows<T extends FeedRow>(prev: T[], incoming: T[], limit: number): T[] {
  const seen = new Set(prev.map((r) => r.id));
  const fresh: T[] = [];
  for (const row of incoming) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    fresh.push(row);
  }
  if (fresh.length === 0) return prev;
  return [...fresh, ...prev].sort(newestFirst).slice(0, Math.max(0, limit));
}

/** The rows of `incoming` that `prev` does not hold yet, in arrival order. */
export function newRows<T extends FeedRow>(prev: T[], incoming: T[]): T[] {
  const seen = new Set(prev.map((r) => r.id));
  return incoming.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

/**
 * Where the next poll starts: the `created_at` of the newest row shown, or null for "no rows yet" (ask for the
 * newest ones). The poll asks for rows at or after it (not strictly after) so rows that share its timestamp
 * are not missed; the duplicates this returns are dropped by `mergeRows`.
 */
export function pollSince(rows: FeedRow[]): string | null {
  let best: FeedRow | null = null;
  for (const r of rows) if (!best || newestFirst(r, best) < 0) best = r;
  return best ? best.created_at : null;
}
