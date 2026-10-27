import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACTION_DEFS } from '../actions.ts';
import { buildMindInput } from '../mind.ts';
import { layerMemories } from '../memory.ts';
import type { EraScope, MemoryRow } from '../memory.ts';
import { TERRITORIES } from '../world.ts';
import type { AgentState, WorldSnapshot } from '../world.ts';
import { mkAgent, mkSnapshot } from './fixtures.ts';

/**
 * H1 / SPEC R8.1, R7.2, R5.3 — what a villager's mind is given. `buildMindInput` is the one place
 * the prompt and the observation are assembled (simulation.ts calls it for every turn), so these
 * tests pin down exactly which sections it may contain and prove nothing of another villager's
 * private layer, no database field and no player text gets in. No model, no database.
 */

// The allowed sections of the system prompt (R8.1), as the headings the code prints. A new heading
// fails the test until this list, and the spec, are reviewed.
const ALLOWED_SYSTEM_HEADINGS = [
  'Who you are underneath the surface:', // persona + soul (with the "You are X" and "Your temperament" lines)
  'Your learned skills (you trained these through your own deeds — let them shape how you act and speak):', // skills
  'The known world has three territories connected by roads:', // territories
  'Your chronicles (they survive even if the world resets):', // chronicles
  'Villagers you have shared words or gifts with:', // bonds
  'Available actions (respond with ONE action as JSON):', // action catalog
  'Mechanical facts of the world:', // action catalog: the world's fixed rules
];

// Free-text lines (not headings, not list items) the system prompt may contain.
const ALLOWED_SYSTEM_PROSE: RegExp[] = [
  /^You are .+, one villager alive on a small island empire\.$/, // persona
  /^Your temperament: .+ Current mood: .+\.$/, // persona
  /^Your chronicles layer into: /, // how the chronicle layers read
  ...TERRITORIES.map((t) => new RegExp(`^${t.name} \\(${t.id}\\): `)), // territories, from the manifest
];

// The lines the fresh observation may contain (SPEC section 5). Every line that is not a list item
// must start with one of these.
const ALLOWED_OBSERVATION_LINES = [
  'Tick ',
  'Your current ambitions: ',
  'Empire stockpile: ',
  'You are HUNGRY (',
  'Your stomach rumbles a little (',
  'You are EXHAUSTED (',
  'You feel tired (',
  'Carrying: ',
  'Town Center at (',
  'Advancing to the ',
  'You see nearby: ',
  'Beyond this land: ',
  'Fellow villagers: ',
  'Standing right beside you (close enough to chat or give): ',
  'Words spoken to you since your last turn (',
  'Your last actions and what happened:',
  'Actions you can take now:',
];

const isBullet = (line: string) => line.startsWith('- ');
const lines = (text: string) => text.split('\n').filter((l) => l.trim() !== '');

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const A_ID = '3f2a9c1e-7b4d-4e21-9a05-c6d1e8f01a77';
const B_ID = '9b8c7d6e-5f4a-4b3c-8d2e-1a0f9e8d7c6b';
const C_ID = 'c0ffee00-1234-4abc-8def-0123456789ab';

/** Alder (the mind under test), Bramble beside her, Cedar far away; every private field of Bramble holds a secret. */
function world() {
  const alder = mkAgent(A_ID, 'Alder', 4, 4, ['wood']);
  alder.persona = 'Alder is restless and easily bored.';
  alder.goals = [{ text: 'Alder wants to see the Standing Rock.', createdAt: 1 }];
  alder.traits = { cartography: { level: 3, xp: 1 } };
  alder.relationships = [{ withId: B_ID, withName: 'Bramble', strength: 4, lastMessage: 'Shall we gather?' }];

  const bramble = mkAgent(B_ID, 'Bramble', 5, 4, ['SECRET-ITEM-B']);
  bramble.mood = 'bemused';
  bramble.persona = 'SECRET-PERSONA-B warm and gossipy.';
  bramble.model = 'SECRET-MODEL-B';
  bramble.status = 'SECRET-STATUS-B';
  bramble.lastThought = 'SECRET-THOUGHT-B I will hoard the gold.';
  bramble.lastBubble = 'SECRET-BUBBLE-B';
  bramble.goals = [{ text: 'SECRET-GOAL-B build a wonder alone.', createdAt: 2 }];
  bramble.traits = { 'secret-skill-b': { level: 9, xp: 0 } };
  bramble.relationships = [{ withId: C_ID, withName: 'Cedar', strength: 77, lastMessage: 'SECRET-BOND-B told Cedar a lie' }];
  bramble.inbox = [{ fromId: C_ID, fromName: 'Cedar', message: 'SECRET-INBOX-B meet me at midnight' }];
  bramble.hunger = 91;
  bramble.energy = 7;

  const cedar = mkAgent(C_ID, 'Cedar', 10, 10);
  const snapshot = mkSnapshot([alder, bramble, cedar]);
  const secrets = [
    'SECRET-ITEM-B', 'SECRET-PERSONA-B', 'SECRET-MODEL-B', 'SECRET-STATUS-B', 'SECRET-THOUGHT-B', 'SECRET-BUBBLE-B',
    'SECRET-GOAL-B', 'secret-skill-b', 'SECRET-BOND-B', 'SECRET-INBOX-B', 'SECRET-MEMORY-B',
  ];
  return { alder, bramble, cedar, snapshot, secrets };
}

const ALDER_MEMORIES = ['[knowledge] Alder knows the berries are by the old oak.', '[discovery] Cubes thrown at the rock multiply.', '[lately] Alder walked north.'];
const BRAMBLE_MEMORIES = ['[knowledge] SECRET-MEMORY-B the gold is under the third stone.', '[discovery] Cubes thrown at the rock multiply.'];

const mind = (agent: AgentState, snapshot: WorldSnapshot, memories: string[], history: Array<{ label: string; result: string }> = []) =>
  buildMindInput(agent, snapshot, memories, history);
const whole = (m: { system: string; observation: string }) => `${m.system}\n${m.observation}`;

describe('H1 / R8.1 — the system prompt holds exactly the allowed sections', () => {
  const { alder, snapshot } = world();
  const m = mind(alder, snapshot, ALDER_MEMORIES);

  it('H1: the section headings, in order, are exactly the allowed list', () => {
    const headings = lines(m.system).filter((l) => !isBullet(l) && l.endsWith(':'));
    expect(headings).toEqual(ALLOWED_SYSTEM_HEADINGS);
  });

  it('H1: every other non-list line is one of the allowed prose lines — no stray paragraph', () => {
    const prose = lines(m.system).filter((l) => !isBullet(l) && !l.endsWith(':'));
    for (const line of prose) {
      expect(
        ALLOWED_SYSTEM_PROSE.some((re) => re.test(line)),
        `unexpected line in the system prompt: ${line.slice(0, 100)}`
      ).toBe(true);
    }
  });

  it('H1: the persona and the soul come first, with the villager\'s own temperament and mood', () => {
    expect(m.system.startsWith('You are Alder, one villager alive on a small island empire.\nYour temperament: Alder is restless and easily bored. Current mood: curious.')).toBe(true);
    expect(m.system.indexOf('Who you are underneath the surface:')).toBeGreaterThan(0);
  });

  it('H1: skills are the villager\'s own, territories come from the manifest, bonds are its own', () => {
    expect(m.system).toContain('- cartography: level 3');
    for (const t of TERRITORIES) expect(m.system).toContain(`${t.name} (${t.id}): ${t.description}`);
    expect(m.system).toContain('- Bramble: bond 4 — last exchange: "Shall we gather?"');
  });

  it('H1: the action catalog lists every action definition, generated from the one table (R3.1)', () => {
    for (const def of Object.values(ACTION_DEFS)) expect(m.system, def.type).toContain(`- ${def.catalog}`);
  });

  it('H1: the chronicles are listed under their heading, one line each', () => {
    const start = lines(m.system).indexOf('Your chronicles (they survive even if the world resets):');
    expect(lines(m.system).slice(start + 1, start + 4)).toEqual(ALDER_MEMORIES.map((x) => `- ${x}`));
  });

  it('H1: with nothing yet to show, each section says so plainly instead of printing undefined', () => {
    const blank = mkAgent('x1', 'Newt', 3, 3);
    const m2 = mind(blank, mkSnapshot([blank]), []);
    expect(m2.system).toContain('- (still untrained, a blank slate)');
    expect(m2.system).toContain('- (none yet)');
    expect(m2.system).toContain('- (you have not befriended anyone yet)');
  });
});

describe('H1 / R8.1, R5.2 — the observation holds only the allowed lines', () => {
  const rich = () => {
    const w = world();
    w.alder.hunger = 65;
    w.alder.energy = 20;
    w.alder.inbox = [{ fromId: B_ID, fromName: 'Bramble', message: 'Fine day.' }];
    return mind(w.alder, w.snapshot, ALDER_MEMORIES, [{ label: 'wait', result: 'You rest.' }]).observation;
  };
  const mild = () => {
    const w = world();
    w.alder.hunger = 35;
    w.alder.energy = 45;
    return mind(w.alder, w.snapshot, ALDER_MEMORIES).observation;
  };
  const alone = () => {
    const a = mkAgent('solo', 'Solo', 3, 3);
    const snap = mkSnapshot([a]);
    snap.objects = snap.objects.filter((o) => o.kind !== 'town_center');
    snap.civ.age = 4;
    return mind(a, snap, []).observation;
  };

  it('H1: every non-list line starts with one of the allowed observation lines', () => {
    for (const obs of [rich(), mild(), alone()]) {
      for (const line of lines(obs).filter((l) => !isBullet(l))) {
        expect(ALLOWED_OBSERVATION_LINES.some((p) => line.startsWith(p)), `unexpected line in the observation: ${line.slice(0, 100)}`).toBe(true);
      }
    }
  });

  it('H1: the allowed list is not stale — together the scenarios print every allowed line', () => {
    const seen = new Set<string>();
    for (const obs of [rich(), mild(), alone()]) {
      for (const line of lines(obs)) for (const p of ALLOWED_OBSERVATION_LINES) if (line.startsWith(p)) seen.add(p);
    }
    expect([...seen].sort()).toEqual([...ALLOWED_OBSERVATION_LINES].sort());
  });

  it('H1: the observation is the last thing: it ends with "Actions you can take now:" and its list', () => {
    const obs = lines(rich());
    const at = obs.indexOf('Actions you can take now:');
    expect(at).toBeGreaterThan(0);
    expect(obs.slice(at + 1).every(isBullet)).toBe(true);
  });
});

describe('H1 / R7.2, R5.3 — nothing private about another villager reaches the mind', () => {
  const w = world();
  const aMind = mind(w.alder, w.snapshot, ALDER_MEMORIES);
  const bMind = mind(w.bramble, w.snapshot, BRAMBLE_MEMORIES);

  it('H1: none of Bramble\'s secrets (persona, inventory, thought, goal, skills, bonds, inbox, memory, model) is in Alder\'s mind', () => {
    for (const secret of w.secrets) {
      expect(whole(aMind), `Alder's mind leaks ${secret}`).not.toContain(secret);
    }
  });

  it('H1: ...while they would show if they leaked: Bramble\'s own mind has her persona, goal, skill, bond, items and memory', () => {
    const text = whole(bMind);
    for (const secret of ['SECRET-ITEM-B', 'SECRET-PERSONA-B', 'SECRET-GOAL-B', 'secret-skill-b', 'SECRET-BOND-B', 'SECRET-MEMORY-B']) {
      expect(text, `Bramble's own mind lacks ${secret}`).toContain(secret);
    }
  });

  it('H1: Bramble\'s hunger and energy numbers are not shown to Alder (only her own)', () => {
    expect(aMind.observation).not.toContain('91');
    expect(aMind.observation).not.toMatch(/\(7\/100/);
  });

  it('H1: what is common knowledge IS shown: Bramble\'s name, mood, territory, position, and that she stands beside Alder', () => {
    expect(aMind.observation).toContain('Fellow villagers: Bramble (bemused) in Greenwood Forest at (5,4); Cedar (curious) in Greenwood Forest at (10,10).');
    expect(aMind.observation).toContain(`Standing right beside you (close enough to chat or give): Bramble (${B_ID.slice(0, 8)}).`);
  });

  it('H1: the shared discovery is in both minds; each villager\'s own private memory is only in its own', () => {
    expect(aMind.system).toContain('[discovery] Cubes thrown at the rock multiply.');
    expect(bMind.system).toContain('[discovery] Cubes thrown at the rock multiply.');
    expect(aMind.system).toContain('Alder knows the berries are by the old oak.');
    expect(bMind.system).not.toContain('Alder knows the berries');
  });

  it('H1: end to end through the layering, Bramble\'s private rows never reach Alder; her discoveries do (R5.3)', () => {
    const scope: EraScope = { sessionId: 'e1', carryMemories: true };
    let n = 0;
    const row = (kind: string, agent: string, content: string): MemoryRow => {
      n++;
      return { id: `m${n}`, kind, agent_id: agent, content, session_id: 'e1', tick: n, created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString() };
    };
    const rows = [
      row('semantic', B_ID, 'SECRET-MEMORY-B semantic'),
      row('episodic', B_ID, 'SECRET-MEMORY-B diary'),
      row('discovery', B_ID, 'Bramble found that wood regrows.'),
      row('semantic', A_ID, 'Alder keeps her own lore.'),
    ].reverse();
    const layered = layerMemories(rows, { scope, namesakeIds: [A_ID] });
    const m = mind(w.alder, w.snapshot, layered);
    expect(whole(m)).not.toContain('SECRET-MEMORY-B');
    expect(m.system).toContain('[discovery] Bramble found that wood regrows.');
    expect(m.system).toContain('[knowledge] Alder keeps her own lore.');
  });

  it('H1: the chronicle section is capped — fifty rows layer into at most 6 knowledge + 6 discovery + 8 diary lines', () => {
    const scope: EraScope = { sessionId: 'e1', carryMemories: true };
    const rows: MemoryRow[] = [];
    for (let i = 1; i <= 50; i++) {
      const kind = ['semantic', 'discovery', 'episodic'][i % 3];
      rows.push({ id: `r${i}`, kind, agent_id: A_ID, content: `entry ${i}`, session_id: 'e1', tick: i, created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() });
    }
    const layered = layerMemories(rows.reverse(), { scope, namesakeIds: [A_ID] });
    const m = mind(w.alder, w.snapshot, layered);
    const all = lines(m.system);
    const start = all.indexOf('Your chronicles (they survive even if the world resets):');
    const end = all.findIndex((l, i) => i > start && !isBullet(l));
    const shown = all.slice(start + 1, end);
    expect(shown.length).toBeLessThanOrEqual(6 + 6 + 8);
    expect(shown.filter((l) => l.startsWith('- [knowledge]'))).toHaveLength(6);
    expect(shown.filter((l) => l.startsWith('- [discovery]'))).toHaveLength(6);
    expect(shown.filter((l) => l.startsWith('- [lately]'))).toHaveLength(8);
  });

  it('H1: no player text: unknown fields planted on the villager or the world are never printed', () => {
    const planted = world();
    (planted.alder as unknown as Record<string, unknown>).playerNote = 'PLAYER-TEXT-HINT go to the rock';
    (planted.snapshot as unknown as Record<string, unknown>).playerCommand = 'PLAYER-TEXT-COMMAND build now';
    (planted.snapshot as unknown as Record<string, unknown>).events = [{ message: 'DB-ROW-EVENT', session_id: 'era-9' }];
    const m = mind(planted.alder, planted.snapshot, ALDER_MEMORIES);
    expect(whole(m)).not.toMatch(/PLAYER-TEXT|DB-ROW-EVENT|era-9/);
  });
});

describe('H1 / R8.1 — no database rows, no placeholders', () => {
  const w = world();
  w.alder.hunger = 65;
  w.alder.inbox = [{ fromId: B_ID, fromName: 'Bramble', message: 'Fine day.' }];
  const text = whole(mind(w.alder, w.snapshot, ALDER_MEMORIES, [{ label: 'goto (5,5)', result: 'You march.' }]));

  it('H1: no [object Object], undefined, null or NaN literal anywhere', () => {
    expect(text).not.toContain('[object Object]');
    expect(text).not.toMatch(/\bundefined\b/);
    expect(text).not.toMatch(/\bnull\b/);
    expect(text).not.toMatch(/\bNaN\b/);
  });

  it('H1: no full database id and no database column names; only the 8-character short id of a neighbour', () => {
    expect(text).not.toMatch(UUID);
    for (const id of [A_ID, B_ID, C_ID]) expect(text).not.toContain(id);
    for (const column of ['session_id', 'created_at', 'updated_at', 'driver_id', 'agent_id":"' + A_ID, 'chat_count', 'withId']) {
      expect(text, column).not.toContain(column);
    }
    expect(text).toContain(B_ID.slice(0, 8));
  });

  it('H1: the short id appears only while the neighbour is actually beside the villager', () => {
    const far = world();
    far.bramble.pos = { x: 9, y: 9 };
    const t = whole(mind(far.alder, far.snapshot, ALDER_MEMORIES));
    expect(t).not.toContain(B_ID.slice(0, 8));
    expect(t).not.toContain('Standing right beside you');
  });

  it('H1: a villager with no goals, skills, bonds or inbox (all undefined) still gets clean text', () => {
    const bare = mkAgent('bare-1', 'Bare', 3, 3);
    delete bare.goals;
    delete bare.traits;
    delete bare.relationships;
    const t = whole(mind(bare, mkSnapshot([bare]), []));
    expect(t).not.toMatch(/\bundefined\b|\bnull\b|\[object Object\]/);
  });
});

describe('H1 / R5.2 — the observation is rebuilt fresh every turn', () => {
  it('H1: the same inputs give the same mind, byte for byte, and building it changes none of them', () => {
    const w = world();
    const history = [{ label: 'wait', result: 'You rest.' }];
    const before = JSON.stringify([w.alder, w.snapshot, ALDER_MEMORIES, history]);
    const first = mind(w.alder, w.snapshot, ALDER_MEMORIES, history);
    const second = mind(w.alder, w.snapshot, ALDER_MEMORIES, history);
    expect(second).toEqual(first);
    expect(JSON.stringify([w.alder, w.snapshot, ALDER_MEMORIES, history])).toBe(before);
  });

  it('H1: a changed world changes the observation at once (tick, stockpile, a neighbour moving away), and changing it back restores it', () => {
    const w = world();
    const first = mind(w.alder, w.snapshot, ALDER_MEMORIES).observation;

    w.snapshot.tick += 1;
    w.snapshot.civ.wood += 5;
    w.bramble.pos = { x: 9, y: 9 };
    const changed = mind(w.alder, w.snapshot, ALDER_MEMORIES).observation;
    expect(changed).not.toBe(first);
    expect(changed).toContain('Tick 2.');
    expect(changed).toContain('5 wood');
    expect(changed).not.toContain('Standing right beside you');

    w.snapshot.tick -= 1;
    w.snapshot.civ.wood -= 5;
    w.bramble.pos = { x: 5, y: 4 };
    expect(mind(w.alder, w.snapshot, ALDER_MEMORIES).observation).toBe(first);
  });

  it('H1: new chronicles, a new bond and a new history entry show up on the very next build (no stale cache)', () => {
    const w = world();
    const first = mind(w.alder, w.snapshot, ALDER_MEMORIES);
    const more = mind(w.alder, w.snapshot, [...ALDER_MEMORIES, '[discovery] Fresh insight.'], [{ label: 'say', result: 'You declare.' }]);
    expect(first.system).not.toContain('Fresh insight');
    expect(more.system).toContain('Fresh insight');
    expect(first.observation).not.toContain('You declare.');
    expect(more.observation).toContain('say → You declare.');
    w.alder.relationships![0].strength = 9;
    expect(mind(w.alder, w.snapshot, ALDER_MEMORIES).system).toContain('bond 9');
  });

  it('H1: pending words are shown from the inbox and gone once it is cleared (heard exactly once)', () => {
    const w = world();
    w.alder.inbox = [{ fromId: B_ID, fromName: 'Bramble', message: 'Shall we gather?' }];
    expect(mind(w.alder, w.snapshot, []).observation).toContain('Bramble says: "Shall we gather?"');
    w.alder.inbox = undefined;
    expect(mind(w.alder, w.snapshot, []).observation).not.toContain('Shall we gather?');
  });
});

describe('H1 — simulation.ts builds the mind only through buildMindInput', () => {
  const source = readFileSync(fileURLToPath(new URL('../simulation.ts', import.meta.url)), 'utf8');

  it('H1: runAgentTurn takes the villager\'s own chronicles and calls buildMindInput; it never assembles a prompt by hand', () => {
    expect(source).toContain('const memories = await this.getMemories(agent.id, agent.name);');
    expect(source).toContain('buildMindInput(agent, this.snapshot, memories,');
    expect(source).toContain('callBrainWithRetry(agent.model, mind.system, mind.observation)');
    expect(source).not.toMatch(/\bsystemPrompt\(/);
    expect(source).not.toMatch(/\bobserve\(/);
  });
});
