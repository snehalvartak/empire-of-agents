import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EVENT_LIMIT, FEED_POLL_MAX_MS, FEED_POLL_MS, MEMORY_LIMIT, WATCH_REFRESH_MS,
  mergeRows, newRows, pollDelay, pollPlan, pollSince, watchRefreshPlan,
} from '../feed.ts';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

interface TestRow {
  id: string;
  created_at: string;
  type?: string;
  n?: number;
}
const row = (id: string, secs: number, extra: { type?: string; n?: number } = {}): TestRow => ({
  id,
  created_at: new Date(Date.UTC(2026, 9, 28, 12, 0, secs)).toISOString(),
  ...extra,
});
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe('feed fallback — poll plan', () => {
  it('Realtime delivering (SUBSCRIBED) means no polling, visible or hidden', () => {
    expect(pollPlan('SUBSCRIBED', false)).toBe('off');
    expect(pollPlan('SUBSCRIBED', true)).toBe('off');
  });

  it.each(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED', 'JOINING', 'whatever-a-newer-client-says'])(
    'status %s polls while the tab is visible and pauses while it is hidden',
    (status) => {
      expect(pollPlan(status, false)).toBe('poll');
      expect(pollPlan(status, true)).toBe('paused');
    },
  );

  it('nothing reported yet (null) counts as not delivering', () => {
    expect(pollPlan(null, false)).toBe('poll');
    expect(pollPlan(null, true)).toBe('paused');
  });

  it('a tab that comes back resumes: the same status flips from paused to poll', () => {
    expect(pollPlan('CLOSED', true)).toBe('paused');
    expect(pollPlan('CLOSED', false)).toBe('poll');
  });
});

describe('feed fallback — cadence and backoff', () => {
  it('polls every 3 s, a watcher refreshes every 5 s', () => {
    expect(FEED_POLL_MS).toBe(3000);
    expect(WATCH_REFRESH_MS).toBe(5000);
    expect(pollDelay(0)).toBe(3000);
  });

  it('doubles after each failed poll, up to the cap, and returns to 3 s after a success (failures back to 0)', () => {
    expect([0, 1, 2, 3, 4, 5].map(pollDelay)).toEqual([3000, 6000, 12000, 24000, 30000, 30000]);
    expect(pollDelay(1000)).toBe(FEED_POLL_MAX_MS);
  });

  it('is total: negative, fractional and non-numeric failure counts fall back to the normal cadence', () => {
    expect(pollDelay(-3)).toBe(3000);
    expect(pollDelay(1.9)).toBe(6000);
    expect(pollDelay(Number.NaN)).toBe(3000);
    expect(pollDelay(Number.POSITIVE_INFINITY)).toBe(3000);
  });
});

describe('feed fallback — watcher refresh plan', () => {
  it('refreshes only while watching and visible', () => {
    expect(watchRefreshPlan(true, false)).toBe('refresh');
    expect(watchRefreshPlan(true, true)).toBe('paused');
    expect(watchRefreshPlan(false, false)).toBe('off');
    expect(watchRefreshPlan(false, true)).toBe('off');
  });
});

describe('feed fallback — mergeRows', () => {
  it('adds new rows newest first', () => {
    const prev = [row('c', 3), row('b', 2), row('a', 1)];
    expect(ids(mergeRows(prev, [row('e', 5), row('d', 4)], 100))).toEqual(['e', 'd', 'c', 'b', 'a']);
  });

  it('orders by time, not by arrival (an older row that arrives late goes where it belongs)', () => {
    const prev = [row('c', 3), row('a', 1)];
    expect(ids(mergeRows(prev, [row('b', 2)], 100))).toEqual(['c', 'b', 'a']);
    expect(ids(mergeRows([], [row('a', 1), row('c', 3), row('b', 2)], 100))).toEqual(['c', 'b', 'a']);
  });

  it('never shows a row twice: a row delivered by Realtime and by a poll (or by two polls) is added once', () => {
    const prev = [row('b', 2), row('a', 1)];
    const merged = mergeRows(prev, [row('c', 3), row('b', 2), row('c', 3)], 100);
    expect(ids(merged)).toEqual(['c', 'b', 'a']);
    expect(ids(mergeRows(merged, [row('c', 3), row('b', 2), row('a', 1)], 100))).toEqual(['c', 'b', 'a']);
  });

  it('returns prev itself when nothing is new, so a poll that finds nothing re-renders nothing', () => {
    const prev = [row('b', 2), row('a', 1)];
    expect(mergeRows(prev, [], 100)).toBe(prev);
    expect(mergeRows(prev, [row('a', 1), row('b', 2)], 100)).toBe(prev);
  });

  it('keeps at most `limit` rows, dropping the oldest', () => {
    const prev = [row('c', 3), row('b', 2), row('a', 1)];
    expect(ids(mergeRows(prev, [row('e', 5), row('d', 4)], 3))).toEqual(['e', 'd', 'c']);
    expect(mergeRows([], [row('a', 1)], 0)).toEqual([]);
    const many = Array.from({ length: 250 }, (_, i) => row(`r${i}`, i % 60, { n: i }));
    expect(mergeRows([], many, EVENT_LIMIT)).toHaveLength(EVENT_LIMIT);
    expect(mergeRows([], many, MEMORY_LIMIT)).toHaveLength(MEMORY_LIMIT);
  });

  it('rows with the same time keep arrival order, newer arrivals ahead of what is held', () => {
    const prev = [row('old', 5)];
    expect(ids(mergeRows(prev, [row('n1', 5), row('n2', 5)], 100))).toEqual(['n1', 'n2', 'old']);
  });

  it('compares times, not strings: +00:00 and Z spellings and different digit counts order correctly', () => {
    const a = { id: 'a', created_at: '2026-10-28T12:00:09.5+00:00' };
    const b = { id: 'b', created_at: '2026-10-28T12:00:10Z' };
    expect(ids(mergeRows([a], [b], 10))).toEqual(['b', 'a']);
  });

  it('orders rows inside the same millisecond by their microseconds, as the database does', () => {
    const early = { id: 'early', created_at: '2026-10-28T12:00:00.123456+00:00' };
    const late = { id: 'late', created_at: '2026-10-28T12:00:00.123789+00:00' };
    const short = { id: 'short', created_at: '2026-10-28T12:00:00.12345+00:00' }; // Postgres drops trailing zeros: .123450
    expect(ids(mergeRows([early], [late, short], 10))).toEqual(['late', 'early', 'short']);
    expect(pollSince([short, early, late])).toBe(late.created_at);
  });

  it('does not change its inputs and keeps the extra columns of each row', () => {
    const prev = [row('a', 1, { type: 'say' })];
    const incoming = [row('b', 2, { type: 'gather' })];
    const before = JSON.stringify([prev, incoming]);
    const merged = mergeRows(prev, incoming, 10);
    expect(JSON.stringify([prev, incoming])).toBe(before);
    expect(merged.map((r) => r.type)).toEqual(['gather', 'say']);
  });

  it('a simulated outage: polls with overlapping windows leave exactly the database rows, once each', () => {
    const database = Array.from({ length: 19 }, (_, i) => row(`e${i + 1}`, i + 1));
    let shown = database.slice(0, 4).reverse(); // what a load before the outage showed: 4 of 19 (the earlier measurement)
    // each poll asks for rows at or after the newest shown, newest first, as the query does
    for (let pass = 0; pass < 3; pass += 1) {
      const since = pollSince(shown);
      const reply = database.filter((r) => since === null || Date.parse(r.created_at) >= Date.parse(since)).reverse();
      shown = mergeRows(shown, reply, EVENT_LIMIT);
    }
    expect(ids(shown)).toEqual(database.map((r) => r.id).reverse());
    expect(new Set(ids(shown)).size).toBe(19);
  });
});

describe('feed fallback — newRows and pollSince', () => {
  it('newRows lists only rows not held, once each, in arrival order', () => {
    expect(ids(newRows([row('a', 1)], [row('b', 2), row('a', 1), row('c', 3), row('b', 2)]))).toEqual(['b', 'c']);
    expect(newRows([], [])).toEqual([]);
  });

  it('pollSince is the newest created_at shown, whatever the order of the rows, and null for none', () => {
    expect(pollSince([])).toBeNull();
    expect(pollSince([row('a', 1), row('c', 3), row('b', 2)])).toBe(row('c', 3).created_at);
    expect(pollSince([row('c', 3), row('b', 2)])).toBe(row('c', 3).created_at);
  });

  it('pollSince returns the row\'s own text unchanged (the filter uses the database\'s precision)', () => {
    const t = '2026-10-28T12:00:03.123456+00:00';
    expect(pollSince([{ id: 'x', created_at: t }, row('y', 1)])).toBe(t);
  });
});

describe('feed fallback — wiring (source checks; the UI and Supabase are not imported by tests)', () => {
  const app = read('../../components/WorldApp.tsx');
  const sim = read('../simulation.ts');
  const feed = read('../feed.ts');

  it('feed.ts is pure: no Supabase, no React, no clock, no timers, no DOM', () => {
    expect(feed).not.toMatch(/supabase|from 'react'|Date\.now|new Date\(|setTimeout|setInterval|document\.|window\./);
  });

  it('WorldApp reads the channel status, polls only through pollPlan, pauses on visibilitychange and clears its timers', () => {
    expect(app).toMatch(/\.subscribe\(\(status\) =>/);
    expect(app).toContain("pollPlan(realtime, hidden) !== 'poll'");
    expect(app).toContain("addEventListener('visibilitychange'");
    expect(app).toContain("removeEventListener('visibilitychange'");
    expect(app.match(/clearTimeout\(timer\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('every source of feed rows goes through mergeRows (Realtime handlers and polls share one de-duplicating path)', () => {
    expect(app).toContain('announce(addEvents([row]))');
    expect(app).toContain('addMemories([row])');
    expect(app).not.toMatch(/setEvents\(\(prev\)|setMemories\(\(prev\)/);
    expect(app).toContain('announce(addEvents(ev.data as EventRow[]))');
  });

  it('the watcher refresh is read-only: refreshWatching never claims, writes or releases, and loadWorld(refresh) skips bonds and the cursor', () => {
    const start = sim.indexOf('async refreshWatching(');
    expect(start).toBeGreaterThan(-1);
    const refresh = sim.slice(start, sim.indexOf('\n  }\n', start));
    expect(refresh).not.toMatch(/claimLease|renewLease|releaseLease|\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(|start\(/);
    expect(refresh).toContain('this.leaseState(true)');
    expect(refresh).toContain('this.loadWorld(false, true)');
    expect(sim).toContain('if (!refresh) {\n      await this.hydrateRelationships(agents);');
    expect(sim).toContain('if (!keepLive && !refresh) {');
    expect(sim).toContain('if (refresh && !this.stillWatching(sid)) return;');
  });
});
