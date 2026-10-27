import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANIMAL_RESPAWN_TICKS, nextIdFor, step } from '../world.ts';
import type { WorldObject } from '../world.ts';
import { clearField, mkAgent, mkSnapshot } from './fixtures.ts';

const ENGINE_FILES = ['world.ts', 'brain.ts', 'actions.ts', 'rotation.ts'];
const CLOCK_CALLS = ['Date.now', 'new Date', 'performance.now'];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('E3 / R5.1 — the engine never reads the wall clock', () => {
  for (const file of ENGINE_FILES) {
    it(`E3: ${file} contains no host-clock call`, () => {
      const source = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
      for (const call of CLOCK_CALLS) expect(source, `${file} uses ${call}`).not.toContain(call);
    });
  }
});

describe('E3 / R5.1 — respawn is counted in ticks', () => {
  const sheepId = (objects: WorldObject[]) => objects.find((o) => o.kind === 'sheep')!;

  for (const tick of [0, 1, 42, 1000]) {
    it(`E3: an animal gathered at tick ${tick} is due exactly ANIMAL_RESPAWN_TICKS later`, () => {
      const sheep = mkSnapshot([], {}, tick).objects.find((o) => o.kind === 'sheep')!;
      const snap = mkSnapshot([mkAgent('a', 'Alder', sheep.pos.x, sheep.pos.y + 1)], {}, tick);
      const result = step(snap, 'a', { type: 'gather', data: { object_id: sheep.id } });
      expect(result.ok).toBe(true);
      expect(result.depleted).toEqual({ id: sheep.id, respawnTick: tick + ANIMAL_RESPAWN_TICKS });
    });
  }

  it('E3: the due tick does not change when the host clock is wildly different', () => {
    const sheep = sheepId(mkSnapshot([]).objects);
    const dueTicks = [0, 1.7e12, 9e15].map((fakeNow) => {
      vi.spyOn(Date, 'now').mockReturnValue(fakeNow);
      const snap = mkSnapshot([mkAgent('a', 'Alder', sheep.pos.x, sheep.pos.y + 1)], {}, 77);
      return step(snap, 'a', { type: 'gather', data: { object_id: sheep.id } }).depleted?.respawnTick;
    });
    expect(dueTicks).toEqual([77 + ANIMAL_RESPAWN_TICKS, 77 + ANIMAL_RESPAWN_TICKS, 77 + ANIMAL_RESPAWN_TICKS]);
  });

  it('E3: trees regrow without a respawn timer and mines are gone for good', () => {
    const base = mkSnapshot([]);
    const tree = base.objects.find((o) => o.kind === 'tree')!;
    const mine = base.objects.find((o) => o.kind === 'gold_mine')!;
    const snapTree = mkSnapshot([mkAgent('a', 'Alder', tree.pos.x, tree.pos.y)]);
    expect(step(snapTree, 'a', { type: 'gather', data: { object_id: tree.id } }).depleted).toBeUndefined();
    const snapMine = mkSnapshot([mkAgent('a', 'Alder', mine.pos.x, mine.pos.y)]);
    expect(step(snapMine, 'a', { type: 'gather', data: { object_id: mine.id } }).depleted).toEqual({
      id: mine.id,
      respawnTick: null,
    });
  });
});

describe('E3 / R5.1 — ids come from the per-era counter', () => {
  const idNumber = (id: string) => Number(/_(\d+)$/.exec(id)![1]);

  it('E3: consecutive builds and cubes get distinct, increasing small ids', () => {
    const snap = clearField(mkSnapshot([mkAgent('a', 'Alder', 4, 4)], { wood: 20 }));
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const built = step(snap, 'a', { type: 'build', data: { structure: 'house' } }).built;
      ids.push(built!.id);
    }
    snap.agents[0].inventory = ['cube'];
    ids.push(step(snap, 'a', { type: 'place', data: { dx: 1, dy: 0 } }).built!.id);
    snap.agents[0].inventory = ['cube'];
    ids.push(step(snap, 'a', { type: 'place', data: { dx: 0, dy: 1 } }).built!.id);

    expect(ids).toEqual(['built_1', 'built_2', 'cube_3', 'cube_4']);
    expect(new Set(ids).size).toBe(ids.length);
    const numbers = ids.map(idNumber);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    for (const n of numbers) expect(n).toBeLessThan(1e6); // nothing timestamp-like
  });

  it('E3: a thrown cube takes the next counter id', () => {
    const snap = clearField(mkSnapshot([mkAgent('a', 'Alder', 4, 4, ['cube'])]));
    snap.nextId = 12;
    const result = step(snap, 'a', { type: 'throw', data: { dx: 2, dy: 0 } });
    expect(result.ok).toBe(true);
    expect(result.built?.id).toBe('cube_12');
    expect(snap.nextId).toBe(13);
  });

  it('E3: nextIdFor starts past every built_/cube_ id, so a restored counter never collides', () => {
    expect(nextIdFor(mkSnapshot([]).objects)).toBe(1); // seed ids are res_<n>
    const existing: WorldObject[] = [
      { id: 'built_3', territory: 'forest', pos: { x: 1, y: 1 }, kind: 'house' },
      { id: 'cube_9', territory: 'forest', pos: { x: 2, y: 2 }, kind: 'cube' },
      { id: 'res_40', territory: 'forest', pos: { x: 3, y: 3 }, kind: 'tree' },
    ];
    expect(nextIdFor(existing)).toBe(10);

    const snap = mkSnapshot([mkAgent('a', 'Alder', 4, 4)], { wood: 20 });
    snap.objects.push(...existing);
    snap.nextId = nextIdFor(snap.objects);
    const taken = new Set(snap.objects.map((o) => o.id));
    for (let i = 0; i < 5; i++) {
      const id = step(snap, 'a', { type: 'build', data: { structure: 'house' } }).built!.id;
      expect(taken.has(id), `${id} collided`).toBe(false);
      taken.add(id);
    }
  });

  it('E3: a missing or zero counter still yields a valid first id', () => {
    const snap = mkSnapshot([mkAgent('a', 'Alder', 4, 4)], { wood: 20 });
    snap.nextId = 0;
    expect(step(snap, 'a', { type: 'build', data: { structure: 'house' } }).built!.id).toBe('built_1');
    expect(snap.nextId).toBe(2);
  });
});
