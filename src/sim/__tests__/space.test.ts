import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GridPos, ActionInput, AgentState, WorldSnapshot } from '../world.ts';
import { GRID_SIZE, STARTING_VILLAGERS, findSpawnTile, TERRITORIES, isRoad, planSteps, runSteps, step, territoryAt } from '../world.ts';
import { pickNextActor } from '../rotation.ts';
import { mkAgent, mkSnapshot, seededRandom } from './fixtures.ts';

/**
 * G2 / SPEC section 7 "Space" — one villager per tile, across a whole run.
 *
 * Drives the real engine `step()` (and `runSteps` for plans) with a seeded, random but valid-ish
 * stream of actions in cursor rotation (`pickNextActor`), exactly as the tick loop orders turns, and
 * checks the whole board after EVERY step.
 */

const land = (): GridPos[] => {
  const tiles: GridPos[] = [];
  for (let y = 0; y < GRID_SIZE; y++) for (let x = 0; x < GRID_SIZE; x++) if (territoryAt({ x, y }) || isRoad({ x, y })) tiles.push({ x, y });
  return tiles;
};
const LAND = land();
const cheb = (a: GridPos, b: GridPos) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const tileKey = (p: GridPos) => `${p.x},${p.y}`;

const STRUCTURES = ['house', 'mill', 'barracks', 'watch_tower', 'wonder'] as const;

/** Villagers on the real island: the manifest's starting cast first, then more at free forest tiles. */
function makeWorld(count: number): WorldSnapshot {
  const extra: GridPos[] = [{ x: 5, y: 5 }, { x: 6, y: 3 }, { x: 2, y: 6 }, { x: 7, y: 7 }];
  const spots = [...STARTING_VILLAGERS.map((v) => v.pos), ...extra].slice(0, count);
  const names = ['Alder', 'Bramble', 'Cedar', 'Dunn'];
  const agents = spots.map((p, i) => mkAgent(`v${i}`, names[i], p.x, p.y));
  return mkSnapshot(agents, { wood: 12, food: 6, gold: 6, stone: 10, age: 2 });
}

/** One random action for `agent`: mostly sensible, sometimes junk, so failures are exercised too. */
function randomAction(rnd: () => number, snap: WorldSnapshot, agent: AgentState, depth = 0): ActionInput {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const others = snap.agents.filter((a) => a.id !== agent.id);
  const dir = () => pick([-1, 0, 1] as const);
  const unit = () => pick([{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }]);
  const cubes = snap.objects.filter((o) => o.kind === 'cube');
  const tc = snap.objects.find((o) => o.kind === 'town_center');
  const rock = snap.objects.find((o) => o.kind === 'rock');
  const beside = (p: GridPos): GridPos => ({ x: p.x + dir(), y: p.y + dir() });

  const roll = rnd();
  if (roll < 0.28) {
    // where to go: anywhere, beside a neighbour, beside a cube, beside the rock or the Town Center
    const target = pick<GridPos>([
      pick(LAND),
      ...(others.length ? [beside(pick(others).pos)] : []),
      ...(cubes.length ? [beside(pick(cubes).pos)] : []),
      ...(rock ? [beside(rock.pos), { x: rock.pos.x - 2, y: rock.pos.y }] : []),
      ...(tc ? [beside(tc.pos)] : []),
      { x: 99, y: -3 }, // off the map
    ]);
    return { type: 'goto', data: target };
  }
  if (roll < 0.42) return { type: 'move', data: pick([...[unit(), unit()], { dx: 1, dy: 1 }]) };
  if (roll < 0.57) return { type: 'wander', data: {} };
  if (roll < 0.63) return { type: 'gather_nearest', data: {} };
  if (roll < 0.66) {
    const near = snap.objects.filter((o) => cheb(o.pos, agent.pos) <= 2);
    return { type: 'gather', data: { object_id: near.length ? pick(near).id : 'res_0' } };
  }
  if (roll < 0.70) return { type: 'deposit', data: {} };
  if (roll < 0.74) {
    const near = cubes.filter((o) => cheb(o.pos, agent.pos) <= 1);
    return { type: 'pick_up', data: { object_id: near.length ? pick(near).id : pick(cubes.length ? cubes : snap.objects).id } };
  }
  if (roll < 0.79) return { type: 'place', data: pick([...[unit(), unit()], { dx: 0, dy: 0 }]) };
  if (roll < 0.85) return { type: 'throw', data: { dx: pick([-3, -2, -1, 0, 1, 2, 3]), dy: pick([-3, -2, -1, 0, 1, 2, 3]) } };
  if (roll < 0.88) return { type: 'build', data: { structure: pick(STRUCTURES) } };
  if (roll < 0.92 && others.length) return { type: 'chat', data: { agent_id: pick(others).id, message: 'hello' } };
  if (roll < 0.95 && others.length) return { type: 'gift', data: { agent_id: pick(others).id } };
  if (roll < 0.97 && depth === 0) {
    const n = 2 + Math.floor(rnd() * 3);
    return { type: 'plan', data: { steps: Array.from({ length: n }, () => randomAction(rnd, snap, agent, 1)).filter((a) => a.type !== 'plan') } };
  }
  return { type: 'wait', data: {} };
}

/** What must hold on the board after every single step. Returns the first violation, or null. */
export function boardViolation(snap: WorldSnapshot): string | null {
  const seen = new Map<string, string>();
  for (const a of snap.agents) {
    const p = a.pos;
    if (!Number.isInteger(p.x) || !Number.isInteger(p.y)) return `${a.name} stands off the grid at (${p.x}, ${p.y})`;
    if (!territoryAt(p) && !isRoad(p)) return `${a.name} stands in water at (${p.x}, ${p.y})`;
    const prior = seen.get(tileKey(p));
    if (prior) return `${a.name} and ${prior} both stand on (${p.x}, ${p.y})`;
    seen.set(tileKey(p), a.name);
  }
  const cubeTiles = new Map<string, string>();
  for (const o of snap.objects.filter((x) => x.kind === 'cube')) {
    const prior = cubeTiles.get(tileKey(o.pos));
    if (prior) return `cubes ${prior} and ${o.id} lie on the same tile (${o.pos.x}, ${o.pos.y})`;
    cubeTiles.set(tileKey(o.pos), o.id);
  }
  return null;
}

interface RunStats {
  attempts: Record<string, number>;
  successes: Record<string, number>;
  steps: number;
}

async function runSeeded(seed: number, villagers: number, turns: number): Promise<RunStats> {
  const rnd = seededRandom(seed);
  vi.spyOn(Math, 'random').mockImplementation(seededRandom(seed ^ 0x9e3779b9));
  const snap = makeWorld(villagers);
  const stats: RunStats = { attempts: {}, successes: {}, steps: 0 };
  expect(boardViolation(snap), 'the starting board').toBeNull();

  let lastId: string | null = null;
  let lastIndex = 0;
  for (let turn = 0; turn < turns; turn++) {
    const idx = pickNextActor(snap.agents.map((a) => a.id), lastId, lastIndex);
    const agent = snap.agents[idx];
    lastId = agent.id;
    lastIndex = idx;

    // keep the economy and the cube supply from drying up, so every action type keeps getting exercised
    if (turn % 150 === 0) Object.assign(snap.civ, { wood: 12, food: 6, gold: 6, stone: 10, age: 2 });
    if (turn % 40 === 7 && !agent.inventory.includes('cube') && agent.inventory.length < 2) agent.inventory.push('cube');
    if (agent.inventory.length > 1 && rnd() < 0.5) agent.inventory = agent.inventory.slice(0, 1);

    // plans run through the same loop the simulation uses; every step is checked, not just the last
    await runSteps(planSteps(randomAction(rnd, snap, agent)), (s) => {
      const cubesBefore = new Set(snap.objects.filter((o) => o.kind === 'cube').map((o) => o.id));
      const occupiedBefore = new Set(snap.objects.map((o) => tileKey(o.pos)));
      const result = step(snap, agent.id, s);
      stats.steps++;
      stats.attempts[s.type] = (stats.attempts[s.type] ?? 0) + 1;
      if (result.ok) stats.successes[s.type] = (stats.successes[s.type] ?? 0) + 1;
      const where = `seed ${seed}, turn ${turn} (${agent.name}), ${s.type} ${JSON.stringify(s.data)}`;
      const bad = boardViolation(snap);
      if (bad) throw new Error(`${where}: ${bad}`);
      // a cube set down or thrown onto open ground never lands on another object
      if (result.ok && (s.type === 'place' || s.type === 'throw') && !result.spawned) {
        for (const c of snap.objects.filter((o) => o.kind === 'cube' && !cubesBefore.has(o.id))) {
          if (occupiedBefore.has(tileKey(c.pos))) throw new Error(`${where}: the cube landed on an occupied tile (${c.pos.x}, ${c.pos.y})`);
        }
      }
      return Promise.resolve(result);
    });
  }
  return stats;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('G2 / section 7 Space — no tile is ever double-occupied across a whole run', () => {
  const TURNS = 2500;
  const total: RunStats = { attempts: {}, successes: {}, steps: 0 };

  for (const [seed, villagers] of [[1, 3], [2, 4], [3, 3], [4, 4], [5, 3], [6, 4]] as const) {
    it(`G2: seed ${seed}, ${villagers} villagers, ${TURNS} turns in cursor rotation — no shared tile after any step`, async () => {
      const stats = await runSeeded(seed, villagers, TURNS);
      expect(stats.steps).toBeGreaterThanOrEqual(TURNS);
      for (const [type, n] of Object.entries(stats.attempts)) total.attempts[type] = (total.attempts[type] ?? 0) + n;
      for (const [type, n] of Object.entries(stats.successes)) total.successes[type] = (total.successes[type] ?? 0) + n;
      total.steps += stats.steps;
    });
  }

  it('G2: across the runs every movement, carrying, building and social action succeeded, and all but wander also failed, at least once', () => {
    expect(total.steps).toBeGreaterThanOrEqual(6 * TURNS);
    for (const type of ['goto', 'move', 'wander', 'gather_nearest', 'deposit', 'pick_up', 'place', 'throw', 'build', 'chat', 'gift']) {
      expect(total.successes[type] ?? 0, `${type} never succeeded`).toBeGreaterThan(0);
      // wander only fails when boxed in on all four sides, which a run need not produce
      if (type !== 'wander') expect((total.attempts[type] ?? 0) - (total.successes[type] ?? 0), `${type} never failed`).toBeGreaterThan(0);
    }
  });
});

describe('G2 — the Standing Rock never stacks the cubes it pushes out', () => {
  it('G2: the two new cubes always land on two different tiles (regression: both could draw the same spot)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      vi.spyOn(Math, 'random').mockImplementation(seededRandom(seed));
      const snap = mkSnapshot([mkAgent('a', 'Alder', 0, 0, ['cube'])]);
      snap.objects = snap.objects.filter((o) => o.kind === 'rock');
      const rock = snap.objects[0];
      snap.agents[0].pos = { x: rock.pos.x - 1, y: rock.pos.y };
      const result = step(snap, 'a', { type: 'throw', data: { dx: 1, dy: 0 } });
      expect(result.ok).toBe(true);
      expect(result.spawned).toHaveLength(2);
      expect(boardViolation(snap), `seed ${seed}`).toBeNull();
      vi.restoreAllMocks();
    }
  });
});

describe('G2 / section 7 Joining — a newcomer is placed on a free tile of its territory', () => {
  const tilesOf = (territory: string) => LAND.filter((p) => territoryAt(p) === territory);

  it('G2: with the whole cast around, a newcomer never lands on a villager, in any territory, over many draws', () => {
    for (const t of TERRITORIES) {
      const rnd = seededRandom(t.id.length * 101);
      const snap = mkSnapshot([]);
      const tiles = tilesOf(t.id);
      // fill the territory villager by villager until it is full, spawning each one through the real function
      for (let i = 0; i < tiles.length; i++) {
        const p = findSpawnTile(snap, t.id, rnd);
        expect(p, `${t.id} should still have room for villager ${i}`).not.toBeNull();
        expect(territoryAt(p!)).toBe(t.id);
        snap.agents.push(mkAgent(`n${i}`, `N${i}`, p!.x, p!.y));
        expect(boardViolation(snap)).toBeNull();
      }
      expect(findSpawnTile(snap, t.id, rnd), `${t.id} is full`).toBeNull();
    }
  });

  it('G2: it prefers ground with nothing on it, and falls back to an object tile only when it must', () => {
    const t = TERRITORIES.find((x) => x.id === 'hills')!;
    const snap = mkSnapshot([]);
    const tiles = tilesOf(t.id);
    const objectTiles = new Set(snap.objects.map((o) => tileKey(o.pos)));
    const bare = tiles.filter((p) => !objectTiles.has(tileKey(p)));
    expect(bare.length).toBeGreaterThan(0);
    for (let seed = 1; seed <= 50; seed++) {
      expect(objectTiles.has(tileKey(findSpawnTile(snap, t.id, seededRandom(seed))!))).toBe(false);
    }
    for (const p of bare) snap.agents.push(mkAgent(`b${tileKey(p)}`, 'B', p.x, p.y));
    const last = findSpawnTile(snap, t.id, seededRandom(1))!;
    expect(objectTiles.has(tileKey(last))).toBe(true);
    expect(boardViolation(mkSnapshot([...snap.agents, mkAgent('z', 'Z', last.x, last.y)]))).toBeNull();
  });

  it('G2: an unknown territory has no spawn tile', () => {
    expect(findSpawnTile(mkSnapshot([]), 'nowhere')).toBeNull();
  });
});

describe('G2 — the checker itself', () => {
  it('G2: a board with two villagers on one tile is reported', () => {
    const snap = mkSnapshot([mkAgent('a', 'Alder', 3, 3), mkAgent('b', 'Bramble', 3, 3)]);
    expect(boardViolation(snap)).toContain('both stand on (3, 3)');
  });

  it('G2: a villager in the water is reported', () => {
    const water = { x: 14, y: 14 };
    expect(territoryAt(water) ?? (isRoad(water) ? 'road' : null)).toBeNull();
    expect(boardViolation(mkSnapshot([mkAgent('a', 'Alder', water.x, water.y)]))).toContain('water');
  });

  it('G2: two cubes on one tile are reported', () => {
    const snap = mkSnapshot([]);
    snap.objects.push(
      { id: 'cube_1', territory: 'forest', pos: { x: 2, y: 2 }, kind: 'cube' },
      { id: 'cube_2', territory: 'forest', pos: { x: 2, y: 2 }, kind: 'cube' }
    );
    expect(boardViolation(snap)).toContain('same tile');
  });

  it('G2: the real starting cast stands on distinct land tiles in their own territory', () => {
    const keys = STARTING_VILLAGERS.map((v) => tileKey(v.pos));
    expect(new Set(keys).size).toBe(keys.length);
    for (const v of STARTING_VILLAGERS) expect(territoryAt(v.pos)).toBe(v.territory);
    expect(TERRITORIES.length).toBeGreaterThan(0);
  });
});
