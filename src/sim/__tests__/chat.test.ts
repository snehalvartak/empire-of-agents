import { describe, expect, it } from 'vitest';
import { INBOX_LIMIT, clearInbox, findVillager, observe, step } from '../world.ts';
import type { AgentState, WorldSnapshot } from '../world.ts';
import { mkAgent, mkSnapshot } from './fixtures.ts';

function trio(): { snap: WorldSnapshot; a: AgentState; b: AgentState; c: AgentState } {
  const [a, b, c] = [mkAgent('a', 'Alder', 6, 7), mkAgent('b', 'Bramble', 7, 7), mkAgent('c', 'Cedar', 8, 7)];
  return { snap: mkSnapshot([a, b, c]), a, b, c };
}
const chat = (snap: WorldSnapshot, from: string, to: string, message: string) =>
  step(snap, from, { type: 'chat', data: { agent_id: to, message } });
/** What the simulation does for a villager's turn: observe, think, then mark the inbox heard. */
function takeTurn(snap: WorldSnapshot, agent: AgentState): string {
  const observation = observe(snap, agent, []);
  clearInbox(agent, snap.agents.find((x) => x.id === agent.id));
  return observation;
}

describe('G4 / R7.4 — chat delivery', () => {
  it('G4: a chat shows in the target\'s next observation and not the one after', () => {
    const { snap, b } = trio();
    expect(chat(snap, 'a', 'b', 'hello there').ok).toBe(true);
    const first = takeTurn(snap, b);
    expect(first).toContain('Words spoken to you since your last turn');
    expect(first).toContain('- Alder says: "hello there"');
    const second = takeTurn(snap, b);
    expect(second).not.toContain('hello there');
    expect(second).not.toContain('Words spoken to you');
  });

  it('G4: messages arrive oldest first, from named senders', () => {
    const { snap, b } = trio();
    chat(snap, 'a', 'b', 'first');
    chat(snap, 'c', 'b', 'second');
    const obs = observe(snap, b, []);
    expect(obs.indexOf('- Alder says: "first"')).toBeGreaterThan(-1);
    expect(obs.indexOf('- Cedar says: "second"')).toBeGreaterThan(obs.indexOf('- Alder says: "first"'));
  });

  it('G4: a message is never visible to anyone but its target (R7.2)', () => {
    const { snap, a, b, c } = trio();
    chat(snap, 'a', 'b', 'a private word');
    expect(observe(snap, a, [])).not.toContain('a private word');
    expect(observe(snap, c, [])).not.toContain('a private word');
    expect(observe(snap, b, [])).toContain('a private word');
    expect(a.inbox).toBeUndefined();
    expect(c.inbox).toBeUndefined();
  });

  it('G4: a chat to someone who is not beside you is refused and delivers nothing', () => {
    const { snap, b } = trio();
    snap.agents[0].pos = { x: 1, y: 1 };
    const result = chat(snap, 'a', 'b', 'can you hear me');
    expect(result.ok).toBe(false);
    expect(b.inbox).toBeUndefined();
    expect(observe(snap, b, [])).not.toContain('can you hear me');
  });

  it('G4: a chat to yourself or to nobody is refused', () => {
    const { snap, a } = trio();
    expect(chat(snap, 'a', 'a', 'me').ok).toBe(false);
    expect(chat(snap, 'a', 'nobody', 'who').ok).toBe(false);
    expect(a.inbox).toBeUndefined();
  });

  it('G4: an inbox snapshot taken before the clear is not changed by it', () => {
    const { snap, b } = trio();
    chat(snap, 'a', 'b', 'kept in history');
    const frozen = { ...b, inbox: b.inbox?.map((m) => ({ ...m })) };
    clearInbox(b);
    expect(b.inbox).toBeUndefined();
    expect(frozen.inbox).toHaveLength(1);
  });

  it('G4: clearInbox clears every villager it is given and ignores missing ones', () => {
    const { snap, b, c } = trio();
    chat(snap, 'a', 'b', 'x');
    chat(snap, 'a', 'c', 'y');
    clearInbox(b, undefined, c);
    expect(b.inbox).toBeUndefined();
    expect(c.inbox).toBeUndefined();
  });
});

describe('R7.4 — inbox cap', () => {
  it('G4: only INBOX_LIMIT (3) messages are kept; the oldest is dropped and the drop is reported', () => {
    const { snap, b } = trio();
    expect(INBOX_LIMIT).toBe(3);
    for (const m of ['m1', 'm2', 'm3']) expect(chat(snap, 'a', 'b', m).chat?.dropped).toBeUndefined();
    const fourth = chat(snap, 'a', 'b', 'm4');
    expect(b.inbox?.map((m) => m.message)).toEqual(['m2', 'm3', 'm4']);
    expect(fourth.chat?.dropped).toEqual({ fromName: 'Alder', message: 'm1' });
    const obs = observe(snap, b, []);
    expect(obs).not.toContain('"m1"');
    for (const m of ['m2', 'm3', 'm4']) expect(obs).toContain(`"${m}"`);
  });

  it('G4: the inbox array is replaced, never mutated, so earlier references stay frozen', () => {
    const { snap, b } = trio();
    for (const m of ['m1', 'm2', 'm3']) chat(snap, 'a', 'b', m);
    const before = b.inbox;
    chat(snap, 'c', 'b', 'm4');
    expect(b.inbox).not.toBe(before);
    expect(before?.map((m) => m.message)).toEqual(['m1', 'm2', 'm3']);
  });

  it('G4: a message is cut to 200 characters and its whitespace flattened in the observation', () => {
    const { snap, b } = trio();
    chat(snap, 'a', 'b', `line one\nline two ${'x'.repeat(300)}`);
    expect(b.inbox?.[0].message).toHaveLength(200);
    expect(observe(snap, b, [])).toContain('line one line two');
  });
});

describe('R7.4 — villagers are addressed by the id they were shown', () => {
  const longId = '3f2a9c1e-7b64-4d0a-9e51-0c8d2b7a6f10';

  it('chat and gift accept the 8-character id printed in the observation', () => {
    const a = mkAgent('a', 'Alder', 5, 5, ['wood']);
    const b = mkAgent(longId, 'Bramble', 6, 5);
    const snap = mkSnapshot([a, b]);
    expect(observe(snap, a, [])).toContain(`Bramble (${longId.slice(0, 8)})`);

    const chat = step(snap, 'a', { type: 'chat', data: { agent_id: longId.slice(0, 8), message: 'Well met.' } });
    expect(chat.ok).toBe(true);
    const gift = step(snap, 'a', { type: 'gift', data: { agent_id: longId.slice(0, 8), item: 'wood' } });
    expect(gift.ok).toBe(true);
  });

  it('also accepts the full id and the villager name, but not an ambiguous or unknown reference', () => {
    const a = mkAgent('a', 'Alder', 5, 5);
    const b = mkAgent(longId, 'Bramble', 6, 5);
    const c = mkAgent(longId.replace('3f2a', '3f2b'), 'Cedar', 4, 5);
    const snap = mkSnapshot([a, b, c]);
    expect(findVillager(snap, longId)?.name).toBe('Bramble');
    expect(findVillager(snap, 'bramble')?.name).toBe('Bramble');
    expect(findVillager(snap, '3f2')).toBeUndefined();
    expect(findVillager(snap, '')).toBeUndefined();
    expect(findVillager(snap, 'nobody')).toBeUndefined();
  });
});
