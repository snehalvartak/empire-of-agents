/*
# Create civilization state table (Age of Empires theme)

1. New Tables
- civ: single-row civilization state shared by all villagers
  - id (text, primary key, always 'global')
  - wood, food, gold, stone (integers, stockpiled resources)
  - age (integer 1-4: Dark, Feudal, Castle, Imperial)
  - updated_at (timestamp)
2. Security
- RLS enabled; anon + authenticated full CRUD (single-tenant, no sign-in).
*/

CREATE TABLE IF NOT EXISTS civ (
  id text PRIMARY KEY,
  wood integer NOT NULL DEFAULT 0,
  food integer NOT NULL DEFAULT 0,
  gold integer NOT NULL DEFAULT 0,
  stone integer NOT NULL DEFAULT 0,
  age integer NOT NULL DEFAULT 1,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE civ ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON civ TO anon, authenticated;

DROP POLICY IF EXISTS "anon_select_civ" ON civ;
CREATE POLICY "anon_select_civ" ON civ FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_civ" ON civ;
CREATE POLICY "anon_insert_civ" ON civ FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_civ" ON civ;
CREATE POLICY "anon_update_civ" ON civ FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_civ" ON civ;
CREATE POLICY "anon_delete_civ" ON civ FOR DELETE TO anon, authenticated USING (true);