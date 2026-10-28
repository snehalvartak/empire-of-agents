/*
# Tick-stamped memories (SPEC section 8, section 9)

1. Problem
- A restored or forked era must inherit only the memories written before its starting point.
  That needs every memory row to carry the era it was written in and the world tick.

2. Modified Tables (new nullable columns, no data loss)
- `memories.session_id` (uuid, nullable) — the era the row was written in. It already exists
  (added with sessions and backfilled); `IF NOT EXISTS` keeps this migration safe either way.
- `memories.tick` (integer, nullable) — the world tick the row was written at, i.e. the tick the
  world shows once that turn is done (see `memoryTick` in src/sim/memory.ts). Rows written before
  this migration stay NULL and are treated as earlier-era history.
- Index on (session_id, tick) for the era-and-tick cut that fork inheritance reads.

3. Security
- No grant or policy change: `memories` already has RLS enabled with the anon + authenticated
  CRUD policies (single-tenant, no sign-in), and new columns inherit the table-level privileges.
*/

ALTER TABLE memories ADD COLUMN IF NOT EXISTS session_id uuid;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS tick integer;

CREATE INDEX IF NOT EXISTS idx_memories_session_tick ON memories (session_id, tick);
