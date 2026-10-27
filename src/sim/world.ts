import { ACTION_DEFS } from './actions.ts';

export type TerritoryId = 'forest' | 'valley' | 'hills';

export interface GridPos {
  x: number;
  y: number;
}

export type ResourceKind = 'wood' | 'food' | 'gold' | 'stone';

/** Natural resource nodes and built structures */
export interface WorldObject {
  id: string;
  territory: TerritoryId;
  pos: GridPos;
  kind:
    | 'tree'
    | 'berry_bush'
    | 'gold_mine'
    | 'stone_mine'
    | 'town_center'
    | 'house'
    | 'mill'
    | 'barracks'
    | 'watch_tower'
    | 'wonder'
    | 'cube'
    | 'rock'
    | 'shrub'
    | 'flower'
    | 'boulder'
    | 'outcrop'
    | 'deer'
    | 'boar'
    | 'sheep';
  builtBy?: string;
}

export const GRID_SIZE = 24;

export interface TerritoryDef {
  id: TerritoryId;
  name: string;
  color: string;
  offset: GridPos;
  size: number;
  description: string;
}

export const ANIMAL_KINDS = ['deer', 'boar', 'sheep'] as const;
export type AnimalKind = (typeof ANIMAL_KINDS)[number];

/**
 * How long a gathered animal takes to return to the wild, in world ticks (R5.1: never wall-clock).
 * 170 ticks is roughly the old 10 minutes at the default 3.5s per tick.
 */
export const ANIMAL_RESPAWN_TICKS = 170;

export const TERRITORIES: TerritoryDef[] = [
  {
    id: 'forest',
    name: 'Greenwood Forest',
    color: '#22c55e',
    offset: { x: 0, y: 0 },
    size: 14,
    description: 'Dense woodland. Trees stand thick here, and berry bushes grow in the shade.',
  },
  {
    id: 'valley',
    name: 'Golden Valley',
    color: '#eab308',
    offset: { x: 17, y: 0 },
    size: 7,
    description: 'Open plains of tall grass. Gold veins lie exposed in the earth.',
  },
  {
    id: 'hills',
    name: 'Stone Hills',
    color: '#94a3b8',
    offset: { x: 8, y: 17 },
    size: 6,
    description: 'Rocky highlands. Stone quarries are cut into the slopes.',
  },
];

export function territoryDef(id: TerritoryId): TerritoryDef {
  return TERRITORIES.find((t) => t.id === id) ?? TERRITORIES[0];
}

export const AGE_NAMES = ['Dark Age', 'Feudal Age', 'Castle Age', 'Imperial Age'] as const;

/** Cost to advance to the next age (wood, food, gold) */
export const AGE_COSTS: Array<{ wood: number; food: number; gold: number }> = [
  { wood: 0, food: 0, gold: 0 }, // placeholder, age 1 -> 2 uses index 1
  { wood: 4, food: 4, gold: 2 },
  { wood: 6, food: 6, gold: 4 },
  { wood: 8, food: 8, gold: 6 },
];

export interface CivState {
  wood: number;
  food: number;
  gold: number;
  stone: number;
  age: number; // 1..4
}

export const ROADS: Array<{ a: TerritoryId; b: TerritoryId; cells: GridPos[] }> = [
  {
    a: 'forest',
    b: 'valley',
    cells: [
      { x: 14, y: 6 },
      { x: 15, y: 6 },
      { x: 16, y: 6 },
      { x: 17, y: 6 },
    ],
  },
  {
    a: 'valley',
    b: 'hills',
    cells: [
      { x: 16, y: 7 },
      { x: 16, y: 8 },
      { x: 16, y: 9 },
      { x: 16, y: 10 },
      { x: 16, y: 11 },
      { x: 16, y: 12 },
      { x: 16, y: 13 },
      { x: 16, y: 14 },
      { x: 16, y: 15 },
      { x: 16, y: 16 },
      { x: 15, y: 16 },
      { x: 14, y: 16 },
      { x: 13, y: 16 },
    ],
  },
  {
    a: 'hills',
    b: 'forest',
    cells: [
      { x: 11, y: 14 },
      { x: 10, y: 14 },
      { x: 10, y: 15 },
      { x: 10, y: 16 },
      { x: 10, y: 17 },
    ],
  },
];

function inTerritory(p: GridPos, def: TerritoryDef): boolean {
  return (
    p.x >= def.offset.x &&
    p.x < def.offset.x + def.size &&
    p.y >= def.offset.y &&
    p.y < def.offset.y + def.size
  );
}

export function isRoad(p: GridPos): boolean {
  return ROADS.some((r) => r.cells.some((c) => c.x === p.x && c.y === p.y));
}

export function territoryAt(p: GridPos): TerritoryId | null {
  for (const def of TERRITORIES) {
    if (inTerritory(p, def)) return def.id;
  }
  return null;
}

export interface AgentState {
  id: string;
  name: string;
  model: string;
  color: string;
  island: TerritoryId;
  pos: GridPos;
  mood: string;
  persona: string;
  status: string;
  inventory: string[];
  hunger: number;
  energy: number;
  lastThought?: string;
  lastBubble?: string;
  traits?: Record<string, { level: number; xp: number }>;
  goals?: Array<{ text: string; createdAt: number }>;
  relationships?: Array<{ withId: string; withName: string; strength: number; lastMessage: string | null }>;
  /** In-memory only: last tiles this villager stood on, newest last. Drives wander. */
  recentTiles?: GridPos[];
  /**
   * In-memory only (R7.4): words spoken to this villager since its last turn, oldest first,
   * at most INBOX_LIMIT. Always replaced, never mutated, so history snapshots stay frozen.
   */
  inbox?: Array<{ fromId: string; fromName: string; message: string }>;
}

/** Most pending chat messages a villager keeps; the oldest is dropped beyond this (R7.4). */
export const INBOX_LIMIT = 3;

export interface WorldSnapshot {
  tick: number;
  agents: AgentState[];
  objects: WorldObject[];
  civ: CivState;
  /** Per-era counter for ids of built structures and cubes (R5.1: never the wall clock). */
  nextId: number;
}

/** Safe starting value for `nextId` given existing objects: one past the highest built_/cube_ id. */
export function nextIdFor(objects: WorldObject[]): number {
  let max = 0;
  for (const o of objects) {
    const m = /^(?:built|cube)_(\d+)/.exec(o.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** Takes the next id for a built structure or cube from the snapshot's counter. */
function allocId(snapshot: WorldSnapshot, prefix: 'built' | 'cube'): string {
  const n = Math.max(1, snapshot.nextId || 1);
  snapshot.nextId = n + 1;
  return `${prefix}_${n}`;
}

export type ActionInput =
  | { type: 'move'; data: { dx: number; dy: number } }
  | { type: 'goto'; data: { x: number; y: number } }
  | { type: 'gather'; data: { object_id: string } }
  | { type: 'gather_nearest'; data: Record<string, never> }
  | { type: 'build'; data: { structure: 'house' | 'mill' | 'barracks' | 'watch_tower' | 'wonder' } }
  | { type: 'deposit'; data: Record<string, never> }
  | { type: 'advance_age'; data: Record<string, never> }
  | { type: 'say'; data: { message: string } }
  | { type: 'chat'; data: { agent_id: string; message: string } }
  | { type: 'gift'; data: { agent_id: string; item?: string } }
  | { type: 'wander'; data: Record<string, never> }
  | { type: 'eat'; data: Record<string, never> }
  | { type: 'train'; data: { ability: string } }
  | { type: 'pick_up'; data: { object_id: string } }
  | { type: 'place'; data: { dx: number; dy: number } }
  | { type: 'throw'; data: { dx: number; dy: number } }
  | { type: 'discover'; data: { insight: string } }
  | { type: 'set_goal'; data: { goal: string } }
  | { type: 'plan'; data: { steps: ActionInput[] } }
  | { type: 'remember'; data: { kind: 'semantic' | 'episodic'; content: string } }
  | { type: 'wait'; data: Record<string, never> };

/** The single steps a decision executes: a plan's steps in order, otherwise the action itself. */
export function planSteps(action: ActionInput): ActionInput[] {
  return action.type === 'plan' ? action.data.steps : [action];
}

/**
 * Runs steps strictly in order, awaiting each; a failed step ends the run there (R3.2, R8.4).
 * `endedAt` is the index of the failing step, or null when every step succeeded.
 */
export async function runSteps<R extends { ok: boolean }>(
  steps: ActionInput[],
  exec: (step: ActionInput, index: number) => Promise<R>
): Promise<{ results: R[]; endedAt: number | null }> {
  const results: R[] = [];
  for (let i = 0; i < steps.length; i++) {
    const result = await exec(steps[i], i);
    results.push(result);
    if (!result.ok) return { results, endedAt: i };
  }
  return { results, endedAt: null };
}

/** Marks villagers' pending chat as heard: the inbox is shown exactly once (R7.4). */
export function clearInbox(...agents: Array<AgentState | undefined>): void {
  for (const a of agents) if (a) a.inbox = undefined;
}

/** Every action type, derived from the one definition table (ACTION_DEFS). */
export const ACTION_TYPES = Object.keys(ACTION_DEFS) as ActionInput['type'][];

export const BUILD_COSTS: Record<string, { wood: number; stone: number; gold: number }> = {
  house: { wood: 3, stone: 0, gold: 0 },
  mill: { wood: 4, stone: 0, gold: 0 },
  barracks: { wood: 4, stone: 2, gold: 0 },
  watch_tower: { wood: 1, stone: 4, gold: 0 },
  wonder: { wood: 6, stone: 8, gold: 6 },
};

/** Seeded resource nodes per territory */
export function seedObjects(): WorldObject[] {
  const objs: WorldObject[] = [];
  let n = 0;
  const add = (territory: TerritoryId, x: number, y: number, kind: WorldObject['kind']) => {
    objs.push({ id: `res_${n++}`, territory, pos: { x, y }, kind });
  };

  // Greenwood Forest: clustered woodland, berry thickets, undergrowth
  const trees: Array<[number, number]> = [
    [2, 2], [3, 2], [2, 3], [3, 3], [4, 3], [3, 4],
    [9, 3], [10, 3], [11, 4], [10, 4], [12, 5],
    [4, 9], [5, 9], [5, 10], [6, 10], [5, 11], [6, 11], [4, 12],
    [1, 7], [2, 8], [1, 9], [7, 5], [8, 5],
    [11, 8], [12, 6], [12, 8], [8, 12], [9, 12], [9, 2], [11, 9],
    [7, 13], [12, 12], [1, 12], [13, 3], [13, 9],
  ];
  trees.forEach(([x, y]) => add('forest', x, y, 'tree'));
  const bushes: Array<[number, number]> = [
    [2, 12], [12, 2], [6, 7], [9, 7], [3, 6], [11, 10], [1, 4], [7, 11],
  ];
  bushes.forEach(([x, y]) => add('forest', x, y, 'berry_bush'));
  const shrubs: Array<[number, number]> = [
    [4, 5], [8, 8], [11, 11], [2, 6], [9, 9], [6, 2], [13, 6], [4, 8], [10, 6], [7, 8],
  ];
  shrubs.forEach(([x, y]) => add('forest', x, y, 'shrub'));
  const flowers: Array<[number, number]> = [
    [5, 4], [8, 10], [3, 10], [11, 5], [6, 12], [12, 10], [2, 10], [9, 4],
  ];
  flowers.forEach(([x, y]) => add('forest', x, y, 'flower'));
  add('forest', 7, 7, 'town_center');

  // Golden Valley (offset 17,0, 7x7): gold veins, lone trees, meadow life
  add('valley', 17 + 2, 2, 'gold_mine'); add('valley', 17 + 5, 3, 'gold_mine');
  add('valley', 17 + 3, 5, 'gold_mine'); add('valley', 17 + 1, 4, 'gold_mine');
  add('valley', 17 + 4, 1, 'tree'); add('valley', 17 + 1, 6, 'tree');
  add('valley', 17 + 5, 5, 'tree');
  add('valley', 17 + 2, 4, 'shrub'); add('valley', 17 + 4, 3, 'shrub');
  add('valley', 17 + 3, 1, 'flower'); add('valley', 17 + 6, 2, 'flower');
  add('valley', 17 + 5, 6, 'flower');
  add('valley', 17 + 2, 0, 'sheep'); add('valley', 17 + 3, 0, 'sheep');
  add('valley', 17 + 6, 4, 'sheep');
  add('valley', 17 + 0, 2, 'deer');

  // Stone Hills (offset 8,17): quarries, boulders, outcrops
  add('hills', 8 + 1, 17 + 1, 'stone_mine'); add('hills', 8 + 4, 17 + 3, 'stone_mine');
  add('hills', 8 + 1, 17 + 4, 'stone_mine'); add('hills', 8 + 5, 17 + 5, 'stone_mine');
  add('hills', 8 + 3, 17 + 1, 'tree'); add('hills', 8 + 0, 17 + 2, 'tree');
  add('hills', 8 + 5, 17 + 1, 'boulder'); add('hills', 8 + 2, 17 + 5, 'boulder');
  add('hills', 8 + 3, 17 + 3, 'outcrop'); add('hills', 8 + 5, 17 + 4, 'outcrop');
  add('hills', 8 + 0, 17 + 5, 'shrub');
  add('hills', 8 + 1, 17 + 0, 'boar'); add('hills', 8 + 2, 17 + 0, 'boar');
  add('hills', 8 + 5, 17 + 0, 'deer');

  // woodland creatures in the deep forest
  add('forest', 12, 11, 'deer'); add('forest', 1, 6, 'deer'); add('forest', 13, 12, 'boar');

  // the Standing Rock — it does not gather, mine or burn. Villagers must learn what it does.
  add('hills', 10, 19, 'rock');

  // strange cubes scattered near the Town Center — free to pick up, place and throw
  [[6, 8], [9, 8], [8, 9], [5, 6], [10, 10]].forEach(([x, y]) => add('forest', x, y, 'cube'));

  return objs;
}

const MAX_OBJECTS = 240;

export interface ActionResult {
  ok: boolean;
  message: string;
  events: Array<{ type: string; message: string; data?: Record<string, unknown> }>;
  memory?: { kind: 'semantic' | 'episodic' | 'discovery'; content: string };
  depleted?: { id: string; respawnTick: number | null };
  newGoal?: string;
  civDelta?: Partial<CivState>;
  civAge?: number;
  built?: { id: string; structure: WorldObject['kind']; pos: GridPos; by: string };
  spawned?: Array<{ id: string; pos: GridPos; by: string }>;
  chat?: { withId: string; withName: string; message: string; dropped?: { fromName: string; message: string } };
  gift?: { withId: string; withName: string; item: string };
}

const RESOURCE_LABEL: Record<ResourceKind, string> = {
  wood: 'wood',
  food: 'food',
  gold: 'gold',
  stone: 'stone',
};

export function nodeResource(kind: WorldObject['kind']): ResourceKind | null {
  switch (kind) {
    case 'tree': return 'wood';
    case 'berry_bush': return 'food';
    case 'gold_mine': return 'gold';
    case 'stone_mine': return 'stone';
    case 'deer': return 'food';
    case 'boar': return 'food';
    case 'sheep': return 'food';
    default: return null;
  }
}

function canStand(p: GridPos): boolean {
  return territoryAt(p) !== null || isRoad(p);
}

/** Breadth-first search over walkable land (territories and roads); other villagers block, objects do not. */
function hasLandPath(snapshot: WorldSnapshot, agent: AgentState, target: GridPos): boolean {
  const key = (p: GridPos) => p.y * GRID_SIZE + p.x;
  const blocked = (p: GridPos) =>
    !canStand(p) || snapshot.agents.some((a) => a.id !== agent.id && a.pos.x === p.x && a.pos.y === p.y);
  if (blocked(target)) return false;
  const seen = new Set<number>([key(agent.pos)]);
  const queue: GridPos[] = [agent.pos];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    if (cur.x === target.x && cur.y === target.y) return true;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = { x: cur.x + dx, y: cur.y + dy };
      if (next.x < 0 || next.y < 0 || next.x >= GRID_SIZE || next.y >= GRID_SIZE) continue;
      if (seen.has(key(next)) || blocked(next)) continue;
      seen.add(key(next));
      queue.push(next);
    }
  }
  return false;
}

function tileOccupied(snapshot: WorldSnapshot, p: GridPos): boolean {
  return snapshot.objects.some((o) => o.pos.x === p.x && o.pos.y === p.y);
}

function clampInt(v: unknown, lo: number, hi: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0;
}

export function step(
  snapshot: WorldSnapshot,
  agentId: string,
  action: ActionInput
): ActionResult {
  const agent = snapshot.agents.find((a) => a.id === agentId);
  if (!agent) return { ok: false, message: 'Unknown villager — no such villager stands in the empire. Try again on your next turn.', events: [] };

  const events: ActionResult['events'] = [];
  const dirName = (dx: number, dy: number) =>
    dx < 0 ? 'west' : dx > 0 ? 'east' : dy < 0 ? 'north' : dy > 0 ? 'south' : 'nowhere';

  switch (action.type) {
    case 'move': {
      const { dx, dy } = action.data;
      if (Math.abs(dx) + Math.abs(dy) !== 1) {
        return { ok: false, message: 'Move exactly 1 step in a single direction (dx or dy of -1 or 1, the other 0). To travel farther, use goto with a tile instead.', events };
      }
      const next = { x: agent.pos.x + dx, y: agent.pos.y + dy };
      if (next.x < 0 || next.y < 0 || next.x >= GRID_SIZE || next.y >= GRID_SIZE) {
        return { ok: false, message: 'Beyond the known world lies the void. Stay on the map.', events };
      }
      if (!territoryAt(next) && !isRoad(next)) {
        return { ok: false, message: 'You cannot cross open water. Use the roads.', events };
      }
      const other = snapshot.agents.find(
        (a) => a.id !== agent.id && a.pos.x === next.x && a.pos.y === next.y
      );
      if (other) {
        return { ok: false, message: `${other.name} is standing there. Step around them, choose another direction, or goto a tile beyond them.`, events };
      }
      const prev = territoryAt(agent.pos);
      agent.pos = next;
      const now = territoryAt(next);
      let msg = `You march ${dirName(dx, dy)} to (${next.x}, ${next.y}).`;
      if (now && now !== prev) msg += ` You arrive in ${territoryDef(now).name}.`;
      return {
        ok: true,
        message: msg,
        events: [{ type: 'move', message: `${agent.name} marched to (${next.x}, ${next.y})`, data: { pos: next } }],
      };
    }

    case 'goto': {
      const { x, y } = action.data;
      const target = { x, y };
      if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE) {
        return { ok: false, message: 'Beyond the known world lies the void. Stay on the map.', events };
      }
      if (!territoryAt(target) && !isRoad(target)) {
        return { ok: false, message: 'That point lies in open water. Choose a point on land, or follow the roads between the territories.', events };
      }
      if (!hasLandPath(snapshot, agent, target)) {
        return { ok: false, message: 'No clear path to that point — open water or another villager is in the way. Try a nearer point, or step aside and go around.', events };
      }
      const cur = target;
      const now = territoryAt(cur);
      const prev = territoryAt(agent.pos);
      agent.pos = cur;
      let msg = `You march to (${cur.x}, ${cur.y}).`;
      if (now && now !== prev) msg += ` You arrive in ${territoryDef(now).name}.`;
      return {
        ok: true,
        message: msg,
        events: [{ type: 'move', message: `${agent.name} marched to (${cur.x}, ${cur.y})`, data: { pos: cur } }],
      };
    }

    case 'gather_nearest':
    case 'gather': {
      let obj: WorldObject | undefined;
      if (action.type === 'gather_nearest') {
        const candidates = snapshot.objects
          .map((o) => ({ o, d: Math.max(Math.abs(o.pos.x - agent.pos.x), Math.abs(o.pos.y - agent.pos.y)) }))
          .filter(({ o, d }) => nodeResource(o.kind) !== null && d <= 1)
          .sort((a, b) => a.d - b.d);
        if (candidates.length === 0) {
          return {
            ok: false,
            message: "Nothing can be gathered within arm's reach. March toward a resource first (goto).",
            events,
          };
        }
        obj = candidates[0].o;
      } else {
        obj = snapshot.objects.find((o) => o.id === action.data.object_id);
        if (!obj) return { ok: false, message: 'No resource with that id exists here (it may be depleted already). Pick an id from "You see nearby", or gather_nearest once a resource is beside you.', events };
      }
      const reach = Math.max(Math.abs(obj.pos.x - agent.pos.x), Math.abs(obj.pos.y - agent.pos.y));
      if (reach > 1) {
        return { ok: false, message: `The ${obj.kind.replace('_', ' ')} is beyond arm's reach. March onto or right beside it first (goto).`, events };
      }
      const res = nodeResource(obj.kind);
      if (!res) return { ok: false, message: `A ${obj.kind.replace('_', ' ')} is not a resource to gather. Choose a tree, berry bush, mine or animal instead.`, events };
      if (agent.inventory.length >= 2) {
        return { ok: false, message: 'You are carrying enough (max 2). Deposit at the Town Center first.', events };
      }
      // mines are finite; trees and bushes regrow so food and wood never run dry;
      // creatures of the wild return to their herds after a while
      let depleted: ActionResult['depleted'];
      if (obj.kind === 'gold_mine' || obj.kind === 'stone_mine') {
        snapshot.objects = snapshot.objects.filter((o) => o.id !== obj.id);
        depleted = { id: obj.id, respawnTick: null };
      } else if ((ANIMAL_KINDS as readonly string[]).includes(obj.kind)) {
        snapshot.objects = snapshot.objects.filter((o) => o.id !== obj.id);
        depleted = { id: obj.id, respawnTick: snapshot.tick + ANIMAL_RESPAWN_TICKS };
      }
      agent.inventory.push(res);
      return {
        ok: true,
        message: `You gather 1 ${RESOURCE_LABEL[res]} from the ${obj.kind.replace('_', ' ')}. Carrying: ${agent.inventory.join(', ')}. Deposit it at the Town Center.`,
        events: [{ type: 'gather', message: `${agent.name} gathered ${RESOURCE_LABEL[res]}`, data: { resource: res } }],
        depleted,
      };
    }

    case 'deposit': {
      const carriedCubes = agent.inventory.filter((i) => i === 'cube');
      const resources = agent.inventory.filter((i) => i !== 'cube');
      if (resources.length === 0) {
        return { ok: false, message: carriedCubes.length ? 'You carry only a strange cube — the Town Center wants no part of it. Place or throw it instead.' : 'You carry nothing to deposit. Gather something first.', events };
      }
      const tc = snapshot.objects.find((o) => o.kind === 'town_center');
      if (!tc) return { ok: false, message: 'There is no Town Center on the map, so there is nowhere to deposit. Try something else meanwhile, such as wander.', events };
      if (Math.abs(tc.pos.x - agent.pos.x) + Math.abs(tc.pos.y - agent.pos.y) > 1) {
        return {
          ok: false,
          message: `The Town Center is at (${tc.pos.x}, ${tc.pos.y}). March to a tile right beside it and deposit again.`,
          events,
        };
      }
      const delta: Partial<CivState> = {};
      for (const item of resources) {
        const key = item as ResourceKind;
        snapshot.civ[key] = (snapshot.civ[key] ?? 0) + 1;
        delta[key] = (delta[key] ?? 0) + 1;
      }
      const deposited = resources.join(', ');
      agent.inventory = carriedCubes;
      const cubeNote = carriedCubes.length ? ' (You keep hold of your strange cube.)' : '';
      return {
        ok: true,
        message: `You deposit ${deposited} at the Town Center. Stockpile: ${snapshot.civ.wood} wood, ${snapshot.civ.food} food, ${snapshot.civ.gold} gold, ${snapshot.civ.stone} stone.${cubeNote}`,
        events: [{ type: 'deposit', message: `${agent.name} deposited ${deposited} at the Town Center`, data: delta }],
        civDelta: delta,
      };
    }

    case 'build': {
      const structure = action.data.structure;
      if (!structure || !(structure in BUILD_COSTS)) {
        return { ok: false, message: 'Unknown structure. Choose: house, mill, barracks, watch_tower, wonder.', events };
      }
      if (snapshot.objects.length >= MAX_OBJECTS) {
        return { ok: false, message: 'The known world is too crowded to hold another structure. Try gathering or exploring (wander) instead.', events };
      }
      const cost = BUILD_COSTS[structure];
      const civ = snapshot.civ;
      const missing: string[] = [];
      if (civ.wood < cost.wood) missing.push(`${cost.wood} wood`);
      if (civ.stone < cost.stone) missing.push(`${cost.stone} stone`);
      if (civ.gold < cost.gold) missing.push(`${cost.gold} gold`);
      if (missing.length > 0) {
        return {
          ok: false,
          message: `The empire cannot afford a ${structure.replace('_', ' ')} yet. Missing: ${missing.join(', ')}. Gather and deposit resources first.`,
          events,
        };
      }
      if (structure === 'wonder' && civ.age < 4) {
        return { ok: false, message: "A Wonder may only be raised in the Imperial Age. Advance the empire's age first.", events };
      }
      civ.wood -= cost.wood;
      civ.stone -= cost.stone;
      civ.gold -= cost.gold;
      const builtId = allocId(snapshot, 'built');
      snapshot.objects.push({
        id: builtId,
        territory: agent.island,
        pos: { ...agent.pos },
        kind: structure,
        builtBy: agent.name,
      });
      return {
        ok: true,
        message: `A ${structure.replace('_', ' ')} rises at (${agent.pos.x}, ${agent.pos.y})! Paid from the stockpile: ${cost.wood} wood, ${cost.stone} stone, ${cost.gold} gold.`,
        events: [{ type: 'build', message: `${agent.name} built a ${structure.replace('_', ' ')} for the empire`, data: { structure } }],
        civDelta: { wood: -cost.wood, stone: -cost.stone, gold: -cost.gold },
        built: { id: builtId, structure, pos: { ...agent.pos }, by: agent.name },
      };
    }

    case 'advance_age': {
      const civ = snapshot.civ;
      if (civ.age >= 4) {
        return { ok: false, message: 'The empire already stands in the Imperial Age. Glory is now built, not researched. Gather for a wonder and build it instead.', events };
      }
      const cost = AGE_COSTS[civ.age]; // age 1 -> 2 uses AGE_COSTS[1]
      if (civ.wood < cost.wood || civ.food < cost.food || civ.gold < cost.gold) {
        return {
          ok: false,
          message: `Advancing to ${AGE_NAMES[civ.age]} requires ${cost.wood} wood, ${cost.food} food, ${cost.gold} gold in the stockpile. Gather more and deposit it at the Town Center first.`,
          events,
        };
      }
      civ.wood -= cost.wood;
      civ.food -= cost.food;
      civ.gold -= cost.gold;
      civ.age += 1;
      const next = AGE_NAMES[civ.age - 1];
      return {
        ok: true,
        message: `The empire advances to the ${next}! Drums echo across the territories.`,
        events: [{ type: 'advance_age', message: `The civilization advanced to the ${next}`, data: { age: civ.age } }],
        civDelta: { wood: -cost.wood, food: -cost.food, gold: -cost.gold },
        civAge: civ.age,
      };
    }

    case 'pick_up': {
      const obj = snapshot.objects.find((o) => o.id === action.data.object_id);
      if (!obj) return { ok: false, message: 'No object with that id is here (a cube may have been moved or picked up). Pick an id from "You see nearby", and march beside it first (goto).', events };
      if (obj.kind !== 'cube') {
        return { ok: false, message: `The ${obj.kind.replace('_', ' ')} cannot be picked up. Only the strange cubes can — gather resources instead, or goto a cube first.`, events };
      }
      const reach = Math.max(Math.abs(obj.pos.x - agent.pos.x), Math.abs(obj.pos.y - agent.pos.y));
      if (reach > 1) return { ok: false, message: `The cube is at (${obj.pos.x}, ${obj.pos.y}) — march onto or beside it first.`, events };
      if (agent.inventory.includes('cube')) {
        return { ok: false, message: 'You already carry a cube. Place or throw it before picking up another.', events };
      }
      snapshot.objects = snapshot.objects.filter((o) => o.id !== obj.id);
      agent.inventory.push('cube');
      return {
        ok: true,
        message: 'You heft the strange cube. It hums faintly in your hands. Place it (dx/dy -1..1) or throw it (dx/dy up to 3).',
        events: [{ type: 'pick_up', message: `${agent.name} picked up a strange cube` }],
      };
    }

    case 'place': {
      if (!agent.inventory.includes('cube')) return { ok: false, message: 'You carry no cube to place. Goto a strange cube and pick_up it first.', events };
      const t = { x: agent.pos.x + clampInt(action.data.dx, -1, 1), y: agent.pos.y + clampInt(action.data.dy, -1, 1) };
      if (t.x < 0 || t.y < 0 || t.x >= GRID_SIZE || t.y >= GRID_SIZE || !canStand(t)) {
        return { ok: false, message: 'You cannot set the cube down there — open water. Choose another direction (dx/dy -1..1) that leads onto land.', events };
      }
      if (tileOccupied(snapshot, t)) {
        return { ok: false, message: 'Something already stands on that tile. Choose an empty one.', events };
      }
      agent.inventory = agent.inventory.filter((i) => i !== 'cube');
      const id = allocId(snapshot, 'cube');
      snapshot.objects.push({ id, territory: territoryAt(t) ?? agent.island, pos: t, kind: 'cube', builtBy: agent.name });
      return {
        ok: true,
        message: `You set the cube down at (${t.x}, ${t.y}).`,
        events: [{ type: 'place', message: `${agent.name} placed a cube at (${t.x}, ${t.y})` }],
        built: { id, structure: 'cube', pos: t, by: agent.name },
      };
    }

    case 'throw': {
      if (!agent.inventory.includes('cube')) return { ok: false, message: 'You carry no cube to throw. Goto a strange cube and pick_up it first.', events };
      const dx = clampInt(action.data.dx, -3, 3);
      const dy = clampInt(action.data.dy, -3, 3);
      if (dx === 0 && dy === 0) return { ok: false, message: 'A throw needs a direction. Choose dx/dy up to 3 — for example dx 2, dy 0.', events };
      const ux = Math.sign(dx);
      const uy = Math.sign(dy);
      const range = Math.max(Math.abs(dx), Math.abs(dy));
      let cur = { ...agent.pos };
      let flew = 0;
      let rock: WorldObject | undefined;
      for (let i = 0; i < range; i++) {
        const next = { x: cur.x + ux, y: cur.y + uy };
        if (next.x < 0 || next.y < 0 || next.x >= GRID_SIZE || next.y >= GRID_SIZE || !canStand(next)) break;
        // the rock occupies its tile, so a cube that reaches it strikes it instead of stopping short
        rock = snapshot.objects.find((o) => o.kind === 'rock' && o.pos.x === next.x && o.pos.y === next.y);
        if (rock) {
          flew++;
          break;
        }
        if (tileOccupied(snapshot, next)) break;
        cur = next;
        flew++;
      }
      if (flew === 0) return { ok: false, message: 'The way is blocked — the cube drops back into your hands. Try throwing in another direction, or place it on an empty tile instead.', events };
      agent.inventory = agent.inventory.filter((i) => i !== 'cube');
      if (rock) {
        const spawned: NonNullable<ActionResult['spawned']> = [];
        const spots: GridPos[] = [];
        for (let ox = -1; ox <= 1; ox++) {
          for (let oy = -1; oy <= 1; oy++) {
            if (ox === 0 && oy === 0) continue;
            const p = { x: rock.pos.x + ox, y: rock.pos.y + oy };
            if (canStand(p) && !tileOccupied(snapshot, p) && !snapshot.agents.some((a) => a.pos.x === p.x && a.pos.y === p.y)) spots.push(p);
          }
        }
        for (let i = 0; i < Math.min(2, spots.length); i++) {
          const p = spots[Math.floor(Math.random() * spots.length)];
          const id = allocId(snapshot, 'cube');
          snapshot.objects.push({ id, territory: territoryAt(p) ?? agent.island, pos: p, kind: 'cube', builtBy: 'the Standing Rock' });
          spawned.push({ id, pos: p, by: 'the Standing Rock' });
        }
        return {
          ok: true,
          message: `The cube strikes the Standing Rock. The ground shudders — the rock swallows your cube and pushes two NEW cubes out of the earth! Throw more. Experiment.`,
          events: [{ type: 'throw', message: `${agent.name} threw a cube at the Standing Rock — it spawned new cubes!` }],
          spawned,
        };
      }
      const id = allocId(snapshot, 'cube');
      snapshot.objects.push({ id, territory: territoryAt(cur) ?? agent.island, pos: cur, kind: 'cube', builtBy: agent.name });
      return {
        ok: true,
        message: `The cube skitters ${flew} tile${flew > 1 ? 's' : ''} and settles at (${cur.x}, ${cur.y}).`,
        events: [{ type: 'throw', message: `${agent.name} threw a cube to (${cur.x}, ${cur.y})` }],
        built: { id, structure: 'cube', pos: cur, by: agent.name },
      };
    }

    case 'say': {
      const msg = action.data.message.slice(0, 200);
      return {
        ok: true,
        message: `You declare: "${msg}"`,
        events: [{ type: 'say', message: `${agent.name} says: "${msg}"` }],
      };
    }

    case 'remember': {
      const content = action.data.content.slice(0, 500);
      return {
        ok: true,
        message: `You record in the empire chronicles: "${content}"`,
        events: [{ type: 'memory', message: `${agent.name} recorded: ${content}` }],
        memory: { kind: action.data.kind, content },
      };
    }

    case 'discover':
      return {
        ok: true,
        message: `Insight recorded for the whole empire: "${action.data.insight}"`,
        events: [{ type: 'discover', message: `${agent.name} discovered: ${action.data.insight}` }],
        memory: { kind: 'discovery', content: action.data.insight },
      };

    case 'set_goal':
      return {
        ok: true,
        message: `You fix your ambition: "${action.data.goal}"`,
        events: [{ type: 'goal', message: `${agent.name} resolves: ${action.data.goal}` }],
        newGoal: action.data.goal,
      };

    case 'train':
      return {
        ok: true,
        message: `You drill ${action.data.ability} until it becomes second nature. You feel yourself improving.`,
        events: [{ type: 'train', message: `${agent.name} trained ${action.data.ability}`, data: { ability: action.data.ability } }],
      };

    case 'chat': {
      const target = snapshot.agents.find((a) => a.id === action.data.agent_id);
      if (!target) return { ok: false, message: 'No such villager to chat with. Use an id from "Standing right beside you" or "Fellow villagers", and stand beside them first.', events };
      if (target.id === agent.id) return { ok: false, message: 'Talking to yourself again? Choose a villager standing beside you to chat with, or use say to speak aloud instead.', events };
      const dist = Math.max(Math.abs(target.pos.x - agent.pos.x), Math.abs(target.pos.y - agent.pos.y));
      if (dist > 1) return { ok: false, message: `${target.name} is too far away — march to a tile right beside them first.`, events };
      const msg = action.data.message.slice(0, 200);
      // the target hears it in its next observation; beyond INBOX_LIMIT the oldest is lost
      const pending = [...(target.inbox ?? []), { fromId: agent.id, fromName: agent.name, message: msg }];
      const lost = pending.length > INBOX_LIMIT ? pending[0] : undefined;
      target.inbox = pending.slice(-INBOX_LIMIT);
      return {
        ok: true,
        message: `You say to ${target.name}: "${msg}"`,
        events: [
          { type: 'chat', message: `${agent.name} to ${target.name}: "${msg}"` },
        ],
        chat: {
          withId: target.id,
          withName: target.name,
          message: msg,
          ...(lost ? { dropped: { fromName: lost.fromName, message: lost.message } } : {}),
        },
      };
    }

    case 'gift': {
      const target = snapshot.agents.find((a) => a.id === action.data.agent_id);
      if (!target) return { ok: false, message: 'No such villager to give to. Use an id from "Standing right beside you", and stand beside them first.', events };
      if (target.id === agent.id) return { ok: false, message: 'Giving to yourself changes nothing. Choose a villager standing beside you instead.', events };
      const dist = Math.max(Math.abs(target.pos.x - agent.pos.x), Math.abs(target.pos.y - agent.pos.y));
      if (dist > 1) return { ok: false, message: `${target.name} is too far away — march to a tile right beside them first.`, events };
      if (agent.inventory.length === 0) return { ok: false, message: 'Your hands are empty. Gather something before giving.', events };
      const wanted = action.data.item?.trim();
      const idx = wanted ? agent.inventory.indexOf(wanted) : 0;
      if (idx === -1) return { ok: false, message: `You are not carrying ${wanted || 'that'}. Carrying: ${agent.inventory.join(', ') || 'nothing'}. Choose one of those, or omit the item to give the first.`, events };
      if (target.inventory.length >= 2) return { ok: false, message: `${target.name}'s hands are full — they cannot take more. Wait for them to deposit, or give to someone else instead.`, events };
      const item = agent.inventory.splice(idx, 1)[0];
      target.inventory.push(item);
      return {
        ok: true,
        message: `You give 1 ${item} to ${target.name}. They accept it warmly. Carrying: ${agent.inventory.join(', ') || 'nothing'}.`,
        events: [{ type: 'gift', message: `${agent.name} gave 1 ${item} to ${target.name}`, data: { item } }],
        gift: { withId: target.id, withName: target.name, item },
      };
    }

    case 'eat': {
      if (snapshot.civ.food < 1) return { ok: false, message: 'The stockpile has no food. Gather berries or hunt first, then deposit it at the Town Center.', events };
      if (!snapshot.objects.some((o) => o.kind === 'town_center')) return { ok: false, message: 'There is no Town Center on the map, so there is nowhere to eat. Try something else meanwhile, such as wander.', events };
      snapshot.civ.food -= 1;
      return {
        ok: true,
        message: 'You take 1 food from the stockpile and eat. Warmth spreads through you.',
        events: [{ type: 'eat', message: `${agent.name} ate from the stockpile` }],
        civDelta: { food: -1 },
      };
    }

    case 'wander': {
      const recent = new Set((agent.recentTiles ?? []).map((p) => `${p.x},${p.y}`));
      const options = [
        { x: agent.pos.x + 1, y: agent.pos.y },
        { x: agent.pos.x - 1, y: agent.pos.y },
        { x: agent.pos.x, y: agent.pos.y + 1 },
        { x: agent.pos.x, y: agent.pos.y - 1 },
      ].filter(
        (p) =>
          p.x >= 0 && p.y >= 0 && p.x < GRID_SIZE && p.y < GRID_SIZE &&
          (territoryAt(p) || isRoad(p)) &&
          !snapshot.agents.some((a) => a.id !== agent.id && a.pos.x === p.x && a.pos.y === p.y)
      );
      if (options.length === 0) {
        return { ok: false, message: 'Every step around you is blocked. There is nowhere to wander. Wait a turn for a neighbour to move, or chat to ask them to step aside.', events };
      }
      const fresh = options.filter((p) => !recent.has(`${p.x},${p.y}`));
      const pool = fresh.length ? fresh : options;
      const next = pool[Math.floor(Math.random() * pool.length)];
      const ddx = next.x - agent.pos.x;
      const ddy = next.y - agent.pos.y;
      const prevT = territoryAt(agent.pos);
      agent.pos = next;
      const nowT = territoryAt(next);
      let msg = `You wander ${dirName(ddx, ddy)} to (${next.x}, ${next.y}), off the beaten path.`;
      if (nowT && nowT !== prevT) msg += ` You arrive in ${territoryDef(nowT).name}.`;
      return {
        ok: true,
        message: msg,
        events: [{ type: 'wander', message: `${agent.name} wandered to (${next.x}, ${next.y})`, data: { pos: next } }],
      };
    }

    case 'wait':
      return { ok: true, message: 'You rest beside the road and watch the banners flutter.', events: [{ type: 'wait', message: `${agent.name} rests.` }] };

    case 'plan':
      // plans are unrolled into single steps by the simulation before step() runs
      return { ok: false, message: 'A plan cannot be a step of another plan. Choose a single action for each step instead.', events };

    default:
      return unhandledAction(action, events);
  }
}

/**
 * Compile-time exhaustiveness check for step(): `action` is `never` only while
 * every ActionInput type has a case above. Adding a type to the union without a
 * handler fails typecheck here. At runtime it still reports garbage input.
 */
function unhandledAction(action: never, events: ActionResult['events']): ActionResult {
  void action;
  return { ok: false, message: 'Unknown action. Choose one of the actions listed under "Actions you can take now", or wait.', events };
}

export function availableActions(snapshot: WorldSnapshot, agent: AgentState): string[] {
  const acts: string[] = [];
  const gatherables = snapshot.objects.filter((o) => nodeResource(o.kind) !== null);
  const cheb = (o: WorldObject) =>
    Math.max(Math.abs(o.pos.x - agent.pos.x), Math.abs(o.pos.y - agent.pos.y));
  const manhattan = (p: GridPos) => Math.abs(p.x - agent.pos.x) + Math.abs(p.y - agent.pos.y);
  const inReach = gatherables
    .filter((o) => cheb(o) <= 1)
    .sort((a, b) => cheb(a) - cheb(b));
  if (agent.inventory.length >= 2) {
    acts.push('- (your hands are full — deposit at the Town Center before gathering more)');
  } else if (inReach.length) {
    const o = inReach[0];
    acts.push(`- gather_nearest: take ${nodeResource(o.kind)} from the ${o.kind.replace('_', ' ')} beside you (in reach)`);
  }
  const tc = snapshot.objects.find((o) => o.kind === 'town_center');
  const hasResources = agent.inventory.some((i) => i !== 'cube');
  if (tc && hasResources) {
    const d = Math.abs(tc.pos.x - agent.pos.x) + Math.abs(tc.pos.y - agent.pos.y);
    if (d <= 1) {
      acts.push(`- deposit: you carry ${agent.inventory.join(', ')} and stand at the Town Center`);
    } else {
      acts.push(`- goto (${tc.pos.x},${tc.pos.y}): Town Center, ${d} steps away (to deposit)`);
    }
  }
  if (!inReach.length && agent.inventory.length < 2 && gatherables.length) {
    const nearest = gatherables.slice().sort((a, b) => cheb(a) - cheb(b))[0];
    acts.push(`- goto (${nearest.pos.x},${nearest.pos.y}): nearest ${nearest.kind.replace('_', ' ')}, ${manhattan(nearest.pos)} steps away`);
  }
  // exploration: the Standing Rock, strange cubes, the roads, and unvisited ground
  const rock = snapshot.objects.find((o) => o.kind === 'rock');
  if (rock && cheb(rock) > 1) {
    acts.push(`- goto (${rock.pos.x},${rock.pos.y}): the Standing Rock, ${manhattan(rock.pos)} steps away`);
  }
  if (!agent.inventory.includes('cube')) {
    const cube = snapshot.objects
      .filter((o) => o.kind === 'cube')
      .sort((a, b) => cheb(a) - cheb(b))[0];
    if (cube) {
      acts.push(`- goto (${cube.pos.x},${cube.pos.y}): a strange cube, ${manhattan(cube.pos)} steps away`);
    }
  }
  const here = territoryAt(agent.pos);
  const nearestRoadCell = ROADS
    .flatMap((r) => r.cells.map((c) => ({ c, r })))
    .sort((x, y) => manhattan(x.c) - manhattan(y.c))[0];
  if (nearestRoadCell && manhattan(nearestRoadCell.c) > 2 && !isRoad(agent.pos)) {
    const dest = [nearestRoadCell.r.a, nearestRoadCell.r.b]
      .filter((t) => t !== here)
      .map((t) => territoryDef(t).name)
      .join(' or ');
    acts.push(`- goto (${nearestRoadCell.c.x},${nearestRoadCell.c.y}): the road, ${manhattan(nearestRoadCell.c)} steps away — it leads toward ${dest}`);
  }
  acts.push('- wander: step onto ground you have not stood on recently — the best way to find what no map shows');
  acts.push('- wait: rest');
  return acts;
}

export function observe(
  snapshot: WorldSnapshot,
  agent: AgentState,
  history?: Array<{ label: string; result: string }>
): string {
  const civ = snapshot.civ;
  const nearby = snapshot.objects.filter(
    (o) => Math.abs(o.pos.x - agent.pos.x) <= 4 && Math.abs(o.pos.y - agent.pos.y) <= 4
  );
  const others = snapshot.agents.filter((a) => a.id !== agent.id);
  const tc = snapshot.objects.find((o) => o.kind === 'town_center');
  const lines: string[] = [];
  lines.push(`Tick ${snapshot.tick}. You are ${agent.name}, a villager of the empire, in ${territoryDef(agent.island).name} at (${agent.pos.x}, ${agent.pos.y}). The empire is in the ${AGE_NAMES[civ.age - 1]}.`);
  if (agent.goals?.length) {
    lines.push(`Your current ambitions: ${agent.goals.map((g) => g.text).join('; ')}.`);
  }
  lines.push(`Empire stockpile: ${civ.wood} wood, ${civ.food} food, ${civ.gold} gold, ${civ.stone} stone.`);
  const hungerNote =
    agent.hunger >= 60 ? `You are HUNGRY (${agent.hunger}/100) — eat 1 food at the Town Center soon.` :
    agent.hunger >= 30 ? `Your stomach rumbles a little (${agent.hunger}/100 hunger).` : null;
  if (hungerNote) lines.push(hungerNote);
  const energyNote =
    agent.energy <= 25 ? `You are EXHAUSTED (${agent.energy}/100 energy) — waiting or resting will restore you.` :
    agent.energy <= 50 ? `You feel tired (${agent.energy}/100 energy).` : null;
  if (energyNote) lines.push(energyNote);
  lines.push(`Carrying: ${agent.inventory.length ? agent.inventory.join(', ') : 'nothing'}.`);
  if (tc) lines.push(`Town Center at (${tc.pos.x}, ${tc.pos.y}).`);
  const nextAge = civ.age < 4 ? AGE_COSTS[civ.age] : null;
  if (nextAge) {
    lines.push(`Advancing to the ${AGE_NAMES[civ.age]} costs ${nextAge.wood} wood, ${nextAge.food} food, ${nextAge.gold} gold from the stockpile.`);
  }
  const nearbyStr = nearby.length
    ? nearby
        .map((o) => `${o.kind.replace('_', ' ')}#${o.id} at (${o.pos.x},${o.pos.y})${o.builtBy ? ` built by ${o.builtBy}` : ''}`)
        .join('; ')
    : 'nothing of interest';
  lines.push(`You see nearby: ${nearbyStr}.`);
  const beyond = TERRITORIES.filter((t) => t.id !== territoryAt(agent.pos)).map((t) => {
    const cx = t.offset.x + Math.floor(t.size / 2);
    const cy = t.offset.y + Math.floor(t.size / 2);
    const dx = cx - agent.pos.x;
    const dy = cy - agent.pos.y;
    const dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'east' : 'west') : (dy > 0 ? 'south' : 'north');
    return `${t.name} to the ${dir} (${Math.abs(dx) + Math.abs(dy)} steps)`;
  });
  if (beyond.length) lines.push(`Beyond this land: ${beyond.join('; ')}.`);
  const othersStr = others.length
    ? others.map((a) => `${a.name} (${a.mood}) in ${territoryDef(a.island).name} at (${a.pos.x},${a.pos.y})`).join('; ')
    : 'no other villagers';
  const closeBy = others.filter(
    (a) => Math.abs(a.pos.x - agent.pos.x) <= 1 && Math.abs(a.pos.y - agent.pos.y) <= 1
  );
  lines.push(`Fellow villagers: ${othersStr}.`);
  if (closeBy.length) {
    lines.push(`Standing right beside you (close enough to chat or give): ${closeBy.map((a) => `${a.name} (${a.id.slice(0, 8)})`).join('; ')}.`);
  }
  if (agent.inventory.length > 0 && closeBy.length) {
    lines.push('- gift {agent_id}: hand 1 carried item to a villager beside you — a gift deepens a bond');
  }
  if (agent.inbox?.length) {
    lines.push('Words spoken to you since your last turn (answer if you like — no one forces a reply):');
    for (const m of agent.inbox) lines.push(`- ${m.fromName} says: "${m.message.replace(/\s+/g, ' ')}"`);
  }
  if (history && history.length) {
    lines.push('Your last actions and what happened:');
    for (const h of history) lines.push(`- ${h.label} → ${h.result}`);
  }
  lines.push('Actions you can take now:');
  for (const a of availableActions(snapshot, agent)) lines.push(a);
  return lines.join('\n');
}
