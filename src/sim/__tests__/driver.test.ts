import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DRIVER_HEARTBEAT_MS, DRIVER_TTL_MS, DRIVER_TTL_SECONDS, leaseReleaseRequest } from '../driver.ts';

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/*
 * The lease rules themselves (who may claim, the TTL boundary, renew and release by a non-owner, the state
 * 'free' | 'mine' | 'other') are SQL evaluated with the database's clock: they are tested against a real
 * PostgreSQL in `npm run check:migrations` (including a real two-session race) and, through PostgREST and the
 * real client with skewed browser clocks, in `npm run e2e`. Only the pure parts live here.
 */
describe('G5 / R7.6 — constants', () => {
  it('G5: 30 s time-to-live (also the SQL functions\' default, asserted in check:migrations) and a 10 s heartbeat', () => {
    expect(DRIVER_TTL_MS).toBe(30000);
    expect(DRIVER_TTL_SECONDS).toBe(30);
    expect(DRIVER_HEARTBEAT_MS).toBe(10000);
    expect(DRIVER_HEARTBEAT_MS).toBeLessThan(DRIVER_TTL_MS);
  });
});

describe('G5 — the lease module reads no clock', () => {
  it('G5: driver.ts contains no host-clock call', () => {
    const source = read('../driver.ts');
    for (const call of ['Date.now', 'new Date', 'performance.now']) {
      expect(source, `driver.ts uses ${call}`).not.toContain(call);
    }
  });
});

describe('G5 / R7.6 — leaseReleaseRequest (the release sent while the page unloads)', () => {
  const api = { url: 'https://abc.supabase.co/', anonKey: 'anon-key' };
  const SESSION = 'cccccccc-0000-4000-8000-000000000003';

  it('is the PostgREST rpc POST that frees only my own lease, survives the page (keepalive) and needs no async auth lookup', () => {
    const r = leaseReleaseRequest(api, SESSION, ME);
    expect(r.url).toBe('https://abc.supabase.co/rest/v1/rpc/release_session_lease');
    expect(r.init.method).toBe('POST');
    expect(r.init.keepalive).toBe(true);
    expect(r.init.headers).toEqual({
      apikey: 'anon-key',
      Authorization: 'Bearer anon-key',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(r.init.body)).toEqual({ p_session: SESSION, p_driver: ME });
  });

  it('puts the ids in the JSON body only, so nothing in them can change the URL', () => {
    const r = leaseReleaseRequest(api, SESSION, 'x&or=(id.not.is.null)');
    expect(r.url).toBe('https://abc.supabase.co/rest/v1/rpc/release_session_lease');
    expect(JSON.parse(r.init.body)).toEqual({ p_session: SESSION, p_driver: 'x&or=(id.not.is.null)' });
  });

  it('simulation.ts frees the lease from the unload handlers through it, synchronously, not through the query builder', () => {
    const source = read('../simulation.ts');
    expect(source).toMatch(/const release = \(\) => this\.releaseOnUnload\(\);\s+window\.addEventListener\('pagehide', release\);\s+window\.addEventListener\('beforeunload', release\);/);
    const start = source.indexOf('private releaseOnUnload()');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n  }\n', start));
    expect(body).toContain('leaseReleaseRequest(apiConfig');
    expect(body).toContain('fetch(url, init)');
    expect(body).not.toContain('await');
    expect(body).not.toContain('supabase.');
  });
});

describe('G5 / R7.6 — simulation.ts leaves the lease clock to the database', () => {
  const source = read('../simulation.ts');

  it('G5: claim, renew, release and the watch-or-drive check are the four rpc calls, with the parameter names the SQL declares', () => {
    for (const fn of ['claim_session_lease', 'session_lease_state']) {
      expect(source).toMatch(new RegExp(`rpc\\('${fn}', \\{\\s+p_session: this\\.session\\.id,\\s+p_driver: this\\.driverId,\\s+p_ttl_seconds: DRIVER_TTL_SECONDS,\\s+\\}\\)`));
    }
    for (const fn of ['renew_session_lease', 'release_session_lease']) {
      expect(source).toContain(`rpc('${fn}', { p_session: this.session.id, p_driver: this.driverId })`);
    }
  });

  it('G5: no client-clock lease code is left (no timestamp is written to or compared with driver_heartbeat_at)', () => {
    for (const gone of ['leaseClaimFilter', 'leaseCutoffIso', 'decideLease', 'toIso(']) expect(source, gone).not.toContain(gone);
    expect(source).not.toMatch(/driver_heartbeat_at:(?!\s*null)/);
    expect(source).not.toMatch(/\.eq\('driver_id'/);
  });
});
