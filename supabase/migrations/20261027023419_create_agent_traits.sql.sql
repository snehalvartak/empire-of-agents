/*
# Self-evolving villager traits

1. Modified Tables
- `agents`: adds `traits` (jsonb) — per-villager learned skills. Shape:
  { "woodcutting": {"level": 1, "xp": 0}, "foraging": {...}, "mining": {...},
    "building": {...}, "wisdom": {...} }
  Villagers gain XP from successful actions; every few XP a skill levels up,
  and the villager's AI prompt is enriched with its learned abilities.
2. Security
- No change: `traits` inherits the table's existing RLS (anon + authenticated full CRUD).
3. Notes
- Idempotent: uses IF NOT EXISTS with a jsonb default.
- Existing agents get level-1 skills in all five traits.
*/

ALTER TABLE agents ADD COLUMN IF NOT EXISTS traits jsonb NOT NULL DEFAULT
'{"woodcutting":{"level":1,"xp":0},"foraging":{"level":1,"xp":0},"mining":{"level":1,"xp":0},"building":{"level":1,"xp":0},"wisdom":{"level":1,"xp":0}}';
