/*
# Track depleted world objects per session

1. New Tables
- `depleted_objects`: one row per natural object (mine, animal) removed from the
  seeded world during a session, so the island's state survives page reloads.
  - `id` (text, primary key) — matches the seed object id (e.g. `res_12`)
  - `session_id` (uuid, not null) — the session the depletion belongs to
  - `respawn_at` (timestamptz, nullable) — when a gathered animal returns to the
    wild; NULL for mines, which never come back
  - `created_at` (timestamp)
2. Security
- Enable RLS on `depleted_objects`.
- Grant full CRUD to `anon` + `authenticated` (single-tenant app, no sign-in;
  the data is intentionally shared/public).
*/

CREATE TABLE IF NOT EXISTS depleted_objects (
  id text NOT NULL,
  session_id uuid NOT NULL,
  respawn_at timestamptz,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (id, session_id)
);

ALTER TABLE depleted_objects ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON depleted_objects TO anon, authenticated;

DROP POLICY IF EXISTS "anon_select_depleted_objects" ON depleted_objects;
CREATE POLICY "anon_select_depleted_objects" ON depleted_objects FOR SELECT
TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_depleted_objects" ON depleted_objects;
CREATE POLICY "anon_insert_depleted_objects" ON depleted_objects FOR INSERT
TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_depleted_objects" ON depleted_objects
;
CREATE POLICY "anon_update_depleted_objects" ON depleted_objects FOR UPDATE
TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_depleted_objects" ON depleted_objects;
CREATE POLICY "anon_delete_depleted_objects" ON depleted_objects FOR DELETE
TO anon, authenticated USING (true);