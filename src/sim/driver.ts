/**
 * Single-driver lease (R7.6, R9.4): exactly one window drives the tick loop for
 * the live era. The lease lives on the `sessions` row as `driver_id` plus
 * `driver_heartbeat_at`. Everything here is pure: time is always passed in as a
 * number of milliseconds, never read from the host clock.
 */

/** A lease whose last heartbeat is this old (or older) has timed out and may be taken over. */
export const DRIVER_TTL_MS = 30000;
/** How often the driver renews its lease while the loop runs. */
export const DRIVER_HEARTBEAT_MS = 10000;

export type LeaseDecision = 'acquire' | 'renew' | 'denied';

export interface LeaseRow {
  driver_id: string | null;
  driver_heartbeat_at: string | null;
}

/**
 * Boundary: a heartbeat exactly DRIVER_TTL_MS old is already stale (age >= TTL),
 * which matches the `lte` clause of the claim filter below.
 */
export function decideLease(row: LeaseRow, myId: string, nowMs: number): LeaseDecision {
  if (!row.driver_id) return 'acquire';
  if (row.driver_id === myId) return 'renew';
  const beat = row.driver_heartbeat_at ? Date.parse(row.driver_heartbeat_at) : Number.NaN;
  if (Number.isNaN(beat)) return 'acquire';
  return nowMs - beat >= DRIVER_TTL_MS ? 'acquire' : 'denied';
}

/** ISO-8601 UTC timestamp (millisecond precision) for a millisecond count, without a Date object. */
export function toIso(ms: number): string {
  const whole = Math.floor(ms);
  const days = Math.floor(whole / 86400000);
  const msOfDay = whole - days * 86400000;
  // civil-from-days (proleptic Gregorian), days since 1970-01-01
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  const p = (n: number, w: number) => String(n).padStart(w, '0');
  const h = Math.floor(msOfDay / 3600000);
  const mi = Math.floor((msOfDay % 3600000) / 60000);
  const s = Math.floor((msOfDay % 60000) / 1000);
  return `${p(year, 4)}-${p(month, 2)}-${p(day, 2)}T${p(h, 2)}:${p(mi, 2)}:${p(s, 2)}.${p(msOfDay % 1000, 3)}Z`;
}

/** Heartbeats at or before this instant are stale. */
export function leaseCutoffIso(nowMs: number): string {
  return toIso(nowMs - DRIVER_TTL_MS);
}

/** Ids go straight into a PostgREST filter, so anything but letters, digits and hyphens is refused. */
export function assertSafeDriverId(id: string): void {
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error('Driver id may only contain letters, digits and hyphens.');
}

/**
 * The `.or(...)` filter of the atomic claim: the row matches when nobody drives it,
 * when I already do, or when the driver's last heartbeat is missing or has gone stale. Used as
 * `update({ driver_id, driver_heartbeat_at }).eq('id', sessionId).or(filter).select()`;
 * one conditional UPDATE, so of several competing claims only one gets a row back.
 */
export function leaseClaimFilter(myId: string, nowMs: number): string {
  assertSafeDriverId(myId);
  return `driver_id.is.null,driver_id.eq.${myId},driver_heartbeat_at.is.null,driver_heartbeat_at.lte.${leaseCutoffIso(nowMs)}`;
}
