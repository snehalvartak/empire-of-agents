import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DRIVER_HEARTBEAT_MS,
  DRIVER_TTL_MS,
  assertSafeDriverId,
  decideLease,
  leaseClaimFilter,
  leaseCutoffIso,
  leaseReleaseRequest,
  toIso,
} from '../driver.ts';

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0, 0);
const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';

describe('G5 / R7.6 — decideLease', () => {
  it('G5: constants are 30 s time-to-live and a 10 s heartbeat', () => {
    expect(DRIVER_TTL_MS).toBe(30000);
    expect(DRIVER_HEARTBEAT_MS).toBe(10000);
    expect(DRIVER_HEARTBEAT_MS).toBeLessThan(DRIVER_TTL_MS);
  });

  const cases: Array<[string, { driver_id: string | null; driver_heartbeat_at: string | null }, string]> = [
    ['no driver', { driver_id: null, driver_heartbeat_at: null }, 'acquire'],
    ['no driver but a leftover heartbeat', { driver_id: null, driver_heartbeat_at: toIso(NOW) }, 'acquire'],
    ['me, fresh', { driver_id: ME, driver_heartbeat_at: toIso(NOW - 1000) }, 'renew'],
    ['me, long stale', { driver_id: ME, driver_heartbeat_at: toIso(NOW - 10 * DRIVER_TTL_MS) }, 'renew'],
    ['other, just beat', { driver_id: OTHER, driver_heartbeat_at: toIso(NOW) }, 'denied'],
    ['other, TTL - 1 ms old', { driver_id: OTHER, driver_heartbeat_at: toIso(NOW - DRIVER_TTL_MS + 1) }, 'denied'],
    // boundary: a heartbeat exactly TTL old is already stale (age >= TTL)
    ['other, exactly TTL old', { driver_id: OTHER, driver_heartbeat_at: toIso(NOW - DRIVER_TTL_MS) }, 'acquire'],
    ['other, TTL + 1 ms old', { driver_id: OTHER, driver_heartbeat_at: toIso(NOW - DRIVER_TTL_MS - 1) }, 'acquire'],
    ['other, null heartbeat', { driver_id: OTHER, driver_heartbeat_at: null }, 'acquire'],
    ['other, garbage heartbeat', { driver_id: OTHER, driver_heartbeat_at: 'not a time' }, 'acquire'],
    ['other, empty heartbeat', { driver_id: OTHER, driver_heartbeat_at: '' }, 'acquire'],
    [
      'other, Postgres-style timestamp (microseconds, +00:00)',
      { driver_id: OTHER, driver_heartbeat_at: '2026-10-27T11:59:59.123456+00:00' },
      'denied',
    ],
  ];
  for (const [name, row, expected] of cases) {
    it(`G5: ${name} -> ${expected}`, () => {
      expect(decideLease(row, ME, NOW)).toBe(expected);
    });
  }
});

describe('G5 / R7.6 — cutoff and filter', () => {
  it('G5: toIso agrees with the host formatter across eras and leap days', () => {
    for (const ms of [0, 1, 951782400000, 1709164800000, NOW, 4102444800000, -86400001, 253402300799999]) {
      expect(toIso(ms)).toBe(new Date(ms).toISOString());
    }
  });

  it('G5: the cutoff is exactly TTL before now', () => {
    expect(leaseCutoffIso(NOW)).toBe('2026-10-27T11:59:30.000Z');
    expect(Date.parse(leaseCutoffIso(NOW))).toBe(NOW - DRIVER_TTL_MS);
  });

  it('G5: the claim filter has the three clauses with my id and the cutoff', () => {
    const clauses = leaseClaimFilter(ME, NOW).split(',');
    expect(clauses).toContain('driver_id.is.null');
    expect(clauses).toContain(`driver_id.eq.${ME}`);
    expect(clauses).toContain(`driver_heartbeat_at.lte.${leaseCutoffIso(NOW)}`);
    // a driver row with no heartbeat at all counts as stale, as decideLease says
    expect(clauses).toContain('driver_heartbeat_at.is.null');
    expect(clauses).toHaveLength(4);
  });

  it('G5: ids outside letters, digits and hyphens are refused, never escaped into the filter', () => {
    for (const bad of ['', 'a,b', 'a.b', 'x),driver_id.is.null', 'a"b', "a'b", 'a b', 'a%2Cb', 'ü', 'a\nb']) {
      expect(() => assertSafeDriverId(bad), JSON.stringify(bad)).toThrow();
      expect(() => leaseClaimFilter(bad, NOW), JSON.stringify(bad)).toThrow();
    }
    expect(() => leaseClaimFilter(ME, NOW)).not.toThrow();
  });
});

/**
 * In-memory stand-in for the `sessions` row. The claim parses the real filter string
 * produced by leaseClaimFilter, so it checks that string means what decideLease means.
 * (The real UPDATE is atomic in Postgres; no database exists in this environment.)
 */
class FakeSessionRow {
  driver_id: string | null = null;
  driver_heartbeat_at: string | null = null;

  private matches(filter: string): boolean {
    return filter.split(',').some((clause) => {
      const [column, op, ...rest] = clause.split('.');
      const value = rest.join('.');
      const have = this[column as 'driver_id' | 'driver_heartbeat_at'];
      if (op === 'is') return value === 'null' && have === null;
      if (op === 'eq') return have === value;
      if (op === 'lte') return have !== null && have <= value;
      throw new Error(`unsupported clause ${clause}`);
    });
  }

  /** update({driver_id, driver_heartbeat_at}).or(filter).select(): rows changed (1 or 0). */
  claim(me: string, nowMs: number): number {
    if (!this.matches(leaseClaimFilter(me, nowMs))) return 0;
    this.driver_id = me;
    this.driver_heartbeat_at = toIso(nowMs);
    return 1;
  }

  /** update({driver_heartbeat_at}).eq('driver_id', me).select(): rows changed. */
  renew(me: string, nowMs: number): number {
    if (this.driver_id !== me) return 0;
    this.driver_heartbeat_at = toIso(nowMs);
    return 1;
  }

  /** update({driver_id: null, ...}).eq('driver_id', me) */
  release(me: string): number {
    if (this.driver_id !== me) return 0;
    this.driver_id = null;
    this.driver_heartbeat_at = null;
    return 1;
  }
}

describe('G5 / R7.6, R9.4 — two competing drivers', () => {
  it('G5: the fake agrees with decideLease about who may claim', () => {
    for (const age of [0, 1, DRIVER_TTL_MS - 1, DRIVER_TTL_MS, DRIVER_TTL_MS + 1, 5 * DRIVER_TTL_MS]) {
      const row = new FakeSessionRow();
      row.driver_id = OTHER;
      row.driver_heartbeat_at = toIso(NOW - age);
      const verdict = decideLease(row, ME, NOW);
      expect(row.claim(ME, NOW) === 1, `age ${age}`).toBe(verdict !== 'denied');
    }
  });

  it('G5: only one of two simultaneous claims wins, and the loser stays denied while the winner beats', () => {
    const row = new FakeSessionRow();
    expect(row.claim(ME, NOW)).toBe(1);
    expect(row.claim(OTHER, NOW)).toBe(0);
    expect(row.driver_id).toBe(ME);

    // the winner keeps beating every heartbeat interval; the loser keeps being refused
    let t = NOW;
    for (let i = 0; i < 20; i++) {
      t += DRIVER_HEARTBEAT_MS;
      expect(row.renew(ME, t)).toBe(1);
      expect(row.claim(OTHER, t)).toBe(0);
    }
    expect(row.driver_id).toBe(ME);
  });

  it('G5: the winner re-claiming its own lease is a renewal, not a conflict', () => {
    const row = new FakeSessionRow();
    expect(row.claim(ME, NOW)).toBe(1);
    expect(row.claim(ME, NOW + 5000)).toBe(1);
    expect(row.driver_heartbeat_at).toBe(toIso(NOW + 5000));
  });

  it('G5: after the winner goes quiet the loser is denied until the heartbeat is stale, then takes over', () => {
    const row = new FakeSessionRow();
    row.claim(ME, NOW);
    expect(row.claim(OTHER, NOW + DRIVER_TTL_MS - 1)).toBe(0);
    expect(row.claim(OTHER, NOW + DRIVER_TTL_MS)).toBe(1);
    expect(row.driver_id).toBe(OTHER);
    // the old driver's next heartbeat updates nothing: it has lost the lease and must stop
    expect(row.renew(ME, NOW + DRIVER_TTL_MS + 1)).toBe(0);
    // and it cannot take it back while the new driver is live
    expect(row.claim(ME, NOW + DRIVER_TTL_MS + 2)).toBe(0);
  });

  it('G5: a release lets the other window acquire at once', () => {
    const row = new FakeSessionRow();
    row.claim(ME, NOW);
    expect(row.claim(OTHER, NOW + 1000)).toBe(0);
    expect(row.release(ME)).toBe(1);
    expect(row.claim(OTHER, NOW + 2000)).toBe(1);
    expect(row.driver_id).toBe(OTHER);
  });

  it('G5: a release by a window that no longer holds the lease changes nothing', () => {
    const row = new FakeSessionRow();
    row.claim(ME, NOW);
    row.claim(OTHER, NOW + DRIVER_TTL_MS);
    expect(row.release(ME)).toBe(0);
    expect(row.driver_id).toBe(OTHER);
  });
});

describe('G5 — the lease module reads no clock', () => {
  it('G5: driver.ts contains no host-clock call', () => {
    const source = readFileSync(fileURLToPath(new URL('../driver.ts', import.meta.url)), 'utf8');
    for (const call of ['Date.now', 'new Date', 'performance.now']) {
      expect(source, `driver.ts uses ${call}`).not.toContain(call);
    }
  });
});

describe('G5 / R7.6 — leaseReleaseRequest (the release sent while the page unloads)', () => {
  const api = { url: 'https://abc.supabase.co/', anonKey: 'anon-key' };
  const SESSION = 'cccccccc-0000-4000-8000-000000000003';

  it('is the PostgREST PATCH that frees only my own lease, survives the page (keepalive) and needs no async auth lookup', () => {
    const r = leaseReleaseRequest(api, SESSION, ME);
    expect(r.url).toBe(`https://abc.supabase.co/rest/v1/sessions?id=eq.${SESSION}&driver_id=eq.${ME}`);
    expect(r.init.method).toBe('PATCH');
    expect(r.init.keepalive).toBe(true);
    expect(r.init.headers).toEqual({
      apikey: 'anon-key',
      Authorization: 'Bearer anon-key',
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    });
    expect(JSON.parse(r.init.body)).toEqual({ driver_id: null, driver_heartbeat_at: null });
  });

  it('refuses ids that could change the filter (they go straight into the URL)', () => {
    expect(() => leaseReleaseRequest(api, SESSION, 'x&or=(id.not.is.null)')).toThrow();
    expect(() => leaseReleaseRequest(api, SESSION, '')).toThrow();
    expect(() => leaseReleaseRequest(api, `${SESSION}&status=eq.live`, ME)).toThrow();
    expect(() => leaseReleaseRequest(api, '', ME)).toThrow();
  });

  it('simulation.ts frees the lease from the unload handlers through it, synchronously, not through the query builder', () => {
    const source = readFileSync(fileURLToPath(new URL('../simulation.ts', import.meta.url)), 'utf8');
    expect(source).toMatch(/const release = \(\) => this\.releaseOnUnload\(\);\s+window\.addEventListener\('pagehide', release\);\s+window\.addEventListener\('beforeunload', release\);/);
    const start = source.indexOf('private releaseOnUnload()');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n  }\n', start));
    expect(body).toContain('leaseReleaseRequest(apiConfig');
    expect(body).toContain('fetch(url, init)');
    expect(body).not.toContain('await');
    expect(body).not.toContain('supabase.from');
  });
});
