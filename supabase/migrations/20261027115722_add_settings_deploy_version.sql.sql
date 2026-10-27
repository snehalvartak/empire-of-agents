/*
# Add deploy version tracking to settings

1. Modified Tables
- `settings`: new nullable column `deploy_version` (text).
  - Used to store the shipped world version. When the app loads and finds a
    different version than its built-in constant, it wipes the world state
    (villagers, structures, stockpile, chronicle) once, then stamps the new
    version. This gives a fresh world after each deploy without manual work.
  - A dedicated row with id 'world_state' holds the stamp; the existing
    'global' row keeps storing the OpenRouter key. Memories are untouched by
    the reset (the empire's records intentionally survive).

2. Security
- No policy changes: RLS and existing grants on `settings` already cover the
  new column (table-level grants).
*/

ALTER TABLE settings ADD COLUMN IF NOT EXISTS deploy_version text;
