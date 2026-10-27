import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ActionType } from '../actions.ts';
import { eventsForResult, planEndRow } from '../chronicle.ts';
import type { ChronicleRow } from '../chronicle.ts';
import { ACTION_TYPES, planSteps, runSteps, step, territoryAt } from '../world.ts';
import type { ActionInput, WorldSnapshot } from '../world.ts';
import { REPRESENTATIVE, clearField, mkAgent, mkSnapshot } from './fixtures.ts';

/**
 * H3 / SPEC R3.3, R8.4 — every executed action result, and every plan step, produces a chronicle
 * entry; a plan that stops early says where. Actions run through the real engine `step()`; the rows
 * are what `eventsForResult` / `planEndRow` return and `simulation.ts` writes verbatim. No database.
 */

/** Open ground: Alder (4,4) and Bramble (5,4) side by side, the Town Center at (7,7), a tree at (4,5) and a cube at (3,4). */
function field(tweak: (snap: WorldSnapshot) => void = () => {}): WorldSnapshot {
  const snap = clearField(mkSnapshot([mkAgent('a', 'Alder', 4, 4), mkAgent('b', 'Bramble', 5, 4)]));
  snap.objects.push(
    { id: 'tree1', territory: 'forest', pos: { x: 4, y: 5 }, kind: 'tree' },
    { id: 'cube1', territory: 'forest', pos: { x: 3, y: 4 }, kind: 'cube' }
  );
  tweak(snap);
  return snap;
}

interface Case {
  action: ActionInput;
  setup?: (snap: WorldSnapshot) => void;
}

/** For every action type: a situation where the world accepts it, and (where the world can refuse it at all) one where it does not. */
const CASES: Record<ActionType, { ok: Case; fail: Case | null }> = {
  goto: { ok: { action: { type: 'goto', data: { x: 6, y: 5 } } }, fail: { action: { type: 'goto', data: { x: 99, y: 99 } } } },
  move: { ok: { action: { type: 'move', data: { dx: 0, dy: 1 } } }, fail: { action: { type: 'move', data: { dx: 2, dy: 0 } } } },
  gather: { ok: { action: { type: 'gather', data: { object_id: 'tree1' } } }, fail: { action: { type: 'gather', data: { object_id: 'nothing' } } } },
  gather_nearest: { ok: { action: { type: 'gather_nearest', data: {} } }, fail: { action: { type: 'gather_nearest', data: {} }, setup: (s) => { s.objects = s.objects.filter((o) => o.id !== 'tree1'); } } },
  deposit: {
    ok: { action: { type: 'deposit', data: {} }, setup: (s) => { s.agents[0].pos = { x: 6, y: 7 }; s.agents[0].inventory = ['wood']; } },
    fail: { action: { type: 'deposit', data: {} } },
  },
  pick_up: { ok: { action: { type: 'pick_up', data: { object_id: 'cube1' } } }, fail: { action: { type: 'pick_up', data: { object_id: 'tree1' } } } },
  place: {
    ok: { action: { type: 'place', data: { dx: 0, dy: -1 } }, setup: (s) => { s.agents[0].inventory = ['cube']; } },
    fail: { action: { type: 'place', data: { dx: 0, dy: -1 } } },
  },
  throw: {
    ok: { action: { type: 'throw', data: { dx: 0, dy: -2 } }, setup: (s) => { s.agents[0].inventory = ['cube']; } },
    fail: { action: { type: 'throw', data: { dx: 0, dy: -2 } } },
  },
  build: { ok: { action: { type: 'build', data: { structure: 'house' } }, setup: (s) => { s.civ.wood = 5; } }, fail: { action: { type: 'build', data: { structure: 'house' } } } },
  advance_age: {
    ok: { action: { type: 'advance_age', data: {} }, setup: (s) => { Object.assign(s.civ, { wood: 4, food: 4, gold: 2 }); } },
    fail: { action: { type: 'advance_age', data: {} } },
  },
  say: { ok: { action: { type: 'say', data: { message: 'Hear me.' } } }, fail: null },
  chat: { ok: { action: { type: 'chat', data: { agent_id: 'b', message: 'Hello.' } } }, fail: { action: { type: 'chat', data: { agent_id: 'nobody', message: 'Hello?' } } } },
  gift: {
    ok: { action: { type: 'gift', data: { agent_id: 'b' } }, setup: (s) => { s.agents[0].inventory = ['wood']; } },
    fail: { action: { type: 'gift', data: { agent_id: 'b' } } },
  },
  wander: {
    ok: { action: { type: 'wander', data: {} } },
    fail: {
      action: { type: 'wander', data: {} },
      setup: (s) => { // boxed into the corner (0,0) by two villagers
        s.agents[0].pos = { x: 0, y: 0 };
        s.agents[1].pos = { x: 1, y: 0 };
        s.agents.push(mkAgent('c', 'Cedar', 0, 1));
      },
    },
  },
  eat: { ok: { action: { type: 'eat', data: {} }, setup: (s) => { s.civ.food = 2; } }, fail: { action: { type: 'eat', data: {} } } },
  remember: { ok: { action: { type: 'remember', data: { kind: 'semantic', content: 'The old oak bears nuts.' } } }, fail: null },
  train: { ok: { action: { type: 'train', data: { ability: 'fishing' } } }, fail: null },
  discover: { ok: { action: { type: 'discover', data: { insight: 'Trees regrow.' } } }, fail: null },
  set_goal: { ok: { action: { type: 'set_goal', data: { goal: 'Build a house.' } } }, fail: null },
  wait: { ok: { action: { type: 'wait', data: {} } }, fail: null },
  // a plan is unrolled into its steps before step() runs (covered below); handed to step() whole it is refused
  plan: { ok: { action: REPRESENTATIVE.plan }, fail: { action: REPRESENTATIVE.plan } },
};

/** Runs one decision the way `runAgentTurn` does: unroll the plan, execute each step, collect the rows each yields, then the plan-end row. */
async function playTurn(snap: WorldSnapshot, action: ActionInput, thought = 'I act.') {
  const agent = snap.agents[0];
  const steps = planSteps(action);
  const rows: ChronicleRow[] = [];
  const results: Array<ReturnType<typeof step>> = [];
  const { endedAt } = await runSteps(steps, async (s, i) => {
    const result = step(snap, agent.id, s);
    agent.island = territoryAt(agent.pos) ?? agent.island;
    const target = result.chat ? snap.agents.find((a) => a.id === result.chat!.withId) : undefined;
    rows.push(...eventsForResult(agent, s, result, { thought, isFirst: i === 0, target }));
    results.push(result);
    return result;
  });
  const end = planEndRow(agent, endedAt, steps.length);
  if (end) rows.push(end);
  return { rows, results, endedAt, steps };
}

const actionRows = (rows: ChronicleRow[]) => rows.filter((r) => r.type !== 'thought' && r.type !== 'system');

describe('H3 / R3.3 — every action type produces a chronicle row, on success and on failure', () => {
  it('H3: the table covers every action type the engine has', () => {
    expect(Object.keys(CASES).sort()).toEqual([...ACTION_TYPES].sort());
  });

  for (const type of ACTION_TYPES.filter((t) => t !== 'plan')) {
    it(`H3: ${type} succeeds and the success is chronicled`, () => {
      const c = CASES[type].ok;
      const snap = field(c.setup);
      const agent = snap.agents[0];
      const result = step(snap, agent.id, c.action);
      expect(result.ok, result.message).toBe(true);
      const rows = eventsForResult(agent, c.action, result, { thought: 'I act.', isFirst: false });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ agent_id: 'a', island: 'forest', type, message: `Alder: ${result.message}` });
      expect(result.message.length).toBeGreaterThan(10);
    });

    const failing = CASES[type].fail;
    if (failing) {
      it(`H3: ${type} is refused by the world and the refusal, with its reason, is chronicled`, () => {
        const snap = field(failing.setup);
        const agent = snap.agents[0];
        const result = step(snap, agent.id, failing.action);
        expect(result.ok).toBe(false);
        const rows = eventsForResult(agent, failing.action, result);
        expect(rows).toHaveLength(1);
        expect(rows[0].type).toBe(type);
        expect(rows[0].message).toBe(`Alder: ${result.message}`);
        expect(result.message.length).toBeGreaterThan(20); // a plain-language reason, not an empty string (R4.1)
      });
    } else {
      it(`H3: ${type} cannot be refused by the world (it always succeeds), so it has only the success case`, () => {
        expect(failing).toBeNull();
      });
    }
  }

  it('H3: plan is unrolled step by step (below); handed to step() whole, the refusal and its reason are chronicled', () => {
    const snap = field();
    const result = step(snap, 'a', REPRESENTATIVE.plan);
    expect(result.ok).toBe(false);
    expect(eventsForResult(snap.agents[0], REPRESENTATIVE.plan, result)).toEqual([
      { agent_id: 'a', island: 'forest', type: 'plan', message: `Alder: ${result.message}` },
    ]);
  });

  it('H3: a villager that no longer exists is answered too: even that failure has a message to chronicle', () => {
    const snap = field();
    const result = step(snap, 'ghost', { type: 'wait', data: {} });
    expect(result.ok).toBe(false);
    const rows = eventsForResult({ id: 'ghost', name: 'Ghost', island: 'forest' }, { type: 'wait' }, result);
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain('Unknown villager');
  });
});

describe('H3 / R3.3 — private memories are summarized, not dropped', () => {
  it('H3: remember is chronicled as the world\'s own summary line, naming the villager and carrying the entry', () => {
    const snap = field();
    const action: ActionInput = { type: 'remember', data: { kind: 'episodic', content: 'Bramble fears the dark.' } };
    const result = step(snap, 'a', action);
    expect(result.memory).toEqual({ kind: 'episodic', content: 'Bramble fears the dark.' });
    const rows = eventsForResult(snap.agents[0], action, result);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('remember');
    expect(rows[0].message).toBe('Alder: You record in the empire chronicles: "Bramble fears the dark."');
  });

  it('H3: a long private memory is chronicled (cut to the engine\'s 500 characters), never dropped', () => {
    const snap = field();
    const action: ActionInput = { type: 'remember', data: { kind: 'semantic', content: 'x'.repeat(800) } };
    const result = step(snap, 'a', action);
    const rows = eventsForResult(snap.agents[0], action, result);
    expect(rows).toHaveLength(1);
    expect(rows[0].message.length).toBeLessThan(600);
    expect(rows[0].message).toContain('x'.repeat(500));
  });

  it('H3: a discovery (shared) is chronicled as a discover row', () => {
    const snap = field();
    const action: ActionInput = { type: 'discover', data: { insight: 'Cubes multiply at the rock.' } };
    const rows = eventsForResult(snap.agents[0], action, step(snap, 'a', action));
    expect(rows.map((r) => r.type)).toEqual(['discover']);
    expect(rows[0].message).toContain('Cubes multiply at the rock.');
  });
});

describe('H3 / R8.4 — every plan step is chronicled', () => {
  const threeStepPlan: ActionInput = {
    type: 'plan',
    data: { steps: [{ type: 'goto', data: { x: 4, y: 4 } }, { type: 'gather_nearest', data: {} }, { type: 'say', data: { message: 'Done.' } }] },
  };

  it('H3: a three-step plan that runs to the end writes three action rows (plus the thought), and no plan-end row', async () => {
    const { rows, results, endedAt } = await playTurn(field(), threeStepPlan);
    expect(results.map((r) => r.ok)).toEqual([true, true, true]);
    expect(endedAt).toBeNull();
    expect(actionRows(rows).map((r) => r.type)).toEqual(['goto', 'gather_nearest', 'say']);
    expect(rows.filter((r) => r.type === 'thought')).toHaveLength(1); // the thought belongs to the turn, not to each step
    expect(rows.filter((r) => r.type === 'system')).toHaveLength(0);
    expect(rows).toHaveLength(4);
  });

  it('H3: each step\'s row carries that step\'s own result (later steps saw the earlier ones)', async () => {
    const { rows, results } = await playTurn(field(), threeStepPlan);
    const mine = actionRows(rows);
    for (let i = 0; i < 3; i++) expect(mine[i].message).toBe(`Alder: ${results[i].message}`);
    expect(mine[1].message).toContain('You gather 1 wood');
  });

  it('H3: a plan whose step 2 of 3 fails writes step 1, the failing step with its reason, and "plan ends at step 2 of 3" — step 3 is not run', async () => {
    const plan: ActionInput = {
      type: 'plan',
      data: { steps: [{ type: 'say', data: { message: 'Off I go.' } }, { type: 'pick_up', data: { object_id: 'tree1' } }, { type: 'say', data: { message: 'Never said.' } }] },
    };
    const { rows, results, endedAt, steps } = await playTurn(field(), plan);
    expect(steps).toHaveLength(3);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(endedAt).toBe(1);
    expect(actionRows(rows).map((r) => r.type)).toEqual(['say', 'pick_up']);
    expect(actionRows(rows)[1].message).toBe(`Alder: ${results[1].message}`); // the world's plain-language reason
    const system = rows.filter((r) => r.type === 'system');
    expect(system).toHaveLength(1);
    expect(system[0].message).toBe("Alder's plan ends at step 2 of 3; the remaining steps are not attempted.");
    expect(rows.map((r) => r.message).join('\n')).not.toContain('Never said');
  });

  it('H3: a plan that fails at its first step writes that step and "plan ends at step 1 of 4"', async () => {
    const plan: ActionInput = {
      type: 'plan',
      data: { steps: [{ type: 'deposit', data: {} }, { type: 'wait', data: {} }, { type: 'wait', data: {} }, { type: 'wait', data: {} }] },
    };
    const { rows, endedAt } = await playTurn(field(), plan);
    expect(endedAt).toBe(0);
    expect(actionRows(rows).map((r) => r.type)).toEqual(['deposit']);
    expect(rows.find((r) => r.type === 'system')?.message).toBe("Alder's plan ends at step 1 of 4; the remaining steps are not attempted.");
  });

  it('H3: a plan whose LAST step fails has run every step, so it has no "plan ends" row — the failure row itself is the entry', async () => {
    const plan: ActionInput = { type: 'plan', data: { steps: [{ type: 'wait', data: {} }, { type: 'deposit', data: {} }] } };
    const { rows, endedAt } = await playTurn(field(), plan);
    expect(endedAt).toBe(1);
    expect(actionRows(rows).map((r) => r.type)).toEqual(['wait', 'deposit']);
    expect(rows.filter((r) => r.type === 'system')).toHaveLength(0);
  });

  it('H3: plans of 2, 3 and 4 steps always write one action row per executed step', async () => {
    for (const n of [2, 3, 4]) {
      const plan: ActionInput = { type: 'plan', data: { steps: Array.from({ length: n }, () => ({ type: 'wait', data: {} }) as ActionInput) } };
      const { rows, results } = await playTurn(field(), plan);
      expect(results).toHaveLength(n);
      expect(actionRows(rows)).toHaveLength(n);
    }
  });

  it('H3: a single action is one row and never a "plan ends" row, whether it works or not', async () => {
    const ok = await playTurn(field(), { type: 'wait', data: {} });
    const bad = await playTurn(field(), { type: 'deposit', data: {} });
    expect(actionRows(ok.rows)).toHaveLength(1);
    expect(actionRows(bad.rows)).toHaveLength(1);
    expect([...ok.rows, ...bad.rows].filter((r) => r.type === 'system')).toHaveLength(0);
  });

  it('H3: planEndRow is null for a plan that finished, for a failure at the last step, and for a single action', () => {
    const agent = { id: 'a', name: 'Alder', island: 'forest' };
    expect(planEndRow(agent, null, 3)).toBeNull();
    expect(planEndRow(agent, 2, 3)).toBeNull();
    expect(planEndRow(agent, 0, 1)).toBeNull();
    expect(planEndRow(agent, 0, 2)?.message).toContain('step 1 of 2');
  });
});

describe('H3 / R3.3, R7.4 — the other rows a result can carry', () => {
  it('H3: the thought is chronicled once per turn, on the first step only, and only when there is one', () => {
    const snap = field();
    const agent = snap.agents[0];
    const wait: ActionInput = { type: 'wait', data: {} };
    const result = step(snap, 'a', wait);
    expect(eventsForResult(agent, wait, result, { thought: 'Resting.', isFirst: true }).map((r) => r.type)).toEqual(['wait', 'thought']);
    expect(eventsForResult(agent, wait, result, { thought: 'Resting.', isFirst: false }).map((r) => r.type)).toEqual(['wait']);
    expect(eventsForResult(agent, wait, result, { thought: '', isFirst: true }).map((r) => r.type)).toEqual(['wait']);
    expect(eventsForResult(agent, wait, result, { thought: 'Resting.', isFirst: true })[1].message).toBe('Alder thinks: Resting.');
  });

  it('H3: a chat that pushes out the target\'s oldest unheard words also chronicles the loss, under the target', async () => {
    const snap = field();
    const chat = (m: string): ActionInput => ({ type: 'chat', data: { agent_id: 'b', message: m } });
    const all: ChronicleRow[][] = [];
    for (const m of ['one', 'two', 'three', 'four']) all.push((await playTurn(snap, chat(m), '')).rows);
    expect(all.slice(0, 3).map((r) => r.length)).toEqual([1, 1, 1]);
    expect(all[3]).toHaveLength(2);
    expect(all[3][0].type).toBe('chat');
    expect(all[3][1]).toEqual({
      agent_id: 'b',
      island: 'forest',
      type: 'system',
      message: 'Bramble had too many unheard words pending; Alder\'s "one" was lost.',
    });
  });

  it('H3: the rows carry who and where: the villager\'s id and the territory they stand in after the step', async () => {
    const snap = field();
    const { rows } = await playTurn(snap, { type: 'goto', data: { x: 20, y: 3 } }, '');
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_id).toBe('a');
    expect(rows[0].island).toBe(territoryAt(snap.agents[0].pos));
  });
});

describe('H3 — simulation.ts writes what chronicle.ts returns', () => {
  const source = readFileSync(fileURLToPath(new URL('../simulation.ts', import.meta.url)), 'utf8');

  it('H3: every executed step\'s rows and the plan-end row go through eventsForResult / planEndRow and logEvent', () => {
    expect(source.match(/eventsForResult\(/g)).toHaveLength(1);
    expect(source).toMatch(/for \(const row of eventsForResult\([^)]*\)\) \{\s*await this\.logEvent\(row\);\s*\}/);
    expect(source.match(/planEndRow\(/g)).toHaveLength(1);
    expect(source).toMatch(/if \(planEnd\) await this\.logEvent\(planEnd\);/);
  });

  it('H3: no result is chronicled by hand any more, and the plan still runs through runSteps', () => {
    expect(source).not.toContain('type: action.type,');
    expect(source).not.toContain("type: 'thought',");
    expect(source).not.toContain('plan ends at step');
    expect(source).toContain('runSteps(steps,');
  });

  it('H3: the result is chronicled before anything is persisted for it, and a window that only watches writes none (R7.6)', () => {
    const exec = source.slice(source.indexOf('private async executeAction('));
    expect(exec.indexOf('if (this.readOnly) return result;')).toBeGreaterThan(0);
    expect(exec.indexOf('eventsForResult(')).toBeGreaterThan(exec.indexOf('if (this.readOnly) return result;'));
    expect(exec.indexOf('eventsForResult(')).toBeLessThan(exec.indexOf("from('memories')"));
  });
});
