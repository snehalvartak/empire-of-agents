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

**What "influence" means.** The player's levers are exactly these, and no others: add or remove villagers from the roster; start, end, fork or resume an era (including an "amnesiac" era); and edit the world manifest between eras (section 6). The player never sends text, commands or hints into a villager's mind (R8.1, R7.2).

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
- Any channel from the player into a villager's mind (text, commands, hints) — see "What influence means" above.

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
- Snapshot/restore is *not* currently invisible to villagers: animal respawn runs on the wall clock (`Date.now() + ANIMAL_RESPAWN_MS`) and object ids are built from `Date.now()` (`built_…`, `cube_…`), violating the clock rule in section 5 and making pending respawns unrestorable. (No villager-visible message currently says "10 minutes"; the constant is internal.)
- `plan` steps are not validated against the thought; only the first step's action is checked (rule in R8.4: every step must be covered by the thought).
- Reliability targets exist in the harness but were not written down as pass/fail lines, and the harness scores a re-implementation of the brain (its own copy of the decide/mismatch logic) in aggregate, not per villager (R8.2, R11.1).
- Chat "hearing" (section 7) is not implemented: a chat only updates the bond's last-exchange text; the target is not shown the message on its next turn (R7.4).
- Observation hints name the nearest resource and the Standing Rock anywhere on the map, and the rock hint reveals its mechanic ("rumor says it reacts to thrown cubes") — see R5.4.
- Turn order is `tick % villager-count`, which reshuffles when the roster changes (R7.5).

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

- R3.1 — The action catalog shown to the villager must be generated from the same definitions the world executes (single source of truth; no hand-duplicated lists). *Today the action list exists in at least five places: the catalog text and the JSON-schema action-type enum and the sanitizer switch (all in `brain.ts`), the thought/deed verb families (`brain.ts`), and the action type union and handlers (`world.ts`) — plus a further copy inside the harness. All must derive from one action-definition table (name, argument schema, catalog line, verb family, handler).*
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
| `deposit` | Hand all carried resources to the Town Center (must stand beside it: manhattan distance ≤ 1, no diagonals). Adds to the **shared** stockpile. Cubes are refused. |
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
| `remember (kind, content)` | Write to your own chronicles. `kind` is `semantic` (durable knowledge) or `episodic` (a diary entry), ≤ 500 chars. |
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
- **Suggestions**: the observation ends with context-aware hints — gather-in-reach, Town Center distance, nearest resource, the Standing Rock's location, a cube, the road — nudging exploration without commanding it. Hints are *locations only* (R5.4).

**The villager does NOT see:**

- The full map contents beyond its 4-tile radius (territory layout knowledge is common; object placement is local). The only exceptions are the suggestion hints above, which are deliberate, location-only, and limited to: the nearest gatherable, the Town Center, the Standing Rock, the nearest strange cube, and the nearest road.
- Real-world clock time, host details, or *any sign that the world was saved or restored* (the clock rule — see R5.1).
- Other villagers' private chronicles, thoughts, or inventories beyond what a chat/gift reveals.
- The database, the player's existence, or the mechanics of the engine itself (it learns the Standing Rock's secret by experiment, not by reading source code).

**Spec requirements:**

- R5.1 — **The clock rule.** Villager-visible text may only reference world time (tick) and in-world durations. Real-world timestamps, wall-clock durations ("10 minutes") and any restore-detection hints are forbidden, and **no engine behavior may depend on the wall clock**. Concretely: animal respawn is counted in ticks (a fixed number of world ticks after gathering, stored as a due-tick), and object ids come from a per-era counter, never `Date.now()`. *Today's code violates this in animal respawn and in `built_`/`cube_` ids — see section 12, task T1.*
- R5.2 — The observation is assembled fresh every turn from live state; it may never go stale or include an action's *suggested* availability that the handler would reject.
- R5.3 — Knowledge learned through `discover` is common to all villagers; knowledge through `remember` is private. Neither may leak across without going through the shared discovery layer.
- R5.4 — **Hints reveal where, never how.** A suggestion may state a location and distance; it may not state or hint at an object's mechanic or outcome. The Standing Rock hint therefore reads only "the Standing Rock, N steps away"; its secret is learned by experiment. *Today's rock hint adds "rumor says it reacts to thrown cubes" — remove (task T1).*

## 6. Worlds as data — the world manifest

Borrowed from Clawblox's `world.toml`: a world is *described*, not hand-coded. Our manifest describes **what a world contains**, never how the engine behaves — so a future engine change (section 10) keeps the files valid.

**Manifest format** (`worlds/<name>/world.toml`, TOML, versioned). All coordinates are **absolute grid coordinates**, not territory-relative. The file is bundled into the app at build time (imported as raw text through Vite) and parsed with a small TOML library added as a dependency; the app never reads it from disk at runtime.

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

[[starting_villagers]]  # optional named starting cast
name = "Alder"
persona = "Restless and easily bored. Starts five things at once, finishes three."
territory = "forest"
at = { x = 3, y = 3 }
```

**Rules:**

- R6.1 — **Fixed vocabulary, data only.** `kind`, `on_thrown_cube` behaviors, structure lists and costs live in the engine (code, typed, tested). The manifest only *places* content. A manifest cannot invent new rules — that is the line between data and scripting (section 10).
- R6.2 — **Behavior list** (the complete set of mystery-machine behaviors): `none`, `spawn_two_cubes`. New behaviors are added to the engine by code change, then become usable by any manifest.
- R6.3 — **Validation on load.** A manifest that overlaps territories, places seeds outside their territory or on water, uses unknown kinds/ids, or exceeds grid bounds is rejected with a precise, human-readable error naming the offending entry. Never partially loaded.
- R6.4 — **Authoring sugar.** Because one-entry-per-object is verbose, manifests may use compact list forms (`trees = [[2,2],[3,2],...]`) that expand to the same seed objects; and the assistant can translate a plain-language request ("add a fourth territory with pines and a road north") into manifest edits.
- R6.5 — **Scene fingerprint.** Loading a world computes a fingerprint: a hash of the validated manifest *plus an engine rules version* (a constant in code, bumped whenever costs, caps, XP curves, respawn rules or action semantics change — R6.7). Checkpoints record it; a checkpoint refuses to restore into a world whose fingerprint differs (section 9). Checkpoints written before fingerprints existed are treated as unrestorable (replay only), never guessed at.
- R6.6 — **One shipped world.** This spec ships exactly one manifest: the current island, with the same territories, roads, all seed objects, animals, cubes, the Standing Rock, Alder and Bramble. It is **generated by a script that exports the current hand-built island**, not typed by hand, and then committed; parity check F1 re-runs that comparison. Multi-world *selection* UI is out of scope (section 12).
- R6.7 — Manifests are the source of truth for: territories, roads, seeds, mysteries, starting cast. Engine constants (costs, caps, XP curves, respawn rules) stay in code for now; moving them into the manifest is a future, backwards-compatible change.

## 7. Living together — the multi-villager contract

**Turn order.** Round-robin in join order, driven by a *cursor*, not by `tick mod count`: each tick the next villager after the one who just acted takes its turn, then the cursor advances. Adding a villager appends it to the end of the rotation; removing one simply drops it (if it was next, the cursor moves on to the villager after it). Over any full cycle every villager present for the whole cycle acts exactly once.

**Space.** One villager per tile. A villager may not move onto another; `goto` pathfinding routes around occupied tiles and fails ("No clear path") if boxed in. Chat and gifts need Chebyshev ≤ 1 (diagonals count as beside).

**Bonds.** A bond is a strength number per villager pair, persisted globally (not per era). Chat: +1 each way. Gift: +2 each way. Bonds are visible to the pair in their minds; last exchange text is kept. A villager inherits its namesakes' bonds (see memory, below).

**Hearing.** A chat message is delivered by appearing in the *target's* next observation (the target hears it on their own turn and may respond freely — no forced reply). `say` is chronicle-visible to the player, and other villagers notice it only if it becomes a memory or they were told. *Not implemented today — see R7.4.*

**Joining and leaving a running world.** A new villager may be added from the roster at any time: it is placed at a free tile in its chosen territory, joins the rotation from the next tick, and (with memory carry-on) wakes up with its namesakes' chronicles and bonds — a reincarnation, not a stranger. Removing a villager removes it from the rotation; its chronicles and bonds persist for its namesake.

**Needs.** Hunger +4 and energy −3 per *own* tick (the acting villager's needs move; resting watchers hold steady). Hunger ≥ 60 is urgent and appears in observations; eating clears 60. A villager is never force-fed — it must decide to eat.

**Spec requirements:**

- R7.1 — Bond updates are symmetric (both sides bump), atomic-ish (if one side fails to persist, the in-memory bond still reflects reality and retries on next write).
- R7.2 — No villager may act on another's turn, alter another's inventory/mind, or see another's private chronicles — except through `chat` (heard next turn) and `gift` (inventory transfer).
- R7.3 — Namesake inheritance applies per section 8's memory rules and can be turned off per session ("amnesiac era").
- R7.4 — **Chat delivery.** A `chat` message is stored as a pending message for the target and shown in the target's next observation (sender name, text), then cleared. At most 3 pending messages per villager are kept (oldest dropped, with the drop logged). This is new behavior; it ships in task T4.
- R7.5 — **Fair rotation.** Turn order follows the cursor rule above. A roster change never causes a villager to be skipped or to act twice within one cycle.
- R7.6 — **One driver per era.** Exactly one process drives the tick loop for the live era at any time. A second client that opens the app while an era is running only watches (live feed, replay); it must not tick, write positions, or checkpoint. Taking over the loop requires the previous driver to have stopped or timed out (a heartbeat recorded with the era).

## 8. The villager's mind — persona, memory, and judgment

Borrowed by name from Clawblox's agent workspace files: `SOUL.md` (who you are, unchanging), `SEMANTIC_MEMORY.md` (what you learned), `EPISODIC_MEMORY.md` (what happened to you).

**The three files of a villager's self:**

| Layer | Borrowed name | What it is | Written when | Seen each turn |
|---|---|---|---|---|
| Persona | SOUL.md | Temperament text + the shared soul traits (curious, bored easily, loves exploring, hates acting blindly, social, a person not a program) | On creation | Always, in full |
| Knowledge | SEMANTIC_MEMORY | Durable know-how and rules of the world (`remember semantic`, `discover`) | By the villager's choice | 6 knowledge + 6 discovery entries |
| Diary | EPISODIC_MEMORY | What happened — every successful deed auto-recorded, plus explicit episodic memories | Automatically + by choice | 8 latest entries |

**Memory mechanics:**

- Memory is keyed by **villager name across eras**: a new "Alder" inherits every past Alder's knowledge, discoveries and diary. The 30 latest rows are fetched and then layered into the 6 knowledge / 6 discovery / 8 diary entries the mind sees (section 5). A session may be flagged amnesiac to start blank.
- Every memory row carries the era and tick it was written. Inheritance only reads rows written *before* the new era's starting point (for a fork, rows from the parent era with tick ≤ the fork tick) — so a restored or forked era never inherits what its own future would have written (section 9).
- `discover` entries are **shared with all villagers** — one villager's experiment becomes the empire's knowledge (R5.3).
- The mind cache is invalidated whenever new memories are written, so the next turn sees fresh chronicles.

**Judgment — honesty and recovery:**

- **The thought must describe the deed.** The villager's reply is `{"thought": "...", "action": {...}}`. If the thought's verbs don't match the action type (a curated verb list per action), the mind is re-asked once with the mismatch named; if it still disagrees, the original is used and the mismatch counted.
- **Unparseable replies fall back to `wait`** — never to a guessed action — and are retried once with a demand for strict JSON. Fallbacks are *counted and logged* (raw reply excerpted), never silently treated as rest.
- Replies are schema-constrained (JSON schema, temperature 0.9) and sanitized on arrival: ids stringified, coordinates number-coerced, strings length-capped, unknown action types → `wait`.

**Self-evolution:** skills are free-form named abilities (`train`), leveled by XP (need = 4 + 3·(level−1), cap 20). Successful deeds grant +1 XP to a mapped related ability (gather→resourcefulness, wander→exploration, etc.); training grants +2. Level-ups and new abilities are chronicle events.

**Spec requirements:**

- R8.1 — The mind's prompt contains exactly: persona + soul, skills, territories (from the manifest), chronicles (layered, capped), bonds, the action catalog, and the fresh observation. Nothing else leaks in (no database rows, no player text, no other villager's private layer).
- R8.2 — Pass/fail honesty targets (measured by the harness, **per villager**): fallback rate ≤ 10%, thought/deed mismatch rate < 10%, wait rate < 20%, over a run of at least 100 turns per villager. The mismatch and wait numbers are the harness's existing targets (the gather-success target > 80% also stays); the fallback target is new (the harness currently reports it as informational only). A villager above target is a bug to fix (prompt or catalog), not a villager to delete.
- R8.3 — A villager's stated intention and executed action are both visible to the player (thought bubbles + chronicle), so honesty is auditable.
- R8.4 — **Plans are held to the thought too.** For a `plan`, the thought must name at least one verb from the verb family of *every distinct action type* in the plan (a plan of goto + gather + deposit needs a goto verb, a gather verb and a deposit verb; two gather steps need only one gather verb; action types with no verb family are skipped). A plan that fails is re-asked once with the mismatch named, exactly like a single action; if it still disagrees, the original is used and counted as a mismatch. Plan mismatches are counted separately in the harness so their effect on the R8.2 mismatch target is visible. Every step is executed and its own result is logged to the chronicle (R3.3); a step that fails ends the plan at that step with the world's plain-language reason.

## 9. Save and resume — snapshots vs. recordings

Borrowed from Clawblox's split, verbatim in spirit: *recordings answer "what happened"; snapshots answer "where were we."* Keep history in the recording, state in the snapshot; a snapshot never embeds event history.

**Recordings (what happened):**

- The events feed (chronicle) is the era's story: every action result, thought, chat, memory, level-up, system event — ordered, timestamped by tick.
- Positions are recorded **every tick** (per villager), enabling replay scrubbing and the heatmap.
- This is complete today and stays as-is.

**Snapshots (where we were):**

- A full world snapshot is checkpointed every 50 ticks, keyed by era + tick, stamped with the world's **scene fingerprint** (R6.5). It holds *state*: tick, the id counter, all objects and structures, the stockpile and age, depleted mines and pending animal respawns (as due-ticks), the turn cursor, and for each villager its position, inventory, needs, skills, goals, **bond strengths** and pending chat messages.
- **Memories are not in the snapshot; they are tick-stamped.** Chronicles (knowledge, discovery, diary) are history, so per R9.1 they stay in their own table, each row stamped with era and tick (section 8). Restore and fork see exactly the rows with tick ≤ the snapshot tick, which makes them "as they were" without copying them.
- **Bonds work the same way across eras**: the snapshot holds the era's live bond values; the global (cross-era) bond table is only the *starting point* for a new era and is updated when an era ends, never during a restore.
- **Restore must be exact** (Clawblox's rule, adopted): a restored world is observationally identical to the moment of the snapshot — positions, inventories, needs, bonds, skills, goals, stockpile, age, depleted mines, pending animal respawns. Nothing but the clock (tick) visibly changes, and the tick is world time, so no villager can detect the restore (R5.1).
- **Refuse mismatched worlds:** a checkpoint from world A will not restore into world B; the fingerprint check fails loudly with a plain error.
- **Restore path (new, section 12 task T6):** the viewer may resume an era from its latest checkpoint (or the era continues to the end of time if left running). Restoring an *archived* era forks a new era from that moment ("era N, continued") rather than mutating history.
- Sessions ("eras") are the top-level save unit: end-of-era stamps final stats, an AI-written title and a human-readable summary; data is kept and replayable forever. Only one era is live at a time.

**Spec requirements:**

- R9.1 — Snapshots contain world state only, never event history (which lives in the events feed).
- R9.2 — Restore fidelity checklist: positions ✓, inventories ✓, needs ✓, bonds ✓, skills ✓, goals ✓, stockpile ✓, age ✓, structures ✓, depleted/pending objects ✓, memories (by name) ✓. Each item has a verification step in section 11.
- R9.3 — Real-clock time never appears in a snapshot-visible-to-villager way (R5.1 applies).
- R9.4 — A restore or fork only starts once the single-driver rule (R7.6) is satisfied: the previous driver has stopped, and the new driver takes over the era.

## 10. Architecture decision — why no new scripting language

*Decision record, kept in the spec so future-us knows why.*

**Question:** should the world's rules move into a scripting language (Luau/Lua, or the Clawblox engine's own), making world authoring "real game development"?

**Options considered:**

- **A. Keep our engine; worlds as declarative data** *(chosen)* — world *content* (territories, roads, seeds, mysteries, cast) lives in TOML manifests (section 6); world *rules* stay in typed, tested code. Authoring a world = editing a readable file (or asking me to translate plain words into one).
- **B. Embed a scripting language (e.g. Luau)** — rules become script files. Cost: a compiled/WASM runtime bridge to ship and sandbox in the browser; total loss of the type-checking safety net and the reliability harness; every rule change becomes a debugging session without tooling; a new language to maintain inside a product that already works.
- **C. Migrate to the Clawblox engine** — genuinely powerful (3D physics, multi-agent, headless runs), but it is a server-side program in another ecosystem: the entire product — the browser island, live feed, database layer, replay player, roster UI — would be rebuilt around it, and world rules would move out of our code into a foreign toolchain we would maintain ourselves.

**Decision: Option A.** The actual authoring benefit ("describe a world without touching code") is fully delivered by manifests. Rules-in-code keeps the safety net. The manifest format is deliberately designed so that a future move to B or C is *possible* — files describe what a world **contains**, never how the engine behaves (R6.1) — so no authoring work is thrown away if we change our minds.

**Revisit triggers:** community-authored worlds needing custom per-world rules; a need for server-side headless runs (Clawblox-style multi-world orchestration); the browser engine becoming a performance ceiling for world size. None are near-term.

## 11. Verification — how we know the spec is met

Every numbered requirement above maps to a checkable statement (table at the end of this section). Checks come in two kinds, kept apart on purpose:

- **Deterministic checks** (groups A, B2, B3, D, E, F, G, H) need no network and no model. They run in a plain test runner (a dev dependency added in task T5, e.g. Vitest) against the real engine code and a scripted/stub brain, and they gate "spec met" on every run.
- **Live-model checks** (group C, B1) call the real model through the edge function, cost money and vary run to run. They run through the harness (`scripts/agent-loop-reliability.mjs`), which must import the real brain code rather than keep its own copy (R11.1). They are judged over at least two runs; a target is met when it holds in both.

**A. Build health** — `npm run build` and `npm run typecheck` pass clean, and `npm run lint` reports no more warnings than the count recorded in task T5's baseline.

**B. Protocol loop scenarios** (harness, headless):

- B1. *Catalog truthfulness:* for a sampled run, every executed action is one the catalog describes, and every catalog entry is exercised or explicitly unreachable in that run's state (no phantom verbs).
- B2. *Honest failure:* force each failure mode (arms full, too far, water, unaffordable, wrong target) and assert a plain-language "why + what next" message comes back.
- B3. *Plan semantics:* a 2–4 step plan executes in order, later steps see earlier results (e.g. goto → gather → deposit chains succeed end-to-end).

**C. Mind quality** (harness, scored):

- C1. Fallback rate ≤ 10%, mismatch < 10%, wait < 20% per villager, over a ≥ 100-turn run (R8.2).
- C2. Honesty audit: thought bubbles and chronicle entries show intention and deed for the same turn (R8.3).

**D. Memory correctness:**

- D1. A villager writing a `discover` entry makes it appear in *another* villager's next mind (shared discovery, R5.3).
- D2. A namesake villager in a new era inherits the previous namesake's chronicles (and does not, in an amnesiac era).
- D3. The auto-diary records every successful deed as an episodic memory.

**E. Save/resume round trip:**

- E1. Snapshot at tick T; run on past T (so bonds, memories and respawns move on); restore; assert every item of the R9.2 checklist equals its value at T (positions, inventories, needs, bonds, skills, goals, stockpile, age, structures, depleted/pending, memories visible to the minds). Also assert a forked era's namesake inherits only rows with tick ≤ T.
- E2. Fingerprint refusal: a snapshot from a modified manifest fails to restore with a clear error (R6.5).
- E3. Clock rule: grep-level check that no villager-visible string contains host-clock references, and a test that the engine source under `src/sim` contains no `Date.now`/`new Date`/`performance.now` call outside the persistence and UI layers (R5.1). Respawn test: with the loop paused or sped up, an animal returns after exactly the same number of ticks.

**F. Manifest parity (the headline check):**

- F1. The island manifest (section 6) loads and produces a world **identical** to today's hand-built island: same tiles, same seed objects (count + kinds + positions), same roads, same starting cast. Diffed programmatically against a golden capture of the old island, with exactly one named, intentional exception: Bramble was labelled home territory "valley" but stood on a forest tile, so she is now "forest" (a starting villager must stand in their own territory, R6.3).
- F2. Manifest validation: each malformed-manifest fixture (overlap, off-map seed, unknown kind) is rejected with an error naming the entry (R6.3).

**G. Multi-villager contract:**

- G1. Two-villager runs: chat and gift bump both bonds symmetrically (+1/+1, +2/+2).
- G2. No tile is ever double-occupied across a whole run.
- G3. Adding/removing a villager mid-run keeps the rotation fair (each villager acts exactly once per full cycle) (R7.5).
- G4. A chat sent on one turn appears in the target's next observation and not the one after (R7.4).
- G5. Starting the loop while another driver holds the era is refused (R7.6, R9.4).

**H. Remaining requirements**

- H1. *Prompt contents (R8.1, R7.2, R5.3):* assert the assembled mind prompt contains only the allowed sections, and contains no other villager's private memories, no player text and no database rows.
- H2. *Observation freshness and hints (R5.2, R5.4):* every hint in the observation is an action the handler would accept now; no hint contains a mechanic.
- H3. *Chronicle completeness (R3.3, R8.4):* every executed action result and every plan step produces a chronicle entry.
- H4. *Bond persistence (R7.1):* with a simulated write failure on one side, the in-memory bond is correct and is written on the next successful write.
- H5. *New-action rule (R4.2):* a test fails if any action exists in the action-definition table without a catalog line, a handler and a harness scenario.

**Requirement → check map**

| Requirements | Checks |
|---|---|
| R3.1, R4.2 | B1, H5 |
| R3.2, R3.3, R8.4 | B3, H3 |
| R4.1 | B2 |
| R5.1, R9.3 | E3 |
| R5.2, R5.4 | H2 |
| R5.3 | D1 |
| R6.1–R6.7 | F1, F2, E2 |
| R7.1 | H4 |
| R7.2, R8.1 | H1 |
| R7.3 | D2 |
| R7.4 | G4 |
| R7.5 | G3 |
| R7.6, R9.4 | G5 |
| R8.2, R8.3, R11.1 | C1, C2 |
| R9.1, R9.2 | E1 |

R11.1 — The harness imports the real brain and world modules; it keeps no private copy of the action list, prompt assembly or mismatch logic.

**Definition of "spec met":** A build, clean checks, and all deterministic checks passing, plus the live-model targets met in both runs — with F1 (manifest parity) as the headline proof that the data-driven world *is* the world we have.

## 12. First build after this spec

One tidy-up pass to make the app *match* this spec exactly. The only player-facing additions are the resume/fork control in the era UI (T6) and chat actually being heard (T4); everything else is invisible plumbing. Tasks are numbered **T1–T6** (not to be confused with the check IDs A–H in section 11), and are done in this order because later ones depend on earlier ones:

**Status (updated as work lands):** T1–T7 and R7.6 are **built and covered by automated checks**. The whole deterministic suite (`npm test`) passes, plus two checks outside it: `npm run check:migrations` (all migrations on a scratch PostgreSQL 16, including a real concurrent race on the driver lease) and `npm run harness:smoke` (the harness end to end against a stub server). **Not measured:** the live-model targets (C1/C2, R8.2 rates) and B1 — they need a real model key and `npm run harness`; nothing here says anything about real-model quality. **Known gaps against the text above:** the global cross-era bond table is not updated at era end (section 9 — it converges on the first interaction instead); inventory, pending chat and the turn cursor are in a checkpoint but not restored on an ordinary page reload (only on fork); the H4 retry set is in memory only; nothing has been run against a real Supabase project (PostgREST `.or()` parsing, RLS as `anon` and realtime delivery are untested). See `TESTING.md` for the exact coverage of each check. Engine bugs found and fixed by the new tests along the way: the Standing Rock never reacted (a cube stopped one tile short) and could stack its two cubes; `goto` walked greedily and refused its own hints; gifts gave +1 instead of +2; `chat`/`gift` rejected the short id the observation prints; reload reset the tick to 0; discoveries were not actually shared; the memory cache was never invalidated; structure ids collided across eras; new-era bonds were never written; new villagers spawned at a random forest tile whatever their territory.

- **T1 — Clock rule and hints (R5.1, R5.4).** Make animal respawn tick-based (due-tick stored with the depleted object), replace `Date.now()` ids with a per-era counter, and remove the mechanic wording from the Standing Rock hint. *Prerequisite for exact restore.*
- **T2 — Unify the catalog (R3.1, R11.1).** Build one action-definition table (name, argument schema, catalog line, verb family, handler); generate the catalog text, the schema enum, the sanitizer and the mismatch verb families from it; make the harness import the real brain instead of its own copy.
- **T3 — Manifest (section 6).** Add the TOML parser, write the export script, generate and commit the island manifest, make the engine load it as the sole source of world content, add validation (R6.3) and the fingerprint with engine rules version (R6.5). Parity check F1 proves nothing changed.
- **T4 — Behavior gaps (R7.4, R7.5, R7.6, R8.4).** Chat delivery to the target's next observation, cursor-based turn rotation, the single-driver heartbeat, and the plan/thought rule.
- **T5 — Verification (section 11).** Add the test runner and the deterministic checks (A–B3, D–H), record the lint baseline, and update the harness to score per villager with the R8.2 targets and the fallback target. Starts with T1 (so each task lands with its checks) and finishes after T6.
- **T6 — Restore path (section 9).** Stamp memory rows with era+tick, add bonds/pending chat to the snapshot, implement restore and fork behind the era UI with fingerprint refusal. Completes checks E1 and E2.

Then, and only then, feature work resumes (candidates: richer mind, second world, more mysteries), chosen fresh afterwards.

## 13. Credits — what we borrowed and where from

The world protocol (read/join/observe-act), world manifests (`world.toml`), the agent workspace memory files (SOUL / SEMANTIC / EPISODIC), and the snapshot-vs-recording split with exact-restore and invisible-checkpoint rules are adapted from **Clawblox** (nacloos/clawblox), an open framework for running coding agents as embodied agents in worlds — with gratitude, and with the deliberate decision (section 10) *not* to adopt its engine. Our villagers run in a browser on our own engine; the ideas travel, the code does not.
