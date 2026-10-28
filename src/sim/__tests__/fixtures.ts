import type { ActionType } from '../actions.ts';
import type { ActionInput, AgentState, CivState, WorldSnapshot } from '../world.ts';
import { seedObjects } from '../world.ts';

/** Tiny deterministic PRNG (mulberry32) so no test depends on Math.random. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mkAgent(id: string, name: string, x: number, y: number, inventory: string[] = []): AgentState {
  return {
    id,
    name,
    model: 'stub',
    color: '#000000',
    island: 'forest',
    pos: { x, y },
    mood: 'curious',
    persona: 'A test villager.',
    status: 'idle',
    inventory,
    hunger: 0,
    energy: 100,
    traits: {},
    goals: [],
    relationships: [],
  };
}

export function mkCiv(partial: Partial<CivState> = {}): CivState {
  return { wood: 0, food: 0, gold: 0, stone: 0, age: 1, ...partial };
}

/** A fresh world: the seed objects, an empty stockpile and the given villagers. */
export function mkSnapshot(agents: AgentState[], civ: Partial<CivState> = {}, tick = 1): WorldSnapshot {
  return { tick, agents, objects: seedObjects(), civ: mkCiv(civ), nextId: 1 };
}

/** Removes every seed object except the Town Center, leaving open ground to build, place and throw on. */
export function clearField(snapshot: WorldSnapshot): WorldSnapshot {
  snapshot.objects = snapshot.objects.filter((o) => o.kind === 'town_center');
  return snapshot;
}

/** One valid input for every action type; `Record<ActionType, ...>` fails typecheck if a type is missing. */
export const REPRESENTATIVE: Record<ActionType, ActionInput> = {
  goto: { type: 'goto', data: { x: 7, y: 9 } },
  move: { type: 'move', data: { dx: 0, dy: 1 } },
  gather: { type: 'gather', data: { object_id: 'res_0' } },
  gather_nearest: { type: 'gather_nearest', data: {} },
  deposit: { type: 'deposit', data: {} },
  pick_up: { type: 'pick_up', data: { object_id: 'res_0' } },
  place: { type: 'place', data: { dx: 1, dy: 0 } },
  throw: { type: 'throw', data: { dx: 1, dy: 0 } },
  build: { type: 'build', data: { structure: 'house' } },
  advance_age: { type: 'advance_age', data: {} },
  say: { type: 'say', data: { message: 'Hello, empire.' } },
  chat: { type: 'chat', data: { agent_id: 'b', message: 'Hello, neighbour.' } },
  gift: { type: 'gift', data: { agent_id: 'b', item: 'wood' } },
  wander: { type: 'wander', data: {} },
  eat: { type: 'eat', data: {} },
  remember: { type: 'remember', data: { kind: 'episodic', content: 'A note.' } },
  train: { type: 'train', data: { ability: 'fishing' } },
  discover: { type: 'discover', data: { insight: 'Trees regrow.' } },
  set_goal: { type: 'set_goal', data: { goal: 'Build a house.' } },
  plan: {
    type: 'plan',
    data: { steps: [{ type: 'wait', data: {} }, { type: 'say', data: { message: 'Done.' } }] },
  },
  wait: { type: 'wait', data: {} },
};

export const planOf = (...types: ActionInput['type'][]): ActionInput =>
  ({ type: 'plan', data: { steps: types.map((type) => REPRESENTATIVE[type]) } });
