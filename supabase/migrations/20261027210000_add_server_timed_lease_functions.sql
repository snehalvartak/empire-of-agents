/*
# Server-timed single-driver lease (R7.6, R9.4)

1. Problem
- The lease was claimed, renewed and judged stale with timestamps from each browser's
  clock (`driver_heartbeat_at.lte.<now-30s>` computed client-side). A window whose clock
  runs ~20 s or more ahead of the driver's computes a cutoff that makes the driver's
  fresh lease look stale and takes it over: two drivers on one era.

2. New Functions (all in `public`, no table change)
- `claim_session_lease(p_session, p_driver, p_ttl_seconds default 30)` -> boolean:
  ONE conditional UPDATE that sets `driver_id = p_driver` and `driver_heartbeat_at = now()`
  when nobody drives the era, the caller already does, the heartbeat is missing, or it is at
  least p_ttl_seconds old (a heartbeat exactly p_ttl_seconds old is stale). True when a row
  was updated. Postgres serialises competing updates on the row, so of several concurrent
  claims exactly one gets true.
- `renew_session_lease(p_session, p_driver)` -> boolean: sets `driver_heartbeat_at = now()`
  only while `driver_id = p_driver`; false means the lease was lost.
- `release_session_lease(p_session, p_driver)` -> boolean: clears `driver_id` and
  `driver_heartbeat_at` only while `driver_id = p_driver`.
- `session_lease_state(p_session, p_driver, p_ttl_seconds default 30)` -> text (STABLE):
  'mine' when p_driver holds the lease, 'free' when nobody does or the holder's heartbeat is
  missing or stale, 'other' when someone else holds it fresh; NULL when the era does not exist.
- Every timestamp and cutoff is the DATABASE's now(); a client sends no time at all.

3. Security
- All four are SECURITY INVOKER with a pinned search_path: they run with the caller's rights,
  so the existing grants and RLS on `sessions` (anon + authenticated full CRUD, single-tenant,
  no sign-in) decide what they may touch; nothing is widened. EXECUTE is granted to anon and
  authenticated so PostgREST can expose them as /rest/v1/rpc/<name>.
- The app now REQUIRES these functions: apply this migration before deploying the new client.
*/

CREATE OR REPLACE FUNCTION public.claim_session_lease(
  p_session uuid,
  p_driver text,
  p_ttl_seconds integer DEFAULT 30
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  UPDATE public.sessions
  SET driver_id = p_driver, driver_heartbeat_at = now()
  WHERE id = p_session
    AND (
      driver_id IS NULL
      OR driver_id = p_driver
      OR driver_heartbeat_at IS NULL
      OR driver_heartbeat_at <= now() - make_interval(secs => p_ttl_seconds)
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.renew_session_lease(
  p_session uuid,
  p_driver text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  UPDATE public.sessions
  SET driver_heartbeat_at = now()
  WHERE id = p_session AND driver_id = p_driver;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_session_lease(
  p_session uuid,
  p_driver text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  UPDATE public.sessions
  SET driver_id = NULL, driver_heartbeat_at = NULL
  WHERE id = p_session AND driver_id = p_driver;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.session_lease_state(
  p_session uuid,
  p_driver text,
  p_ttl_seconds integer DEFAULT 30
) RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  state text;
BEGIN
  SELECT CASE
           WHEN driver_id IS NULL THEN 'free'
           WHEN driver_id = p_driver THEN 'mine'
           WHEN driver_heartbeat_at IS NULL
             OR driver_heartbeat_at <= now() - make_interval(secs => p_ttl_seconds) THEN 'free'
           ELSE 'other'
         END
  INTO state
  FROM public.sessions
  WHERE id = p_session;
  RETURN state;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_session_lease(uuid, text, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.renew_session_lease(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_session_lease(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.session_lease_state(uuid, text, integer) TO anon, authenticated;
