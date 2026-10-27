import { afterEach, describe, expect, it, vi } from 'vitest';
import { step } from '../world.ts';
import { mkAgent, mkSnapshot, seededRandom } from './fixtures.ts';

/** A world holding only the Town Center and the Standing Rock, so a throw has open ground to cross. */
function rockWorld(agentX: number, agentY: number) {
  const agent = mkAgent('a', 'Alder', agentX, agentY, ['cube']);
  const snap = mkSnapshot([agent]);
  snap.objects = snap.objects.filter((o) => o.kind === 'town_center' || o.kind === 'rock');
  const rock = snap.objects.find((o) => o.kind === 'rock');
  if (!rock) throw new Error('fixture has no Standing Rock');
  return { agent, snap, rock };
}

describe('the Standing Rock', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mystery: a cube thrown at the rock is swallowed and two new cubes appear', () => {
    vi.spyOn(Math, 'random').mockImplementation(seededRandom(7));
    const { agent, snap, rock } = rockWorld(0, 0);
    agent.pos = { x: rock.pos.x - 3, y: rock.pos.y };
    const before = snap.objects.length;

    const result = step(snap, 'a', { type: 'throw', data: { dx: 3, dy: 0 } });

    expect(result.ok).toBe(true);
    expect(result.spawned).toHaveLength(2);
    expect(agent.inventory).not.toContain('cube');
    expect(snap.objects.length).toBe(before + 2);
    const ids = result.spawned?.map((s) => s.id) ?? [];
    expect(new Set(ids).size).toBe(2);
    expect(result.message).toContain('Standing Rock');
  });

  it('mystery: a cube thrown from the tile right beside the rock also strikes it', () => {
    vi.spyOn(Math, 'random').mockImplementation(seededRandom(11));
    const { agent, snap, rock } = rockWorld(0, 0);
    agent.pos = { x: rock.pos.x - 1, y: rock.pos.y };

    const result = step(snap, 'a', { type: 'throw', data: { dx: 1, dy: 0 } });

    expect(result.ok).toBe(true);
    expect(result.spawned).toHaveLength(2);
  });

  it('a throw that stops short of the rock lands as an ordinary cube', () => {
    const { agent, snap, rock } = rockWorld(0, 0);
    agent.pos = { x: rock.pos.x - 3, y: rock.pos.y };

    const result = step(snap, 'a', { type: 'throw', data: { dx: 2, dy: 0 } });

    expect(result.ok).toBe(true);
    expect(result.spawned).toBeUndefined();
    expect(result.built?.structure).toBe('cube');
  });

  it('a throw into another object still stops in front of it', () => {
    const { agent, snap, rock } = rockWorld(0, 0);
    agent.pos = { x: rock.pos.x - 3, y: rock.pos.y };
    snap.objects.push({ id: 'blocker', territory: 'hills', pos: { x: rock.pos.x - 1, y: rock.pos.y }, kind: 'boulder' });

    const result = step(snap, 'a', { type: 'throw', data: { dx: 3, dy: 0 } });

    expect(result.ok).toBe(true);
    expect(result.spawned).toBeUndefined();
    expect(result.built?.pos).toEqual({ x: rock.pos.x - 2, y: rock.pos.y });
  });
});
