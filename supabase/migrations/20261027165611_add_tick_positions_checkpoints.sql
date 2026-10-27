/*
# Add tick, position history, and checkpoints

1. Modified Tables
- `events`: adds `tick` (integer, nullable) — the simulation tick when the event
  happened. Nullable so existing rows remain valid. Index on (session_id, tick).

2. New Tables
- `agent_positions`: one row per simulation tick per acting villager — where they
  stood. Powers the position heatmap.
  - `id` bigint identity primary key
  - `session_id` uuid (nullable)
  - `agent_id` uuid, `tick` integer, `x` integer, `y` integer
  - index on (session_id, agent_id, tick)
- `checkpoints`: full world snapshot every 50 ticks. Powers replay seeking and
  archive thumbnails.
  - `id` uuid primary key
  - `session_id` uuid (nullable), `tick` integer, `snapshot` jsonb
  - unique on (session_id, tick)

3. Security
- RLS enabled on both new tables; anon + authenticated full CRUD (single-tenant
  no-sign-in app, matching every other table). Grants included.
*/

ALTER TABLE events ADD COLUMN IF NOT EXISTS tick integer;
CREATE INDEX IF NOT EXISTS idx_events_session_tick ON events (session_id, tick);

CREATE TABLE IF NOT EXISTS agent_positions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid,
  agent_id uuid NOT NULL,
  tick integer NOT NULL,
  x integer NOT NULL,
  y integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_positions_session_agent_tick
  ON agent_positions (session_id, agent_id, tick);

CREATE TABLE IF NOT EXISTS checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid,
  tick integer NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, tick)
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_session_tick ON checkpoints (session_id, tick);

ALTER TABLE agent_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkpoints ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_positions TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON checkpoints TO anon, authenticated;

DROP POLICY IF EXISTS "anon_select_agent_positions" ON agent_positions;
CREATE POLICY "anon_select_agent_positions" ON agent_positions
  FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_agent_positions" ON agent_positions;
CREATE POLICY "anon_insert_agent_positions" ON agent_positions
  FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_agent_positions" ON agent_positions;
CREATE POLICY "anon_update_agent_positions" ON agent_positions
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_agent_positions" ON agent_positions;
CREATE POLICY "anon_delete_agent_positions" ON agent_positions
  FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_select_checkpoints" ON checkpoints;
CREATE POLICY "anon_select_checkpoints" ON checkpoints
  FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_checkpoints" ON checkpoints;
CREATE POLICY "anon_insert_checkpoints" ON checkpoints
  FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_checkpoints" ON checkpoints;
CREATE POLICY "anon_update_checkpoints" ON checkpoints
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_checkpoints" ON checkpoints;
CREATE POLICY "anon_delete_checkpoints" ON checkpoints
  FOR DELETE TO anon, authenticated USING (true);