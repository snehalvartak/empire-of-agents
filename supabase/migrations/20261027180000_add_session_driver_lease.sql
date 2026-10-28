/*
# Single-driver lease on sessions (R7.6, R9.4)

1. Problem
- Two windows open on the same live era would both run the tick loop and both
  write positions, events and checkpoints, corrupting the era.

2. Modified Tables (new nullable columns, no data loss)
- `sessions.driver_id` (text, nullable) — random id of the window that currently
  drives the tick loop for this era; NULL when nobody drives it.
- `sessions.driver_heartbeat_at` (timestamptz, nullable) — last time the driver
  renewed its lease. A lease older than 30 seconds counts as timed out and may be
  taken over (see src/sim/driver.ts).

3. Security
- No grant or policy change: `sessions` already has RLS enabled and the
  anon + authenticated UPDATE policy (single-tenant, no sign-in), and new columns
  inherit the table-level privileges. The lease is claimed with one conditional
  UPDATE ... WHERE (driver_id IS NULL OR driver_id = me OR heartbeat <= cutoff),
  so exactly one competing claim can succeed.
*/

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS driver_id text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS driver_heartbeat_at timestamptz;
