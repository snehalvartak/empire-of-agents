import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { step } from '../world.ts';
import type { ActionInput, WorldObject, WorldSnapshot } from '../world.ts';
import { clearField, mkAgent, mkSnapshot } from './fixtures.ts';

/**
 * B2 / R4.1 — every `ok: false` site in world.ts has one case below.
 *
 * HOW TO KEEP THIS IN SYNC: the guard test counts the literal text `ok: false` in
 * src/sim/world.ts and requires exactly that many cases in FAILURE_SITES. When you add
 * a failure to step(), add a case here (a setup that triggers it) and keep its message
 * telling the villager why it failed and what to do next. When you remove one, remove
 * its case. Do not "fix" the guard by editing the count — add the case.
 */

/** Words that mark a next step. A failure message must contain at least one. */
const GUIDANCE_MARKERS = [
  'first', 'before', 'instead', 'Try', 'Choose', 'Use', 'Stay', 'March', 'goto', 'Goto',
  'Gather', 'Deposit', 'Advance', 'Wait', 'Pick', 'pick_up', 'wander',
];
const NOT_PLAIN = /undefined|null|NaN|\[object|\{|\}|Error:|=>/;

/** A bare restatement is a single clause; a why-and-what-next message has at least two. */
const clauses = (message: string) => message.split(/[.!?—]+/).map((c) => c.trim()).filter(Boolean);

interface FailureSite {
  /** Short description of the failure this case triggers. */
  name: string;
  world: () => WorldSnapshot;
  /** The action to try; may read ids and positions from the seeded world it is given. */
  action: ActionInput | ((snap: WorldSnapshot) => ActionInput);
  /** Who acts; defaults to villager 'a'. */
  actor?: string;
}

/** Fixtures: villager 'a' (Alder) in the forest, with whatever else the case needs. */
const solo = (x: number, y: number, inventory: string[] = [], civ = {}) =>
  mkSnapshot([mkAgent('a', 'Alder', x, y, inventory)], civ);
const pair = (inventory: string[] = [], other: string[] = [], bx = 4) =>
  mkSnapshot([mkAgent('a', 'Alder', 3, 3, inventory), mkAgent('b', 'Bramble', bx, 3, other)]);
const withObject = (snap: WorldSnapshot, o: Pick<WorldObject, 'id' | 'kind' | 'pos'>): WorldSnapshot => {
  snap.objects.push({ ...o, territory: 'forest' });
  return snap;
};
const objectOf = (snap: WorldSnapshot, kind: WorldObject['kind']) => {
  const found = snap.objects.find((o) => o.kind === kind);
  if (!found) throw new Error(`no ${kind} in the seed world`);
  return found;
};
const bad = (action: unknown) => action as ActionInput;

const FAILURE_SITES: FailureSite[] = [
  { name: 'step: unknown villager', world: () => solo(5, 5), action: { type: 'wait', data: {} }, actor: 'ghost' },
  { name: 'move: not exactly one step', world: () => solo(5, 5), action: { type: 'move', data: { dx: 1, dy: 1 } } },
  { name: 'move: off the map', world: () => solo(0, 5), action: { type: 'move', data: { dx: -1, dy: 0 } } },
  { name: 'move: into open water', world: () => solo(13, 0), action: { type: 'move', data: { dx: 1, dy: 0 } } },
  {
    name: 'move: onto a villager',
    world: () => mkSnapshot([mkAgent('a', 'Alder', 5, 5), mkAgent('b', 'Bramble', 6, 5)]),
    action: { type: 'move', data: { dx: 1, dy: 0 } },
  },
  { name: 'goto: off the map', world: () => solo(5, 5), action: { type: 'goto', data: { x: 30, y: 5 } } },
  { name: 'goto: open water', world: () => solo(5, 5), action: { type: 'goto', data: { x: 15, y: 0 } } },
  {
    name: 'goto: no clear path (boxed in)',
    world: () => mkSnapshot([mkAgent('a', 'Alder', 0, 0), mkAgent('b', 'Bramble', 1, 0), mkAgent('c', 'Cedar', 0, 1)]),
    action: { type: 'goto', data: { x: 5, y: 5 } },
  },
  { name: 'gather_nearest: nothing in reach', world: () => solo(9, 9), action: { type: 'gather_nearest', data: {} } },
  { name: 'gather: no such object id', world: () => solo(7, 5), action: { type: 'gather', data: { object_id: 'nope' } } },
  { name: 'gather: too far', world: () => solo(9, 9), action: { type: 'gather', data: { object_id: 'res_0' } } },
  {
    name: 'gather: not a resource (flower)',
    world: () => {
      const snap = solo(5, 5);
      const flower = objectOf(snap, 'flower');
      snap.agents[0].pos = { x: flower.pos.x, y: flower.pos.y + 1 };
      return snap;
    },
    action: (snap) => ({ type: 'gather', data: { object_id: objectOf(snap, 'flower').id } }),
  },
  { name: 'gather: hands full', world: () => solo(7, 5, ['wood', 'food']), action: { type: 'gather_nearest', data: {} } },
  { name: 'deposit: only a cube carried', world: () => solo(7, 6, ['cube']), action: { type: 'deposit', data: {} } },
  {
    name: 'deposit: no Town Center',
    world: () => {
      const snap = solo(7, 6, ['wood']);
      snap.objects = snap.objects.filter((o) => o.kind !== 'town_center');
      return snap;
    },
    action: { type: 'deposit', data: {} },
  },
  { name: 'deposit: away from the Town Center', world: () => solo(2, 5, ['wood']), action: { type: 'deposit', data: {} } },
  {
    name: 'build: unknown structure',
    world: () => solo(7, 8, [], { wood: 9 }),
    action: bad({ type: 'build', data: { structure: 'castle' } }),
  },
  {
    name: 'build: world is crowded',
    world: () => {
      const snap = solo(7, 8, [], { wood: 9 });
      for (let i = 0; i < 400; i++) snap.objects.push({ id: `filler_${i}`, territory: 'forest', pos: { x: 0, y: 0 }, kind: 'flower' });
      return snap;
    },
    action: { type: 'build', data: { structure: 'house' } },
  },
  { name: 'build: unaffordable', world: () => solo(7, 8, [], { wood: 1 }), action: { type: 'build', data: { structure: 'house' } } },
  {
    name: 'build: wonder before the Imperial Age',
    world: () => solo(7, 8, [], { wood: 9, stone: 9, gold: 9 }),
    action: { type: 'build', data: { structure: 'wonder' } },
  },
  { name: 'advance_age: already Imperial', world: () => solo(7, 8, [], { age: 4 }), action: { type: 'advance_age', data: {} } },
  { name: 'advance_age: unaffordable', world: () => solo(7, 8), action: { type: 'advance_age', data: {} } },
  { name: 'pick_up: no such object', world: () => solo(5, 5), action: { type: 'pick_up', data: { object_id: 'nope' } } },
  { name: 'pick_up: not a cube', world: () => solo(2, 2), action: { type: 'pick_up', data: { object_id: 'res_0' } } },
  {
    name: 'pick_up: cube too far',
    world: () => solo(2, 2),
    action: (snap) => ({ type: 'pick_up', data: { object_id: objectOf(snap, 'cube').id } }),
  },
  {
    name: 'pick_up: already carrying a cube',
    world: () => withObject(solo(5, 5, ['cube']), { id: 'cube_near', kind: 'cube', pos: { x: 5, y: 6 } }),
    action: { type: 'pick_up', data: { object_id: 'cube_near' } },
  },
  { name: 'place: no cube carried', world: () => solo(5, 5), action: { type: 'place', data: { dx: 1, dy: 0 } } },
  { name: 'place: into open water', world: () => solo(13, 0, ['cube']), action: { type: 'place', data: { dx: 1, dy: 0 } } },
  {
    name: 'place: tile occupied',
    world: () => withObject(clearField(solo(5, 5, ['cube'])), { id: 'block', kind: 'boulder', pos: { x: 6, y: 5 } }),
    action: { type: 'place', data: { dx: 1, dy: 0 } },
  },
  { name: 'throw: no cube carried', world: () => solo(5, 5), action: { type: 'throw', data: { dx: 2, dy: 0 } } },
  { name: 'throw: no direction', world: () => solo(5, 5, ['cube']), action: { type: 'throw', data: { dx: 0, dy: 0 } } },
  {
    name: 'throw: blocked at once',
    world: () => withObject(clearField(solo(5, 5, ['cube'])), { id: 'block', kind: 'boulder', pos: { x: 6, y: 5 } }),
    action: { type: 'throw', data: { dx: 3, dy: 0 } },
  },
  { name: 'chat: no such villager', world: () => pair(), action: { type: 'chat', data: { agent_id: 'zz', message: 'hi' } } },
  { name: 'chat: with yourself', world: () => pair(), action: { type: 'chat', data: { agent_id: 'a', message: 'hi' } } },
  { name: 'chat: too far', world: () => pair([], [], 9), action: { type: 'chat', data: { agent_id: 'b', message: 'hi' } } },
  { name: 'gift: no such villager', world: () => pair(['wood']), action: { type: 'gift', data: { agent_id: 'zz' } } },
  { name: 'gift: to yourself', world: () => pair(['wood']), action: { type: 'gift', data: { agent_id: 'a' } } },
  { name: 'gift: too far', world: () => pair(['wood'], [], 9), action: { type: 'gift', data: { agent_id: 'b' } } },
  { name: 'gift: empty hands', world: () => pair(), action: { type: 'gift', data: { agent_id: 'b' } } },
  { name: 'gift: item not carried', world: () => pair(['wood']), action: { type: 'gift', data: { agent_id: 'b', item: 'gold' } } },
  {
    name: 'gift: receiver hands full',
    world: () => pair(['wood'], ['food', 'food']),
    action: { type: 'gift', data: { agent_id: 'b', item: 'wood' } },
  },
  { name: 'eat: no food in the stockpile', world: () => solo(7, 8), action: { type: 'eat', data: {} } },
  {
    name: 'eat: no Town Center',
    world: () => {
      const snap = solo(7, 8, [], { food: 5 });
      snap.objects = snap.objects.filter((o) => o.kind !== 'town_center');
      return snap;
    },
    action: { type: 'eat', data: {} },
  },
  {
    name: 'wander: every neighbour blocked',
    world: () => mkSnapshot([mkAgent('a', 'Alder', 0, 0), mkAgent('b', 'Bramble', 1, 0), mkAgent('c', 'Cedar', 0, 1)]),
    action: { type: 'wander', data: {} },
  },
  { name: 'plan: reaching step() unrolled', world: () => solo(5, 5), action: { type: 'plan', data: { steps: [] } } },
  { name: 'unknown action type', world: () => solo(5, 5), action: bad({ type: 'dance', data: {} }) },
];

const worldSource = readFileSync(fileURLToPath(new URL('../world.ts', import.meta.url)), 'utf8');

describe('B2 / R4.1 — every failure in step() says why and what to do next', () => {
  it('guard: there is one case for every `ok: false` in world.ts (update FAILURE_SITES when this fails)', () => {
    const sites = worldSource.match(/ok: false/g)?.length ?? 0;
    expect(
      FAILURE_SITES.length,
      `world.ts has ${sites} "ok: false" sites but FAILURE_SITES has ${FAILURE_SITES.length}: add or remove a case`
    ).toBe(sites);
  });

  it('guard: case names are unique', () => {
    expect(new Set(FAILURE_SITES.map((s) => s.name)).size).toBe(FAILURE_SITES.length);
  });

  for (const site of FAILURE_SITES) {
    it(`B2: ${site.name}`, () => {
      const snap = site.world();
      const action = typeof site.action === 'function' ? site.action(snap) : site.action;
      const before = JSON.stringify(snap);
      const result = step(snap, site.actor ?? 'a', action);

      expect(result.ok).toBe(false);
      expect(result.message.trim().length).toBeGreaterThan(10);
      expect(result.message).not.toMatch(NOT_PLAIN);
      expect(
        GUIDANCE_MARKERS.some((m) => result.message.includes(m)),
        `no guidance marker in: ${result.message}`
      ).toBe(true);
      expect(clauses(result.message).length, `bare restatement: ${result.message}`).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(snap), 'a failed action must not change the world').toBe(before);
    });
  }

  it('B2: depositing only a cube is refused with a pointer to place or throw it', () => {
    const result = step(solo(7, 6, ['cube']), 'a', { type: 'deposit', data: {} });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Place or throw it instead');
  });

  it('B2: depositing with empty hands says to gather first', () => {
    const result = step(solo(7, 6), 'a', { type: 'deposit', data: {} });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Gather something first');
  });
});
