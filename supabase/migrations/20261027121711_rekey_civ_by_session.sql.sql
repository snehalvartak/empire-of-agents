/*
# Key each session's stockpile row by its session id

The `civ` table's primary key is `id` (text). With sessions, each session has
exactly one stockpile row, so the row's id is set to the session's id. The
legacy single row (id 'global') belonging to Session 1 is renamed to Session
1's id so app upserts for Session 1 update it instead of duplicating.

1. Modified Tables
- `civ`: id set to session_id (as text) where a session_id exists.

2. Security
- No changes: existing grants and policies cover the update.
*/

UPDATE civ SET id = session_id::text WHERE session_id IS NOT NULL;
