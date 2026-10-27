/*
# Create simulation tables

1. New Tables
- agents: AI avatars (name, model, color, island, position, mood, persona, status)
- memories: journal entries (semantic / episodic) per agent
- events: world event log
- runs: simulation runs with tick count
2. Security
- RLS enabled on all tables.
- Anon + authenticated full CRUD: single-tenant app with no sign-in.
*/

CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  model text NOT NULL,
  color text NOT NULL,
  island text NOT NULL DEFAULT 'palm',
  position jsonb NOT NULL DEFAULT '{"x":10,"y":10}',
  mood text NOT NULL DEFAULT 'curious',
  persona text NOT NULL DEFAULT 'A curious explorer.',
  status text NOT NULL DEFAULT 'idle',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'episodic',
  content text NOT NULL,
  island text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
  island text,
  type text NOT NULL,
  message text NOT NULL,
  data jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz DEFAULT now(),
  ended_at timestamptz,
  status text NOT NULL DEFAULT 'running',
  tick_count integer NOT NULL DEFAULT 0
);

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON agents TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON memories TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON events TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON runs TO anon, authenticated;

DROP POLICY IF EXISTS "anon_select_agents" ON agents;
CREATE POLICY "anon_select_agents" ON agents FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_agents" ON agents;
CREATE POLICY "anon_insert_agents" ON agents FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_agents" ON agents;
CREATE POLICY "anon_update_agents" ON agents FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_agents" ON agents;
CREATE POLICY "anon_delete_agents" ON agents FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_select_memories" ON memories;
CREATE POLICY "anon_select_memories" ON memories FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_memories" ON memories;
CREATE POLICY "anon_insert_memories" ON memories FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_memories" ON memories;
CREATE POLICY "anon_update_memories" ON memories FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_memories" ON memories;
CREATE POLICY "anon_delete_memories" ON memories FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_select_events" ON events;
CREATE POLICY "anon_select_events" ON events FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_events" ON events;
CREATE POLICY "anon_insert_events" ON events FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_events" ON events;
CREATE POLICY "anon_update_events" ON events FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_events" ON events;
CREATE POLICY "anon_delete_events" ON events FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_select_runs" ON runs;
CREATE POLICY "anon_select_runs" ON runs FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_runs" ON runs;
CREATE POLICY "anon_insert_runs" ON runs FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_runs" ON runs;
CREATE POLICY "anon_update_runs" ON runs FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_runs" ON runs;
CREATE POLICY "anon_delete_runs" ON runs FOR DELETE TO anon, authenticated USING (true);