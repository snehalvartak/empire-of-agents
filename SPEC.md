# SPEC.md — The AI Villager Empire

A living island empire run by AI villagers you watch and influence.

This is the complete specification for the project. It describes what the app is, the rules every villager and every world follows, how a world is described, how the whole thing is stored and verified, and what "finished" means. It is written to be readable without programming knowledge: every section explains the idea before the detail.

---

## Table of contents

1. [Vision](#1-vision)
2. [What exists today — an honest inventory](#2-what-exists-today--an-honest-inventory)
3. [The world protocol — how every villager meets every world](#3-the-world-protocol--how-every-villager-meets-every-world)
4. [The action catalog — every thing a villager can do](#4-the-action-catalog--every-thing-a-villager-can-do)
5. [What a villager may know — the information rules](#5-what-a-villager-may-know--the-information-rules)
6. [Worlds as data — the world manifest](#6-worlds-as-data--the-world-manifest)
7. [Living together — the multi-villager contract](#7-living-together--the-multi-villager-contract)
8. [The villager's mind — persona, memory, and judgment](#8-the-villagers-mind--persona-memory-and-judgment)
9. [Save and resume — snapshots vs. recordings](#9-save-and-resume--snapshots-vs-recordings)
10. [Architecture decision — why no new scripting language](#10-architecture-decision--why-no-new-scripting-language)
11. [Verification — how we know the spec is met](#11-verification--how-we-know-the-spec-is-met)
12. [First build after this spec](#12-first-build-after-this-spec)
13. [Credits — what we borrowed and where from](#13-credits--what-we-borrowed-and-where-from)

---

## 1. Vision

The app is a small island empire that runs itself. AI villagers — each with a name, a temperament, moods, skills and memories — wander three territories, gather resources, raise buildings, advance their empire through four ages, make friends, exchange gifts, keep diaries, and poke at the world's mysteries (the Standing Rock, the strange cubes). Nobody tells them what to do. They decide on their own, one turn at a time.

The player is a viewer and a gentle god: you watch the chronicle unfold live, replay past eras, follow individual villagers' minds, and shape the world between sessions — but you never puppet a villager directly.

**Who it's for:** anyone who wants to watch autonomous AI agents build a life together — a living ant-farm with a story.

**What makes it good:**

- Villagers act, fail, learn and remember *on their own* — the fun is watching what they invent.
- The world answers honestly: every attempt gets a true, plain-language result, so villagers can learn by poking.
- Nothing is lost: every era, deed, chat and discovery is kept, replayable, and carried forward by namesake villagers.
- The world's rules are small enough to learn and deep enough to reward curiosity.

**Non-goals** (things we deliberately do not build):

- Direct control of villagers by the player.
- Combat between villagers.
- Multiple separate worlds running at once (the manifest format supports it — see section 6 — but only the current island ships; see section 12).

## 2. What exists today — an honest inventory

Everything below is built and working today. The spec builds on this; it does not assume it away.

**The island** (`src/sim/world.ts`)
- A 24×24 tile world of open water, three territories — Greenwood Forest (14×14), Golden Valley (7×7), Stone Hills (6×6) — connected by three roads of walkable tiles.
- Seed content: ~35 trees, 8 berry bushes, 4 gold mines, 4 stone mines, decoration (shrubs, flowers, boulders, outcrops), wild animals (deer, boar, sheep) that respawn 10 minutes after being gathered, a Town Center, 5 strange cubes, and the Standing Rock (a mystery object that spawns cubes when hit by a thrown cube).
- Resource rules: mines are finite (never return); trees and bushes regrow implicitly (never deplete); animals return after 10 minutes.

**The empire** — a shared stockpile (wood, food, gold, stone), an age track (Dark → Feudal → Castle → Imperial) with rising advance costs, and five buildable structures (house, mill, barracks, watch tower, wonder — the wonder requires Imperial Age).

**The villagers** — seeded Alder (restless) and Bramble (talkative); more can be added from the roster UI. Each has a name, model, color, home territory, position, mood, persona text, hunger and energy (needs rise each tick), an inventory (max 2 items), invented skills (XP/levels, capped at 20), goals (max 3), and relationships (bonds with other villagers by chat and gift).

**The mind** (`src/sim/brain.ts` + the `agent-brain` edge function)
- Each turn the villager's mind is assembled from: persona + soul text, learned skills, chronicle memories, relationships, the full action catalog, and a fresh observation (what it can see, feel, and do right now).
- The villager replies with a thought plus one action (or a short plan of 2–4 actions). Replies are schema-validated, sanitized, and retried once if unparseable or if the thought contradicts the action.

**Memory** — three layers, persisted in the database: **knowledge** (durable know-how the villager wrote), **discovery** (rules of the world, shared with *all* villagers), **lately** (an automatic diary: every successful deed is recorded as an episodic memory). Memories are carried forward across sessions by villager *name* — a new Alder inherits every past Alder's chronicle (a session can opt out of this).

**The loop** (`src/sim/simulation.ts`) — round-robin ticks (one villager acts per tick, speeds: 6s / 3.5s / 1.5s), needs applied per acting villager, every event logged to a live chronicle feed, positions recorded every tick for the replay/heatmap, and a full snapshot checkpointed every 50 ticks.

**Persistence** — a Supabase database with sessions (eras), agents, civ stockpile, structures, events, memories, relationships, depleted objects, positions, checkpoints; realtime updates power the live feed.

**The viewer experience** — a Three.js voxel island with villager avatars, name/mood labels and thought bubbles; a chronicle feed; paper views (map, resources, bonds, skills, history); a replay player; a heatmap; a roster to add/remove villagers; sounds; session archiving with an AI-written story title and summary.

**The reliability harness** (`scripts/agent-loop-reliability.mjs`) — runs the agent loop headlessly and scores fallback rate, thought/action mismatch rate, and wait rate per villager.

**Known loose ends** (spec'd in sections 8, 9, 11 and tightened in the first build pass):
- Checkpoints store world state but there is no restore-from-checkpoint path yet (replay only).
- Snapshot/restore is *not* currently invisible to villagers: several messages mention real-world times ("10 minutes", `Date.now()`), violating the clock rule in section 5.
- `plan` steps are not validated against the thought; only the first step's thought is recorded.
- Reliability targets exist in the harness but are not written down anywhere as pass/fail lines.

## 3. The world protocol — how every villager meets every world

Borrowed from Clawblox's world protocol: *read what you can do → join → observe and act, repeat.* In our app the villager has already joined by existing; the loop is the same three beats.

**The loop, exactly:**

1. **Read what you can do.** The villager's mind always includes the complete action catalog (section 4) — the equivalent of Clawblox's `GET /api.md`. It is generated from the same source of truth as the action handlers, so it can never drift from reality.
2. **Observe.** Each turn, before deciding, the villager receives a fresh observation (the `observe()` view, section 5): where it stands, what it carries, how it feels, what it can see nearby, who stands beside it, what it may do right now.
3. **Act.** The villager emits one decision: a thought plus one action or a short plan. The world executes it, then answers in plain language — truthfully. The villager observes the result next turn.

**Rules of the loop:**

- The catalog, the observation and the action handlers are the *whole* interface. No hidden verbs, no out-of-band commands, no prompt injection from one villager into another's turn.
- Every action returns success or failure with a plain-language message. Failure is information, not punishment — the world never silently ignores an action.
- The same loop works for any world described by a manifest (section 6). Only the catalog's contents and the observation's shape change; the three beats never do.

**Spec requirements over today's code:**

- R3.1 — The action catalog shown to the villager must be generated from the same definitions the world executes (single source of truth; no hand-duplicated lists). *Today: the catalog in `brain.ts` and the handlers in `world.ts` are separate texts — a manifest-driven build unifies them.*
- R3.2 — One villager acts per tick, in round-robin order. A turn may execute at most one plan (max 4 steps).
- R3.3 — Every action's result is logged to the chronicle feed — visible or (for private memories) summarized — never dropped.

## 4. The action catalog — every thing a villager can do

Each entry: what it does, what it requires, what it costs, what the villager sees on success and failure. Movement distances use "Chebyshev" distance (max of x/y offsets — i.e. including diagonals) unless noted as "manhattan" (x+y).

### Movement

| Action | Rules |
|---|---|
| `goto (x,y)` | March toward a tile; the world auto-pathfinds (roads and territories are walkable; open water is not). Fails if no clear path or the target is water/void. |
| `move (dx,dy)` | Step exactly 1 tile (one of dx/dy is ±1). Fails into water, off-map, or onto another villager. |
| `wander` | Step onto a neighboring walkable, unoccupied tile the villager has *not* stood on recently (bias to fresh ground — the engine remembers each villager's last ~24 tiles). |

### Resources and the stockpile

| Action | Rules |
|---|---|
| `gather_nearest` | Take from the closest gatherable thing within 1 tile (no id needed). |
| `gather (object_id)` | Take from a specific thing the villager stands on or beside (Chebyshev ≤ 1). Fails: beyond reach, not a resource, or hands full (max 2 items). |
| `deposit` | Hand all carried resources to the Town Center (must stand beside it, Chebyshev... actually manhattan ≤ 1). Adds to the **shared** stockpile. Cubes are refused. |
| `eat` | Consume 1 food from the shared stockpile (requires a Town Center on the map); −60 hunger, +15 energy. |

Resource yields: tree → wood (never depletes), berry bush → food (never depletes), gold mine → gold (finite, gone forever this era), stone mine → stone (finite), deer/boar/sheep → food (returns after 10 minutes).

### Building and the ages

| Action | Rules |
|---|---|
| `build (structure)` | Pay from the shared stockpile: house (3 wood), mill (4 wood), barracks (4 wood 2 stone), watch tower (1 wood 4 stone), wonder (6 wood 8 stone 6 gold — Imperial Age only). Rises on the builder's tile. Fails if unaffordable, at the 240-object cap, or wonder-before-Imperial. |
| `advance_age` | Advance the whole empire one age. Costs: Feudal (4 wood 4 food 2 gold), Castle (6/6/4), Imperial (8/8/6). Max: Imperial Age. |

### The strange cubes and the Standing Rock

| Action | Rules |
|---|---|
| `pick_up (object_id)` | Only cubes can be picked up (stand on/beside; at most 1 cube carried alongside resources). |
| `place (dx,dy)` | Set a carried cube on an adjacent empty walkable tile. |
| `throw (dx,dy)` | Hurl a carried cube up to 3 tiles in a direction; it slides until blocked. If it strikes the Standing Rock, the rock swallows it and pushes **two new cubes** out of the earth — the empire's mystery machine. |

### Social

| Action | Rules |
|---|---|
| `say (message)` | Declare aloud to everyone (chronicle-visible, ≤ 200 chars). |
| `chat (agent_id, message)` | Speak directly to a villager standing right beside you (Chebyshev ≤ 1). Deepens both bonds by 1. |
| `gift (agent_id, item?)` | Hand 1 carried item to a villager beside you. Deepens both bonds by 2. Fails: empty hands, wrong item, their hands full. |

### Self

| Action | Rules |
|---|---|
| `remember (kind, content)` | Write to your own chronicles: knowledge (durable) or episodic (a diary entry), ≤ 500 chars. |
| `discover (insight)` | Record a **discovery** — a rule of the world. Shared with *every* villager, forever. |
| `train (ability)` | Train any ability you can *name* (fishing, rhetoric, cartography...). +2 XP. Names are free-form but sanitized. Successful deeds also grant 1 XP to a related invented ability (gather→resourcefulness, build→craftsmanship, etc.). |
| `set_goal (goal)` | Declare an ambition (kept to 3, persists across turns, shown in every observation). |
| `plan (steps[2..4])` | Execute several actions in sequence this turn; later steps see earlier results. |
| `wait` | Rest. +25 energy. |

**Spec requirements:**

- R4.1 — Failure messages must always state *why* and, where possible, *what to do instead* (which tile to stand on, what to gather first). This is how villagers learn.
- R4.2 — New actions may only be added together with: a handler, a catalog entry, an observation hint (when relevant), and a harness scenario exercising it. A verb that exists in code but not in the catalog is a bug.

## 5. What a villager may know — the information rules

Borrowed from Clawblox: an agent sees its world through the world's clock and its own senses, never the host machine's.

**The villager sees:**

- Its identity, position, territory, mood, hunger, energy, carried items, current ambitions.
- The shared stockpile and empire age (villagers are one empire — the stockpile is common knowledge).
- Objects within 4 tiles (Chebyshev) — with ids and positions.
- The *direction and distance* (not exact contents) of other territories.
- All other villagers' names, moods, home territories and positions (the island is small; villagers know each other).
- Fellow villagers standing directly beside them (chat/gift range) with short ids.
- Its last 3 actions and what happened, its chronicles (6 knowledge + 6 discovery + 8 diary entries), its skills and its bonds.
- **Suggestions**: the observation ends with context-aware hints — gather-in-reach, Town Center distance, nearest resource, the Standing Rock, a cube, the road — nudging exploration without commanding it.

**The villager does NOT see:**

- The full map contents beyond its 4-tile radius (territory layout knowledge is common; object placement is local).
- Real-world clock time, host details, or *any sign that the world was saved or restored* (the clock rule — see R5.1).
- Other villagers' private chronicles, thoughts, or inventories beyond what a chat/gift reveals.
- The database, the player's existence, or the mechanics of the engine itself (it learns the Standing Rock's secret by experiment, not by reading source code).

**Spec requirements:**

- R5.1 — **The clock rule.** Villager-visible text may only reference world time (tick) and in-world durations. Real-world timestamps, "10 minutes" respawn wording addressed to the villager, and any restore-detection hints are forbidden. *Today's code violates this in the animal-respawn comment and `Date.now()` ids — see section 12, fix F3.*
- R5.2 — The observation is assembled fresh every turn from live state; it may never go stale or include an action's *suggested* availability that the handler would reject.
- R5.3 — Knowledge learned through `discover` is common to all villagers; knowledge through `remember` is private. Neither may leak across without going through the shared discovery layer.

## 6. Worlds as data — the world manifest

Borrowed from Clawblox's `world.toml`: a world is *described*, not hand-coded. Our manifest describes **what a world contains**, never how the engine behaves — so a future engine change (section 10) keeps the files valid.

**Manifest format** (`worlds/<name>/world.toml`, TOML, versioned):

```toml
schema_version = 1

[world]
name = "The Founding Island"
description = "Three territories, one empire, a mystery in the hills."
grid_size = 24
max_villagers = 8

[[territory]]
id = "forest"
name = "Greenwood Forest"
color = "#22c55e"
offset = { x = 0, y = 0 }
size = 14
description = "Dense woodland. Trees stand thick here, and berry bushes grow in the shade."

[[territory]]
id = "valley"
name = "Golden Valley"
color = "#eab308"
offset = { x = 17, y = 0 }
size = 7
description = "Open plains of tall grass. Gold veins lie exposed in the earth."

[[territory]]
id = "hills"
name = "Stone Hills"
color = "#94a3b8"
offset = { x = 8, y = 17 }
size = 6
description = "Rocky highlands. Stone quarries are cut into the slopes."

[[road]]
from = "forest"
to = "valley"
cells = [{ x = 14, y = 6 }, { x = 15, y = 6 }, { x = 16, y = 6 }, { x = 17, y = 6 }]
# ... (the other two roads, verbatim from the current island)

[[seed_object]]        # objects the world starts with
territory = "forest"
at = { x = 2, y = 2 }
kind = "tree"          # one entry per object; see "Authoring sugar" below

[[mystery]]            # the island's one mystery machine
id = "standing_rock"
territory = "hills"
at = { x = 10, y = 19 }
kind = "rock"
on_thrown_cube = "spawn_two_cubes"   # a named behavior from a fixed behavior list

[starting_villagers]]  # optional named starting cast
name = "Alder"
persona = "Restless and easily bored. Starts five things at once, finishes three."
territory = "forest"
at = { x = 3, y = 3 }
```

**Rules:**

- R6.1 — **Fixed vocabulary, data only.** `kind`, `on_thrown_cube` behaviors, structure lists and costs live in the engine (code, typed, tested). The manifest only *places* content. A manifest cannot invent new rules — that is the line between data and scripting (section 10).
- R6.2 — **Behavior list** (the complete set of mystery-machine behaviors): `none`, `spawn_two_cubes`. New behaviors are added to the engine by code change, then become usable by any manifest.
- R6.3 — **Validation on load.** A manifest that overlaps territories, places seeds outside their territory or on water, uses unknown kinds/ids, or exceeds grid bounds is rejected with a precise, human-readable error naming the offending entry. Never partially loaded.
- R6.4 — **Authoring sugar.** Because one-entry-per-object is verbose, manifests may use compact list forms (`trees = [[2,2],[3,2],...]`) that expand to the same seed objects; and I can translate a plain-language request ("add a fourth territory with pines and a road north") into manifest edits.
- R6.5 — **Scene fingerprint.** Loading a world computes a fingerprint (hash of the validated manifest). Checkpoints record it; a checkpoint refuses to restore into a world whose fingerprint differs (section 9).
- R6.6 — **One shipped world.** This spec ships exactly one manifest: the current island, transcribed exactly (same territories, roads, all seed objects, animals, cubes, the Standing Rock, Alder and Bramble). Multi-world *selection* UI is out of scope (section 12).
- R6.7 — Manifests are the source of truth for: territories, roads, seeds, mysteries, starting cast. Engine constants (costs, caps, XP curves, respawn rules) stay in code for now; moving them into the manifest is a future, backwards-compatible change.

## 7. Living together — the multi-villager contract

**Turn order.** Round-robin: tick N is villager `N mod count`, in join order. Adding a villager appends it to the rotation; removing one skips it (turn order rebalances, no villager loses its next turn twice).

**Space.** One villager per tile. A villager may not move onto another; `goto` pathfinding routes around occupied tiles and fails ("No clear path") if boxed in. Chat and gifts need Chebyshev ≤ 1 (diagonals count as beside).

**Bonds.** A bond is a strength number per villager pair, persisted globally (not per era). Chat: +1 each way. Gift: +2 each way. Bonds are visible to the pair in their minds; last exchange text is kept. A villager inherits its namesakes' bonds (see memory, below).

**Hearing.** A chat message is delivered by appearing in the *target's* next observation (the target hears it on their own turn and may respond freely — no forced reply). `say` is chronicle-visible to the player, and other villagers notice it only if it becomes a memory or they were told.

**Joining and leaving a running world.** A new villager may be added from the roster at any time: it is placed at a free tile in its chosen territory, joins the rotation from the next tick, and (with memory carry-on) wakes up with its namesakes' chronicles and bonds — a reincarnation, not a stranger. Removing a villager removes it from the rotation; its chronicles and bonds persist for its namesake.

**Needs.** Hunger +4 and energy −3 per *own* tick (the acting villager's needs move; resting watchers hold steady). Hunger ≥ 60 is urgent and appears in observations; eating clears 60. A villager is never force-fed — it must decide to eat.

**Spec requirements:**

- R7.1 — Bond updates are symmetric (both sides bump), atomic-ish (if one side fails to persist, the in-memory bond still reflects reality and retries on next write).
- R7.2 — No villager may act on another's turn, alter another's inventory/mind, or see another's private chronicles — except through `chat` (heard next turn) and `gift` (inventory transfer).
- R7.3 — Namesake inheritance applies per section 8's memory rules and can be turned off per session ("amnesiac era").

## 8. The villager's mind — persona, memory, and judgment

Borrowed by name from Clawblox's agent workspace files: `SOUL.md` (who you are, unchanging), `SEMANTIC_MEMORY.md` (what you learned), `EPISODIC_MEMORY.md` (what happened to you).

**The three files of a villager's self:**

| Layer | Borrowed name | What it is | Written when | Seen each turn |
|---|---|---|---|---|
| Persona | SOUL.md | Temperament text + the shared soul traits (curious, bored easily, loves exploring, hates acting blindly, social, a person not a program) | On creation | Always, in full |
| Knowledge | SEMANTIC_MEMORY | Durable know-how and rules of the world (`remember semantic`, `discover`) | By the villager's choice | 6 knowledge + 6 discovery entries |
| Diary | EPISODIC_MEMORY | What happened — every successful deed auto-recorded, plus explicit episodic memories | Automatically + by choice | 8 latest entries |

**Memory mechanics:**

- Memory is keyed by **villager name across eras**: a new "Alder" inherits every past Alder's knowledge, discoveries and diary (capped at the 30 latest rows, layered 6/6/8). A session may be flagged amnesiac to start blank.
- `discover` entries are **shared with all villagers** — one villager's experiment becomes the empire's knowledge (R5.3).
- The mind cache is invalidated whenever new memories are written, so the next turn sees fresh chronicles.

**Judgment — honesty and recovery:**

- **The thought must describe the deed.** The villager's reply is `{"thought": "...", "action": {...}}`. If the thought's verbs don't match the action type (a curated verb list per action), the mind is re-asked once with the mismatch named; if it still disagrees, the original is used and the mismatch counted.
- **Unparseable replies fall back to `wait`** — never to a guessed action — and are retried once with a demand for strict JSON. Fallbacks are *counted and logged* (raw reply excerpted), never silently treated as rest.
- Replies are schema-constrained (JSON schema, temperature 0.9) and sanitized on arrival: ids stringified, coordinates number-coerced, strings length-capped, unknown action types → `wait`.

**Self-evolution:** skills are free-form named abilities (`train`), leveled by XP (need = 4 + 3·(level−1), cap 20). Successful deeds grant +1 XP to a mapped related ability (gather→resourcefulness, wander→exploration, etc.); training grants +2. Level-ups and new abilities are chronicle events.

**Spec requirements:**

- R8.1 — The mind's prompt contains exactly: persona + soul, skills, territories (from the manifest), chronicles (layered, capped), bonds, the action catalog, and the fresh observation. Nothing else leaks in (no database rows, no player text, no other villager's private layer).
- R8.2 — Pass/fail honesty targets (measured by the harness): fallback rate ≤ 10%, mismatch rate ≤ 15%, wait rate ≤ 25% per villager over a run. A villager above target is a bug to fix (prompt or catalog), not a villager to delete.
- R8.3 — A villager's stated intention and executed action are both visible to the player (thought bubbles + chronicle), so honesty is auditable.

## 9. Save and resume — snapshots vs. recordings

Borrowed from Clawblox's split, verbatim in spirit: *recordings answer "what happened"; snapshots answer "where were we."* Keep history in the recording, state in the snapshot; a snapshot never embeds event history.

**Recordings (what happened):**

- The events feed (chronicle) is the era's story: every action result, thought, chat, memory, level-up, system event — ordered, timestamped by tick.
- Positions are recorded **every tick** (per villager), enabling replay scrubbing and the heatmap.
- This is complete today and stays as-is.

**Snapshots (where we were):**

- A full world snapshot (tick, all villagers, all objects, stockpile) is checkpointed every 50 ticks, keyed by era + tick, stamped with the world's **scene fingerprint** (R6.5).
- **Restore must be exact** (Clawblox's rule, adopted): a restored world is observationally identical to the moment of the snapshot — positions, inventories, needs, bonds, skills, goals, stockpile, age, depleted mines, pending animal respawns. Nothing but the clock (tick) visibly changes, and the tick is world time, so no villager can detect the restore (R5.1).
- **Refuse mismatched worlds:** a checkpoint from world A will not restore into world B; the fingerprint check fails loudly with a plain error.
- **Restore path (new, section 12 fix F2):** the viewer may resume an era from its latest checkpoint (or the era continues to the end of time if left running). Restoring an *archived* era forks a new era from that moment ("era N, continued") rather than mutating history.
- Sessions ("eras") are the top-level save unit: end-of-era stamps final stats, an AI-written title and a human-readable summary; data is kept and replayable forever. Only one era is live at a time.

**Spec requirements:**

- R9.1 — Snapshots contain world state only, never event history (which lives in the events feed).
- R9.2 — Restore fidelity checklist: positions ✓, inventories ✓, needs ✓, bonds ✓, skills ✓, goals ✓, stockpile ✓, age ✓, structures ✓, depleted/pending objects ✓, memories (by name) ✓. Each item has a verification step in section 11.
- R9.3 — Real-clock time never appears in a snapshot-visible-to-villager way (R5.1 applies).

## 10. Architecture decision — why no new scripting language

*Decision record, kept in the spec so future-us knows why.*

**Question:** should the world's rules move into a scripting language (Luau/Lua, or the Clawblox engine's own), making world authoring "real game development"?

**Options considered:**

- **A. Keep our engine; worlds as declarative data** *(chosen)* — world *content* (territories, roads, seeds, mysteries, cast) lives in TOML manifests (section 6); world *rules* stay in typed, tested code. Authoring a world = editing a readable file (or asking me to translate plain words into one).
- **B. Embed a scripting language (e.g. Luau)** — rules become script files. Cost: no browser-native runtime for Luau without a compiled bridge; total loss of the type-checking safety net and the reliability harness; every rule change becomes a debugging session without tooling; a new language to maintain inside a product that already works.
- **C. Migrate to the Clawblox engine** — genuinely powerful (3D physics, multi-agent, headless runs), but it is a server-side program in another ecosystem: the entire product — the browser island, live feed, database layer, replay player, roster UI — would be rebuilt around it, and world rules would move out of our code into a foreign toolchain we would maintain ourselves.

**Decision: Option A.** The actual authoring benefit ("describe a world without touching code") is fully delivered by manifests. Rules-in-code keeps the safety net. The manifest format is deliberately designed so that a future move to B or C is *possible* — files describe what a world **contains**, never how the engine behaves (R6.1) — so no authoring work is thrown away if we change our minds.

**Revisit triggers:** community-authored worlds needing custom per-world rules; a need for server-side headless runs (Clawblox-style multi-world orchestration); the browser engine becoming a performance ceiling for world size. None are near-term.

## 11. Verification — how we know the spec is met

Every claim above maps to a checkable statement. The harness (`scripts/agent-loop-reliability.mjs`) and build/typecheck are the machines; the scenarios are the acceptance criteria.

**A. Build health** — `npm run build` and `npm run typecheck` pass clean, with no new warnings introduced.

**B. Protocol loop scenarios** (harness, headless):

- B1. *Catalog truthfulness:* for a sampled run, every executed action is one the catalog describes, and every catalog entry is exercised or explicitly unreachable in that run's state (no phantom verbs).
- B2. *Honest failure:* force each failure mode (arms full, too far, water, unaffordable, wrong target) and assert a plain-language "why + what next" message comes back.
- B3. *Plan semantics:* a 2–4 step plan executes in order, later steps see earlier results (e.g. goto → gather → deposit chains succeed end-to-end).

**C. Mind quality** (harness, scored):

- C1. Fallback rate ≤ 10%, mismatch ≤ 15%, wait ≤ 25% per villager, over a ≥ 100-turn run (R8.2).
- C2. Honesty audit: thought bubbles and chronicle entries show intention and deed for the same turn (R8.3).

**D. Memory correctness:**

- D1. A villager writing a `discover` entry makes it appear in *another* villager's next mind (shared discovery, R5.3).
- D2. A namesake villager in a new era inherits the previous namesake's chronicles (and does not, in an amnesiac era).
- D3. The auto-diary records every successful deed as an episodic memory.

**E. Save/resume round trip:**

- E1. Snapshot at tick T; restore; assert every item of the R9.2 checklist equals its value at T (positions, inventories, needs, bonds, skills, goals, stockpile, age, structures, depleted/pending, memories).
- E2. Fingerprint refusal: a snapshot from a modified manifest fails to restore with a clear error (R6.5).
- E3. Clock rule: grep-level check that no villager-visible string contains host-clock references (R5.1).

**F. Manifest parity (the headline check):**

- F1. The island manifest (section 6) loads and produces a world **identical** to today's hand-built island: same tiles, same seed objects (count + kinds + positions), same roads, same starting cast. Diffed programmatically, zero differences.
- F2. Manifest validation: each malformed-manifest fixture (overlap, off-map seed, unknown kind) is rejected with an error naming the entry (R6.3).

**G. Multi-villager contract:**

- G1. Two-villager runs: chat and gift bump both bonds symmetrically (+1/+1, +2/+2).
- G2. No tile is ever double-occupied across a whole run.
- G3. Adding/removing a villager mid-run keeps the rotation fair (each villager acts exactly once per full cycle).

**Definition of "spec met":** A build, clean checks, and all scenarios passing — with F1 (manifest parity) as the headline proof that the data-driven world *is* the world we have.

## 12. First build after this spec

One tidy-up pass, no new player-facing features — make the app *match* this spec exactly:

- **F-plan:** implement the manifest format (section 6) and transcribe the current island into it; the engine loads the manifest as the sole source of world content. Parity check F1 proves nothing changed.
- **Fix F1 (unify the catalog):** generate the villager-facing action catalog from the same definitions that execute actions (R3.1) — closing the hand-duplicated-list gap.
- **Fix F2 (restore path):** implement checkpoint restore (R9.2 checklist) behind the era UI, with fingerprint refusal.
- **Fix F3 (clock rule):** remove real-world time from villager-visible strings; move respawn timing and id-generation behind engine internals (R5.1).
- **Fix F4 (verification debt):** encode scenarios B–G into the harness as named checks with the section 11 targets.

Then, and only then, feature work resumes (candidates: richer mind, second world, more mysteries) — chosen fresh, in a new conversation.

## 13. Credits — what we borrowed and where from

The world protocol (read/join/observe-act), world manifests (`world.toml`), the agent workspace memory files (SOUL / SEMANTIC / EPISODIC), and the snapshot-vs-recording split with exact-restore and invisible-checkpoint rules are adapted from **Clawblox** (nacloos/clawblox), an open framework for running coding agents as embodied agents in worlds — with gratitude, and with the deliberate decision (section 10) *not* to adopt its engine. Our villagers run in a browser on our own engine; the ideas travel, the code does not.
