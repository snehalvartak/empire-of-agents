import { describe, expect, it } from 'vitest';
import { BOND_DELTA, applyBondDelta, bondExchange, createBondWriter, pairRowFor, recordBond } from '../bonds.ts';
import type { BondMap, PairRow, RecordBondDeps } from '../bonds.ts';
import { step } from '../world.ts';
import type { ActionInput, WorldSnapshot } from '../world.ts';
import { mkAgent, mkSnapshot } from './fixtures.ts';

/**
 * G1 / SPEC R7.1 + section 4 social + section 7 Bonds: chat deepens both bonds by exactly 1, a gift
 * by exactly 2, on both sides, and nobody else's bond moves. The villagers act through the real
 * engine `step()`; the bond bookkeeping is the same `recordBond` path the simulation uses, with the
 * database replaced by a list of the rows it would have been asked to write.
 */

const A = { id: 'a-0000', name: 'Alder' };
const B = { id: 'b-0000', name: 'Bramble' };
const C = { id: 'c-0000', name: 'Cedar' };

function world() {
  const snap = mkSnapshot([
    mkAgent(A.id, A.name, 4, 4, ['wood', 'stone']),
    mkAgent(B.id, B.name, 5, 4, ['food']),
    mkAgent(C.id, C.name, 6, 4),
  ]);
  const rels = new Map<string, BondMap>();
  const written: PairRow[] = [];
  const writer = createBondWriter(async (row) => {
    written.push(row);
  });
  const deps: RecordBondDeps = {
    relsOf: (id) => {
      let m = rels.get(id);
      if (!m) rels.set(id, (m = new Map()));
      return m;
    },
    writer,
    sessionId: 'era-1',
    nowIso: () => '2026-01-01T00:00:00.000Z',
  };
  /** A villager acts; if the world answers with a chat or a gift, the bond is recorded as the simulation does. */
  async function act(snapshot: WorldSnapshot, actorId: string, action: ActionInput) {
    const result = step(snapshot, actorId, action);
    const exchange = bondExchange(result);
    if (exchange) {
      const actor = snapshot.agents.find((x) => x.id === actorId)!;
      const target = snapshot.agents.find((x) => x.id === exchange.withId)!;
      await recordBond(deps, actor, target, exchange.delta, exchange.lastMessage);
    }
    return { result, exchange };
  }
  const strength = (from: { id: string }, withName: string) => deps.relsOf(from.id).get(withName)?.strength;
  const last = (from: { id: string }, withName: string) => deps.relsOf(from.id).get(withName)?.lastMessage;
  return { snap, deps, written, act, strength, last };
}

const chat = (to: { id: string }, message = 'Good morning.'): ActionInput => ({ type: 'chat', data: { agent_id: to.id, message } });
const gift = (to: { id: string }, item?: string): ActionInput => ({ type: 'gift', data: { agent_id: to.id, ...(item ? { item } : {}) } });

describe('G1 / R7.1 — chat deepens both bonds by exactly 1', () => {
  it('G1: the rule is +1 for a chat and +2 for a gift', () => {
    expect(BOND_DELTA).toEqual({ chat: 1, gift: 2 });
  });

  it('G1: one chat from Alder to Bramble: +1 on Alder\'s side and +1 on Bramble\'s side', async () => {
    const w = world();
    const { exchange } = await w.act(w.snap, A.id, chat(B));
    expect(exchange?.delta).toBe(1);
    expect(w.strength(A, 'Bramble')).toBe(1);
    expect(w.strength(B, 'Alder')).toBe(1);
  });

  it('G1: it does not matter who speaks — Bramble chatting to Alder is the same +1/+1', async () => {
    const w = world();
    await w.act(w.snap, B.id, chat(A));
    expect([w.strength(A, 'Bramble'), w.strength(B, 'Alder')]).toEqual([1, 1]);
  });

  it('G1: a chat keeps the spoken words as the last exchange on both sides', async () => {
    const w = world();
    await w.act(w.snap, A.id, chat(B, 'Fine weather for felling trees.'));
    expect(w.last(A, 'Bramble')).toBe('Fine weather for felling trees.');
    expect(w.last(B, 'Alder')).toBe('Fine weather for felling trees.');
  });
});

describe('G1 / R7.1 — a gift deepens both bonds by exactly 2', () => {
  it('G1: one gift from Alder to Bramble: +2 on each side (not +1: a gift is worth twice a chat)', async () => {
    const w = world();
    const { result, exchange } = await w.act(w.snap, A.id, gift(B, 'wood'));
    expect(result.ok).toBe(true);
    expect(exchange?.delta).toBe(2);
    expect(w.strength(A, 'Bramble')).toBe(2);
    expect(w.strength(B, 'Alder')).toBe(2);
  });

  it('G1: the gift is kept as the last exchange — "gave wood" for the giver, "received wood" for the receiver', async () => {
    const w = world();
    await w.act(w.snap, A.id, gift(B, 'wood'));
    expect(w.last(A, 'Bramble')).toBe('gave wood');
    expect(w.last(B, 'Alder')).toBe('received wood');
  });

  it('G1: the item actually moves hands (the transfer and the bond come from the same successful result)', async () => {
    const w = world();
    await w.act(w.snap, A.id, gift(B, 'wood'));
    expect(w.snap.agents.find((a) => a.id === A.id)!.inventory).toEqual(['stone']);
    expect(w.snap.agents.find((a) => a.id === B.id)!.inventory).toEqual(['food', 'wood']);
  });
});

describe('G1 / R7.1 — failed exchanges change nothing, and bonds accumulate', () => {
  it('G1: a chat that fails (too far) and a gift that fails (hands full) leave both bonds untouched', async () => {
    const w = world();
    w.snap.agents[2].pos = { x: 12, y: 4 }; // Cedar far away
    w.snap.agents[1].inventory = ['wood', 'stone']; // Bramble's hands are full
    const far = await w.act(w.snap, A.id, chat(C));
    const full = await w.act(w.snap, A.id, gift(B, 'wood'));
    expect(far.result.ok).toBe(false);
    expect(full.result.ok).toBe(false);
    expect(far.exchange).toBeNull();
    expect(full.exchange).toBeNull();
    expect(w.written).toEqual([]);
    expect(w.strength(A, 'Cedar')).toBeUndefined();
    expect(w.strength(A, 'Bramble')).toBeUndefined();
  });

  it('G1: a bond that is neither a chat nor a gift result is not touched by anything else the engine does', async () => {
    const w = world();
    for (const action of [{ type: 'wait', data: {} }, { type: 'say', data: { message: 'Hear me.' } }, { type: 'move', data: { dx: 0, dy: 1 } }] as ActionInput[]) {
      expect((await w.act(w.snap, A.id, action)).exchange).toBeNull();
    }
    expect(w.written).toEqual([]);
  });

  it('G1: three chats and two gifts, in both directions, add up to 1+1+1+2+2 = 7 on each side', async () => {
    const w = world();
    await w.act(w.snap, A.id, chat(B, 'one'));
    await w.act(w.snap, B.id, chat(A, 'two'));
    await w.act(w.snap, A.id, chat(B, 'three'));
    expect([w.strength(A, 'Bramble'), w.strength(B, 'Alder')]).toEqual([3, 3]);
    expect((await w.act(w.snap, A.id, gift(B, 'wood'))).result.ok).toBe(true);
    expect((await w.act(w.snap, B.id, gift(A, 'food'))).result.ok).toBe(true);
    expect([w.strength(A, 'Bramble'), w.strength(B, 'Alder')]).toEqual([7, 7]);
  });

  it('G1: the two sides stay equal after every single exchange of a long mixed run', async () => {
    const w = world();
    let expected = 0;
    for (let i = 0; i < 40; i++) {
      const giver = i % 3 === 0 ? B : A;
      const taker = giver === A ? B : A;
      const isGift = i % 4 === 3;
      // keep hands usable so gifts succeed
      w.snap.agents.find((x) => x.id === giver.id)!.inventory = ['wood'];
      w.snap.agents.find((x) => x.id === taker.id)!.inventory = [];
      const { exchange } = await w.act(w.snap, giver.id, isGift ? gift(taker, 'wood') : chat(taker, `m${i}`));
      expected += exchange!.delta;
      expect(w.strength(A, 'Bramble'), `after exchange ${i}`).toBe(expected);
      expect(w.strength(B, 'Alder'), `after exchange ${i}`).toBe(expected);
    }
  });
});

describe('G1 / R7.1 — nobody else\'s bond moves', () => {
  it('G1: a third villager\'s bonds are untouched, and so are Alder\'s and Bramble\'s bonds with that third villager', async () => {
    const w = world();
    // an earlier bond with Cedar, and Cedar\'s own view of it
    w.deps.relsOf(A.id).set('Cedar', { withId: C.id, withName: 'Cedar', strength: 5, lastMessage: 'old' });
    w.deps.relsOf(B.id).set('Cedar', { withId: C.id, withName: 'Cedar', strength: 3, lastMessage: 'older' });
    w.deps.relsOf(C.id).set('Alder', { withId: A.id, withName: 'Alder', strength: 5, lastMessage: 'old' });
    w.deps.relsOf(C.id).set('Bramble', { withId: B.id, withName: 'Bramble', strength: 3, lastMessage: 'older' });
    const before = JSON.stringify([...w.deps.relsOf(C.id)]);

    w.snap.agents[0].inventory = []; // room for Bramble's gift
    await w.act(w.snap, A.id, chat(B));
    expect((await w.act(w.snap, B.id, gift(A, 'food'))).result.ok).toBe(true);

    expect(JSON.stringify([...w.deps.relsOf(C.id)])).toBe(before);
    expect(w.strength(A, 'Cedar')).toBe(5);
    expect(w.strength(B, 'Cedar')).toBe(3);
    expect(w.last(A, 'Cedar')).toBe('old');
    expect(w.strength(A, 'Bramble')).toBe(3); // 1 + 2
  });

  it('G1: applyBondDelta touches only the two maps it is given and returns the two new sides, actor first', () => {
    const relsA: BondMap = new Map();
    const relsB: BondMap = new Map();
    const [sideA, sideB] = applyBondDelta(relsA, relsB, A, B, 2, { a: 'gave gold', b: 'received gold' });
    expect(sideA.self).toEqual(A);
    expect(sideB.self).toEqual(B);
    expect(sideA.bond).toEqual({ withId: B.id, withName: 'Bramble', strength: 2, lastMessage: 'gave gold' });
    expect(sideB.bond).toEqual({ withId: A.id, withName: 'Alder', strength: 2, lastMessage: 'received gold' });
    expect([sideA.created, sideB.created]).toEqual([true, true]);
    expect([...relsA.keys()]).toEqual(['Bramble']);
    expect([...relsB.keys()]).toEqual(['Alder']);
  });

  it('G1: an existing bond is deepened in place, and a bond that had a different strength on each side moves each by the same delta', () => {
    const relsA: BondMap = new Map([['Bramble', { withId: B.id, withName: 'Bramble', strength: 4, lastMessage: 'x' }]]);
    const relsB: BondMap = new Map([['Alder', { withId: A.id, withName: 'Alder', strength: 9, lastMessage: 'y' }]]);
    const [sideA, sideB] = applyBondDelta(relsA, relsB, A, B, 1, 'hello');
    expect([sideA.bond.strength, sideB.bond.strength]).toEqual([5, 10]);
    expect([sideA.created, sideB.created]).toEqual([false, false]);
    expect([relsA.get('Bramble')!.lastMessage, relsB.get('Alder')!.lastMessage]).toEqual(['hello', 'hello']);
  });
});

describe('G1 / R7.1 — what is written to the database is the pair row, once per side', () => {
  it('G1: each exchange writes the same sorted pair row for both sides, carrying the era and the new strength', async () => {
    const w = world();
    await w.act(w.snap, B.id, chat(A));
    w.snap.agents[0].inventory = []; // room for the gift
    expect((await w.act(w.snap, B.id, gift(A, 'food'))).result.ok).toBe(true);
    expect(w.written.map((r) => [r.a_id, r.b_id, r.strength, r.session_id])).toEqual([
      ['a-0000', 'b-0000', 1, 'era-1'],
      ['a-0000', 'b-0000', 1, 'era-1'],
      ['a-0000', 'b-0000', 3, 'era-1'],
      ['a-0000', 'b-0000', 3, 'era-1'],
    ]);
  });

  it('G1: a first bond carries no last_chat_at, a deepened one does (as the database rows always did)', () => {
    const [created] = applyBondDelta(new Map(), new Map(), A, B, 1, 'hi');
    expect(pairRowFor(created, null, 'T')).not.toHaveProperty('last_chat_at');
    const relsA: BondMap = new Map([['Bramble', { withId: B.id, withName: 'Bramble', strength: 1, lastMessage: null }]]);
    const [existing] = applyBondDelta(relsA, new Map(), A, B, 1, 'hi');
    expect(pairRowFor(existing, null, 'T').last_chat_at).toBe('T');
  });
});

describe('G1 — simulation.ts goes through bonds.ts', () => {
  it('G1: both the chat and the gift branch record the bond through bondExchange / recordBond, with no +1 of their own', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../simulation.ts', import.meta.url), 'utf8');
    expect(source).toContain("from './bonds'");
    expect(source.match(/bondExchange\(result\)/g)?.length).toBe(2); // chat and gift
    expect(source).not.toMatch(/strength \+= /);
    expect(source).not.toContain('bumpRelationship');
  });
});
