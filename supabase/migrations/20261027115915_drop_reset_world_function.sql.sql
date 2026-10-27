/*
# Drop reset_world function

The manual reset script performs the wipe with direct table deletes through
the Data API instead, so this SECURITY DEFINER function is no longer needed.
Dropping it also clears the security advisor warnings about a public
SECURITY DEFINER function.

1. Dropped Functions
- `reset_world()` — atomic wipe helper, replaced by client-side deletes.

2. Security
- Removes a SECURITY DEFINER function that was executable by anon and
  authenticated roles (advisor lint findings).
*/

DROP FUNCTION IF EXISTS reset_world();
