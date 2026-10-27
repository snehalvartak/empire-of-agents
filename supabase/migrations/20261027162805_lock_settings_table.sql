/*
# Lock down settings table

1. Problem
- The `settings` table stored the OpenRouter API key readable and writable by
  anyone (anon + authenticated) with the public key. Any visitor could read or
  replace the key.

2. Changes
- Drop all four anon policies on `settings`.
- Revoke SELECT/INSERT/UPDATE/DELETE from `anon` and `authenticated`.
- Grant nothing to any client-facing role: the edge function reads it with the
  service role key, which bypasses RLS and does not need grants.

3. Notes
- The key is now set through the `settings-key` edge function (added in this
  change), which returns only a boolean "is set" answer — never the key itself.
*/

DROP POLICY IF EXISTS "anon_select_settings" ON settings;
DROP POLICY IF EXISTS "anon_insert_settings" ON settings;
DROP POLICY IF EXISTS "anon_update_settings" ON settings;
DROP POLICY IF EXISTS "anon_delete_settings" ON settings;

REVOKE ALL ON settings FROM anon, authenticated;