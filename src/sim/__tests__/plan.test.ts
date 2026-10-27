import { describe, expect, it } from 'vitest';
import { ACTION_DEFS, sanitizeAction } from '../actions.ts';
import type { ActionType } from '../actions.ts';
import { planUncoveredTypes, thoughtMatchesAction, thoughtMatchesPlan } from '../brain.ts';
import { planSteps, runSteps, step } from '../world.ts';
import type { ActionInput } from '../world.ts';
import { REPRESENTATIVE, mkAgent, mkSnapshot, planOf } from './fixtures.ts';

describe('R8.4 — a plan\'s thought must cover every distinct step type', () => {
  it('R8.4: goto + gather + deposit is accepted for a thought that names all three', () => {
    const thought = "I'll walk to the oak, chop it, and bring the wood back";
    const plan = planOf('goto', 'gather', 'deposit');
    expect(thoughtMatchesAction(thought, plan)).toBe(true);
    expect(thoughtMatchesPlan(thought, plan)).toBe(true);
    expect(planUncoveredTypes(thought, plan)).toEqual([]);
  });

  it('R8.4: goto + gather + build is rejected for "I will gather wood", naming goto and build', () => {
    const thought = 'I will gather wood';
    const plan = planOf('goto', 'gather', 'build');
    expect(thoughtMatchesAction(thought, plan)).toBe(false);
    expect(planUncoveredTypes(thought, plan)).toEqual(['goto', 'build']);
  });

  it('R8.4: two gather-family steps of distinct types need only one gather verb', () => {
    expect(thoughtMatchesPlan('I will gather wood', planOf('gather', 'gather_nearest'))).toBe(true);
  });

  it('R8.4: two steps of the same type are checked once', () => {
    expect(planUncoveredTypes('I will wait', planOf('wait', 'wait'))).toEqual([]);
    expect(planUncoveredTypes('I will sing', planOf('wait', 'wait'))).toEqual(['wait']);
  });

  it('R8.4: a thought that covers only some steps is rejected', () => {
    expect(thoughtMatchesPlan('I will walk', planOf('goto', 'gather'))).toBe(false);
  });

  it('R8.4: an empty thought is not held against a plan', () => {
    expect(thoughtMatchesPlan('', planOf('goto', 'build'))).toBe(true);
  });

  it('R8.4: matching ignores case', () => {
    expect(thoughtMatchesPlan('MARCH to the mine and GATHER ore', planOf('goto', 'gather'))).toBe(true);
  });

  it('R8.4: planUncoveredTypes is empty for a non-plan action', () => {
    expect(planUncoveredTypes('anything', REPRESENTATIVE.build)).toEqual([]);
  });
});

describe('R8.4 — single actions keep the old rule', () => {
  const withVerbs = (Object.keys(ACTION_DEFS) as ActionType[]).filter((t) => ACTION_DEFS[t].verbs);

  it('R8.4: every action type but plan has a verb family', () => {
    expect((Object.keys(ACTION_DEFS) as ActionType[]).filter((t) => !ACTION_DEFS[t].verbs)).toEqual(['plan']);
  });

  for (const type of withVerbs) {
    it(`R8.4: ${type} matches a thought naming any of its verbs`, () => {
      for (const verb of ACTION_DEFS[type].verbs!) {
        expect(thoughtMatchesAction(`Now I shall ${verb} here`, REPRESENTATIVE[type]), verb).toBe(true);
      }
    });

    it(`R8.4: ${type} does not match an unrelated thought`, () => {
      expect(thoughtMatchesAction('xyzzy plugh', REPRESENTATIVE[type])).toBe(false);
    });

    it(`R8.4: ${type} is not held to an empty thought`, () => {
      expect(thoughtMatchesAction('', REPRESENTATIVE[type])).toBe(true);
    });
  }
});

describe('B3 / R3.2 — plan semantics', () => {
  const treeAt = (snap: ReturnType<typeof mkSnapshot>, x: number, y: number) =>
    snap.objects.find((o) => o.kind === 'tree' && o.pos.x === x && o.pos.y === y)!;

  it('B3: planSteps unrolls a plan in order and wraps a single action', () => {
    expect(planSteps(planOf('goto', 'gather', 'deposit')).map((s) => s.type)).toEqual(['goto', 'gather', 'deposit']);
    expect(planSteps(REPRESENTATIVE.build)).toEqual([REPRESENTATIVE.build]);
  });

  it('B3: goto -> gather -> goto -> deposit chains end to end, each step seeing the last', async () => {
    const snap = mkSnapshot([mkAgent('a', 'Alder', 7, 8)]);
    const tree = treeAt(snap, 7, 5);
    const steps: ActionInput[] = [
      { type: 'goto', data: { x: 7, y: 5 } },
      { type: 'gather', data: { object_id: tree.id } },
      { type: 'goto', data: { x: 7, y: 6 } },
      { type: 'deposit', data: {} },
    ];
    const order: string[] = [];
    const { results, endedAt } = await runSteps(steps, async (s, i) => {
      order.push(`${i}:${s.type}`);
      return step(snap, 'a', s);
    });
    expect(order).toEqual(['0:goto', '1:gather', '2:goto', '3:deposit']);
    expect(results.map((r) => r.ok)).toEqual([true, true, true, true]);
    expect(endedAt).toBeNull();
    expect(snap.civ.wood).toBe(1);
    expect(snap.agents[0].inventory).toEqual([]);
  });

  it('B3: a failing step ends the plan there and later steps are never attempted', async () => {
    const snap = mkSnapshot([mkAgent('a', 'Alder', 7, 8)]);
    const tree = treeAt(snap, 7, 5); // three tiles away: gather fails
    const attempted: string[] = [];
    const { results, endedAt } = await runSteps(
      [
        { type: 'say', data: { message: 'off we go' } },
        { type: 'gather', data: { object_id: tree.id } },
        { type: 'deposit', data: {} },
      ],
      async (s) => {
        attempted.push(s.type);
        return step(snap, 'a', s);
      }
    );
    expect(attempted).toEqual(['say', 'gather']);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(results[1].message.length).toBeGreaterThan(0);
    expect(endedAt).toBe(1);
    expect(snap.civ.wood).toBe(0);
  });

  it('B3: steps are awaited one after another, never overlapping', async () => {
    let running = 0;
    let overlap = false;
    await runSteps(planSteps(planOf('wait', 'wait', 'wait')), async () => {
      running++;
      overlap = overlap || running > 1;
      await Promise.resolve();
      running--;
      return { ok: true };
    });
    expect(overlap).toBe(false);
  });

  it('B3: the sanitizer caps a plan at 4 steps and drops nested plans and junk', () => {
    const wait = { type: 'wait', data: {} };
    const plan = sanitizeAction('plan', {
      steps: [wait, { type: 'plan', data: { steps: [wait] } }, null, wait, wait, wait, wait, wait],
    });
    expect(plan.type).toBe('plan');
    if (plan.type !== 'plan') return;
    expect(plan.data.steps.length).toBeLessThanOrEqual(4);
    expect(plan.data.steps.every((s) => s.type !== 'plan')).toBe(true);
    expect(sanitizeAction('plan', { steps: [] })).toEqual({ type: 'wait', data: {} });
  });

  it('B3: step() refuses a plan handed to it whole', () => {
    const snap = mkSnapshot([mkAgent('a', 'Alder', 7, 8)]);
    expect(step(snap, 'a', planOf('wait', 'wait')).ok).toBe(false);
  });
});
