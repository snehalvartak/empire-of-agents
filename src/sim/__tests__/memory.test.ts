import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DIARY_EXCLUDED_ACTIONS,
  diaryEntryFor,
  eraScopeFor,
  isVisible,
  layerMemories,
  memoryTick,
  visibilityFilter,
} from '../memory.ts';
import type { EraRow, EraScope, MemoryRow } from '../memory.ts';
import { ACTION_TYPES, step } from '../world.ts';
import type { ActionInput } from '../world.ts';
import { REPRESENTATIVE, mkAgent, mkSnapshot } from './fixtures.ts';

let n = 0;
/** A stored row; created_at increases with each call, so later rows are newer. */
function row(kind: MemoryRow['kind'], agent: string, content: string, session: string | null, tick: number | null): MemoryRow {
  n++;
  return { id: `m${n}`, kind, agent_id: agent, content, session_id: session, tick, created_at: new Date(Date.UTC(2026, 9, 27, 12, 0, n)).toISOString() };
}
const newestFirst = (rows: MemoryRow[]) => [...rows].reverse();

const NORMAL: EraScope = { sessionId: 'e2', carryMemories: true };

describe('D1 / R5.3 — a discovery is shared with every villager', () => {
  it('D1: a discover written by Alder is in Bramble\'s layered memories; Alder\'s remember is not', () => {
    // written the way the simulation does: from the engine's own result
    const snap = mkSnapshot([mkAgent('a', 'Alder', 5, 5), mkAgent('b', 'Bramble', 6, 5)]);
    const discovered = step(snap, 'a', { type: 'discover', data: { insight: 'Cubes thrown at the rock multiply.' } });
    const remembered = step(snap, 'a', { type: 'remember', data: { kind: 'semantic', content: 'Alder keeps this to herself.' } });
    const rows = [discovered, remembered].map((r) => row(r.memory!.kind, 'a', r.memory!.content, 'e2', memoryTick(snap.tick)));

    const bramble = layerMemories(newestFirst(rows), { scope: NORMAL, namesakeIds: ['b'] });
    expect(bramble).toContain('[discovery] Cubes thrown at the rock multiply.');
    expect(bramble.join('\n')).not.toContain('keeps this to herself');
    // ...while Alder herself has both
    const alder = layerMemories(newestFirst(rows), { scope: NORMAL, namesakeIds: ['a'] });
    expect(alder).toContain('[knowledge] Alder keeps this to herself.');
    expect(alder).toContain('[discovery] Cubes thrown at the rock multiply.');
  });

  it('D1: nothing of another villager\'s diary or knowledge leaks (R7.2), only discoveries are shared', () => {
    const rows = [
      row('episodic', 'a', 'Alder walked north.', 'e2', 1),
      row('semantic', 'a', 'Alder private lore.', 'e2', 2),
      row('discovery', 'a', 'Shared insight.', 'e2', 3),
    ];
    expect(layerMemories(newestFirst(rows), { scope: NORMAL, namesakeIds: ['b'] })).toEqual(['[discovery] Shared insight.']);
  });

  it('D1: a discovery from a villager of the era is also shared inside an amnesiac era (not across eras)', () => {
    const amnesiac: EraScope = { sessionId: 'e2', carryMemories: false };
    const rows = [row('discovery', 'a', 'Old era insight.', 'e1', 4), row('discovery', 'a2', 'This era insight.', 'e2', 4)];
    expect(layerMemories(newestFirst(rows), { scope: amnesiac, namesakeIds: ['b'] })).toEqual(['[discovery] This era insight.']);
  });
});

describe('D2 / R7.3 — namesakes inherit; amnesiac eras do not; forks see only what was written by the fork tick', () => {
  const history = () => {
    const rows: MemoryRow[] = [];
    for (let i = 1; i <= 8; i++) rows.push(row('semantic', 'alder1', `know ${i}`, 'e1', i));
    for (let i = 1; i <= 8; i++) rows.push(row('discovery', 'alder1', `disc ${i}`, 'e1', 10 + i));
    for (let i = 1; i <= 12; i++) rows.push(row('episodic', 'alder1', `deed ${i}`, 'e1', 20 + i));
    return rows;
  };

  it('D2: a new Alder inherits the previous Alder\'s knowledge, discoveries and diary, capped 6 / 6 / 8', () => {
    const out = layerMemories(newestFirst(history()), { scope: NORMAL, namesakeIds: ['alder1', 'alder2'] });
    // 28 rows are fetched (all within the latest 30); layered: 6 knowledge, 6 discoveries, 8 diary, newest first
    expect(out.filter((l) => l.startsWith('[knowledge]'))).toEqual(['8', '7', '6', '5', '4', '3'].map((i) => `[knowledge] know ${i}`));
    expect(out.filter((l) => l.startsWith('[discovery]'))).toEqual(['8', '7', '6', '5', '4', '3'].map((i) => `[discovery] disc ${i}`));
    expect(out.filter((l) => l.startsWith('[lately]'))).toEqual(['12', '11', '10', '9', '8', '7', '6', '5'].map((i) => `[lately] deed ${i}`));
    expect(out).toHaveLength(20);
    // layer order: knowledge, then discoveries, then the diary
    expect(out.map((l) => l.slice(0, 5))).toEqual([...Array(6).fill('[know'), ...Array(6).fill('[disc'), ...Array(8).fill('[late')]);
  });

  it('D2: only the latest 30 rows are layered, so a long diary crowds out older knowledge', () => {
    const rows = [...history()];
    for (let i = 13; i <= 40; i++) rows.push(row('episodic', 'alder1', `deed ${i}`, 'e1', 20 + i));
    const out = layerMemories(newestFirst(rows), { scope: NORMAL, namesakeIds: ['alder1'] });
    expect(out.filter((l) => l.startsWith('[knowledge]'))).toEqual([]);
    expect(out.filter((l) => l.startsWith('[lately]'))).toHaveLength(8);
  });

  it('D2: an ordinary era is layered exactly as the chronicle always was (reference copy of the old code)', () => {
    // the pre-refactor getMemories layering, verbatim: rows already newest first and capped at 30 by the query
    const legacy = (rows: Array<{ content: string; kind: string }>) => [
      ...rows.filter((r) => r.kind === 'semantic').slice(0, 6).map((r) => `[knowledge] ${r.content}`),
      ...rows.filter((r) => r.kind === 'discovery').slice(0, 6).map((r) => `[discovery] ${r.content}`),
      ...rows.filter((r) => r.kind === 'episodic').slice(0, 8).map((r) => `[lately] ${r.content}`),
    ];
    const kinds = ['semantic', 'episodic', 'episodic', 'discovery', 'episodic', 'semantic', 'episodic'] as const;
    for (const total of [0, 1, 7, 19, 30]) {
      const all = Array.from({ length: total }, (_, i) => row(kinds[i % kinds.length], i % 2 ? 'alder1' : 'alder2', `row ${i}`, i < 10 ? 'e1' : 'e2', i < 3 ? null : i));
      const fetched = newestFirst(all).slice(0, 30);
      expect(layerMemories(fetched, { scope: NORMAL, namesakeIds: ['alder1', 'alder2'] })).toEqual(legacy(fetched));
    }
  });

  it('D2: legacy rows (no era, no tick) count as earlier-era history', () => {
    const rows = [row('semantic', 'alder1', 'from before ticks', null, null), row('episodic', 'alder1', 'in era one', 'e1', null)];
    expect(layerMemories(newestFirst(rows), { scope: NORMAL, namesakeIds: ['alder1'] })).toEqual([
      '[knowledge] from before ticks',
      '[lately] in era one',
    ]);
  });

  it('D2: an amnesiac era inherits nothing from other eras, but sees its own', () => {
    const amnesiac: EraScope = { sessionId: 'e2', carryMemories: false };
    const rows = [...history(), row('episodic', 'alder1', 'legacy', null, null), row('episodic', 'alder2', 'lived this era', 'e2', 3), row('semantic', 'alder2', 'learned this era', 'e2', 4)];
    const out = layerMemories(newestFirst(rows), { scope: amnesiac, namesakeIds: ['alder2'] });
    expect(out).toEqual(['[knowledge] learned this era', '[lately] lived this era']);
    expect(visibilityFilter(amnesiac)).toBe('session_id.eq.e2');
  });

  describe('forks', () => {
    // e1 (seq 2) is the parent; e0 came before it; e2 is an ordinary era after e1 that the fork never lived through
    const eras: EraRow[] = [
      { id: 'e0', seq: 1, carry_memories: true },
      { id: 'e1', seq: 2, carry_memories: true },
      { id: 'e2', seq: 3, carry_memories: true },
      { id: 'e3', seq: 4, carry_memories: true, parent_session_id: 'e1', fork_tick: 50 },
      { id: 'e4', seq: 5, carry_memories: true, parent_session_id: 'e3', fork_tick: 70 },
      { id: 'a3', seq: 6, carry_memories: false, parent_session_id: 'e1', fork_tick: 50 },
    ];
    const rows = () => [
      row('semantic', 'x', 'e0 knowledge', 'e0', 999),
      row('episodic', 'x', 'legacy diary', null, null),
      row('episodic', 'x', 'e1 early', 'e1', 10),
      row('episodic', 'x', 'e1 at fork tick', 'e1', 50),
      row('episodic', 'x', 'e1 after fork tick', 'e1', 51),
      row('episodic', 'x', 'e1 unstamped', 'e1', null),
      row('episodic', 'x', 'e2 sibling', 'e2', 5),
      row('episodic', 'x', 'e3 early', 'e3', 60),
      row('episodic', 'x', 'e3 after e4 fork', 'e3', 80),
    ];
    const seen = (era: string) => {
      const scope = eraScopeFor(eras, era)!;
      return layerMemories(newestFirst([...rows(), row('episodic', 'x', `${era} own`, era, 1000)]), { scope, namesakeIds: ['x'] }).map((l) => l.replace('[lately] ', '').replace('[knowledge] ', ''));
    };

    it('E1: a fork at T inherits the parent\'s rows with tick <= T and none after; earlier eras are all visible', () => {
      const out = seen('e3');
      expect(out).toEqual(expect.arrayContaining(['e0 knowledge', 'legacy diary', 'e1 early', 'e1 at fork tick', 'e1 unstamped', 'e3 own']));
      expect(out).not.toContain('e1 after fork tick');
      expect(out).not.toContain('e2 sibling'); // an era that is not in the fork's line
      expect(out).toContain('e3 early'); // the fork's own rows are always its own
    });

    it('E1: a fork of a fork follows the whole line, each ancestor cut at its own fork tick', () => {
      const out = seen('e4');
      expect(out).toEqual(expect.arrayContaining(['e0 knowledge', 'e1 at fork tick', 'e3 early', 'e4 own']));
      expect(out).not.toContain('e1 after fork tick');
      expect(out).not.toContain('e3 after e4 fork');
      expect(out).not.toContain('e2 sibling');
      expect(eraScopeFor(eras, 'e4')!.fork).toEqual({ ancestors: [{ sessionId: 'e3', maxTick: 70 }, { sessionId: 'e1', maxTick: 50 }], earlierSessionIds: ['e0'] });
    });

    it('E1: a fork of an amnesiac era continues its own line but inherits nothing from before it', () => {
      const out = seen('a3');
      expect(out).toEqual(expect.arrayContaining(['e1 early', 'e1 at fork tick', 'a3 own']));
      expect(out).not.toContain('e0 knowledge');
      expect(out).not.toContain('legacy diary');
      expect(out).not.toContain('e1 after fork tick');
    });

    it('a normal era has no fork; unknown eras give no scope; cycles in bad data cannot loop', () => {
      expect(eraScopeFor(eras, 'e2')).toEqual({ sessionId: 'e2', carryMemories: true });
      expect(eraScopeFor(eras, 'nope')).toBeNull();
      const loop: EraRow[] = [
        { id: 'p', seq: 1, carry_memories: true, parent_session_id: 'q', fork_tick: 1 },
        { id: 'q', seq: 2, carry_memories: true, parent_session_id: 'p', fork_tick: 2 },
      ];
      expect(eraScopeFor(loop, 'q')!.fork!.ancestors).toEqual([{ sessionId: 'p', maxTick: 2 }]);
    });
  });

  it('D2: the memory stamp means "the tick the world reads once the turn is done", so a checkpoint at T includes exactly its own turns', () => {
    // turn k runs at world tick k and leaves the world reading k + 1; a checkpoint at T is taken after the turn that made it read T
    const T = 50;
    const written = Array.from({ length: 60 }, (_, k) => row('episodic', 'x', `turn ${k}`, 'e1', memoryTick(k)));
    const scope = eraScopeFor(
      [{ id: 'e1', seq: 1, carry_memories: true }, { id: 'f', seq: 2, carry_memories: true, parent_session_id: 'e1', fork_tick: T }],
      'f'
    )!;
    const visible = written.filter((r) => isVisible(r, scope)).map((r) => r.content);
    expect(visible).toHaveLength(T);
    expect(visible[0]).toBe('turn 0');
    expect(visible[visible.length - 1]).toBe(`turn ${T - 1}`); // the turn that made the world read T is in; the next turn is not
  });
});

describe('the database-side filter is the same rule as the in-code one', () => {
  /** Evaluates the PostgREST `or` grammar the filter uses: eq / is / lte / in, and(...), or(...). */
  function evaluate(filter: string, r: { session_id: string | null; tick: number | null }): boolean {
    const splitTop = (s: string): string[] => {
      const parts: string[] = [];
      let depth = 0;
      let cur = '';
      for (const ch of s) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) {
          parts.push(cur);
          cur = '';
        } else cur += ch;
      }
      parts.push(cur);
      return parts;
    };
    const one = (term: string): boolean => {
      const group = /^(and|or)\((.*)\)$/.exec(term);
      if (group) {
        const results = splitTop(group[2]).map(one);
        return group[1] === 'and' ? results.every(Boolean) : results.some(Boolean);
      }
      const m = /^(session_id|tick)\.(eq|is|lte|in)\.(.*)$/.exec(term);
      if (!m) throw new Error(`cannot read filter term "${term}"`);
      const [, col, op, rawValue] = m;
      const v = r[col as 'session_id' | 'tick'];
      if (op === 'is') return v === null;
      if (v === null) return false; // SQL: a comparison with NULL is never true
      if (op === 'eq') return String(v) === rawValue;
      if (op === 'lte') return Number(v) <= Number(rawValue);
      return rawValue.slice(1, -1).split(',').includes(String(v));
    };
    return splitTop(filter).some(one);
  }

  const eras: EraRow[] = [
    { id: 'e0', seq: 1, carry_memories: true },
    { id: 'e1', seq: 2, carry_memories: true },
    { id: 'e2', seq: 3, carry_memories: true },
    { id: 'f1', seq: 4, carry_memories: true, parent_session_id: 'e1', fork_tick: 50 },
    { id: 'f2', seq: 5, carry_memories: true, parent_session_id: 'f1', fork_tick: 70 },
    { id: 'am', seq: 6, carry_memories: false, parent_session_id: 'e1', fork_tick: 50 },
    { id: 'am2', seq: 7, carry_memories: false },
  ];
  const sessions = [null, 'e0', 'e1', 'e2', 'f1', 'f2', 'am', 'am2', 'unknown'];
  const ticks = [null, 0, 49, 50, 51, 70, 71, 500];

  for (const id of ['e0', 'e1', 'e2', 'f1', 'f2', 'am', 'am2']) {
    it(`for era ${id}: every combination of era and tick is visible in code exactly when the filter says so`, () => {
      const scope = eraScopeFor(eras, id)!;
      const filter = visibilityFilter(scope);
      for (const session_id of sessions) {
        for (const tick of ticks) {
          const expected = isVisible({ session_id, tick }, scope);
          const actual = filter === null ? true : evaluate(filter, { session_id, tick });
          expect(actual, `${id}: row from ${session_id} at ${tick}`).toBe(expected);
        }
      }
    });
  }

  it('an ordinary carrying era needs no filter; ids that could break out of the filter are refused', () => {
    expect(visibilityFilter({ sessionId: 'e2', carryMemories: true })).toBeNull();
    expect(() => visibilityFilter({ sessionId: 'x),session_id.is.null,(', carryMemories: false })).toThrow();
    expect(() =>
      visibilityFilter({ sessionId: 'ok', carryMemories: true, fork: { ancestors: [{ sessionId: 'a,b', maxTick: 1 }], earlierSessionIds: [] } })
    ).toThrow();
  });
});

describe('D3 — the auto-diary records every successful deed as an episodic memory', () => {
  const EXCLUDED = ['discover', 'remember'];

  it('D3: exactly these action types are not auto-diarized, because they write their own explicit memory', () => {
    expect([...DIARY_EXCLUDED_ACTIONS].sort()).toEqual(EXCLUDED);
    for (const type of EXCLUDED) {
      const result = step(mkSnapshot([mkAgent('a', 'Alder', 5, 5)]), 'a', REPRESENTATIVE[type as keyof typeof REPRESENTATIVE]);
      expect(result.ok).toBe(true);
      expect(result.memory, `${type} writes its own memory`).toBeDefined();
    }
  });

  it('D3: every other action type yields a diary entry when it succeeds, and none when it fails', () => {
    expect(ACTION_TYPES.length).toBeGreaterThan(15);
    for (const type of ACTION_TYPES) {
      const action = { type } as { type: ActionInput['type'] };
      const entry = diaryEntryFor(action, { ok: true, message: `You did ${type}.` });
      if (EXCLUDED.includes(type)) expect(entry, `${type} succeeded`).toBeNull();
      else expect(entry, `${type} succeeded`).toEqual({ kind: 'episodic', content: `You did ${type}.` });
      expect(diaryEntryFor(action, { ok: false, message: `Could not ${type}.` }), `${type} failed`).toBeNull();
    }
  });

  it('D3: with the real engine, every representative action that succeeds is diarized with its own result text', () => {
    let diarized = 0;
    for (const type of ACTION_TYPES) {
      const a = mkAgent('a', 'Alder', 5, 5, ['wood']);
      const b = mkAgent('b', 'Bramble', 6, 5, []);
      const result = step(mkSnapshot([a, b], { food: 3 }), 'a', REPRESENTATIVE[type]);
      const entry = diaryEntryFor({ type }, result);
      if (result.ok && !EXCLUDED.includes(type)) {
        expect(entry, `${type}: ${result.message}`).toEqual({ kind: 'episodic', content: result.message.slice(0, 240) });
        diarized++;
      } else expect(entry, `${type} (ok=${result.ok})`).toBeNull();
    }
    expect(diarized).toBeGreaterThanOrEqual(8);
  });

  it('D3: a plan is never diarized as itself: it is unrolled, and a plan inside a plan fails', () => {
    const nested = step(mkSnapshot([mkAgent('a', 'Alder', 5, 5)]), 'a', { type: 'plan', data: { steps: [] } });
    expect(nested.ok).toBe(false);
    expect(diaryEntryFor({ type: 'plan' }, nested)).toBeNull();
  });

  it('D3: entries are capped at 240 characters, as before', () => {
    expect(diaryEntryFor({ type: 'wait' }, { ok: true, message: 'x'.repeat(500) })!.content).toHaveLength(240);
  });

  it('D3: the simulation writes its diary and stamps every memory through these functions', () => {
    const source = readFileSync(fileURLToPath(new URL('../simulation.ts', import.meta.url)), 'utf8');
    expect(source).toContain('diaryEntryFor(action, result)');
    expect(source).not.toMatch(/kind:\s*'episodic'/);
    expect(source).toContain('tick: memoryTick(this.snapshot.tick)');
    expect(source.match(/from\('memories'\)\s*\.insert/g)).toHaveLength(2); // the explicit memory and the diary: both spread `...stamp`
    expect(source.match(/\.\.\.stamp/g)).toHaveLength(2);
  });
});
