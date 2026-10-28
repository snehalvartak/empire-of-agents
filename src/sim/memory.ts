import type { ActionInput } from './world.ts';

/**
 * Villager memory, pure (SPEC section 8): which stored rows a villager may see and how they are
 * layered into the mind. No database, no clock. `simulation.ts` fetches rows and calls this.
 *
 * Every memory row is stamped with the era (`session_id`) and the world tick it was written at.
 * Inheritance only reads rows written before the new era's starting point, so a restored or
 * forked era never inherits what its own future would have written (section 9).
 */

export interface MemoryRow {
  id?: string;
  content: string;
  /** 'semantic' (knowledge), 'discovery' (shared by the whole empire) or 'episodic' (diary). */
  kind: string;
  agent_id: string;
  /** Era the row was written in; null only for legacy rows. */
  session_id: string | null;
  /** World tick it was written at (see `memoryTick`); null for rows written before ticks were stamped. */
  tick: number | null;
  created_at?: string | null;
}

/** Most rows layered into a mind: the latest this many that the villager may see. */
export const MEMORY_WINDOW = 30;
export const KNOWLEDGE_LIMIT = 6;
export const DISCOVERY_LIMIT = 6;
export const DIARY_LIMIT = 8;

/**
 * Where an era stands in history, which decides what its villagers may inherit.
 * - normal era: `fork` is absent. Everything written before it begins is visible (all earlier eras
 *   and legacy unstamped rows), plus its own rows.
 * - fork: the world is the parent era as it was at `fork_tick`, so only the parent's rows with
 *   tick <= fork tick are visible (and, recursively, its ancestors' rows up to *their* fork ticks),
 *   plus the eras that came before the oldest ancestor. Later rows of the parent, and eras
 *   that are not in the fork's line, are invisible.
 * - amnesiac (`carryMemories` false): nothing from before the era's own start. A fork of an
 *   amnesiac era still sees the line it was forked from (that is what "continued" means), but not
 *   the eras before that line began.
 * Rows of the era's own are always visible.
 */
export interface EraScope {
  sessionId: string;
  carryMemories: boolean;
  fork?: {
    /** Parent first, then its parent, and so on: each with the last tick of it that this line includes. */
    ancestors: Array<{ sessionId: string; maxTick: number }>;
    /** Eras wholly before the oldest ancestor. */
    earlierSessionIds: string[];
  };
}

export function isVisible(row: Pick<MemoryRow, 'session_id' | 'tick'>, scope: EraScope): boolean {
  if (row.session_id === scope.sessionId) return true;
  const fork = scope.fork;
  if (!fork) return scope.carryMemories; // a normal new era inherits everything before it, legacy rows included
  if (row.session_id === null) return scope.carryMemories; // legacy rows are earlier-era history
  const ancestor = fork.ancestors.find((a) => a.sessionId === row.session_id);
  if (ancestor) return row.tick === null || row.tick <= ancestor.maxTick;
  return scope.carryMemories && fork.earlierSessionIds.includes(row.session_id);
}

const SAFE_ID = /^[A-Za-z0-9-]+$/;
function safeId(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error('Era ids may only contain letters, digits and hyphens.');
  return id;
}

/**
 * The same rule as `isVisible`, as one PostgREST `.or(...)` filter so the database does the cut
 * before its row limit (a fork's parent may hold thousands of later rows). Null means "no
 * restriction" (a normal carrying era).
 */
export function visibilityFilter(scope: EraScope): string | null {
  const parts = [`session_id.eq.${safeId(scope.sessionId)}`];
  const fork = scope.fork;
  if (!fork) return scope.carryMemories ? null : parts[0];
  if (scope.carryMemories) {
    parts.push('session_id.is.null');
    if (fork.earlierSessionIds.length) parts.push(`session_id.in.(${fork.earlierSessionIds.map(safeId).join(',')})`);
  }
  for (const a of fork.ancestors) {
    parts.push(`and(session_id.eq.${safeId(a.sessionId)},or(tick.is.null,tick.lte.${Math.floor(a.maxTick)}))`);
  }
  return parts.join(',');
}

export interface EraRow {
  id: string;
  seq: number;
  parent_session_id?: string | null;
  fork_tick?: number | null;
  carry_memories: boolean;
}

/** The scope of era `sessionId` among all eras: normal, or a fork with its line of ancestors. */
export function eraScopeFor(eras: EraRow[], sessionId: string): EraScope | null {
  const byId = new Map(eras.map((e) => [e.id, e] as const));
  const era = byId.get(sessionId);
  if (!era) return null;
  const scope: EraScope = { sessionId, carryMemories: era.carry_memories };
  if (!era.parent_session_id || era.fork_tick == null) return scope;
  const ancestors: Array<{ sessionId: string; maxTick: number }> = [];
  const line = new Set([sessionId]);
  let cur: EraRow = era;
  while (cur.parent_session_id && cur.fork_tick != null) {
    const parent = byId.get(cur.parent_session_id);
    if (!parent || line.has(parent.id)) break;
    ancestors.push({ sessionId: parent.id, maxTick: cur.fork_tick });
    line.add(parent.id);
    cur = parent;
  }
  const earlierSessionIds = eras.filter((e) => e.seq < cur.seq && !line.has(e.id)).map((e) => e.id);
  return { ...scope, fork: { ancestors, earlierSessionIds } };
}

/**
 * The tick a memory written during the turn that starts at world tick `worldTick` is stamped with:
 * the tick the world will show once that turn is done. A checkpoint at tick T is taken after the
 * turn that makes the world read T, so a fork at T sees that turn's memories (stamped T) and not the
 * next turn's (stamped T + 1).
 */
export function memoryTick(worldTick: number): number {
  return worldTick + 1;
}

/**
 * Layers the rows a villager may see into its mind, exactly as the chronicle always has:
 * of the latest 30 visible rows, 6 knowledge, 6 discoveries, 8 diary entries (newest first).
 * Knowledge and diary come from the villager's namesakes (`namesakeIds`, memory is keyed by name
 * across eras); discoveries come from every villager (R5.3). `rows` may be in any order.
 */
export function layerMemories(rows: MemoryRow[], opts: { scope: EraScope; namesakeIds: string[] }): string[] {
  const namesakes = new Set(opts.namesakeIds);
  const seen = new Set<string>();
  const stamped = (r: MemoryRow) => (r.created_at ? Date.parse(r.created_at) : Number.NaN);
  const latest = rows
    .filter((r) => isVisible(r, opts.scope) && (r.kind === 'discovery' || namesakes.has(r.agent_id)))
    .filter((r) => {
      if (!r.id) return true;
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    })
    .sort((a, b) => {
      const x = stamped(a);
      const y = stamped(b);
      return Number.isNaN(x) || Number.isNaN(y) || x === y ? 0 : y - x; // newest first; stable otherwise
    })
    .slice(0, MEMORY_WINDOW);
  const layer = (kind: string, limit: number, tag: string) =>
    latest.filter((r) => r.kind === kind).slice(0, limit).map((r) => `[${tag}] ${r.content}`);
  return [...layer('semantic', KNOWLEDGE_LIMIT, 'knowledge'), ...layer('discovery', DISCOVERY_LIMIT, 'discovery'), ...layer('episodic', DIARY_LIMIT, 'lately')];
}

/**
 * Actions whose successful result is not auto-diarized, because they already write their own,
 * explicit memory (`remember`, `discover`). A `plan` is unrolled into its steps before anything
 * runs (each step is diarized as itself), and a plan nested in a plan always fails, so no
 * successful `plan` ever reaches the diary either.
 */
export const DIARY_EXCLUDED_ACTIONS: ReadonlyArray<ActionInput['type']> = ['remember', 'discover'];

/** The diary line for one executed step: every successful deed except the excluded ones; failures write nothing. */
export function diaryEntryFor(
  action: { type: ActionInput['type'] },
  result: { ok: boolean; message: string }
): { kind: 'episodic'; content: string } | null {
  if (!result.ok || DIARY_EXCLUDED_ACTIONS.includes(action.type)) return null;
  return { kind: 'episodic', content: result.message.slice(0, 240) };
}
