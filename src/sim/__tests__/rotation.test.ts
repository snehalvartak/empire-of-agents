import { describe, expect, it } from 'vitest';
import { pickNextActor } from '../rotation.ts';
import { seededRandom } from './fixtures.ts';

/** Mirrors how the simulation holds the cursor between ticks. */
class Rotation {
  lastId: string | null = null;
  lastIdx = 0;
  constructor(public ids: string[]) {}
  next(): string {
    const i = pickNextActor(this.ids, this.lastId, this.lastIdx);
    this.lastId = this.ids[i];
    this.lastIdx = i;
    return this.ids[i];
  }
  take(n: number): string[] {
    return Array.from({ length: n }, () => this.next());
  }
  remove(id: string): void {
    this.ids = this.ids.filter((x) => x !== id);
  }
}

describe('G3 / R7.5 — scripted roster changes', () => {
  it('G3: a plain roster cycles in join order and wraps', () => {
    expect(new Rotation(['A', 'B', 'C', 'D']).take(9)).toEqual(['A', 'B', 'C', 'D', 'A', 'B', 'C', 'D', 'A']);
  });

  it('G3: an empty roster has no next actor, a fresh roster starts at the first villager', () => {
    expect(pickNextActor([], null, 0)).toBe(-1);
    expect(pickNextActor([], 'A', 3)).toBe(-1);
    expect(pickNextActor(['X', 'Y'], null, 0)).toBe(0);
  });

  it('G3: add mid-cycle appends the newcomer to the end of the cycle', () => {
    const r = new Rotation(['A', 'B', 'C', 'D']);
    r.take(1); // A acted
    r.ids.push('E');
    expect(r.take(5)).toEqual(['B', 'C', 'D', 'E', 'A']);
  });

  it('G3: removing the villager who is next hands the turn to their successor', () => {
    const r = new Rotation(['A', 'B', 'C', 'D']);
    r.take(1); // A acted, B is next
    r.remove('B');
    expect(r.next()).toBe('C');
  });

  it('G3: removing the last villager in the roster while they are next wraps to the first', () => {
    const r = new Rotation(['A', 'B', 'C']);
    r.take(2); // B acted, C is next
    r.remove('C');
    expect(r.next()).toBe('A');
  });

  it('G3: removing the villager who just acted passes the turn to whoever took their slot', () => {
    const r = new Rotation(['A', 'B', 'C', 'D']);
    r.take(2); // B acted
    r.remove('B');
    expect(r.next()).toBe('C');
  });

  it('G3: removing the last actor from the end of the roster wraps to the first', () => {
    const r = new Rotation(['A', 'B', 'C']);
    r.take(3); // C acted
    r.remove('C');
    expect(r.next()).toBe('A');
  });

  it('G3: nobody is skipped or repeated across several joins and leaves', () => {
    const r = new Rotation(['A', 'B', 'C']);
    expect(r.take(2)).toEqual(['A', 'B']);
    r.ids.push('D');
    r.remove('A');
    expect(r.take(3)).toEqual(['C', 'D', 'B']);
    expect(r.take(3)).toEqual(['C', 'D', 'B']);
  });
});

describe('G3 / R7.5 — seeded random roster churn', () => {
  it('G3: every villager present for a whole cycle acts exactly once', () => {
    const rnd = seededRandom(12345);
    let cycles = 0;
    for (let trial = 0; trial < 300; trial++) {
      const r = new Rotation(['v0', 'v1', 'v2', 'v3', 'v4']);
      let nextVillager = 5;
      r.take(5); // park the cursor somewhere arbitrary
      for (let cycle = 0; cycle < 4; cycle++) {
        const present = new Set(r.ids); // villagers on the roster at the start of the cycle
        const seen: string[] = [];
        for (let k = 0; k < 60; k++) {
          const roll = rnd();
          if (roll < 0.2 && r.ids.length > 2) {
            const victim = r.ids[Math.floor(rnd() * r.ids.length)];
            r.remove(victim);
            present.delete(victim);
          } else if (roll < 0.4) {
            r.ids.push(`v${nextVillager++}`);
          }
          if ([...present].every((p) => seen.includes(p))) break;
          seen.push(r.next());
        }
        for (const p of present) {
          expect(seen.filter((s) => s === p), `trial ${trial} cycle ${cycle}: ${p}`).toHaveLength(1);
        }
        cycles++;
      }
    }
    expect(cycles).toBe(1200);
  });
});
