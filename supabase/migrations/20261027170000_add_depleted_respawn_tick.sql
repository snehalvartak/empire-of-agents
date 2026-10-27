/*
# Tick-based animal respawn (clock rule, R5.1)

1. Changes
- `depleted_objects.respawn_tick` (integer, nullable) — the world tick at which a
  gathered animal returns to the wild; NULL for mines, which never come back.
  Replaces the wall-clock `respawn_at` column, which is no longer read or written
  (kept in place so the migration is non-destructive).
2. Backfill
- Legacy animal rows (`respawn_at` set, no `respawn_tick`) cannot be converted to a
  tick, and would otherwise read as permanent mine depletion. They are removed so
  the animals return to the wild.
*/

ALTER TABLE depleted_objects ADD COLUMN IF NOT EXISTS respawn_tick integer;

DELETE FROM depleted_objects WHERE respawn_at IS NOT NULL AND respawn_tick IS NULL;
