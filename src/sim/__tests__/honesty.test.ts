import { describe, expect, it } from 'vitest';
import { step } from '../world.ts';
import type { ActionInput, WorldSnapshot } from '../world.ts';
import { mkAgent, mkSnapshot } from './fixtures.ts';

/** Words a message must use somewhere to count as telling the villager what to do next. */
const GUIDANCE = /\b(first|instead|try|use|march|gather|deposit|stay|choose|pick|go around|another|nearer)\b/i;
const NOT_PLAIN = /undefined|null|NaN|\[object|\{|\}|Error:|=>/;

interface Failure {
  name: string;
  world: () => WorldSnapshot;
  action: ActionInput;
  /** Stable fragment(s) of the message: the reason and the next step. */
  says: string[];
}

const inForest = (x: number, y: number, inventory: string[] = [], civ = {}) =>
  mkSnapshot([mkAgent('a', 'Alder', x, y, inventory)], civ);

const FAILURES: Failure[] = [
  {
    name: 'hands full: gather with 2 items',
    world: () => inForest(7, 5, ['wood', 'food']),
    action: { type: 'gather_nearest', data: {} },
    says: ['carrying enough', 'Deposit at the Town Center first'],
  },
  {
    name: 'too far from a resource: gather_nearest',
    world: () => inForest(9, 9),
    action: { type: 'gather_nearest', data: {} },
    says: ["Nothing can be gathered within arm's reach", 'March toward a resource first'],
  },
  {
    name: 'too far from a resource: gather by id',
    world: () => inForest(9, 9),
    action: { type: 'gather', data: { object_id: 'res_0' } },
    says: ["beyond arm's reach", 'March onto or right beside it first'],
  },
  {
    name: 'goto into open water',
    world: () => inForest(5, 5),
    action: { type: 'goto', data: { x: 15, y: 0 } },
    says: ['open water', 'follow the roads'],
  },
  {
    name: 'goto off the map',
    world: () => inForest(5, 5),
    action: { type: 'goto', data: { x: 30, y: 5 } },
    says: ['void', 'Stay on the map'],
  },
  {
    name: 'goto with no clear path (boxed in)',
    world: () => {
      const snap = mkSnapshot([
        mkAgent('a', 'Alder', 0, 0),
        mkAgent('b', 'Bramble', 1, 0),
        mkAgent('c', 'Cedar', 0, 1),
      ]);
      return snap;
    },
    action: { type: 'goto', data: { x: 5, y: 5 } },
    says: ['No clear path', 'Try a nearer point'],
  },
  {
    name: 'move into open water',
    world: () => inForest(13, 0),
    action: { type: 'move', data: { dx: 1, dy: 0 } },
    says: ['open water', 'Use the roads'],
  },
  {
    name: 'move off the map',
    world: () => inForest(0, 5),
    action: { type: 'move', data: { dx: -1, dy: 0 } },
    says: ['void', 'Stay on the map'],
  },
  {
    name: 'unaffordable build',
    world: () => inForest(7, 8, [], { wood: 1 }),
    action: { type: 'build', data: { structure: 'house' } },
    says: ['cannot afford a house', 'Missing: 3 wood', 'Gather and deposit resources first'],
  },
  {
    name: 'wonder before the Imperial Age',
    world: () => inForest(7, 8, [], { wood: 9, stone: 9, gold: 9 }),
    action: { type: 'build', data: { structure: 'wonder' } },
    says: ['Imperial Age', 'Advance the empire'],
  },
  {
    name: 'advance_age without resources',
    world: () => inForest(7, 8),
    action: { type: 'advance_age', data: {} },
    says: ['requires 4 wood, 4 food, 2 gold', 'Gather more'],
  },
  {
    name: 'deposit away from the Town Center',
    world: () => inForest(2, 5, ['wood']),
    action: { type: 'deposit', data: {} },
    says: ['Town Center is at (7, 7)', 'March to a tile right beside it'],
  },
  {
    name: 'deposit with nothing carried',
    world: () => inForest(7, 6),
    action: { type: 'deposit', data: {} },
    says: ['carry nothing', 'Gather'],
  },
  {
    name: 'gift to a non-adjacent villager',
    world: () => {
      const snap = mkSnapshot([mkAgent('a', 'Alder', 3, 3, ['wood']), mkAgent('b', 'Bramble', 9, 9)]);
      return snap;
    },
    action: { type: 'gift', data: { agent_id: 'b', item: 'wood' } },
    says: ['Bramble is too far away', 'march to a tile right beside them first'],
  },
  {
    name: 'gift with empty hands',
    world: () => mkSnapshot([mkAgent('a', 'Alder', 3, 3), mkAgent('b', 'Bramble', 4, 3)]),
    action: { type: 'gift', data: { agent_id: 'b' } },
    says: ['hands are empty', 'Gather something before giving'],
  },
  {
    name: 'chat with a non-adjacent villager',
    world: () => mkSnapshot([mkAgent('a', 'Alder', 3, 3), mkAgent('b', 'Bramble', 9, 9)]),
    action: { type: 'chat', data: { agent_id: 'b', message: 'hi' } },
    says: ['Bramble is too far away', 'march to a tile right beside them first'],
  },
  {
    name: 'eat from an empty stockpile',
    world: () => inForest(7, 8),
    action: { type: 'eat', data: {} },
    says: ['no food', 'Gather berries or hunt first'],
  },
];

describe('B2 / R4.1 — honest failure: why, and what to do next', () => {
  for (const f of FAILURES) {
    it(`B2: ${f.name}`, () => {
      const snap = f.world();
      const before = JSON.stringify(snap);
      const result = step(snap, 'a', f.action);
      expect(result.ok).toBe(false);
      expect(result.message.trim().length).toBeGreaterThan(10);
      expect(result.message).not.toMatch(NOT_PLAIN);
      expect(result.message).toMatch(GUIDANCE);
      for (const fragment of f.says) expect(result.message).toContain(fragment);
      expect(JSON.stringify(snap), 'a failed action must not change the world').toBe(before);
    });
  }

  it('B2: forced failures leave the villager where they were', () => {
    const snap = inForest(5, 5);
    step(snap, 'a', { type: 'goto', data: { x: 15, y: 0 } });
    expect(snap.agents[0].pos).toEqual({ x: 5, y: 5 });
  });
});
