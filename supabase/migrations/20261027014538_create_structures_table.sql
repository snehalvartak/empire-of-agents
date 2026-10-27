/*
# Create structures table (built buildings persist across reloads)

1. New Tables
- structures: buildings villagers have constructed
  - id (text, primary key) — generated in app (built_<timestamp>)
  - territory (text, not null) — which territory the building stands in
  - position (jsonb, not null) — {x, y} world grid coordinates
  - kind (text, not null) — house | mill | barracks | watch_tower | wonder
  - built_by (text, nullable) — name of the villager who built it
  - created_at (timestamp)
2. Security
- RLS enabled; anon + authenticated full CRUD (single-tenant, no sign-in).
*/

CREATE TABLE IF NOT EXISTS structures (
  id text PRIMARY KEY,
  territory text NOT NULL,
  position jsonb NOT NULL,
  kind text NOT NULL,
  built_by text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE structures ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON structures TO anon, authenticated;

DROP POLICY IF EXISTS "anon_select_structures" ON structures;
CREATE POLICY "anon_select_structures" ON structures FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_structures" ON structures;
CREATE POLICY "anon_insert_structures" ON structures FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_structures" ON structures;
CREATE POLICY "anon_update_structures" ON structures FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_structures" ON structures;
CREATE POLICY "anon_delete_structures" ON structures FOR DELETE TO anon, authenticated USING (true);