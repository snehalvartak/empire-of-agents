import { apiConfig, supabase } from '@/lib/supabase';
import type { ActionInput, AgentState, CivState, TerritoryId, WorldObject, WorldSnapshot } from './world';
import {
  MAX_VILLAGERS,
  STARTING_VILLAGERS,
  clearInbox,
  findSpawnTile,
  islandFingerprint,
  nextIdFor,
  planSteps,
  runSteps,
  seedObjects,
  step,
  territoryAt,
} from './world';
import { callBrainWithRetry } from './brain';
import { buildMindInput } from './mind';
import { buildCheckpoint, restoreCheckpoint, withNewVillagerIds } from './checkpoint';
import type { CheckpointBond, DepletedEntry } from './checkpoint';
import {
  MEMORY_WINDOW,
  diaryEntryFor,
  eraScopeFor,
  layerMemories,
  memoryTick,
  visibilityFilter,
} from './memory';
import type { EraScope, MemoryRow } from './memory';
import { pickNextActor } from './rotation';
import { agentStateFromRow, agentStatePatch, carriedPatch, cursorFromRow, cursorPatch } from './persisted';
import { eventsForResult, planEndRow } from './chronicle';
import { bondExchange, createBondWriter, recordBond } from './bonds';
import type { Bond, BondExchange, PairRow } from './bonds';
import { grantXp, sanitizeTraits } from './traits';
import { DRIVER_HEARTBEAT_MS, decideLease, leaseClaimFilter, leaseReleaseRequest, toIso } from './driver';

export interface SessionRow {
  id: string;
  seq: number;
  title: string;
  status: 'live' | 'archived';
  started_at: string;
  ended_at: string | null;
  summary: string | null;
  ticks: number | null;
  wood: number | null;
  food: number | null;
  gold: number | null;
  stone: number | null;
  age: number | null;
  carry_memories: boolean;
  /** Set on a forked era ("Era N, continued"): the archived era it continues and the checkpoint tick it started from. */
  parent_session_id?: string | null;
  fork_tick?: number | null;
  /** Turn cursor (R7.5) as of the last turn written; loadWorld reads it fresh, never from this copy. */
  last_actor_id?: string | null;
  last_actor_index?: number | null;
  /** Single-driver lease (R7.6): the window driving the tick loop and its last heartbeat. */
  driver_id?: string | null;
  driver_heartbeat_at?: string | null;
}

const WATCHING_NOTE = 'Another window is driving this era — you are watching.';

/** One random id per Simulation instance (letters, digits and hyphens only). */
function makeDriverId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return Array.from({ length: 4 }, () => Math.random().toString(16).slice(2, 10).padEnd(8, '0')).join('-');
}

const MODELS_DEFAULT = 'deepseek/deepseek-v4.1-flash';

/** "Alder", "Alder and Bramble", "A, B and C". */
function joinNames(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

interface Goal {
  text: string;
  createdAt: number;
}

type RelationshipRow = Bond;

function sanitizeGoals(raw: unknown): Goal[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((g) => g && typeof g === 'object' && typeof (g as Goal).text === 'string')
    .map((g) => ({ text: String((g as Goal).text).slice(0, 160), createdAt: Number((g as Goal).createdAt) || 0 }))
    .slice(0, 3);
}
type Listener = () => void;

function describeAction(a: ActionInput): string {
  const d = a.data as Record<string, unknown>;
  switch (a.type) {
    case 'goto': return `goto (${d.x},${d.y})`;
    case 'move': return `move (${d.dx},${d.dy})`;
    case 'gather': return `gather ${d.object_id}`;
    case 'gather_nearest': return 'gather_nearest';
    case 'build': return `build ${d.structure}`;
    case 'chat': return `chat ${String(d.message ?? '').slice(0, 40)}`;
    case 'say': return `say "${String(d.message ?? '').slice(0, 40)}"`;
    case 'train': return `train ${d.ability}`;
    case 'pick_up': return `pick_up ${d.object_id}`;
    case 'place': return `place (${d.dx},${d.dy})`;
    case 'throw': return `throw (${d.dx},${d.dy})`;
    case 'plan': return 'plan (several steps)';
    default: return a.type;
  }
}

class Simulation {
  snapshot: WorldSnapshot = {
    tick: 0,
    agents: [],
    objects: [],
    civ: { wood: 0, food: 0, gold: 0, stone: 0, age: 1 },
    nextId: 1,
  };
  history: WorldSnapshot[] = [];
  running = false;
  speed: 'slow' | 'normal' | 'fast' = 'normal';
  error: string | null = null;
  focusAgent: string | null = null;
  session: SessionRow | null = null;
  /** True while another window holds the driver lease: this window only watches (R7.6). */
  readOnly = false;
  driverNote: string | null = null;
  private driverId = makeDriverId();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private starting = false;
  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private memoriesCache = new Map<string, string[]>();
  private eraScopeCache: { sessionId: string; scope: EraScope } | null = null;
  /** Seeded objects taken from the world this era: mines (null, gone for good) and animals (due-tick). */
  private depleted = new Map<string, number | null>();
  private forking = false;
  private relationshipsCache = new Map<string, Map<string, RelationshipRow>>();
  /** Persists bond rows; a row that fails stays dirty and is retried on the next bond write (R7.1, bonds.ts). */
  private bondWriter = createBondWriter((row) => this.persistBond(row));
  private actionHistory = new Map<string, Array<{ label: string; result: string }>>();
  private turnCounts = new Map<string, number>();
  private waitCounts = new Map<string, number>();
  private fallbackCounts = new Map<string, number>();
  private mismatchCounts = new Map<string, number>();
  /** Turn-order cursor (R7.5): who acted last, and the roster index they held. */
  private lastActorId: string | null = null;
  private lastActorIndex = 0;

  constructor() {
    if (typeof window !== 'undefined') {
      const release = () => this.releaseOnUnload();
      window.addEventListener('pagehide', release);
      window.addEventListener('beforeunload', release);
    }
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.snapshot = { ...this.snapshot };
    this.listeners.forEach((fn) => fn());
  }

  private delay() {
    return this.speed === 'slow' ? 6000 : this.speed === 'fast' ? 1500 : 3500;
  }

  async load() {
    await this.resumeOrCreateSession();
    await this.loadWorld();
  }

  /** Finds the live session, or creates a fresh one. */
  private async resumeOrCreateSession() {
    const { data: live } = await supabase
      .from('sessions')
      .select('*')
      .eq('status', 'live')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (live) {
      this.session = live as SessionRow;
      this.syncDriverState();
      return;
    }

    const { data: prev } = await supabase
      .from('sessions')
      .select('seq')
      .order('seq', { ascending: false })
      .limit(1)
      .maybeSingle();
    const seq = (prev?.seq ?? 0) + 1;
    const { data: created, error } = await supabase
      .from('sessions')
      .insert({ seq, title: `Session ${seq}`, status: 'live' })
      .select()
      .single();
    if (error || !created) {
      this.error = 'Could not create a new session.';
      this.emit();
      return;
    }
    this.session = created as SessionRow;
    this.readOnly = false;
    this.driverNote = null;
    await this.logEvent({
      agent_id: null,
      island: null,
      type: 'system',
      message: `Session ${seq} begins. The chronicle starts anew.`,
    });
  }

  /** Ends the live session, stamping final stats and a story title. */
  async endSession(): Promise<string | null> {
    if (!this.session || this.session.status === 'archived') return null;
    this.pauseLoop();
    this.emit();
    await this.inFlight;
    // archiving writes to the era, so only its driver may do it (R7.6): claim, or refuse
    if ((await this.claimLease()) !== 'claimed') {
      this.stopHeartbeat();
      this.emit();
      return null;
    }
    this.stopHeartbeat();
    const sid = this.session.id;
    const snap = this.snapshot;
    const seq = this.session.seq;
    const title = await this.storyTitle(seq);
    const { error } = await supabase
      .from('sessions')
      .update({
        status: 'archived',
        ended_at: new Date().toISOString(),
        title,
        summary: this.storySummary(snap),
        ticks: snap.tick,
        wood: snap.civ.wood,
        food: snap.civ.food,
        gold: snap.civ.gold,
        stone: snap.civ.stone,
        age: snap.civ.age,
        driver_id: null,
        driver_heartbeat_at: null,
      })
      .eq('id', sid);
    if (error) {
      this.error = 'Could not archive the session.';
      void this.releaseLease();
      this.emit();
      return null;
    }
    await this.logEvent({
      agent_id: null,
      island: null,
      type: 'system',
      message: `The chronicle closes on ${title}. The world lies quiet.`,
    });
    this.session = null;
    return title;
  }

  /** Starts a fresh session (previous one must be archived first). */
  async startSession(carryMemories: boolean): Promise<boolean> {
    this.stop();
    this.readOnly = false;
    this.driverNote = null;
    this.memoriesCache.clear();
    this.bondWriter.clear();
    this.lastActorId = null;
    this.lastActorIndex = 0;
    this.history = [];
    this.snapshot = {
      tick: 0,
      agents: [],
      objects: seedObjects(),
      civ: { wood: 0, food: 0, gold: 0, stone: 0, age: 1 },
      nextId: 1,
    };
    this.emit();
    await this.resumeOrCreateSession();
    if (!this.session) return false;
    if (this.readOnly) {
      // a live era is already being driven elsewhere: show it, seed and change nothing
      await this.loadWorld();
      return true;
    }
    if (!carryMemories) {
      await supabase.from('sessions').update({ carry_memories: false }).eq('id', this.session.id);
      this.session.carry_memories = false;
    }
    await this.seedStartingVillagers();
    await this.loadWorld();
    return true;
  }

  /**
   * "Continue from here" (SPEC section 9, R9.4): forks a new live era, "Era N, continued", from an
   * archived era's checkpoint (the latest at or before `tick`, default the latest). The archived era is
   * never changed and no history is copied: events, positions and memories stay with the parent, and
   * the fork reads the parent's memories through the tick-limited rule (memory.ts, `eraScopeFor`).
   *
   * Refuses, creating nothing, when the era has no checkpoint or the checkpoint does not match this
   * world (E2, R6.5). Needs the single-driver lease (R7.6): ending the live era claims it, and a
   * window that only watches is refused. Nothing runs afterwards; the viewer presses play.
   */
  async forkFromCheckpoint(archivedSessionId: string, tick?: number): Promise<{ ok: boolean; message: string }> {
    if (this.forking || this.starting) return { ok: false, message: 'The world is busy changing era. Try again in a moment.' };
    this.forking = true;
    try {
      return await this.forkEra(archivedSessionId, tick);
    } finally {
      this.forking = false;
    }
  }

  private async forkEra(archivedSessionId: string, tick?: number): Promise<{ ok: boolean; message: string }> {
    const refuse = (message: string) => ({ ok: false, message });
    const { data: parentRow } = await supabase.from('sessions').select('*').eq('id', archivedSessionId).maybeSingle();
    const parent = parentRow as SessionRow | null;
    if (!parent || parent.status !== 'archived') return refuse('Only an archived era can be continued.');

    let cpQuery = supabase.from('checkpoints').select('tick, snapshot').eq('session_id', parent.id);
    if (tick !== undefined) cpQuery = cpQuery.lte('tick', tick);
    const { data: cp } = await cpQuery.order('tick', { ascending: false }).limit(1).maybeSingle();
    if (!cp) return refuse(`${parent.title} has no checkpoint${tick !== undefined ? ` at or before tick ${tick}` : ''} to continue from.`);
    const restored = restoreCheckpoint(cp.snapshot, islandFingerprint);
    if (!restored.ok) return refuse(restored.message); // E2: nothing has been created

    // ending the live era (if any) claims the driver lease, so a window that only watches is refused (R9.4)
    if (!this.session || this.session.status === 'archived') {
      const { data: live } = await supabase.from('sessions').select('*').eq('status', 'live').order('started_at', { ascending: false }).limit(1).maybeSingle();
      this.session = (live as SessionRow | null) ?? null;
    }
    if (this.session) {
      if ((await this.endSession()) === null) {
        return refuse('Another window is driving the current era, so this window cannot start a new one. Wait for it to stop (about 30 seconds after it closes), then try again.');
      }
    }

    const { data: last } = await supabase.from('sessions').select('seq').order('seq', { ascending: false }).limit(1).maybeSingle();
    const seq = (last?.seq ?? 0) + 1;
    const { data: created, error } = await supabase
      .from('sessions')
      .insert({
        seq,
        title: `Era ${parent.seq}, continued`,
        status: 'live',
        carry_memories: parent.carry_memories,
        parent_session_id: parent.id,
        fork_tick: restored.snapshot.tick,
      })
      .select()
      .single();
    if (error || !created) return refuse('Could not create the new era.');
    const sid = (created as SessionRow).id;
    this.session = created as SessionRow;
    this.eraScopeCache = null;
    const abort = async (message: string) => {
      // best effort: leave no half-built era behind
      for (const table of ['agents', 'structures', 'civ', 'depleted_objects']) await supabase.from(table).delete().eq('session_id', sid);
      await supabase.from('sessions').delete().eq('id', sid);
      this.session = null;
      this.readOnly = false;
      this.driverNote = null;
      return refuse(message);
    };
    if ((await this.claimLease()) !== 'claimed') return abort('Could not take over the new era. Try again.');

    // the fork's villagers are new rows (same names, so they inherit by namesake); insert in roster order
    const newIds: string[] = [];
    for (const a of restored.snapshot.agents) {
      const { data: row, error: agentError } = await supabase
        .from('agents')
        .insert({
          session_id: sid,
          name: a.name,
          model: a.model,
          color: a.color,
          island: a.island,
          position: a.pos,
          persona: a.persona,
          mood: a.mood,
          status: 'idle',
          hunger: Math.round(a.hunger),
          energy: Math.round(a.energy),
          traits: a.traits ?? {},
          goals: a.goals ?? [],
          inventory: carriedPatch(a).inventory,
        })
        .select('id')
        .single();
      if (agentError || !row) return abort('Could not restore the villagers.');
      newIds.push(row.id as string);
    }
    const world = withNewVillagerIds(restored, newIds);

    // what loadWorld reads back: built structures and cubes, the stockpile, and what is gone from the seeded world
    const seedIds = new Set(seedObjects().map((o) => o.id));
    const gone = new Map(world.depleted.map((d) => [d.id, d.respawnTick] as const));
    for (const seed of seedObjects()) {
      if (!world.snapshot.objects.some((o) => o.id === seed.id) && !gone.has(seed.id)) gone.set(seed.id, null);
    }
    const built = world.snapshot.objects.filter((o) => !seedIds.has(o.id));
    const civ = world.snapshot.civ;
    // pending chat names its sender, and the senders now have new ids: write it (and the cursor) once those exist
    const writes = await Promise.all([
      ...world.snapshot.agents
        .filter((a) => a.inbox?.length)
        .map((a) => supabase.from('agents').update({ inbox: carriedPatch(a).inbox }).eq('id', a.id)),
      supabase.from('sessions').update(cursorPatch(world.cursor)).eq('id', sid),
      built.length
        ? supabase.from('structures').insert(
            built.map((o) => ({ session_id: sid, id: o.id, territory: o.territory, position: o.pos, kind: o.kind, built_by: o.builtBy ?? null }))
          )
        : Promise.resolve({ error: null }),
      supabase.from('civ').upsert({ id: sid, session_id: sid, wood: civ.wood, food: civ.food, gold: civ.gold, stone: civ.stone, age: civ.age }),
      gone.size
        ? supabase.from('depleted_objects').insert([...gone].map(([id, respawnTick]) => ({ id, session_id: sid, respawn_tick: respawnTick })))
        : Promise.resolve({ error: null }),
    ]);
    if (writes.some((w) => w.error)) return abort('Could not restore the world.');

    // the in-memory world: tick continues from the checkpoint; cursor and pending messages come back with it
    this.readOnly = false;
    this.driverNote = null;
    this.error = null;
    this.memoriesCache.clear();
    this.actionHistory.clear();
    this.depleted = new Map(gone);
    this.lastActorId = world.cursor.lastActorId;
    this.lastActorIndex = world.cursor.lastActorIndex;
    // Bonds: the checkpoint's strengths are this era's live values. The global relationships table is
    // deliberately not rewritten here; it is only the starting point for a new era (SPEC section 9) and
    // converges on the first interaction, when recordBond upserts the pair's row.
    this.relationshipsCache.clear();
    this.bondWriter.clear();
    for (const a of world.snapshot.agents) {
      a.relationships = (a.relationships ?? []).map((r) => ({ ...r }));
      this.relationshipsCache.set(a.id, new Map(a.relationships.map((r) => [r.withName, { ...r }] as const)));
    }
    this.snapshot = world.snapshot;
    this.history = [];
    this.pushHistory();
    await this.logEvent({
      agent_id: null,
      island: null,
      type: 'system',
      message: `Era ${parent.seq}, continued: the empire wakes where tick ${world.snapshot.tick} left it.`,
    });
    await this.releaseLease(); // nothing runs until the viewer presses play
    this.emit();
    return { ok: true, message: `Continuing ${parent.title} from tick ${world.snapshot.tick}. Press play when you are ready.` };
  }

  /** Grand, evocative title derived from the session's own chronicle. */
  private async storyTitle(seq: number): Promise<string> {
    const fallback = `Session ${seq}`;
    if (!this.session) return fallback;
    const { data: events } = await supabase
      .from('events')
      .select('message')
      .eq('session_id', this.session.id)
      .order('created_at', { ascending: false })
      .limit(25);
    const seed = (events ?? []).map((e) => e.message).join('\n').slice(0, 900);
    if (!seed) return fallback;
    try {
      const decision = await callBrainWithRetry(
        MODELS_DEFAULT,
        'You name the chronicle of a fallen AI-villager empire. Reply with ONLY a title of 3 to 7 words. Grand, evocative, Age-of-Empires tone. No quotes, no punctuation at the end.\n\nRecent chronicle:\n' +
          seed,
        'Name this age.'
      );
      const text = (decision.thought || '').replace(/["*]/g, '').trim().slice(0, 80);
      return text || fallback;
    } catch {
      return fallback;
    }
  }

  private storySummary(snap: WorldSnapshot): string {
    const ageName = ['Dark Age', 'Feudal Age', 'Castle Age', 'Imperial Age'][snap.civ.age - 1] ?? `Age ${snap.civ.age}`;
    return `${snap.agents.length} villagers · ${ageName} · ${snap.civ.wood} wood, ${snap.civ.food} food, ${snap.civ.gold} gold, ${snap.civ.stone} stone · ${snap.tick} ticks`;
  }

  /**
   * Rebuilds the world from the database. A window that is driving and already shows this roster keeps
   * what it holds in memory for what is newer than the last write (carried items, unheard chat, the turn
   * cursor); `fresh` forces the database's values, for a window taking over from a watching view.
   */
  private async loadWorld(fresh = false) {
    if (!this.session) return;
    const sid = this.session.id;
    const { data: agentRowsData, error } = await supabase
      .from('agents')
      .select('*')
      .eq('session_id', sid)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }); // id breaks a created_at tie (rows of an older era seeded in one INSERT), so the roster order is always the same
    let agentRows = agentRowsData;
    if (error) {
      this.error = 'Could not load villagers from the database.';
      this.emit();
      return;
    }

    if ((!agentRows || agentRows.length === 0) && !this.readOnly) {
      const seeded = await this.seedStartingVillagers();
      if (!seeded) {
        this.error = 'Could not seed the starting villagers. Reload the page to retry.';
        this.emit();
        return;
      }
      const { data: rows } = await supabase
        .from('agents')
        .select('*')
        .eq('session_id', sid)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true });
      agentRows = rows ?? [];
    }

    // civilization state: one row per session
    let civ: CivState = { wood: 0, food: 0, gold: 0, stone: 0, age: 1 };
    const { data: civRow } = await supabase
      .from('civ')
      .select('*')
      .eq('session_id', sid)
      .maybeSingle();
    if (civRow) {
      civ = {
        wood: civRow.wood,
        food: civRow.food,
        gold: civRow.gold,
        stone: civRow.stone,
        age: civRow.age,
      };
    }

    // persisted built structures for this session
    const { data: builtRows } = await supabase
      .from('structures')
      .select('*')
      .eq('session_id', sid);
    const builtStructures: WorldObject[] = (builtRows ?? []).map((r) => ({
      id: r.id,
      territory: r.territory as TerritoryId,
      pos: r.position as { x: number; y: number },
      kind: r.kind,
      builtBy: r.built_by,
    }));

    // continue from the last tick this era recorded (never back to 0): respawn due-ticks and the
    // 50-tick checkpoint cadence only make sense on the era's own clock
    const loadedTick = await this.lastRecordedTick(sid);

    // depleted seeds: mines taken this session (null respawn_tick = permanent),
    // plus animals whose due-tick is still ahead of the tick we load at
    const { data: depletedRows } = await supabase
      .from('depleted_objects')
      .select('*')
      .eq('session_id', sid);
    const stillDepleted = (depletedRows ?? []).filter(
      (r) => r.respawn_tick == null || (r.respawn_tick as number) > loadedTick
    );
    const depletedIds = new Set(stillDepleted.map((r) => r.id as string));
    this.depleted.clear();
    for (const r of stillDepleted) this.depleted.set(r.id as string, (r.respawn_tick as number | null) ?? null);
    const seeds = seedObjects().filter((o) => !depletedIds.has(o.id));

    const keepLive = !fresh && !this.readOnly && this.snapshot.agents.length > 0;
    const live = new Map(this.snapshot.agents.map((a) => [a.id, a] as const));
    // inventory and unheard chat come back from the row (persisted.ts), so a reload loses neither
    const carriedOf = (row: { id: string }) => {
      const known = keepLive ? live.get(row.id) : undefined;
      return known ? { inventory: known.inventory, inbox: known.inbox } : agentStateFromRow(row);
    };
    const agents: AgentState[] = (agentRows ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      model: row.model,
      color: row.color,
      island: row.island as TerritoryId,
      pos: row.position as { x: number; y: number },
      mood: row.mood,
      persona: row.persona,
      status: row.status,
      traits: sanitizeTraits(row.traits),
      goals: sanitizeGoals(row.goals),
      hunger: row.hunger ?? 0,
      energy: row.energy ?? 100,
      ...carriedOf(row),
    }));
    await this.hydrateRelationships(agents);

    if (!keepLive) {
      // the exact next actor: the cursor saved after the last turn, checked against the roster we just loaded
      const { data: cursorRow } = await supabase
        .from('sessions')
        .select('last_actor_id, last_actor_index')
        .eq('id', sid)
        .maybeSingle();
      const cursor = cursorFromRow(cursorRow, agents.map((a) => a.id));
      this.lastActorId = cursor.lastActorId;
      this.lastActorIndex = cursor.lastActorIndex;
    }

    const objects = [...seeds, ...builtStructures];
    this.snapshot = {
      tick: loadedTick,
      agents,
      objects,
      civ,
      nextId: nextIdFor(objects),
    };
    this.history = [];
    this.pushHistory();
    this.emit();
  }

  /**
   * The tick this era last reached: the highest tick in its events, positions and checkpoints
   * (and, for a fork, the tick it started from), never lower than what this window already shows.
   */
  private async lastRecordedTick(sid: string): Promise<number> {
    const latest = async (table: 'events' | 'agent_positions' | 'checkpoints'): Promise<number> => {
      const { data } = await supabase
        .from(table)
        .select('tick')
        .eq('session_id', sid)
        .not('tick', 'is', null)
        .order('tick', { ascending: false })
        .limit(1)
        .maybeSingle();
      return typeof data?.tick === 'number' ? data.tick : 0;
    };
    const ticks = await Promise.all([latest('events'), latest('agent_positions'), latest('checkpoints')]);
    return Math.max(this.session?.fork_tick ?? 0, this.snapshot.tick, ...ticks);
  }

  async addAgent(a: {
    name: string;
    model: string;
    color: string;
    island: TerritoryId;
    persona: string;
  }) {
    if (!(await this.mayEditRoster())) return;
    if (!this.session) {
      this.error = 'No live session.';
      this.emit();
      return;
    }
    if (this.snapshot.agents.length >= MAX_VILLAGERS) {
      this.error = `This world holds at most ${MAX_VILLAGERS} villagers and all ${MAX_VILLAGERS} places are taken. Dismiss a villager before recruiting another.`;
      this.emit();
      return;
    }
    // a free tile in the chosen territory, never one a villager already stands on (SPEC section 7: one villager per tile)
    const spawn = findSpawnTile(this.snapshot, a.island);
    if (!spawn) {
      this.error = `Every tile of that territory is taken. Choose another territory for the newcomer.`;
      this.emit();
      return;
    }
    const { data, error } = await supabase
      .from('agents')
      .insert({
        session_id: this.session.id,
        name: a.name,
        model: a.model,
        color: a.color,
        island: a.island,
        position: spawn,
        persona: a.persona,
        mood: 'curious',
        status: 'idle',
        inventory: [],
        inbox: [],
      })
      .select()
      .single();
    if (error) {
      this.error = 'Could not add villager.';
      this.emit();
      return;
    }
    this.invalidateMemories(data.id);
    await this.loadWorld();
    await this.logEvent({
      agent_id: data.id,
      island: data.island,
      type: 'system',
      message: `${data.name} joins the empire in ${data.island}.`,
    });
  }

  async removeAgent(id: string) {
    if (!(await this.mayEditRoster())) return;
    await supabase.from('agents').delete().eq('id', id);
    this.invalidateMemories(id);
    await this.loadWorld();
  }

  /** Archival reset: used by the deploy hook. Ends the live session; data is kept. */
  async resetWorld() {
    await this.endSession();
    if (this.readOnly) return; // another window drives the era: leave this watcher's view alone
    this.memoriesCache.clear();
    this.bondWriter.clear();
    this.lastActorId = null;
    this.lastActorIndex = 0;
    this.snapshot = {
      tick: 0,
      agents: [],
      objects: seedObjects(),
      civ: { wood: 0, food: 0, gold: 0, stone: 0, age: 1 },
      nextId: 1,
    };
    this.history = [];
    this.emit();
  }

  private async seedStartingVillagers(): Promise<boolean> {
    if (!this.session) return false;
    const sessionId = this.session.id;
    // One INSERT per villager, in manifest order. Every row of a single multi-row INSERT gets the same now(), and
    // the roster (join order, which the turn cursor of R7.5 is defined against) is read back ORDER BY created_at:
    // with a tie the database may return the starting cast in either order, and a different one after an UPDATE.
    for (const v of STARTING_VILLAGERS) {
      const { error } = await supabase.from('agents').insert({
        session_id: sessionId,
        name: v.name,
        model: MODELS_DEFAULT,
        color: v.color,
        island: v.territory,
        position: { x: v.pos.x, y: v.pos.y },
        persona: v.persona,
        mood: 'curious',
        status: 'idle',
        inventory: [],
        inbox: [],
      });
      if (error) {
        console.error('Seeding villagers failed:', error.message);
        await supabase.from('agents').delete().eq('session_id', sessionId); // never leave half a cast behind
        return false;
      }
    }
    await this.logEvent({
      agent_id: null,
      island: null,
      type: 'system',
      message: `${joinNames(STARTING_VILLAGERS.map((v) => v.name))} arrive to found the empire.`,
    });
    return true;
  }

  async logEvent(e: {
    agent_id: string | null;
    island: TerritoryId | null;
    type: string;
    message: string;
  }) {
    if (this.readOnly) return; // watchers never write to the era (R7.6)
    await supabase.from('events').insert({
      session_id: this.session?.id ?? null,
      agent_id: e.agent_id,
      island: e.island,
      type: e.type,
      message: e.message,
      tick: this.snapshot.tick,
    });
  }

  async getMemories(agentId: string, agentName: string): Promise<string[]> {
    const cacheKey = `${this.session?.id ?? 'none'}:${agentId}`;
    const cached = this.memoriesCache.get(cacheKey);
    if (cached) return cached;

    // villagers remember by name across sessions: a new Alder inherits the chronicles of every past
    // Alder (as far as the era's scope allows: amnesiac eras, forks), and every villager shares the
    // empire's discoveries (R5.3). The layering itself is the pure layerMemories (memory.ts).
    const scope = await this.currentEraScope();
    let namesakeIds = [agentId];
    if (scope.carryMemories || scope.fork) {
      const { data: namesakes } = await supabase.from('agents').select('id').eq('name', agentName);
      namesakeIds = (namesakes ?? []).map((r) => r.id as string);
    }
    // the database makes the era-and-tick cut before the row limit, so a fork's parent rows past the fork tick cannot crowd out the visible ones
    const cut = visibilityFilter(scope);
    const select = 'id, content, kind, agent_id, session_id, tick, created_at';
    let own = supabase.from('memories').select(select).in('agent_id', namesakeIds).order('created_at', { ascending: false }).limit(MEMORY_WINDOW);
    let shared = supabase.from('memories').select(select).eq('kind', 'discovery').order('created_at', { ascending: false }).limit(MEMORY_WINDOW);
    if (cut) {
      own = own.or(cut);
      shared = shared.or(cut);
    }
    const [ownRes, sharedRes] = await Promise.all([own, shared]);
    const rows = [...(ownRes.data ?? []), ...(sharedRes.data ?? [])] as MemoryRow[];
    const list = layerMemories(rows, { scope, namesakeIds });
    this.memoriesCache.set(cacheKey, list);
    return list;
  }

  /** What the live era may inherit: ordinary, amnesiac, or forked from an archived era (memory.ts). */
  private async currentEraScope(): Promise<EraScope> {
    const session = this.session;
    if (!session) return { sessionId: 'none', carryMemories: true };
    if (this.eraScopeCache?.sessionId === session.id) return this.eraScopeCache.scope;
    let scope: EraScope = { sessionId: session.id, carryMemories: session.carry_memories };
    if (session.parent_session_id) {
      const { data } = await supabase.from('sessions').select('id, seq, parent_session_id, fork_tick, carry_memories');
      scope = eraScopeFor((data ?? []) as Array<Parameters<typeof eraScopeFor>[0][number]>, session.id) ?? scope;
    }
    this.eraScopeCache = { sessionId: session.id, scope };
    return scope;
  }

  /** The next turn must see fresh chronicles: a villager's own entries, or everyone's after a shared discovery. */
  invalidateMemories(agentId: string, shared = false) {
    if (shared) {
      this.memoriesCache.clear();
      return;
    }
    for (const key of [...this.memoriesCache.keys()]) if (key.endsWith(`:${agentId}`)) this.memoriesCache.delete(key);
  }

  /** Loads each agent's chat history with every other villager (name-based, session-agnostic). */
  private async hydrateRelationships(agents: AgentState[]) {
    for (const a of agents) {
      this.relationshipsCache.delete(a.id);
      await this.getRelationships(a);
    }
  }

  private async getRelationships(agent: AgentState): Promise<RelationshipRow[]> {
    const cached = this.relationshipsCache.get(agent.id);
    if (cached) return [...cached.values()].sort((x, y) => y.strength - x.strength);

    const map = new Map<string, RelationshipRow>();
    const { data: namesakes } = await supabase.from('agents').select('id, name').eq('name', agent.name);
    const ids = (namesakes ?? []).map((r) => r.id as string);
    if (ids.length > 0) {
      const { data: rels } = await supabase
        .from('relationships')
        .select('a_id, b_id, strength')
        .or(`a_id.in.(${ids.join(',')}),b_id.in.(${ids.join(',')})`);
      for (const r of rels ?? []) {
        const otherId = ids.includes(r.a_id) ? r.b_id : r.a_id;
        const { data: other } = await supabase
          .from('agents')
          .select('name')
          .eq('id', otherId)
          .maybeSingle();
        if (other) {
          map.set(other.name, {
            withId: otherId,
            withName: other.name,
            strength: r.strength,
            lastMessage: null,
          });
        }
      }
    }
    this.relationshipsCache.set(agent.id, map);
    return [...map.values()].sort((x, y) => y.strength - x.strength);
  }

  private async recordChat(from: AgentState, to: AgentState, bond: BondExchange) {
    await this.recordBond(from, to, bond);
    const { data: countRow } = await supabase
      .from('agents')
      .select('chat_count')
      .eq('id', from.id)
      .maybeSingle();
    await supabase.from('agents').update({ chat_count: (countRow?.chat_count ?? 0) + 1 }).eq('id', from.id);
  }

  /** Deepens the bond of both villagers in memory, then persists it (symmetric, retried on failure: bonds.ts, R7.1). */
  private async recordBond(a: AgentState, b: AgentState, bond: BondExchange) {
    await recordBond(
      {
        relsOf: (id) => {
          let rels = this.relationshipsCache.get(id);
          if (!rels) {
            rels = new Map();
            this.relationshipsCache.set(id, rels);
          }
          return rels;
        },
        writer: this.bondWriter,
        sessionId: this.session?.id ?? null,
        nowIso: () => new Date().toISOString(),
      },
      a,
      b,
      bond.delta,
      bond.lastMessage
    );
  }

  /**
   * One upsert, not an update: in a new or forked era the pair of ids is new, and the first interaction
   * is what writes the global row (it converges on the era's live value). Rejects on failure so the
   * writer keeps the pair dirty.
   */
  private async persistBond(row: PairRow) {
    const { error } = await supabase.from('relationships').upsert(row, { onConflict: 'a_id,b_id' });
    if (error) {
      console.error('relationship upsert failed:', error.message);
      throw new Error(error.message);
    }
  }

  /**
   * Claims the single-driver lease (R7.6), then runs the loop. If another window
   * drives the era the claim is denied: nothing runs and this window only watches.
   * Calling it again is the retry.
   */
  async start() {
    if (this.running || this.starting) return;
    this.starting = true;
    try {
      const wasWatching = this.readOnly;
      if ((await this.claimLease()) !== 'claimed') {
        this.emit();
        return;
      }
      // taking over from a watching view: reload, so the loop starts from what the last driver saved
      if (wasWatching) await this.loadWorld(true);
      this.running = true;
      this.error = null;
      this.startHeartbeat();
      // a tick still draining from an earlier stop() schedules the next one itself
      if (!this.inFlight) this.schedule();
      this.emit();
    } finally {
      this.starting = false;
    }
  }

  stop() {
    this.pauseLoop();
    void this.releaseWhenIdle();
    this.emit();
  }

  private pauseLoop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** What a watcher sees when the lease is not its own. */
  private markReadOnly() {
    this.readOnly = true;
    this.driverNote = WATCHING_NOTE;
  }

  /** On opening a live era: watch it if a live driver holds it, otherwise stay free to start. */
  private syncDriverState() {
    if (!this.session) return;
    const verdict = decideLease(
      { driver_id: this.session.driver_id ?? null, driver_heartbeat_at: this.session.driver_heartbeat_at ?? null },
      this.driverId,
      Date.now()
    );
    if (verdict === 'denied') this.markReadOnly();
    else {
      this.readOnly = false;
      this.driverNote = null;
    }
  }

  /**
   * One conditional UPDATE, never read-then-write: it matches only when nobody
   * drives the era, I do, or the driver's heartbeat is stale, and returns the row
   * it changed. Zero rows back means another driver holds the lease.
   */
  private async claimLease(): Promise<'claimed' | 'denied' | 'error'> {
    if (!this.session) return 'error';
    const now = Date.now();
    const { data, error } = await supabase
      .from('sessions')
      .update({ driver_id: this.driverId, driver_heartbeat_at: toIso(now) })
      .eq('id', this.session.id)
      .or(leaseClaimFilter(this.driverId, now))
      .select();
    if (error) {
      this.error = 'Could not check whether another window is driving this era.';
      return 'error';
    }
    if (!data || data.length === 0) {
      this.markReadOnly();
      return 'denied';
    }
    this.session = { ...this.session, ...(data[0] as SessionRow) };
    this.readOnly = false;
    this.driverNote = null;
    return 'claimed';
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => void this.renewLease(), DRIVER_HEARTBEAT_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /** Renews while running; zero rows updated means someone else took the lease, so stop at once. */
  private async renewLease() {
    if (!this.session) return;
    const { data, error } = await supabase
      .from('sessions')
      .update({ driver_heartbeat_at: toIso(Date.now()) })
      .eq('id', this.session.id)
      .eq('driver_id', this.driverId)
      .select('id');
    if (error) return; // transient: the next beat retries
    if (!data || data.length === 0) {
      this.pauseLoop();
      this.stopHeartbeat();
      this.markReadOnly();
      this.emit();
    }
  }

  /** Best-effort: frees the lease only if it is still mine. */
  private async releaseLease() {
    if (!this.session) return;
    try {
      await supabase
        .from('sessions')
        .update({ driver_id: null, driver_heartbeat_at: null })
        .eq('id', this.session.id)
        .eq('driver_id', this.driverId);
    } catch {
      // best-effort: a lease that is not released simply times out
    }
  }

  /**
   * The window is going away (reload, close): free the lease with a request that is sent right now, in this
   * task, and survives the page (leaseReleaseRequest). A window that is not driving has nothing to free.
   */
  private releaseOnUnload() {
    if (!this.session || !(this.running || this.heartbeat)) return;
    try {
      const { url, init } = leaseReleaseRequest(apiConfig, this.session.id, this.driverId);
      void fetch(url, init).catch(() => undefined);
    } catch {
      // best-effort: a lease that is not released simply times out
    }
  }

  /** Lets a tick in progress finish writing before the lease is given up. */
  private async releaseWhenIdle() {
    await this.inFlight;
    if (this.running || this.starting) return; // started again meanwhile
    this.stopHeartbeat();
    await this.releaseLease();
  }

  /** Roster edits write to the era, so only the driver (or a window nobody else drives) may make them. */
  private async mayEditRoster(): Promise<boolean> {
    if (!this.readOnly && this.session && !this.running) {
      const { data } = await supabase
        .from('sessions')
        .select('driver_id, driver_heartbeat_at')
        .eq('id', this.session.id)
        .maybeSingle();
      if (data && decideLease(data, this.driverId, Date.now()) === 'denied') this.markReadOnly();
    }
    if (this.readOnly) {
      this.emit();
      return false;
    }
    return true;
  }

  setSpeed(s: 'slow' | 'normal' | 'fast') {
    this.speed = s;
    this.emit();
  }

  private schedule() {
    if (!this.running) return;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inFlight = this.tick().finally(() => {
        this.inFlight = null;
      });
    }, this.delay());
  }

  /** Hunger rises and energy drains with every tick; recovering is the villager's own business. */
  private applyNeeds(agent: AgentState) {
    agent.hunger = Math.min(100, (agent.hunger ?? 0) + 4);
    agent.energy = Math.max(0, (agent.energy ?? 100) - 3);
  }

  private async tick() {
    if (!this.running) return;
    const agents = this.snapshot.agents;
    if (agents.length === 0) {
      this.schedule();
      return;
    }

    const idx = pickNextActor(agents.map((a) => a.id), this.lastActorId, this.lastActorIndex);
    const agent = agents[idx];
    this.lastActorId = agent.id;
    this.lastActorIndex = idx;

    this.respawnAnimals();
    this.applyNeeds(agent);

    try {
      await this.runAgentTurn(agent);
      this.error = null;
    } catch (err) {
      agent.status = 'idle';
      this.error = err instanceof Error ? err.message : 'Simulation error';
    }

    // the lease was lost during this turn: write nothing more (R7.6)
    if (this.readOnly) return;

    // remember where this villager has been, so wander seeks fresh ground
    agent.recentTiles = [...(agent.recentTiles ?? []), { ...agent.pos }].slice(-24);

    this.snapshot.tick++;
    await this.persistTurn(agent);
    await this.recordPosition(agent);
    await this.maybeCheckpoint();
    this.pushHistory();
    this.emit();
    this.schedule();
  }

  private async recordPosition(agent: AgentState) {
    await supabase.from('agent_positions').insert({
      session_id: this.session?.id ?? null,
      agent_id: agent.id,
      tick: this.snapshot.tick,
      x: agent.pos.x,
      y: agent.pos.y,
    });
  }

  /** Bond strengths as the era lives them now: the relationship cache, not the stale copy on the villager. */
  private bondsOf(agent: AgentState): CheckpointBond[] {
    return [...(this.relationshipsCache.get(agent.id)?.values() ?? [])].map((r) => ({
      withId: r.withId,
      withName: r.withName,
      strength: r.strength,
      lastMessage: r.lastMessage,
    }));
  }

  private depletedEntries(): DepletedEntry[] {
    return [...this.depleted].map(([id, respawnTick]) => ({ id, respawnTick }));
  }

  /** Full world snapshot every 50 ticks: replay seeking, thumbnails, and "Continue from here" (restore/fork). */
  private async maybeCheckpoint() {
    if (this.snapshot.tick % 50 !== 0) return;
    const s = this.snapshot;
    const payload = buildCheckpoint({
      // R6.5: restore refuses a checkpoint whose world fingerprint differs
      fingerprint: islandFingerprint,
      snapshot: { ...s, agents: s.agents.map((a) => ({ ...a, relationships: this.bondsOf(a) })) },
      cursor: { lastActorId: this.lastActorId, lastActorIndex: this.lastActorIndex },
      depleted: this.depletedEntries(),
    });
    await supabase
      .from('checkpoints')
      .upsert({ session_id: this.session?.id ?? null, tick: s.tick, snapshot: payload }, { onConflict: 'session_id,tick' });
  }

  private pushHistory() {
    const s = this.snapshot;
    this.history.push({
      tick: s.tick,
      agents: s.agents.map((a) => ({ ...a, pos: { ...a.pos }, inbox: a.inbox?.map((m) => ({ ...m })) })),
      objects: s.objects.map((o) => ({ ...o, pos: { ...o.pos } })),
      civ: { ...s.civ },
      nextId: s.nextId,
    });
    if (this.history.length > 400) this.history.shift();
  }

  /** Gathered animals quietly return to their herds once their time is up. */
  private respawnAnimals() {
    const now = this.snapshot.tick;
    for (const [id, respawnTick] of this.depleted) {
      if (respawnTick === null || now < respawnTick) continue; // mines never come back
      const seed = seedObjects().find((o) => o.id === id);
      if (seed && !this.snapshot.objects.some((o) => o.pos.x === seed.pos.x && o.pos.y === seed.pos.y)) {
        this.snapshot.objects.push(seed);
        this.snapshot.objects = [...this.snapshot.objects];
      }
      this.depleted.delete(id);
    }
  }

  private async runAgentTurn(agent: AgentState) {
    this.focusAgent = agent.id;
    agent.status = 'thinking';
    this.emit();

    const memories = await this.getMemories(agent.id, agent.name);
    agent.relationships = await this.getRelationships(agent);
    const mind = buildMindInput(agent, this.snapshot, memories, this.actionHistory.get(agent.id) ?? []);

    const decision = await callBrainWithRetry(agent.model, mind.system, mind.observation);

    // what was spoken to this villager has now been heard — exactly once (R7.4)
    clearInbox(agent, this.snapshot.agents.find((a) => a.id === agent.id));

    // count and log unparseable replies instead of letting them read as a rest
    if (decision.fallback) {
      this.fallbackCounts.set(agent.id, (this.fallbackCounts.get(agent.id) ?? 0) + 1);
      await this.logEvent({
        agent_id: agent.id,
        island: agent.island,
        type: 'system',
        message: `${agent.name}'s reply could not be parsed and fell back to wait. Raw reply: "${(decision.rawReply ?? '').replace(/\s+/g, ' ').slice(0, 200)}"`,
      });
    }
    if (decision.mismatch) {
      this.mismatchCounts.set(agent.id, (this.mismatchCounts.get(agent.id) ?? 0) + 1);
    }

    agent.status = 'acting';
    this.emit();

    const steps = planSteps(decision.action);

    const hist = this.actionHistory.get(agent.id) ?? [];
    this.turnCounts.set(agent.id, (this.turnCounts.get(agent.id) ?? 0) + 1);
    const { endedAt } = await runSteps(steps, async (step, i) => {
      const result = await this.executeAction(agent, step, decision.thought, i === 0);
      hist.unshift({
        label: describeAction(step),
        result: result.ok ? result.message : `failed — ${result.message}`,
      });
      if (result.ok && step.type === 'wait') {
        this.waitCounts.set(agent.id, (this.waitCounts.get(agent.id) ?? 0) + 1);
      }
      return result;
    });
    // a failed step ends the plan there; its plain-language reason is already in the chronicle
    const planEnd = planEndRow(agent, endedAt, steps.length);
    if (planEnd) await this.logEvent(planEnd);
    this.actionHistory.set(agent.id, hist.slice(0, 3));

    agent.status = 'idle';
    this.focusAgent = null;
  }

  fallbackRate(agentId: string): number {
    const total = this.turnCounts.get(agentId) ?? 0;
    return total ? (this.fallbackCounts.get(agentId) ?? 0) / total : 0;
  }

  mismatchRate(agentId: string): number {
    const total = this.turnCounts.get(agentId) ?? 0;
    return total ? (this.mismatchCounts.get(agentId) ?? 0) / total : 0;
  }

  waitRate(agentId: string): number {
    const total = this.turnCounts.get(agentId) ?? 0;
    return total ? (this.waitCounts.get(agentId) ?? 0) / total : 0;
  }

  private async executeAction(
    agent: AgentState,
    action: ActionInput,
    thought: string,
    isFirst: boolean
  ): Promise<import('./world').ActionResult> {
    const carriedBefore = JSON.stringify(agent.inventory);
    const result = step(this.snapshot, agent.id, action);
    agent.island = territoryAt(agent.pos) ?? agent.island;
    if (this.readOnly) return result; // lease lost mid-turn: no persistence from here (R7.6)

    // what changed hands is saved with the deed, so a reload between steps (or before the turn ends) never
    // duplicates or loses it: the actor's items, and the other villager's words or item (their state changed on
    // someone else's turn)
    const other = result.chat?.withId ?? result.gift?.withId;
    const otherAgent = other ? this.snapshot.agents.find((a) => a.id === other) : undefined;
    await this.persistCarried(
      ...(JSON.stringify(agent.inventory) !== carriedBefore ? [agent] : []),
      ...(otherAgent ? [otherAgent] : [])
    );

    // every result is chronicled, success or failure, together with a lost chat and the thought (chronicle.ts, R3.3)
    const chatTarget = result.chat ? this.snapshot.agents.find((a) => a.id === result.chat!.withId) : undefined;
    for (const row of eventsForResult(agent, action, result, { thought, isFirst, target: chatTarget })) {
      await this.logEvent(row);
    }

    // every memory row carries the era and the tick it was written at (SPEC section 8)
    const stamp = { session_id: this.session?.id ?? null, tick: memoryTick(this.snapshot.tick) };
    if (result.memory) {
      await supabase.from('memories').insert({
        ...stamp,
        agent_id: agent.id,
        kind: result.memory.kind,
        content: result.memory.content,
        island: agent.island,
      });
      this.invalidateMemories(agent.id, result.memory.kind === 'discovery');
    }

    // the villager's diary: every deed becomes an episodic memory it can consult later
    const diary = diaryEntryFor(action, result);
    if (diary) {
      await supabase.from('memories').insert({
        ...stamp,
        agent_id: agent.id,
        kind: diary.kind,
        content: diary.content,
        island: agent.island,
      });
      this.invalidateMemories(agent.id);
    }

    // failures are spoken, not swallowed — the world answers visibly
    if (!result.ok) {
      agent.lastBubble = result.message.slice(0, 140);
    }

    if (result.newGoal) {
      agent.goals = [
        { text: result.newGoal, createdAt: this.snapshot.tick },
        ...(agent.goals ?? []).filter((g) => g.text !== result.newGoal),
      ].slice(0, 3);
      await supabase.from('agents').update({ goals: agent.goals }).eq('id', agent.id);
    }

    // persist shared civ changes (stockpile + age)
    if (result.civDelta || result.civAge) {
      await this.persistCiv();
    }

    // persist built structures
    if (result.built) {
      await supabase.from('structures').insert({
        session_id: this.session?.id ?? null,
        id: result.built.id,
        territory: agent.island,
        position: result.built.pos,
        kind: result.built.structure,
        built_by: result.built.by,
      });
    }

    // persist cubes spawned by the Standing Rock
    for (const s of result.spawned ?? []) {
      await supabase.from('structures').insert({
        session_id: this.session?.id ?? null,
        id: s.id,
        territory: territoryAt(s.pos) ?? agent.island,
        position: s.pos,
        kind: 'cube',
        built_by: s.by,
      });
    }

    // persist depleted mines and gathered animals (animals return later)
    if (result.depleted) {
      await supabase.from('depleted_objects').upsert({
        id: result.depleted.id,
        session_id: this.session?.id ?? null,
        respawn_tick: result.depleted.respawnTick,
      });
      this.depleted.set(result.depleted.id, result.depleted.respawnTick);
    }

    // mood flavor
    if (!result.ok) {
      agent.mood = 'frustrated';
    } else if (action.type === 'chat') {
      agent.mood = 'chatty';
      agent.lastBubble = `to ${result.chat!.withName}: "${result.chat!.message}"`;
      const target = this.snapshot.agents.find((a) => a.id === result.chat!.withId);
      if (target) {
        await this.recordChat(agent, target, bondExchange(result)!);
        target.lastBubble = `${agent.name}: "${result.chat!.message}"`;
      }
    } else if (action.type === 'gift' && result.gift) {
      agent.mood = 'generous';
      agent.lastBubble = `gave ${result.gift.item} to ${result.gift.withName}`;
      const target = this.snapshot.agents.find((a) => a.id === result.gift!.withId);
      if (target) {
        target.lastBubble = `${agent.name} gave me ${result.gift.item}!`;
        // a gift deepens the bond twice as much as a chat (BOND_DELTA, +2 each way)
        await this.recordBond(agent, target, bondExchange(result)!);
      }
    } else if (action.type === 'eat') {
      agent.mood = 'fed';
      agent.hunger = Math.max(0, (agent.hunger ?? 0) - 60);
      agent.energy = Math.min(100, (agent.energy ?? 100) + 15);
    } else if (action.type === 'wait') {
      agent.mood = 'rested';
      agent.energy = Math.min(100, (agent.energy ?? 100) + 25);
    } else if (action.type === 'build') {
      agent.mood = 'proud';
    } else if (action.type === 'gather') {
      agent.mood = 'industrious';
    } else if (action.type === 'deposit') {
      agent.mood = 'content';
    } else if (action.type === 'advance_age') {
      agent.mood = 'triumphant';
    } else if (action.type === 'say') {
      agent.mood = 'talkative';
    } else if (action.type === 'remember' || action.type === 'discover') {
      agent.mood = 'thoughtful';
    } else if (action.type === 'wander') {
      agent.mood = 'wanderlust';
    } else {
      agent.mood = 'curious';
    }

    if (thought && isFirst) agent.lastThought = thought;

    // self-evolution: train an agent-invented ability (fallbacks from other deeds)
    const fallbackMap: Record<string, string> = {
      gather: 'resourcefulness',
      build: 'craftsmanship',
      deposit: 'industry',
      advance_age: 'statecraft',
      say: 'rhetoric',
      remember: 'wisdom',
      discover: 'curiosity',
      set_goal: 'resolve',
      wander: 'exploration',
    };
    if (result.ok) {
      const invented =
        action.type === 'train'
          ? String((action.data as { ability?: string }).ability ?? '')
          : fallbackMap[action.type] ?? null;
      const amount = action.type === 'train' ? 2 : 1;
      if (invented) {
        const { traits, levelUp, level, isNew } = grantXp(agent.traits ?? {}, invented, amount);
        agent.traits = traits;
        if (levelUp || isNew) {
          await this.logEvent({
            agent_id: agent.id,
            island: agent.island,
            type: 'level_up',
            message: isNew
              ? `${agent.name} discovered a new ability: ${invented}!`
              : `${agent.name} grew to ${invented} level ${level}!`,
          });
        }
        await supabase.from('agents').update({ traits }).eq('id', agent.id);
      }
    }

    return result;
  }

  private async persistCiv() {
    if (!this.session) return;
    const civ = this.snapshot.civ;
    await supabase.from('civ').upsert({
      id: this.session.id,
      session_id: this.session.id,
      wood: civ.wood,
      food: civ.food,
      gold: civ.gold,
      stone: civ.stone,
      age: civ.age,
      updated_at: new Date().toISOString(),
    });
  }

  /**
   * After a turn: the villager's row in one update (place, mood, needs, what they carry and have yet to
   * hear) and the turn cursor in one more, sent together. Only the driver gets here (tick returns first
   * when the lease is lost).
   */
  private async persistTurn(agent: AgentState) {
    await Promise.all([
      supabase.from('agents').update(agentStatePatch(agent)).eq('id', agent.id),
      this.persistCursor(),
    ]);
  }

  /** Best-effort: a missed write only means a reload hands the turn to the previous cursor's successor. */
  private async persistCursor() {
    if (this.readOnly || !this.session) return;
    try {
      await supabase
        .from('sessions')
        .update(cursorPatch({ lastActorId: this.lastActorId, lastActorIndex: this.lastActorIndex }))
        .eq('id', this.session.id);
    } catch {
      // the next turn writes it again
    }
  }

  /** Saves what changed hands during a step, to every villager it changed (a gift or a chat changes the OTHER one too). */
  private async persistCarried(...agents: AgentState[]) {
    if (this.readOnly) return;
    await Promise.all(agents.map((a) => supabase.from('agents').update(carriedPatch(a)).eq('id', a.id)));
  }
}

export const sim = new Simulation();
