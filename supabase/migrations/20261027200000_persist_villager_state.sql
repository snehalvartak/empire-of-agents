/*
# Persist what a villager carries, what they have not yet heard, and whose turn is next

1. Problem
- A page reload rebuilt every villager from `agents`, which held position, needs, mood, skills and
  goals but not their inventory or their pending chat, and the turn cursor lived only in memory.
  A reload therefore made every villager drop what they carried, forget unread chat and restart the
  rotation. Checkpoints hold these but are written every 50 ticks and only read by "Continue from here".

2. Modified Tables (new columns, no data loss)
- `agents.inventory` (jsonb, NOT NULL, default '[]') — the items carried, e.g. ["wood","cube"].
- `agents.inbox` (jsonb, NOT NULL, default '[]') — chat not yet heard, oldest first, at most 3:
  [{"fromId": "...", "fromName": "...", "message": "..."}] (R7.4).
- `sessions.last_actor_id` (uuid, nullable) — the villager who acted last in this era; NULL before
  anyone has acted. Deliberately no foreign key: the villager may be dismissed afterwards and the
  rotation then falls back to `last_actor_index` (src/sim/rotation.ts).
- `sessions.last_actor_index` (integer, nullable) — the roster index that villager held (R7.5).
  Existing rows get the defaults ('[]' / NULL), which is what a fresh era starts with.
- The values are written and read defensively by src/sim/persisted.ts (never trusted as typed).

3. Security
- No grant or policy change: `agents` and `sessions` already have RLS enabled and the anon +
  authenticated CRUD policies (single-tenant, no sign-in), and new columns inherit the table-level
  privileges.
*/

ALTER TABLE agents ADD COLUMN IF NOT EXISTS inventory jsonb NOT NULL DEFAULT '[]';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS inbox jsonb NOT NULL DEFAULT '[]';

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_actor_id uuid;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_actor_index integer;
