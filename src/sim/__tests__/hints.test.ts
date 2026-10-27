import { describe, expect, it } from 'vitest';
import { GRID_SIZE, availableActions, isRoad, observe, step, territoryAt } from '../world.ts';
import type { AgentState, GridPos, WorldSnapshot } from '../world.ts';
import { mkAgent, mkSnapshot } from './fixtures.ts';

const MECHANIC_WORDS = ['rumor', 'reacts', 'thrown', 'spawn'];
const POSITIONS: GridPos[] = [
  { x: 7, y: 6 }, { x: 6, y: 7 }, { x: 7, y: 8 }, { x: 2, y: 5 }, { x: 0, y: 0 }, { x: 13, y: 13 },
  { x: 14, y: 6 }, { x: 16, y: 10 }, { x: 20, y: 3 }, { x: 23, y: 6 }, { x: 10, y: 17 }, { x: 12, y: 21 },
];
const INVENTORIES: string[][] = [[], ['wood'], ['wood', 'food'], ['cube'], ['wood', 'cube']];

const world = (pos: GridPos, inventory: string[]): { snap: WorldSnapshot; agent: AgentState } => {
  const agent = mkAgent('a', 'Alder', pos.x, pos.y, inventory);
  return { snap: mkSnapshot([agent]), agent };
};
const gotoTargets = (hints: string[]): GridPos[] =>
  hints.flatMap((h) => {
    const m = /^- goto \((\d+),(\d+)\)/.exec(h);
    return m ? [{ x: Number(m[1]), y: Number(m[2]) }] : [];
  });
const manhattan = (a: GridPos, b: GridPos) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

describe('H2 / R5.2 / R5.4 — hints', () => {
  it('H2: every goto hint targets an in-bounds, walkable tile or an object tile', () => {
    for (const pos of POSITIONS) {
      for (const inventory of INVENTORIES) {
        const { snap, agent } = world(pos, inventory);
        const targets = gotoTargets(availableActions(snap, agent));
        for (const t of targets) {
          const where = `from (${pos.x},${pos.y}) carrying [${inventory}] -> (${t.x},${t.y})`;
          expect(t.x >= 0 && t.y >= 0 && t.x < GRID_SIZE && t.y < GRID_SIZE, `in bounds ${where}`).toBe(true);
          const walkable = territoryAt(t) !== null || isRoad(t);
          const objectTile = snap.objects.some((o) => o.pos.x === t.x && o.pos.y === t.y);
          expect(walkable || objectTile, `walkable or object ${where}`).toBe(true);
        }
      }
    }
  });

  it('H2: a fresh villager always has at least one location hint, plus wander and wait', () => {
    for (const pos of POSITIONS) {
      const { snap, agent } = world(pos, []);
      const hints = availableActions(snap, agent);
      expect(gotoTargets(hints).length, `at (${pos.x},${pos.y})`).toBeGreaterThan(0);
      expect(hints.some((h) => h.startsWith('- wander'))).toBe(true);
      expect(hints.some((h) => h.startsWith('- wait'))).toBe(true);
    }
  });

  it('R5.4: no hint (and nothing after "Actions you can take now:") contains a mechanic word', () => {
    for (const pos of POSITIONS) {
      for (const inventory of INVENTORIES) {
        const { snap, agent } = world(pos, inventory);
        const hints = availableActions(snap, agent).join('\n').toLowerCase();
        const tail = observe(snap, agent, []).split('Actions you can take now:')[1].toLowerCase();
        for (const word of MECHANIC_WORDS) {
          expect(hints, word).not.toContain(word);
          expect(tail, word).not.toContain(word);
        }
      }
    }
  });

  it('R5.4: the Standing Rock hint states a location and distance only', () => {
    const { snap, agent } = world({ x: 7, y: 8 }, []);
    const rock = availableActions(snap, agent).find((h) => h.includes('Standing Rock'));
    expect(rock).toBeDefined();
    expect(rock).toMatch(/^- goto \(10,19\): the Standing Rock, \d+ steps away$/);
  });

  it('H2: a deposit hint appears only when carrying resources and standing beside the Town Center', () => {
    const tc = { x: 7, y: 7 };
    for (let x = 0; x < GRID_SIZE; x++) {
      for (let y = 0; y < GRID_SIZE; y++) {
        if (territoryAt({ x, y }) === null && !isRoad({ x, y })) continue;
        for (const inventory of INVENTORIES) {
          const { snap, agent } = world({ x, y }, inventory);
          const hasDeposit = availableActions(snap, agent).some((h) => h.startsWith('- deposit'));
          const expected = inventory.some((i) => i !== 'cube') && manhattan({ x, y }, tc) <= 1;
          expect(hasDeposit, `(${x},${y}) carrying [${inventory}]`).toBe(expected);
        }
      }
    }
  });

  it('H2 / R5.2: a deposit hint means the handler would accept a deposit right now', () => {
    for (const pos of [{ x: 7, y: 6 }, { x: 6, y: 7 }, { x: 8, y: 7 }, { x: 7, y: 8 }]) {
      const { snap, agent } = world(pos, ['wood']);
      expect(availableActions(snap, agent).some((h) => h.startsWith('- deposit'))).toBe(true);
      expect(step(snap, agent.id, { type: 'deposit', data: {} }).ok).toBe(true);
    }
  });

  it('R5.2: a gather_nearest hint appears exactly when the handler would accept it', () => {
    for (let x = 0; x < GRID_SIZE; x++) {
      for (let y = 0; y < GRID_SIZE; y++) {
        if (territoryAt({ x, y }) === null && !isRoad({ x, y })) continue;
        for (const inventory of [[], ['wood'], ['wood', 'food']]) {
          const { snap, agent } = world({ x, y }, inventory);
          const hinted = availableActions(snap, agent).some((h) => h.startsWith('- gather_nearest'));
          const accepted = step(structuredClone(snap), agent.id, { type: 'gather_nearest', data: {} }).ok;
          expect(hinted, `(${x},${y}) carrying [${inventory}]`).toBe(accepted);
        }
      }
    }
  });

  it('R5.2: the hints are rebuilt from live state every time (no stale cache)', () => {
    const { snap, agent } = world({ x: 7, y: 6 }, ['wood']);
    expect(availableActions(snap, agent).some((h) => h.startsWith('- deposit'))).toBe(true);
    step(snap, agent.id, { type: 'deposit', data: {} });
    expect(availableActions(snap, agent).some((h) => h.startsWith('- deposit'))).toBe(false);
    expect(observe(snap, agent, [])).toContain('Carrying: nothing.');
  });

  it('R5.2: every goto hint is accepted by the handler from the tile it was offered on', () => {
    const refused: string[] = [];
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        if (territoryAt({ x, y }) === null && !isRoad({ x, y })) continue;
        const { snap, agent } = world({ x, y }, []);
        for (const t of gotoTargets(availableActions(snap, agent))) {
          // each hint is tried on a fresh world so one goto cannot disturb the next
          const fresh = world({ x, y }, []);
          const result = step(fresh.snap, fresh.agent.id, { type: 'goto', data: { x: t.x, y: t.y } });
          if (!result.ok) refused.push(`(${x},${y}) -> (${t.x},${t.y}): ${result.message}`);
        }
      }
    }
    expect(refused).toEqual([]);
  });

  it('goto carries a villager from the east road to a forest tile', () => {
    const { snap, agent } = world({ x: 16, y: 6 }, []);
    const result = step(snap, agent.id, { type: 'goto', data: { x: 2, y: 2 } });
    expect(result.ok).toBe(true);
    expect(agent.pos).toEqual({ x: 2, y: 2 });
  });

  it('goto still refuses a target that is open water, and one a villager stands on', () => {
    const water = world({ x: 7, y: 6 }, []);
    expect(step(water.snap, 'a', { type: 'goto', data: { x: 15, y: 15 } }).ok).toBe(false);
    const other = mkAgent('b', 'Bramble', 9, 6);
    const crowded = world({ x: 7, y: 6 }, []);
    crowded.snap.agents.push(other);
    const blocked = step(crowded.snap, 'a', { type: 'goto', data: { x: 9, y: 6 } });
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toContain('No clear path');
  });
});
