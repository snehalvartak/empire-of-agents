/*
# Add chat action and villager needs

1. New Columns
- `agents.chat_count` (integer, default 0): how many chats this villager has had.
- `agents.hunger` (integer 0-100, default 0): 100 means starving.
- `agents.energy` (integer 0-100, default 100): 0 means exhausted.

2. New Table
- `relationships`: persistent memory of who has talked to whom.
  - `id` uuid primary key
  - `session_id` uuid (nullable)
  - `a_id`, `b_id` uuid: the two villagers (stored name-ordered for easy lookup)
  - `strength` integer: grows with each chat
  - `last_chat_at` timestamptz
  - `created_at` timestamptz
  - unique on (a_id, b_id)

3. Security
- RLS on `relationships`; policies grant full CRUD to anon + authenticated
  (single-tenant app, no sign-in — data is intentionally shared, matching every
  other table in this project).
- New `agents` columns are covered by existing table policies.
- Grants to anon + authenticated for the new table.

4. Notes
- Non-destructive: only additive columns and one new table.
*/

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS chat_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hunger integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS energy integer NOT NULL DEFAULT 100;

CREATE TABLE IF NOT EXISTS relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid,
  a_id uuid NOT NULL,
  b_id uuid NOT NULL,
  strength integer NOT NULL DEFAULT 1,
  last_chat_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (a_id, b_id)
);

ALTER TABLE relationships ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON relationships TO anon, authenticated;

DROP POLICY IF EXISTS "anon_select_relationships" ON relationships;
CREATE POLICY "anon_select_relationships" ON relationships
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_relationships" ON relationships;
CREATE POLICY "anon_insert_relationships" ON relationships
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_relationships" ON relationships;
CREATE POLICY "anon_update_relationships" ON relationships
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_relationships" ON relationships;
CREATE POLICY "anon_delete_relationships" ON relationships
  FOR DELETE TO anon, authenticated USING (true);