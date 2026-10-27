/*
# Agent self-set goals and discoveries

1. Modified Tables
- `agents`: adds `goals` (jsonb, array of {text, created_tick}) — self-declared
  current goals the villager pursues across turns.
2. Notes
- Discoveries reuse the existing `memories` table with kind='discovery'.
- RLS unchanged (existing policies cover the new column).
*/

ALTER TABLE agents ADD COLUMN IF NOT EXISTS goals jsonb NOT NULL DEFAULT '[]';
