import { checkFingerprint } from './manifest.ts';
import type { AgentState, CivState, GridPos, WorldObject, WorldSnapshot } from './world.ts';

/**
 * World snapshots (SPEC section 9, R9.1, R9.2): "where were we", never "what happened".
 * A checkpoint holds state only. It carries no event history and no memories
 * (those are tick-stamped rows in their own tables), and no wall-clock time (R9.3).
 * Pure: no database, no clock. The simulation writes `buildCheckpoint(...)` to the
 * `checkpoints` table every 50 ticks and reads it back through `restoreCheckpoint`.
 *
 * The top-level `tick / agents / objects / civ / nextId` fields deliberately keep the
 * shape of the older snapshot rows, so the replay scrubber reads old and new rows alike
 * (see `replaySnapshotOf`).
 */

/** Bump when the payload shape changes; older and newer versions are refused, never guessed at. */
export const CHECKPOINT_VERSION = 1;

/** Turn-order cursor (R7.5): who acted last and the roster index they held. */
export interface TurnCursor {
  lastActorId: string | null;
  lastActorIndex: number;
}

/** A natural object taken from the seeded world: a mine (never returns) or an animal (due-tick). */
export interface DepletedEntry {
  id: string;
  respawnTick: number | null;
}

export interface CheckpointBond {
  withId: string;
  withName: string;
  strength: number;
  lastMessage: string | null;
}

/** Everything R9.2 lists for one villager, plus the identity needed to bring them back. */
export interface CheckpointVillager {
  id: string;
  name: string;
  model: string;
  color: string;
  island: string;
  pos: GridPos;
  mood: string;
  persona: string;
  status: string;
  inventory: string[];
  hunger: number;
  energy: number;
  /** Skills. */
  traits: Record<string, { level: number; xp: number }>;
  goals: Array<{ text: string; createdAt: number }>;
  /** Bond strengths with the last exchange text (the era's live values). */
  relationships: CheckpointBond[];
  /** Pending chat messages, oldest first (R7.4). */
  inbox: Array<{ fromId: string; fromName: string; message: string }>;
}

export interface CheckpointV1 {
  version: 1;
  /** Scene fingerprint of the world this was saved in (R6.5). */
  fingerprint: string;
  tick: number;
  nextId: number;
  cursor: TurnCursor;
  civ: CivState;
  /** Every object in the world now: seeds that are still there, built structures and cubes. */
  objects: WorldObject[];
  depleted: DepletedEntry[];
  agents: CheckpointVillager[];
}

/** What a checkpoint is built from: the live world plus the bits the world snapshot does not hold. */
export interface CheckpointState {
  snapshot: WorldSnapshot;
  cursor: TurnCursor;
  depleted: DepletedEntry[];
  fingerprint: string;
}

/** What a successful restore hands back; nothing in it is shared with the payload. */
export interface RestoredWorld {
  snapshot: WorldSnapshot;
  cursor: TurnCursor;
  depleted: DepletedEntry[];
}

export type RestoreResult = ({ ok: true } & RestoredWorld) | { ok: false; message: string };

/** Plain data only (it is stored as jsonb), so a JSON round trip is a complete deep copy. */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function villagerOf(a: AgentState): CheckpointVillager {
  return clone({
    id: a.id,
    name: a.name,
    model: a.model,
    color: a.color,
    island: a.island,
    pos: a.pos,
    mood: a.mood,
    persona: a.persona,
    status: 'idle', // a snapshot is taken between turns; nobody is mid-thought
    inventory: a.inventory,
    hunger: a.hunger,
    energy: a.energy,
    traits: a.traits ?? {},
    goals: a.goals ?? [],
    relationships: (a.relationships ?? []).map((r) => ({
      withId: r.withId,
      withName: r.withName,
      strength: r.strength,
      lastMessage: r.lastMessage,
    })),
    inbox: a.inbox ?? [],
  });
}

export function buildCheckpoint(state: CheckpointState): CheckpointV1 {
  const s = state.snapshot;
  return clone({
    version: CHECKPOINT_VERSION,
    fingerprint: state.fingerprint,
    tick: s.tick,
    nextId: s.nextId,
    cursor: { lastActorId: state.cursor.lastActorId, lastActorIndex: state.cursor.lastActorIndex },
    civ: s.civ,
    objects: s.objects,
    depleted: state.depleted.map((d) => ({ id: d.id, respawnTick: d.respawnTick })),
    agents: s.agents.map(villagerOf),
  } satisfies CheckpointV1);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const UNREADABLE = 'This checkpoint is damaged or incomplete, so it cannot be restored. You can still replay it.';

/**
 * Brings a stored checkpoint back as a world. Refuses, with a plain-language reason and
 * without guessing, when the fingerprint is missing or differs (R6.5, E2), when the format
 * is not the one this build writes, or when the payload is malformed.
 */
export function restoreCheckpoint(payload: unknown, currentFingerprint: string): RestoreResult {
  const stored = isObj(payload) && typeof payload.fingerprint === 'string' ? payload.fingerprint : undefined;
  const fp = checkFingerprint(stored, currentFingerprint);
  if (!fp.ok) return { ok: false, message: fp.message };
  const p = payload as Record<string, unknown>;

  if (!isNum(p.version)) {
    return {
      ok: false,
      message:
        'This checkpoint was saved by an older version of the game that did not record the turn order and pending animal returns, so it cannot be restored exactly. You can still replay it.',
    };
  }
  if (p.version !== CHECKPOINT_VERSION) {
    return {
      ok: false,
      message: `This checkpoint uses save format ${p.version}, but this version of the game reads format ${CHECKPOINT_VERSION}, so it cannot be restored. You can still replay it.`,
    };
  }

  const cursor = p.cursor;
  const civ = p.civ;
  if (
    !isNum(p.tick) || !isNum(p.nextId) ||
    !isObj(cursor) || !isNum(cursor.lastActorIndex) ||
    !(cursor.lastActorId === null || typeof cursor.lastActorId === 'string') ||
    !isObj(civ) || !isNum(civ.wood) || !isNum(civ.food) || !isNum(civ.gold) || !isNum(civ.stone) || !isNum(civ.age) ||
    !Array.isArray(p.objects) || !Array.isArray(p.depleted) || !Array.isArray(p.agents) ||
    !p.agents.every((a) => isObj(a) && typeof a.id === 'string' && typeof a.name === 'string' && isObj(a.pos) && Array.isArray(a.inventory))
  ) {
    return { ok: false, message: UNREADABLE };
  }

  const v = clone(p as unknown as CheckpointV1);
  const agents: AgentState[] = v.agents.map((a) => ({
    ...a,
    inbox: a.inbox.length ? a.inbox : undefined, // an empty inbox is "nothing pending", as in the live engine
  }));
  return {
    ok: true,
    snapshot: { tick: v.tick, agents, objects: v.objects, civ: v.civ, nextId: v.nextId },
    cursor: v.cursor,
    depleted: v.depleted,
  };
}

/**
 * The world a replay row shows, for both the old row shape (`tick/agents/objects/civ`, with or
 * without `fingerprint`) and the current one. Read-only use; returns null if the row has no
 * usable world in it.
 */
export function replaySnapshotOf(payload: unknown): WorldSnapshot | null {
  if (!isObj(payload) || !Array.isArray(payload.agents) || !Array.isArray(payload.objects) || !isObj(payload.civ)) return null;
  return {
    tick: isNum(payload.tick) ? payload.tick : 0,
    agents: payload.agents as AgentState[],
    objects: payload.objects as WorldObject[],
    civ: payload.civ as unknown as CivState,
    nextId: isNum(payload.nextId) ? payload.nextId : 1,
  };
}

/**
 * The same world with its villagers under new ids, in the same order (`newIds[i]` replaces the i-th
 * villager). A fork's villagers are new database rows, so the ids inside bonds, pending messages
 * and the turn cursor follow. Leaves its input untouched.
 */
export function withNewVillagerIds(world: RestoredWorld, newIds: string[]): RestoredWorld {
  const old = world.snapshot.agents;
  if (newIds.length !== old.length) throw new Error('Every villager needs exactly one new id.');
  const map = new Map(old.map((a, i) => [a.id, newIds[i]] as const));
  const re = (id: string) => map.get(id) ?? id;
  const copy = clone(world);
  copy.snapshot.agents = copy.snapshot.agents.map((a) => ({
    ...a,
    id: re(a.id),
    relationships: a.relationships?.map((r) => ({ ...r, withId: re(r.withId) })),
    inbox: a.inbox?.map((m) => ({ ...m, fromId: re(m.fromId) })),
  }));
  copy.cursor = { ...copy.cursor, lastActorId: copy.cursor.lastActorId === null ? null : re(copy.cursor.lastActorId) };
  return copy;
}
