/**
 * Single-driver lease (R7.6, R9.4): exactly one window drives the tick loop for the live era. The lease lives
 * on the `sessions` row as `driver_id` plus `driver_heartbeat_at`, and the DATABASE's clock decides everything
 * about it: `claim_session_lease`, `renew_session_lease`, `release_session_lease` and `session_lease_state`
 * (supabase/migrations/20261027210000_add_server_timed_lease_functions.sql) stamp and judge heartbeats with
 * `now()`. A window never sends a time, so a browser clock that runs fast or slow cannot make a live lease look
 * stale. What stays here is the timing the client owns (the heartbeat interval) and the unload request. Time is
 * never read from the host clock in this module.
 */

/** A lease whose last heartbeat is this old (or older) has timed out and may be taken over (the functions' default). */
export const DRIVER_TTL_MS = 30000;
/** The same limit in the whole seconds the SQL functions take. */
export const DRIVER_TTL_SECONDS = DRIVER_TTL_MS / 1000;
/** How often the driver renews its lease while the loop runs. */
export const DRIVER_HEARTBEAT_MS = 10000;

/** Where the API lives and the public key it is called with (what `createClient` is given). */
export interface ApiConfig {
  url: string;
  anonKey: string;
}

/**
 * The request that frees the lease when the window goes away, as a plain `fetch` call that can be made
 * synchronously inside the `pagehide` handler. The supabase-js client cannot be used there: it looks
 * up the auth session (async, behind a lock) before it sends anything, so a page that is unloading may stop
 * running before the request exists, and the era then stays "driven by another window" for the 30 s TTL. The
 * real-browser run found this: about 1 reload in 10 never sent its release. `keepalive` lets the browser finish
 * the request after the page is gone. It calls `release_session_lease`, which frees only the holder's own lease
 * (`driver_id = p_driver`), as in the normal release. The ids travel in a JSON body, so nothing needs escaping.
 */
export function leaseReleaseRequest(api: ApiConfig, sessionId: string, myId: string) {
  return {
    url: `${api.url.replace(/\/+$/, '')}/rest/v1/rpc/release_session_lease`,
    init: {
      method: 'POST' as const,
      keepalive: true as const,
      headers: {
        apikey: api.anonKey,
        Authorization: `Bearer ${api.anonKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_session: sessionId, p_driver: myId }),
    },
  };
}
