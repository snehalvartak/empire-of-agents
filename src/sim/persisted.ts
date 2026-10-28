import { INBOX_LIMIT } from './world.ts';
import type { AgentState } from './world.ts';
import type { TurnCursor } from './checkpoint.ts';

/**
 * What survives a page reload (SPEC sections 7 and 9): the columns of `agents` and `sessions` that
 * hold a villager's carried items, their unheard chat and the turn cursor, as pure functions.
 * The simulation writes `agentStatePatch(...)` / `carriedPatch(...)` / `cursorPatch(...)` and reads
 * rows back through `agentStateFromRow(...)` / `cursorFromRow(...)`. No database, no clock.
 *
 * Reading never trusts the row: a column that is missing, null or of the wrong type means "nothing"
 * and a malformed entry is dropped, so a damaged row can never stop the world from loading.
 */

export type InboxMessage = NonNullable<AgentState['inbox']>[number];

/** Most items a stored inventory may hold; the engine never lets a villager carry more than 3. */
export const INVENTORY_CAP = 8;
/** The engine cuts a chat message at 200 characters (world.ts), so a stored one is cut there too. */
const MESSAGE_MAX = 200;

/** `agents.inventory` and `agents.inbox`: the state other villagers can change on their own turn. */
export interface CarriedColumns {
  inventory: string[];
  inbox: InboxMessage[];
}

/** Every `agents` column written after a turn. */
export interface AgentStatePatch extends CarriedColumns {
  position: { x: number; y: number };
  island: AgentState['island'];
  mood: string;
  status: string;
  hunger: number;
  energy: number;
}

/** What a villager carries and has not yet heard, as the columns store it. */
export function carriedPatch(agent: AgentState): CarriedColumns {
  return {
    inventory: [...agent.inventory],
    inbox: (agent.inbox ?? []).map((m) => ({ fromId: m.fromId, fromName: m.fromName, message: m.message })),
  };
}

/** The whole row update after a villager's turn: where they are, how they feel, what they carry and have yet to hear. */
export function agentStatePatch(agent: AgentState): AgentStatePatch {
  return {
    position: { x: agent.pos.x, y: agent.pos.y },
    island: agent.island,
    mood: agent.mood,
    status: agent.status,
    hunger: Math.round(agent.hunger),
    energy: Math.round(agent.energy),
    ...carriedPatch(agent),
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The carried state of a stored `agents` row. Inventory keeps its string items (at most INVENTORY_CAP).
 * The inbox keeps well-formed messages, drops the rest, and keeps the newest INBOX_LIMIT, as the engine
 * does. An empty inbox is `undefined`, the engine's "nothing pending". Never throws.
 */
export function agentStateFromRow(row: unknown): { inventory: string[]; inbox: InboxMessage[] | undefined } {
  const r = isObj(row) ? row : {};
  const inventory = Array.isArray(r.inventory)
    ? r.inventory.filter((i): i is string => typeof i === 'string' && i.length > 0).slice(0, INVENTORY_CAP)
    : [];
  const inbox = Array.isArray(r.inbox)
    ? r.inbox
        .filter(
          (m): m is Record<string, string> =>
            isObj(m) && typeof m.fromId === 'string' && typeof m.fromName === 'string' && typeof m.message === 'string'
        )
        .map((m) => ({ fromId: m.fromId, fromName: m.fromName, message: m.message.slice(0, MESSAGE_MAX) }))
        .slice(-INBOX_LIMIT)
    : [];
  return { inventory, inbox: inbox.length ? inbox : undefined };
}

/** The `sessions` columns that hold the turn cursor (R7.5). */
export interface CursorColumns {
  last_actor_id: string | null;
  last_actor_index: number;
}

export function cursorPatch(cursor: TurnCursor): CursorColumns {
  return { last_actor_id: cursor.lastActorId, last_actor_index: Math.max(0, Math.trunc(cursor.lastActorIndex) || 0) };
}

/**
 * The turn cursor of a stored `sessions` row, checked against the roster it will be used with
 * (`rosterIds`, in join order). Nothing stored, a damaged id or an empty roster is a fresh cursor.
 * A stored id still in the roster wins and the index is brought in line with where they stand now.
 * An id no longer in the roster (dismissed meanwhile) is kept with its stored index, which is exactly
 * what `pickNextActor` needs to hand the turn to that villager's successor. Never throws.
 */
export function cursorFromRow(row: unknown, rosterIds: string[]): TurnCursor {
  const fresh: TurnCursor = { lastActorId: null, lastActorIndex: 0 };
  const r = isObj(row) ? row : {};
  if (rosterIds.length === 0 || typeof r.last_actor_id !== 'string' || r.last_actor_id === '') return fresh;
  const at = rosterIds.indexOf(r.last_actor_id);
  if (at >= 0) return { lastActorId: r.last_actor_id, lastActorIndex: at };
  const stored = r.last_actor_index;
  return {
    lastActorId: r.last_actor_id,
    lastActorIndex: typeof stored === 'number' && Number.isInteger(stored) && stored >= 0 ? stored : 0,
  };
}
