/*
# Add session support to the world

1. New Tables
- `sessions`: one row per run of the world.
  - `id` (uuid, primary key, default gen_random_uuid())
  - `seq` (integer, not null, unique) — 1, 2, 3… for "Session 1" naming
  - `title` (text, not null) — story-derived title, e.g. "The First Founding"
  - `status` (text, not null, default 'live') — 'live' or 'archived'
  - `started_at` (timestamptz, not null, default now())
  - `ended_at` (timestamptz, nullable)
  - `summary` (text, nullable) — closing story summary written at archive time
  - `ticks`, `wood`, `food`, `gold`, `stone`, `age` (integers, nullable) —
    final state snapshot captured at archive time
  - `carry_memories` (boolean, not null, default true) — whether villagers
    entered this session remembering past sessions, or amnesiac

2. Modified Tables (new nullable columns, no data loss)
- `agents.session_id` — villager belongs to one session
- `structures.session_id` — building belongs to one session
- `civ.session_id` — stockpile snapshot belongs to one session (civ becomes
  one row per session; the old single 'global' row is tagged Session 1)
- `events.session_id` — chronicle entry belongs to one session
- `memories.session_id` — memory belongs to one session
- `runs.session_id` — run stats belong to one session (unused by the app but
  kept consistent)

3. Data Backfill
- A "Session 1" row is inserted with title 'The First Founding'.
- All existing rows in agents/structures/civ/events/memories are tagged with
  Session 1's id, so the current world (Alder and Bramble) is preserved.

4. Security
- RLS enabled on `sessions`; anon + authenticated full CRUD (single-tenant).
- Existing tables: no grant/policy changes — new columns inherit table-level
  privileges. `session_id` indexes added for session-filtered queries.
*/

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq integer NOT NULL UNIQUE,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'live',
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  summary text,
  ticks integer,
  wood integer,
  food integer,
  gold integer,
  stone integer,
  age integer,
  carry_memories boolean NOT NULL DEFAULT true
);

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO anon, authenticated;

DROP POLICY IF EXISTS "anon_select_sessions" ON sessions;
CREATE POLICY "anon_select_sessions" ON sessions FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_sessions" ON sessions;
CREATE POLICY "anon_insert_sessions" ON sessions FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_sessions" ON sessions;
CREATE POLICY "anon_update_sessions" ON sessions FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_sessions" ON sessions;
CREATE POLICY "anon_delete_sessions" ON sessions FOR DELETE TO anon, authenticated USING (true);

ALTER TABLE agents ADD COLUMN IF NOT EXISTS session_id uuid;
ALTER TABLE structures ADD COLUMN IF NOT EXISTS session_id uuid;
ALTER TABLE civ ADD COLUMN IF NOT EXISTS session_id uuid;
ALTER TABLE events ADD COLUMN IF NOT EXISTS session_id uuid;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS session_id uuid;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS session_id uuid;

CREATE INDEX IF NOT EXISTS idx_agents_session ON agents(session_id);
CREATE INDEX IF NOT EXISTS idx_structures_session ON structures(session_id);
CREATE INDEX IF NOT EXISTS idx_civ_session ON civ(session_id);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);

INSERT INTO sessions (seq, title, status, started_at)
SELECT 1, 'The First Founding', 'live', now()
WHERE NOT EXISTS (SELECT 1 FROM sessions);

DO $$
DECLARE
  sid uuid;
BEGIN
  SELECT id INTO sid FROM sessions WHERE seq = 1;
  UPDATE agents SET session_id = sid WHERE session_id IS NULL;
  UPDATE structures SET session_id = sid WHERE session_id IS NULL;
  UPDATE civ SET session_id = sid WHERE session_id IS NULL;
  UPDATE events SET session_id = sid WHERE session_id IS NULL;
  UPDATE memories SET session_id = sid WHERE session_id IS NULL;
  UPDATE runs SET session_id = sid WHERE session_id IS NULL;
END;
$$;
