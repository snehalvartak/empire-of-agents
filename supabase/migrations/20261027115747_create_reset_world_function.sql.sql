/*
# Create reset_world function for one-shot world resets

1. New Functions
- `reset_world()` (void, security definer):
  - Deletes all villagers, all built structures and cubes, the shared
    stockpile row, the chronicle events, and the deploy version stamp.
  - Keeps `memories` (the empire's records survive resets by design) and
    keeps the OpenRouter key stored in `settings`.
  - Used by the manual reset script (npm run reset-world) so the wipe is a
    single atomic database operation.

2. Security
- SECURITY DEFINER so the anon-key script can wipe tables regardless of RLS.
- EXECUTE granted to anon + authenticated only (this is a single-tenant
  sandbox app); revoked from public.
*/

CREATE OR REPLACE FUNCTION reset_world()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM agents;
  DELETE FROM structures;
  DELETE FROM civ;
  DELETE FROM events;
  DELETE FROM settings WHERE id = 'world_state';
END;
$$;

REVOKE EXECUTE ON FUNCTION reset_world() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reset_world() TO anon, authenticated;
