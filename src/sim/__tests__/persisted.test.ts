import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentStateFromRow, agentStatePatch, carriedPatch, cursorFromRow, cursorPatch, INVENTORY_CAP } from '../persisted.ts';
import { pickNextActor } from '../rotation.ts';
import { INBOX_LIMIT, STARTING_VILLAGERS, clearInbox, step } from '../world.ts';
import type { ActionInput, AgentState, WorldSnapshot } from '../world.ts';
import { mkAgent, mkSnapshot, seededRandom } from './fixtures.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

/** What the database does to a value: a JSON round trip (jsonb columns, PostgREST). */
const stored = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const msg = (fromId: string, fromName: string, message: string) => ({ fromId, fromName, message });

describe('E1 / R7.4 — agentStatePatch and agentStateFromRow', () => {
  it('round-trips a rich villager: carried items, pending chat, needs, place and mood', () => {
    const a = mkAgent('a', 'Alder', 7, 9, ['wood', 'cube']);
    a.mood = 'industrious';
    a.hunger = 37;
    a.energy = 64;
    a.inbox = [msg('b', 'Bramble', 'Meet me at the mill.'), msg('c', 'Cedar', 'Quote: "hi" — ünïcode ✓')];
    const patch = stored(agentStatePatch(a));
    expect(patch).toEqual({
      position: { x: 7, y: 9 },
      island: 'forest',
      mood: 'industrious',
      status: 'idle',
      hunger: 37,
      energy: 64,
      inventory: ['wood', 'cube'],
      inbox: a.inbox,
    });
    const back = agentStateFromRow(patch);
    expect(back).toEqual({ inventory: a.inventory, inbox: a.inbox });
  });

  it('an empty inbox is written as [] and read back as "nothing pending" (undefined), as in the live engine', () => {
    const a = mkAgent('a', 'Alder', 1, 1);
    const patch = stored(agentStatePatch(a));
    expect(patch.inbox).toEqual([]);
    expect(patch.inventory).toEqual([]);
    expect(agentStateFromRow(patch)).toEqual({ inventory: [], inbox: undefined });
  });

  it('a full inbox (INBOX_LIMIT) and every pairing of gifts survive the round trip', () => {
    const a = mkAgent('a', 'Alder', 1, 1, ['berries', 'wood']);
    a.inbox = Array.from({ length: INBOX_LIMIT }, (_, i) => msg(`id${i}`, `N${i}`, `message ${i}`));
    expect(agentStateFromRow(stored(agentStatePatch(a)))).toEqual({ inventory: ['berries', 'wood'], inbox: a.inbox });
  });

  it('the patch shares nothing with the villager and rounds the needs the way the column stores them', () => {
    const a = mkAgent('a', 'Alder', 2, 3, ['wood']);
    a.hunger = 40.6;
    a.energy = 59.4;
    a.inbox = [msg('b', 'Bramble', 'hi')];
    const patch = agentStatePatch(a);
    expect(patch.hunger).toBe(41);
    expect(patch.energy).toBe(59);
    a.inventory.push('stone');
    a.pos.x = 99;
    a.inbox[0].message = 'changed';
    expect(patch.inventory).toEqual(['wood']);
    expect(patch.position).toEqual({ x: 2, y: 3 });
    expect(patch.inbox[0].message).toBe('hi');
  });

  it('carriedPatch is exactly the inventory and inbox part of the full patch', () => {
    const a = mkAgent('a', 'Alder', 2, 3, ['wood']);
    a.inbox = [msg('b', 'Bramble', 'hi')];
    const { inventory, inbox } = agentStatePatch(a);
    expect(carriedPatch(a)).toEqual({ inventory, inbox });
    expect(Object.keys(carriedPatch(a)).sort()).toEqual(['inbox', 'inventory']);
  });

  it('a row with nothing usable reads as an empty-handed villager with nothing pending, never throwing', () => {
    const junk: unknown[] = [
      null, undefined, 0, 1, '', 'inventory', true, [], [[]], () => 1,
      {}, { inventory: null, inbox: null }, { inventory: 'wood', inbox: 'hello' }, { inventory: 5, inbox: 5 },
      { inventory: {}, inbox: {} }, { inventory: { 0: 'wood', length: 1 }, inbox: { 0: msg('a', 'A', 'x'), length: 1 } },
    ];
    for (const row of junk) {
      expect(() => agentStateFromRow(row)).not.toThrow();
      expect(agentStateFromRow(row)).toEqual({ inventory: [], inbox: undefined });
    }
  });

  it('drops non-string and empty inventory items and keeps the good ones in order', () => {
    const row = { inventory: ['wood', 3, null, undefined, {}, ['x'], '', 'cube', true, 'food'], inbox: [] };
    expect(agentStateFromRow(row).inventory).toEqual(['wood', 'cube', 'food']);
  });

  it('caps an over-long inventory', () => {
    const row = { inventory: Array.from({ length: 50 }, (_, i) => `item${i}`) };
    const got = agentStateFromRow(row).inventory;
    expect(got).toHaveLength(INVENTORY_CAP);
    expect(got[0]).toBe('item0');
  });

  it('drops malformed inbox entries and keeps the well-formed ones, oldest first', () => {
    const row = {
      inventory: [],
      inbox: [
        msg('a', 'Alder', 'first'),
        null, 'text', 7, [], {},
        { fromId: 'x', fromName: 'X' }, // no message
        { fromId: 1, fromName: 'X', message: 'bad id' },
        { fromId: 'x', fromName: null, message: 'bad name' },
        { fromId: 'x', fromName: 'X', message: { text: 'nested' } },
        { ...msg('b', 'Bramble', 'second'), extra: 'ignored', secret: 'never copied' },
      ],
    };
    expect(agentStateFromRow(row).inbox).toEqual([msg('a', 'Alder', 'first'), msg('b', 'Bramble', 'second')]);
  });

  it('caps an over-long inbox at INBOX_LIMIT, keeping the newest (the engine drops the oldest)', () => {
    const inbox = Array.from({ length: INBOX_LIMIT + 4 }, (_, i) => msg('a', 'Alder', `m${i}`));
    const got = agentStateFromRow({ inbox }).inbox ?? [];
    expect(got.map((m) => m.message)).toEqual(inbox.slice(-INBOX_LIMIT).map((m) => m.message));
    expect(got).toHaveLength(INBOX_LIMIT);
  });

  it('cuts a message longer than the engine allows (200 characters)', () => {
    const got = agentStateFromRow({ inbox: [msg('a', 'Alder', 'x'.repeat(5000))] }).inbox ?? [];
    expect(got[0].message).toHaveLength(200);
  });

  it('what it returns shares nothing with the row it was given', () => {
    const row = { inventory: ['wood'], inbox: [msg('a', 'Alder', 'hi')] };
    const got = agentStateFromRow(row);
    got.inventory.push('stone');
    if (got.inbox) got.inbox[0].message = 'changed';
    expect(row.inventory).toEqual(['wood']);
    expect(row.inbox[0].message).toBe('hi');
  });
});

describe('G3 / R7.5 — cursorPatch and cursorFromRow', () => {
  const roster = ['a', 'b', 'c', 'd'];

  it('round-trips a cursor whose villager is still in the roster', () => {
    for (let i = 0; i < roster.length; i++) {
      const cursor = { lastActorId: roster[i], lastActorIndex: i };
      expect(cursorFromRow(stored(cursorPatch(cursor)), roster)).toEqual(cursor);
    }
  });

  it('a fresh era has a null id and index 0, and reads back as a fresh cursor', () => {
    const fresh = { lastActorId: null, lastActorIndex: 0 };
    expect(cursorPatch(fresh)).toEqual({ last_actor_id: null, last_actor_index: 0 });
    expect(cursorFromRow(cursorPatch(fresh), roster)).toEqual(fresh);
    expect(cursorFromRow({ last_actor_id: null, last_actor_index: null }, roster)).toEqual(fresh);
  });

  it('the villager is trusted over the stored index: a roster that changed meanwhile moves the index with them', () => {
    expect(cursorFromRow({ last_actor_id: 'c', last_actor_index: 0 }, roster)).toEqual({ lastActorId: 'c', lastActorIndex: 2 });
    const next = cursorFromRow({ last_actor_id: 'c', last_actor_index: 0 }, roster);
    expect(roster[pickNextActor(roster, next.lastActorId, next.lastActorIndex)]).toBe('d');
  });

  it('a villager who is gone falls back to the stored index: their successor acts next, wrapping at the end', () => {
    const after = ['a', 'c', 'd']; // b was dismissed
    const c1 = cursorFromRow({ last_actor_id: 'b', last_actor_index: 1 }, after);
    expect(c1.lastActorIndex).toBe(1);
    expect(after[pickNextActor(after, c1.lastActorId, c1.lastActorIndex)]).toBe('c');
    const last = ['a', 'b', 'c']; // d, the last, was dismissed
    const c2 = cursorFromRow({ last_actor_id: 'd', last_actor_index: 3 }, last);
    expect(last[pickNextActor(last, c2.lastActorId, c2.lastActorIndex)]).toBe('a');
  });

  it('an empty roster has no cursor to speak of', () => {
    expect(cursorFromRow({ last_actor_id: 'a', last_actor_index: 2 }, [])).toEqual({ lastActorId: null, lastActorIndex: 0 });
    expect(pickNextActor([], null, 0)).toBe(-1);
  });

  it('a damaged row never throws and reads as a fresh cursor, or falls back to index 0', () => {
    const fresh = { lastActorId: null, lastActorIndex: 0 };
    for (const row of [null, undefined, 3, 'x', [], {}, { last_actor_id: 5 }, { last_actor_id: '' }, { last_actor_id: {}, last_actor_index: 2 }]) {
      expect(() => cursorFromRow(row, roster)).not.toThrow();
      expect(cursorFromRow(row, roster)).toEqual(fresh);
    }
    for (const index of [null, undefined, -3, 1.5, NaN, '2', {}]) {
      expect(cursorFromRow({ last_actor_id: 'gone', last_actor_index: index }, roster)).toEqual({ lastActorId: 'gone', lastActorIndex: 0 });
    }
  });

  it('writes only a non-negative whole index', () => {
    expect(cursorPatch({ lastActorId: 'a', lastActorIndex: -2 }).last_actor_index).toBe(0);
    expect(cursorPatch({ lastActorId: 'a', lastActorIndex: 2.9 }).last_actor_index).toBe(2);
    expect(cursorPatch({ lastActorId: 'a', lastActorIndex: NaN }).last_actor_index).toBe(0);
  });
});

/**
 * A reload, simulated with the real engine. Two copies of one world run the same seeded turns; one is
 * rebuilt from the rows the persistence functions would have written (through a JSON round trip, as the
 * database stores them) and must then stay identical to the one that never reloaded.
 */
interface Run {
  snap: WorldSnapshot;
  cursor: { lastActorId: string | null; lastActorIndex: number };
  chats: number;
  gifts: number;
  gathers: number;
}

function newRun(): Run {
  // the manifest's starting cast, close together so they can reach each other
  const spots = STARTING_VILLAGERS.map((v) => v.pos);
  const agents = spots.slice(0, 3).map((p, i) => mkAgent(`v${i}`, ['Alder', 'Bramble', 'Cedar'][i], p.x, p.y));
  return { snap: mkSnapshot(agents, { wood: 4, food: 4 }), cursor: { lastActorId: null, lastActorIndex: 0 }, chats: 0, gifts: 0, gathers: 0 };
}

/** A seeded action that leans toward the interesting ones: walking up to neighbours, chat, gift, gather, deposit. */
function actionFor(rnd: () => number, snap: WorldSnapshot, agent: AgentState): ActionInput {
  const others = snap.agents.filter((a) => a.id !== agent.id);
  const other = others[Math.floor(rnd() * others.length)];
  const beside = others.filter((o) => Math.max(Math.abs(o.pos.x - agent.pos.x), Math.abs(o.pos.y - agent.pos.y)) <= 1);
  const roll = rnd();
  if (beside.length && agent.inventory.length && roll < 0.4) return { type: 'gift', data: { agent_id: beside[0].id } };
  if (beside.length && roll < 0.6) return { type: 'chat', data: { agent_id: beside[0].id, message: `${agent.name} turn ${Math.floor(rnd() * 1000)}` } };
  if (!beside.length && roll < 0.35) return { type: 'goto', data: { x: other.pos.x + (rnd() < 0.5 ? 1 : -1), y: other.pos.y } };
  if (roll < 0.8) return { type: 'gather_nearest', data: {} };
  if (roll < 0.86) return { type: 'deposit', data: {} };
  if (roll < 0.91) return { type: 'wander', data: {} };
  if (roll < 0.95) return { type: 'eat', data: {} };
  return { type: 'wait', data: {} };
}

/** One turn as the tick loop takes it: next actor by cursor, needs drift, the words heard, one action. */
function playTurn(run: Run, seed: number, turn: number): void {
  const rnd = seededRandom(seed * 7919 + turn);
  vi.spyOn(Math, 'random').mockImplementation(seededRandom(seed * 104729 + turn)); // wander
  const ids = run.snap.agents.map((a) => a.id);
  const idx = pickNextActor(ids, run.cursor.lastActorId, run.cursor.lastActorIndex);
  const agent = run.snap.agents[idx];
  run.cursor = { lastActorId: agent.id, lastActorIndex: idx };
  agent.hunger = Math.min(100, agent.hunger + 4);
  agent.energy = Math.max(0, agent.energy - 3);
  clearInbox(agent); // heard exactly once, before acting
  const action = actionFor(rnd, run.snap, agent);
  const result = step(run.snap, agent.id, action);
  if (result.ok && action.type === 'chat') run.chats++;
  if (result.ok && action.type === 'gift') run.gifts++;
  if (result.ok && (action.type === 'gather_nearest' || action.type === 'gather')) run.gathers++;
  agent.mood = result.ok ? action.type : 'frustrated';
}

/** Everything the database would hold after the last turn, as a JSON round trip. */
function persistRows(run: Run) {
  return {
    agents: run.snap.agents.map((a) => stored({ id: a.id, ...agentStatePatch(a) })),
    session: stored(cursorPatch(run.cursor)),
  };
}

/** The world as loadWorld rebuilds it: only what the rows hold, over villagers that are otherwise as they were. */
function reload(run: Run, rows: ReturnType<typeof persistRows>): Run {
  const agents = rows.agents.map((row) => {
    const old = run.snap.agents.find((a) => a.id === row.id)!;
    return {
      ...mkAgent(old.id, old.name, 0, 0), // name and identity come from other columns
      pos: row.position,
      island: row.island,
      mood: row.mood,
      status: row.status,
      hunger: row.hunger,
      energy: row.energy,
      ...agentStateFromRow(row),
    };
  });
  const snap = { ...stored({ ...run.snap, agents: [] }), agents };
  return { ...run, snap, cursor: cursorFromRow(rows.session, agents.map((a) => a.id)) };
}

/** The reload this fix replaces: position and needs survive, nothing else does. */
function lossyReload(run: Run, rows: ReturnType<typeof persistRows>): Run {
  const back = reload(run, rows);
  back.snap.agents = back.snap.agents.map((a) => ({ ...a, inventory: [], inbox: undefined }));
  return { ...back, cursor: { lastActorId: null, lastActorIndex: 0 } };
}

describe('E1 — a reload in the middle of play changes nothing', () => {
  const RELOAD_AT = 60;

  it.each([1, 2, 3, 4])('seed %i: rebuilt from rows, villagers carry the same, hear the same and act in the same order for 50 more turns', (seed) => {
    const live = newRun();
    for (let t = 0; t < RELOAD_AT; t++) playTurn(live, seed, t);

    // the run is worth reloading: chats, gifts and gathering happened, someone carries something, someone has unread words
    expect(live.chats, 'chats').toBeGreaterThan(0);
    expect(live.gifts, 'gifts').toBeGreaterThan(0);
    expect(live.gathers, 'gathers').toBeGreaterThan(0);

    // find a moment with both a full pair of hands and an unread message, so the reload has something to lose
    let at = RELOAD_AT;
    while (!(live.snap.agents.some((a) => a.inventory.length) && live.snap.agents.some((a) => a.inbox?.length)) && at < RELOAD_AT + 200) {
      playTurn(live, seed, at++);
    }
    expect(live.snap.agents.some((a) => a.inventory.length), 'someone carries something').toBe(true);
    expect(live.snap.agents.some((a) => a.inbox?.length), 'someone has unread chat').toBe(true);

    const rows = persistRows(live);
    const back = reload(live, rows);

    // 1. what each villager carries and has yet to hear, and who acts next, are exactly what they were
    expect(back.snap.agents).toEqual(live.snap.agents);
    expect(back.snap.agents.map((a) => a.inventory)).toEqual(live.snap.agents.map((a) => a.inventory));
    expect(back.snap.agents.map((a) => a.inbox)).toEqual(live.snap.agents.map((a) => a.inbox));
    const ids = live.snap.agents.map((a) => a.id);
    expect(pickNextActor(ids, back.cursor.lastActorId, back.cursor.lastActorIndex)).toBe(
      pickNextActor(ids, live.cursor.lastActorId, live.cursor.lastActorIndex)
    );
    expect(back.cursor).toEqual(live.cursor);

    // 2. nothing in the rebuilt world is the live world's object
    expect(back.snap.agents[0]).not.toBe(live.snap.agents[0]);
    expect(back.snap.agents[0].inventory).not.toBe(live.snap.agents[0].inventory);

    // 3. the two worlds stay identical, turn for turn, for 50 more turns
    for (let t = 0; t < 50; t++) {
      playTurn(live, seed, at + t);
      playTurn(back, seed, at + t);
      expect(back.cursor, `cursor after turn ${t}`).toEqual(live.cursor);
      expect(back.snap, `world after turn ${t}`).toEqual(live.snap);
    }
    expect([back.chats, back.gifts, back.gathers]).toEqual([live.chats, live.gifts, live.gathers]);
  });

  it('a reload after every single turn is just as invisible', () => {
    const seed = 9;
    const straight = newRun();
    let hopping = newRun();
    for (let t = 0; t < 120; t++) {
      playTurn(straight, seed, t);
      playTurn(hopping, seed, t);
      hopping = reload(hopping, persistRows(hopping));
      expect(hopping.snap, `turn ${t}`).toEqual(straight.snap);
      expect(hopping.cursor, `turn ${t}`).toEqual(straight.cursor);
    }
  });

  it('the old reload (empty hands, unread chat forgotten, rotation restarted) does diverge, so the test can tell', () => {
    const seed = 1;
    const live = newRun();
    let at = 0;
    for (; at < 60; at++) playTurn(live, seed, at);
    while (!(live.snap.agents.some((a) => a.inventory.length) && live.snap.agents.some((a) => a.inbox?.length)) && at < 400) {
      playTurn(live, seed, at++);
    }
    const lossy = lossyReload(live, persistRows(live));
    expect(lossy.snap.agents).not.toEqual(live.snap.agents);
    let diverged = false;
    for (let t = 0; t < 50 && !diverged; t++) {
      playTurn(live, seed, at + t);
      playTurn(lossy, seed, at + t);
      diverged = JSON.stringify(lossy.snap) !== JSON.stringify(live.snap);
    }
    expect(diverged).toBe(true);
  });

  it('a villager dismissed while the page was closed hands the turn to their successor, with the others untouched', () => {
    const seed = 5;
    const live = newRun();
    for (let t = 0; t < 40; t++) playTurn(live, seed, t);
    const rows = persistRows(live);
    const gone = live.cursor.lastActorId!;
    rows.agents = rows.agents.filter((r) => r.id !== gone);
    const back = reload(
      { ...live, snap: { ...live.snap, agents: live.snap.agents.filter((a) => a.id !== gone) } },
      rows
    );
    const ids = back.snap.agents.map((a) => a.id);
    const next = pickNextActor(ids, back.cursor.lastActorId, back.cursor.lastActorIndex);
    expect(next).toBe(live.cursor.lastActorIndex % ids.length);
    for (const a of back.snap.agents) {
      const was = live.snap.agents.find((x) => x.id === a.id)!;
      expect(a.inventory).toEqual(was.inventory);
      expect(a.inbox).toEqual(was.inbox);
    }
  });
});

describe('E1 — simulation.ts goes through persisted.ts', () => {
  const source = readFileSync(new URL('../simulation.ts', import.meta.url), 'utf8');
  const body = (name: string): string => {
    const start = source.indexOf(`private async ${name}(`);
    expect(start, `${name} exists`).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf('\n  }\n', start));
  };

  it('writes the turn row with agentStatePatch and the cursor with cursorPatch, and no longer writes needs on their own', () => {
    expect(body('persistTurn')).toContain('agentStatePatch(agent)');
    expect(body('persistCursor')).toContain('cursorPatch(');
    expect(source).not.toContain('persistNeeds');
    expect(source).not.toContain('updateAgentRow');
  });

  it('writes nothing for the lease holder it is not: the cursor and the carried-state writes both stop when read-only', () => {
    expect(body('persistCursor')).toMatch(/if \(this\.readOnly[^)]*\) return/);
    expect(body('persistCarried')).toMatch(/if \(this\.readOnly\) return/);
  });

  it('saves what a gift or a chat changed on the other villager, with carriedPatch', () => {
    expect(body('persistCarried')).toContain('carriedPatch(a)');
    expect(body('executeAction')).toMatch(/result\.chat\?\.withId \?\? result\.gift\?\.withId/);
    expect(body('executeAction')).toContain('this.persistCarried(');
  });

  it('reads inventory, inbox and the cursor back in loadWorld, through the defensive parsers', () => {
    const load = body('loadWorld');
    expect(load).toContain('agentStateFromRow(row)');
    expect(load).toContain("'last_actor_id, last_actor_index'");
    expect(load).toContain('cursorFromRow(');
  });

  it('gives a fork its checkpoint inventory, inbox and cursor, and every other insert explicit empty values', () => {
    const fork = body('forkEra');
    expect(fork).toContain('inventory: carriedPatch(a).inventory');
    expect(fork).toContain('cursorPatch(world.cursor)');
    expect(fork).toContain("update({ inbox: carriedPatch(a).inbox })");
    expect(source.match(/inventory: \[\],\s+inbox: \[\],/g)).toHaveLength(2); // new villager, starting villagers
  });
});
