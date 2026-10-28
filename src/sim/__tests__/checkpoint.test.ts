import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nearestCheckpoint, toReplayCheckpoint } from '../../components/replay.ts';
import { CHECKPOINT_VERSION, buildCheckpoint, replaySnapshotOf, restoreCheckpoint, withNewVillagerIds } from '../checkpoint.ts';
import type { CheckpointState, CheckpointV1, DepletedEntry } from '../checkpoint.ts';
import { ENGINE_RULES_VERSION, fingerprint } from '../manifest.ts';
import { grantXp } from '../traits.ts';
import { ANIMAL_RESPAWN_TICKS, clearInbox, islandFingerprint, loadIsland, observe, seedObjects, step, territoryAt } from '../world.ts';
import type { AgentState, WorldSnapshot } from '../world.ts';
import { mkAgent, mkSnapshot } from './fixtures.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A free walkable tile with room to its east and south, so builds, places and throws have open ground. */
function openGround(snap: WorldSnapshot): { x: number; y: number } {
  const free = (x: number, y: number) =>
    territoryAt({ x, y }) !== null && !snap.objects.some((o) => o.pos.x === x && o.pos.y === y);
  for (let y = 0; y < 40; y++)
    for (let x = 0; x < 40; x++)
      if ([0, 1, 2, 3].every((d) => free(x + d, y)) && free(x, y + 1) && free(x + 1, y + 1)) return { x, y };
  throw new Error('no open ground in the island');
}

/** What the simulation tracks outside the world snapshot. */
interface World {
  snap: WorldSnapshot;
  cursor: { lastActorId: string | null; lastActorIndex: number };
  depleted: DepletedEntry[];
}

/** Everything R9.2 lists, read straight off a live (or restored) world, as plain data. */
function r92(world: World) {
  return json({
    tick: world.snap.tick,
    nextId: world.snap.nextId,
    cursor: world.cursor,
    civ: world.snap.civ,
    objects: world.snap.objects,
    depleted: world.depleted,
    villagers: world.snap.agents.map((a) => ({
      id: a.id,
      name: a.name,
      pos: a.pos,
      inventory: a.inventory,
      hunger: a.hunger,
      energy: a.energy,
      mood: a.mood,
      island: a.island,
      skills: a.traits ?? {},
      goals: a.goals ?? [],
      bonds: a.relationships ?? [],
      inbox: a.inbox ?? [],
    })),
  });
}

/**
 * A rich world built only through the real engine: gathered animal (respawn due-tick), gathered mine,
 * a built structure, a thrown cube, trained skills, goals, a chat waiting in an inbox, bonds, and the
 * turn cursor mid-cycle.
 */
function buildRichWorld(): World {
  const snap = mkSnapshot([mkAgent('a', 'Alder', 0, 0), mkAgent('b', 'Bramble', 0, 0), mkAgent('c', 'Cedar', 0, 0)], {
    wood: 20,
    stone: 20,
    gold: 20,
    food: 5,
    age: 2,
  }, 100);
  const [a, b, c] = snap.agents;
  const sheep = snap.objects.find((o) => o.kind === 'sheep')!;
  const mine = snap.objects.find((o) => o.kind === 'gold_mine')!;
  const depleted: DepletedEntry[] = [];

  a.pos = { x: sheep.pos.x, y: sheep.pos.y + 1 };
  const gatheredSheep = step(snap, 'a', { type: 'gather', data: { object_id: sheep.id } });
  b.pos = { x: mine.pos.x, y: mine.pos.y + 1 };
  const gatheredMine = step(snap, 'b', { type: 'gather', data: { object_id: mine.id } });
  expect(gatheredSheep.ok && gatheredMine.ok).toBe(true);
  for (const r of [gatheredSheep, gatheredMine]) if (r.depleted) depleted.push({ ...r.depleted });
  expect(depleted).toEqual([
    { id: sheep.id, respawnTick: 100 + ANIMAL_RESPAWN_TICKS },
    { id: mine.id, respawnTick: null },
  ]);

  const p = openGround(snap);
  c.pos = { ...p };
  expect(step(snap, 'c', { type: 'build', data: { structure: 'house' } }).ok).toBe(true);
  c.pos = { x: p.x + 1, y: p.y };
  c.inventory = ['cube'];
  expect(step(snap, 'c', { type: 'throw', data: { dx: 2, dy: 0 } }).built?.structure).toBe('cube');
  a.pos = { x: p.x, y: p.y + 1 };
  b.pos = { x: p.x + 1, y: p.y + 1 };

  // skills come from the same function the simulation calls after a successful train
  expect(step(snap, 'a', { type: 'train', data: { ability: 'fishing' } }).ok).toBe(true);
  a.traits = grantXp(grantXp(a.traits ?? {}, 'fishing', 2).traits, 'fishing', 2).traits;
  b.traits = grantXp(b.traits ?? {}, 'resourcefulness', 1).traits;
  const goal = step(snap, 'b', { type: 'set_goal', data: { goal: 'Raise a wonder.' } });
  b.goals = [{ text: goal.newGoal!, createdAt: snap.tick }];
  expect(step(snap, 'a', { type: 'chat', data: { agent_id: 'c', message: 'Look at that cube!' } }).ok).toBe(true);
  expect(step(snap, 'b', { type: 'chat', data: { agent_id: 'c', message: 'Shall we build more?' } }).ok).toBe(true);

  a.hunger = 24; a.energy = 85; a.mood = 'industrious';
  b.hunger = 8; b.energy = 61; b.mood = 'chatty';
  c.hunger = 40; c.energy = 33; c.mood = 'proud';
  a.relationships = [{ withId: 'b', withName: 'Bramble', strength: 3, lastMessage: 'Well met.' }, { withId: 'c', withName: 'Cedar', strength: 1, lastMessage: 'Look at that cube!' }];
  b.relationships = [{ withId: 'a', withName: 'Alder', strength: 3, lastMessage: 'Well met.' }];
  c.relationships = [{ withId: 'a', withName: 'Alder', strength: 1, lastMessage: null }];

  snap.tick = 150;
  return { snap, cursor: { lastActorId: 'b', lastActorIndex: 1 }, depleted };
}

const stateOf = (w: World): CheckpointState => ({
  snapshot: w.snap,
  cursor: w.cursor,
  depleted: w.depleted,
  fingerprint: islandFingerprint,
});

/** Runs the world on well past the checkpoint so every R9.2 item moves. */
function runOn(w: World): void {
  const { snap } = w;
  const [a, b, c] = snap.agents;
  const sheep = seedObjects().find((o) => o.kind === 'sheep')!;
  // the animal returns and gets gathered again, a second house goes up, a cube is picked up, a gift changes hands
  snap.tick = 400;
  w.depleted = w.depleted.filter((d) => d.respawnTick === null);
  snap.objects.push({ ...sheep });
  c.pos = { x: a.pos.x + 1, y: a.pos.y };
  step(snap, 'c', { type: 'build', data: { structure: 'mill' } });
  const cube = snap.objects.find((o) => o.kind === 'cube' && o.id.startsWith('cube_'))!;
  c.pos = { x: cube.pos.x - 1, y: cube.pos.y };
  step(snap, 'c', { type: 'pick_up', data: { object_id: cube.id } });
  a.pos = { x: c.pos.x, y: c.pos.y + 1 };
  a.inventory = ['food'];
  step(snap, 'a', { type: 'gift', data: { agent_id: 'c', item: 'food' } });
  clearInbox(c);
  step(snap, 'b', { type: 'chat', data: { agent_id: 'a', message: 'Later news.' } });
  a.traits = grantXp(a.traits ?? {}, 'fishing', 9).traits;
  a.goals = [{ text: 'Something new.', createdAt: 400 }];
  for (const x of [a, b, c]) {
    x.hunger += 17;
    x.energy -= 11;
    x.mood = 'tired';
    for (const r of x.relationships ?? []) r.strength += 5;
  }
  w.cursor = { lastActorId: 'c', lastActorIndex: 2 };
  snap.civ.wood = 1;
  snap.civ.age = 3;
}

const observations = (snap: WorldSnapshot) =>
  Object.fromEntries(snap.agents.map((x) => [x.id, observe(snap, x, [{ label: 'goto (1,1)', result: 'You march.' }])]));

describe('E1 / R9.2 — snapshot at tick T, run on, restore: every checklist item equals its value at T', () => {
  it('E1: the whole R9.2 checklist survives build -> run on -> restore', () => {
    const world = buildRichWorld();
    const atT = r92(world);
    const obsAtT = observations(world.snap);
    const cp = buildCheckpoint(stateOf(world));

    runOn(world);
    expect(r92(world)).not.toEqual(atT); // the world really did move on
    expect(observations(world.snap)).not.toEqual(obsAtT);

    const restored = restoreCheckpoint(json(cp), islandFingerprint); // through JSON, as the database stores it
    if (!restored.ok) throw new Error(restored.message);
    const back: World = { snap: restored.snapshot, cursor: restored.cursor, depleted: restored.depleted };
    const now = r92(back);

    // the checklist, item by item
    expect(now.villagers.map((v) => v.pos)).toEqual(atT.villagers.map((v) => v.pos));
    expect(now.villagers.map((v) => v.inventory)).toEqual(atT.villagers.map((v) => v.inventory));
    expect(now.villagers.map((v) => [v.hunger, v.energy])).toEqual(atT.villagers.map((v) => [v.hunger, v.energy]));
    expect(now.villagers.map((v) => v.bonds)).toEqual(atT.villagers.map((v) => v.bonds));
    expect(now.villagers.map((v) => v.skills)).toEqual(atT.villagers.map((v) => v.skills));
    expect(now.villagers.map((v) => v.goals)).toEqual(atT.villagers.map((v) => v.goals));
    expect(now.civ).toEqual(atT.civ); // stockpile and age
    expect(now.objects).toEqual(atT.objects); // seeds, structures, cubes
    expect(now.depleted).toEqual(atT.depleted); // the gone mine and the animal's due-tick
    expect(now.villagers.map((v) => v.inbox)).toEqual(atT.villagers.map((v) => v.inbox));
    expect(now.cursor).toEqual(atT.cursor);
    expect(now.nextId).toBe(atT.nextId);
    expect(now.tick).toBe(atT.tick);
    // ...and everything else a villager is
    expect(now).toEqual(atT);

    // observationally identical: each villager would see exactly what it saw at T
    expect(observations(back.snap)).toEqual(obsAtT);
  });

  it('E1: the checklist is not trivially satisfied: the fixture holds every kind of state', () => {
    const w = buildRichWorld();
    const [a, b, c] = w.snap.agents;
    expect(w.snap.objects.some((o) => o.kind === 'house' && o.builtBy === 'Cedar')).toBe(true);
    expect(w.snap.objects.some((o) => o.id.startsWith('cube_'))).toBe(true);
    expect(w.snap.nextId).toBeGreaterThan(2);
    expect(w.depleted.some((d) => d.respawnTick === null)).toBe(true);
    expect(w.depleted.some((d) => d.respawnTick !== null)).toBe(true);
    expect(c.inbox).toHaveLength(2);
    expect(Object.keys(a.traits ?? {})).toContain('fishing');
    expect(a.traits?.fishing.level).toBeGreaterThan(1);
    expect(b.goals).toHaveLength(1);
    expect(a.inventory).toEqual(['food']);
    expect(w.cursor.lastActorId).toBe('b');
  });

  it('E1: a restored inbox is delivered exactly once, like a live one (R7.4)', () => {
    const world = buildRichWorld();
    const restored = restoreCheckpoint(json(buildCheckpoint(stateOf(world))), islandFingerprint);
    if (!restored.ok) throw new Error(restored.message);
    const cedar = restored.snapshot.agents[2];
    expect(observe(restored.snapshot, cedar, [])).toContain('- Alder says: "Look at that cube!"');
    clearInbox(cedar);
    expect(observe(restored.snapshot, cedar, [])).not.toContain('Look at that cube!');
  });

  it('E1: an empty inbox restores as nothing pending, as in the live engine', () => {
    const world = buildRichWorld();
    const restored = restoreCheckpoint(buildCheckpoint(stateOf(world)), islandFingerprint);
    if (!restored.ok) throw new Error(restored.message);
    expect(restored.snapshot.agents[0].inbox).toBeUndefined();
    expect(restored.snapshot.agents[2].inbox).toHaveLength(2);
  });
});

describe('E1 / R9.1 — a checkpoint is state only, and shares nothing with the world', () => {
  it('R9.1: the payload holds exactly the state keys: no events, no memories, no history, no clock', () => {
    const cp = buildCheckpoint(stateOf(buildRichWorld()));
    expect(Object.keys(cp).sort()).toEqual(
      ['agents', 'civ', 'cursor', 'depleted', 'fingerprint', 'nextId', 'objects', 'tick', 'version']
    );
    for (const agent of cp.agents) {
      expect(Object.keys(agent).sort()).toEqual(
        ['color', 'energy', 'goals', 'hunger', 'id', 'inbox', 'inventory', 'island', 'model', 'mood', 'name', 'persona', 'pos', 'relationships', 'status', 'traits'].sort()
      );
    }
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) {
          keys.add(k);
          walk(x);
        }
    };
    walk(cp);
    for (const forbidden of ['events', 'event', 'memories', 'memory', 'history', 'chronicle', 'created_at', 'timestamp', 'recentTiles', 'lastThought', 'lastBubble'])
      expect(keys.has(forbidden), `payload has a "${forbidden}" key`).toBe(false);
    expect(cp.version).toBe(CHECKPOINT_VERSION);
    expect(cp.fingerprint).toBe(islandFingerprint);
  });

  it('R9.3: the payload does not depend on the host clock; the module reads none', () => {
    const world = buildRichWorld();
    const payloads = [0, 1.7e12, 9e15].map((fakeNow) => {
      vi.spyOn(Date, 'now').mockReturnValue(fakeNow);
      return buildCheckpoint(stateOf(world));
    });
    expect(payloads[1]).toEqual(payloads[0]);
    expect(payloads[2]).toEqual(payloads[0]);
    for (const file of ['checkpoint.ts', 'memory.ts']) {
      const source = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
      for (const call of ['Date.now', 'new Date', 'performance.now']) expect(source, `${file} uses ${call}`).not.toContain(call);
    }
  });

  it('building: mutating the live world afterwards leaves the checkpoint intact, and it shares no reference', () => {
    const world = buildRichWorld();
    const cp = buildCheckpoint(stateOf(world));
    const frozen = json(cp);
    const [a] = world.snap.agents;
    expect(cp.agents[0].pos).not.toBe(a.pos);
    expect(cp.agents[0].inventory).not.toBe(a.inventory);
    expect(cp.agents[0].traits).not.toBe(a.traits);
    expect(cp.agents[0].goals).not.toBe(a.goals);
    expect(cp.agents[0].relationships).not.toBe(a.relationships);
    expect(cp.agents[0].relationships[0]).not.toBe(a.relationships![0]);
    expect(cp.agents[2].inbox).not.toBe(world.snap.agents[2].inbox);
    expect(cp.civ).not.toBe(world.snap.civ);
    expect(cp.objects).not.toBe(world.snap.objects);
    expect(cp.objects[0]).not.toBe(world.snap.objects[0]);
    expect(cp.depleted).not.toBe(world.depleted);
    expect(cp.depleted[0]).not.toBe(world.depleted[0]);
    expect(cp.cursor).not.toBe(world.cursor);

    runOn(world);
    a.pos.x += 9;
    a.inventory.push('wood');
    world.snap.objects[0].pos.x += 5;
    world.snap.civ.gold = 0;
    world.depleted.push({ id: 'x', respawnTick: 1 });
    expect(cp).toEqual(frozen);
  });

  it('restoring: mutating the restored world leaves the payload intact, and two restores are independent', () => {
    const cp = buildCheckpoint(stateOf(buildRichWorld()));
    const frozen = json(cp);
    const first = restoreCheckpoint(cp, islandFingerprint);
    const second = restoreCheckpoint(cp, islandFingerprint);
    if (!first.ok || !second.ok) throw new Error('restore refused');
    expect(first.snapshot.agents[0].pos).not.toBe(cp.agents[0].pos);
    expect(first.snapshot.civ).not.toBe(cp.civ);
    expect(first.snapshot.objects[0]).not.toBe(cp.objects[0]);
    expect(first.depleted[0]).not.toBe(cp.depleted[0]);

    const [a] = first.snapshot.agents;
    a.pos.x += 3;
    a.inventory.push('wood');
    a.relationships![0].strength = 99;
    first.snapshot.objects.pop();
    first.snapshot.civ.wood = 0;
    first.depleted.length = 0;
    first.cursor.lastActorIndex = 7;
    step(first.snapshot, 'a', { type: 'wait', data: {} });
    expect(cp).toEqual(frozen);
    const fresh = restoreCheckpointOk(frozen);
    expect(r92({ snap: second.snapshot, cursor: second.cursor, depleted: second.depleted })).toEqual(
      r92({ snap: fresh.snapshot, cursor: fresh.cursor, depleted: fresh.depleted })
    );
  });
});

function restoreCheckpointOk(payload: unknown) {
  const r = restoreCheckpoint(payload, islandFingerprint);
  if (!r.ok) throw new Error(r.message);
  return r;
}

describe('E2 / R6.5 — a checkpoint from a different world is refused, plainly', () => {
  const good = () => json(buildCheckpoint(stateOf(buildRichWorld())));

  it('E2: a rules version bump changes the fingerprint and the restore is refused', () => {
    const island = loadIsland();
    const stamped = fingerprint(island, ENGINE_RULES_VERSION + 1);
    expect(stamped).not.toBe(islandFingerprint);
    const result = restoreCheckpoint({ ...good(), fingerprint: stamped }, islandFingerprint);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('different world');
      expect(result.message).toContain('fingerprint mismatch');
      expect(result.message).toContain('replay');
    }
  });

  it('E2: a moved seed object changes the fingerprint and the restore is refused', () => {
    const moved = json(loadIsland());
    moved.seeds[0].pos.x += 1;
    const stamped = fingerprint(moved, ENGINE_RULES_VERSION);
    expect(stamped).not.toBe(islandFingerprint);
    const result = restoreCheckpoint({ ...good(), fingerprint: stamped }, islandFingerprint);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('different world');
  });

  it('E2: a checkpoint without a fingerprint is unrestorable, never guessed at', () => {
    const payload: Partial<CheckpointV1> = good();
    delete payload.fingerprint;
    const result = restoreCheckpoint(payload, islandFingerprint);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('before worlds carried a fingerprint');
  });

  it('E2: an old-format row (fingerprint but no version, cursor or pending respawns) is refused as such', () => {
    const old = { tick: 50, agents: [], objects: [], civ: { wood: 0, food: 0, gold: 0, stone: 0, age: 1 }, nextId: 1, fingerprint: islandFingerprint };
    const result = restoreCheckpoint(old, islandFingerprint);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('older version of the game');
      expect(result.message).toContain('cannot be restored');
    }
  });

  it('E2: an unknown (future) version is refused, naming both versions', () => {
    const result = restoreCheckpoint({ ...good(), version: CHECKPOINT_VERSION + 1 }, islandFingerprint);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain(`format ${CHECKPOINT_VERSION + 1}`);
      expect(result.message).toContain(`format ${CHECKPOINT_VERSION}`);
    }
  });

  it('E2: the fingerprint is judged before anything else (a stale world wins over a bad format)', () => {
    const result = restoreCheckpoint({ ...good(), version: 99, fingerprint: 'deadbeef' }, islandFingerprint);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('different world');
  });

  it('E2: damaged payloads are refused with a plain message and never throw', () => {
    for (const bad of [null, undefined, 42, 'text', [], {}, { ...good(), agents: 'nope' }, { ...good(), cursor: null }, { ...good(), civ: { wood: 'x' } }, { ...good(), tick: 'soon' }]) {
      const result = restoreCheckpoint(bad, islandFingerprint);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message.length).toBeGreaterThan(20);
    }
  });

  it('E2: a matching checkpoint is accepted', () => {
    expect(restoreCheckpoint(good(), islandFingerprint).ok).toBe(true);
  });
});

describe('fork — a restored world under new villager ids', () => {
  it('ids inside bonds, pending messages and the cursor follow the new ids; the input is untouched', () => {
    const restored = restoreCheckpointOk(buildCheckpoint(stateOf(buildRichWorld())));
    const before = json(restored);
    const moved = withNewVillagerIds(restored, ['A2', 'B2', 'C2']);
    expect(moved.snapshot.agents.map((a) => a.id)).toEqual(['A2', 'B2', 'C2']);
    expect(moved.snapshot.agents[0].relationships!.map((r) => r.withId)).toEqual(['B2', 'C2']);
    expect(moved.snapshot.agents[1].relationships![0].withId).toBe('A2');
    expect(moved.snapshot.agents[2].inbox!.map((m) => m.fromId)).toEqual(['A2', 'B2']);
    expect(moved.cursor.lastActorId).toBe('B2');
    expect(moved.cursor.lastActorIndex).toBe(1);
    // everything else is the same world
    expect(moved.snapshot.agents.map((a) => a.pos)).toEqual(restored.snapshot.agents.map((a) => a.pos));
    expect(moved.snapshot.objects).toEqual(restored.snapshot.objects);
    expect(json(restored)).toEqual(before);
    expect(() => withNewVillagerIds(restored, ['only-one'])).toThrow();
  });

  it('a chat to a restored, re-id\'d villager still works (the engine finds them by the new id)', () => {
    const moved = withNewVillagerIds(restoreCheckpointOk(buildCheckpoint(stateOf(buildRichWorld()))), ['A2', 'B2', 'C2']);
    const result = step(moved.snapshot, 'A2', { type: 'chat', data: { agent_id: 'C2', message: 'We are back.' } });
    expect(result.ok).toBe(true);
    expect(moved.snapshot.agents[2].inbox![moved.snapshot.agents[2].inbox!.length - 1]).toEqual({ fromId: 'A2', fromName: 'Alder', message: 'We are back.' });
  });
});

describe('replay keeps reading old and new checkpoint rows', () => {
  const oldAgent = (id: string): AgentState => ({ ...mkAgent(id, 'Alder', 4, 5), lastBubble: 'hm', recentTiles: [{ x: 4, y: 5 }] });
  const oldRow = (tick: number, withFingerprint: boolean) => ({
    tick,
    snapshot: {
      tick,
      agents: [oldAgent('a')],
      objects: seedObjects().slice(0, 3),
      civ: { wood: 1, food: 2, gold: 3, stone: 4, age: 2 },
      nextId: 5,
      ...(withFingerprint ? { fingerprint: islandFingerprint } : {}),
    },
  });
  const newRow = (tick: number) => {
    const w = buildRichWorld();
    w.snap.tick = tick;
    return { tick, snapshot: json(buildCheckpoint(stateOf(w))) };
  };

  it('both shapes become a replayable world with agents, objects, civ and tick', () => {
    for (const row of [oldRow(50, false), oldRow(100, true), newRow(150)]) {
      const cp = toReplayCheckpoint(row);
      expect(cp, `row at tick ${row.tick}`).not.toBeNull();
      expect(cp!.tick).toBe(row.tick);
      expect(cp!.snapshot.tick).toBe(row.tick);
      expect(Array.isArray(cp!.snapshot.agents) && cp!.snapshot.agents.length > 0).toBe(true);
      expect(cp!.snapshot.agents.every((a) => typeof a.pos.x === 'number' && typeof a.color === 'string' && typeof a.name === 'string')).toBe(true);
      expect(cp!.snapshot.objects.length).toBeGreaterThan(0);
      expect(typeof cp!.snapshot.civ.wood).toBe('number');
      expect(typeof cp!.snapshot.nextId).toBe('number');
    }
  });

  it('the scrubber picks the nearest earlier checkpoint across a mix of old and new rows', () => {
    const cps = [oldRow(50, false), oldRow(100, true), newRow(150), newRow(200)].flatMap((r) => toReplayCheckpoint(r) ?? []);
    expect(cps.map((c) => c.tick)).toEqual([50, 100, 150, 200]);
    expect(nearestCheckpoint(cps, 0)?.tick).toBe(50);
    expect(nearestCheckpoint(cps, 99)?.tick).toBe(50);
    expect(nearestCheckpoint(cps, 100)?.tick).toBe(100);
    expect(nearestCheckpoint(cps, 175)?.tick).toBe(150);
    expect(nearestCheckpoint(cps, 9999)?.tick).toBe(200);
  });

  it('a row with no usable world is skipped instead of breaking the replay', () => {
    expect(toReplayCheckpoint({ tick: 5, snapshot: null })).toBeNull();
    expect(toReplayCheckpoint({ tick: 5, snapshot: {} })).toBeNull();
    expect(replaySnapshotOf({ agents: [], objects: [] })).toBeNull();
  });

  it('replaying a new row shows the checkpointed world as it was', () => {
    const w = buildRichWorld();
    const row = { tick: 150, snapshot: json(buildCheckpoint(stateOf(w))) };
    const shown = toReplayCheckpoint(row)!.snapshot;
    expect(shown.agents.map((a) => [a.name, a.pos])).toEqual(w.snap.agents.map((a) => [a.name, a.pos]));
    expect(shown.objects).toEqual(json(w.snap.objects));
    expect(shown.civ).toEqual(w.snap.civ);
  });
});
