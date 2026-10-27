/*
# Forked eras (SPEC section 9, "Continue from here")

1. Modified Tables (new nullable columns, no data loss)
- `sessions.parent_session_id` (uuid, nullable) — the archived era this era was forked from;
  NULL for an ordinary era.
- `sessions.fork_tick` (integer, nullable) — the checkpoint tick it was forked at. Memories of the
  parent with tick <= fork_tick are what the fork inherits (src/sim/memory.ts).

2. Structures are keyed per era
- `structures.id` was the whole primary key, but ids are now a per-era counter (`built_1`,
  `cube_2`, ... — never the wall clock, R5.1), so two eras use the same ids, and a fork copies its
  parent's structures under the same ids. The primary key is replaced by a unique index on
  (session_id, id). Nothing reads structures by id alone and the table is not in the realtime
  publication, so the missing primary key does not matter.

3. Security
- No grant or policy change: `sessions` and `structures` already have RLS enabled with the anon +
  authenticated CRUD policies (single-tenant, no sign-in), and new columns inherit the table-level
  privileges.
*/

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS parent_session_id uuid;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS fork_tick integer;

ALTER TABLE structures DROP CONSTRAINT IF EXISTS structures_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS structures_session_id_id_key ON structures (session_id, id);
