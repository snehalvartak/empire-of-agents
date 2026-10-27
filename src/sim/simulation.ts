import { supabase } from '@/lib/supabase';
import type { ActionInput, AgentState, CivState, TerritoryId, WorldObject, WorldSnapshot } from './world';
import { isRoad, observe, seedObjects, step, territoryAt } from './world';
import { callBrainWithRetry, systemPrompt } from './brain';
import { grantXp, sanitizeTraits } from './traits';

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
}

const MODELS_DEFAULT = 'deepseek/deepseek-v4.1-flash';

interface Goal {
  text: string;
  createdAt: number;
}

interface RelationshipRow {
  withId: string;
  withName: string;
  strength: number;
  lastMessage: string | null;
}

function sanitizeGoals(raw: unknown): Goal[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((g) => g && typeof g === 'object' && typeof (g as Goal).text === 'string')
    .map((g) => ({ text: String((g as Goal).text).slice(0, 160), createdAt: Number((g as Goal).createdAt) || 0 }))
    .slice(0, 3);
}
type Listener = () => void;

class Simulation {
  snapshot: WorldSnapshot = {
    tick: 0,
    agents: [],
    objects: [],
    civ: { wood: 0, food: 0, gold: 0, stone: 0, age: 1 },
  };
  history: WorldSnapshot[] = [];
  running = false;
  speed: 'slow' | 'normal' | 'fast' = 'normal';
  error: string | null = null;
  focusAgent: string | null = null;
  session: SessionRow | null = null;
  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private memoriesCache = new Map<string, string[]>();
  private pendingRespawns = new Map<string, { id: string; respawnAt: number }>();
  private relationshipsCache = new Map<string, Map<string, RelationshipRow>>();

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
    this.stop();
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
      })
      .eq('id', sid);
    if (error) {
      this.error = 'Could not archive the session.';
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
    this.memoriesCache.clear();
    this.history = [];
    this.snapshot = {
      tick: 0,
      agents: [],
      objects: seedObjects(),
      civ: { wood: 0, food: 0, gold: 0, stone: 0, age: 1 },
    };
    this.emit();
    await this.resumeOrCreateSession();
    if (!this.session) return false;
    if (!carryMemories) {
      await supabase.from('sessions').update({ carry_memories: false }).eq('id', this.session.id);
      this.session.carry_memories = false;
    }
    await this.seedStartingVillagers();
    await this.loadWorld();
    return true;
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

  private async loadWorld() {
    if (!this.session) return;
    const sid = this.session.id;
    const { data: agentRowsData, error } = await supabase
      .from('agents')
      .select('*')
      .eq('session_id', sid)
      .order('created_at', { ascending: true });
    let agentRows = agentRowsData;
    if (error) {
      this.error = 'Could not load villagers from the database.';
      this.emit();
      return;
    }

    if (!agentRows || agentRows.length === 0) {
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
        .order('created_at', { ascending: true });
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

    // depleted seeds: mines taken this session, plus animals not yet respawned
    const now = Date.now();
    const { data: depletedRows } = await supabase
      .from('depleted_objects')
      .select('*')
      .eq('session_id', sid);
    const depletedIds = new Set(
      (depletedRows ?? [])
        .filter((r) => !r.respawn_at || new Date(r.respawn_at).getTime() > now)
        .map((r) => r.id as string)
    );
    const seeds = seedObjects().filter((o) => !depletedIds.has(o.id));

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
      inventory: [],
      traits: sanitizeTraits(row.traits),
      goals: sanitizeGoals(row.goals),
      hunger: row.hunger ?? 0,
      energy: row.energy ?? 100,
    }));
    await this.hydrateRelationships(agents);

    this.snapshot = {
      tick: 0,
      agents,
      objects: [...seeds, ...builtStructures],
      civ,
    };
    this.history = [];
    this.pushHistory();
    this.emit();
  }

  async addAgent(a: {
    name: string;
    model: string;
    color: string;
    island: TerritoryId;
    persona: string;
  }) {
    if (!this.session) {
      this.error = 'No live session.';
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
        position: { x: 2 + Math.floor(Math.random() * 5), y: 2 + Math.floor(Math.random() * 5) },
        persona: a.persona,
        mood: 'curious',
        status: 'idle',
      })
      .select()
      .single();
    if (error) {
      this.error = 'Could not add villager.';
      this.emit();
      return;
    }
    this.memoriesCache.delete(data.id);
    await this.loadWorld();
    await this.logEvent({
      agent_id: data.id,
      island: data.island,
      type: 'system',
      message: `${data.name} joins the empire in ${data.island}.`,
    });
  }

  async removeAgent(id: string) {
    await supabase.from('agents').delete().eq('id', id);
    this.memoriesCache.delete(id);
    await this.loadWorld();
  }

  /** Archival reset: used by the deploy hook. Ends the live session; data is kept. */
  async resetWorld() {
    await this.endSession();
    this.memoriesCache.clear();
    this.snapshot = {
      tick: 0,
      agents: [],
      objects: seedObjects(),
      civ: { wood: 0, food: 0, gold: 0, stone: 0, age: 1 },
    };
    this.history = [];
    this.emit();
  }

  private async seedStartingVillagers(): Promise<boolean> {
    if (!this.session) return false;
    const seeded = await supabase
      .from('agents')
      .insert([
        {
          session_id: this.session.id,
          name: 'Alder',
          model: MODELS_DEFAULT,
          color: '#e2b04a',
          island: 'forest',
          position: { x: 3, y: 3 },
          persona: 'Restless and easily bored. Starts five things at once, finishes three.',
          mood: 'curious',
          status: 'idle',
        },
        {
          session_id: this.session.id,
          name: 'Bramble',
          model: MODELS_DEFAULT,
          color: '#4ade80',
          island: 'valley',
          position: { x: 4, y: 4 },
          persona: 'Warm and talkative. Greets strangers, collects gossip, remembers birthdays.',
          mood: 'curious',
          status: 'idle',
        },
      ])
      .select();
    if (seeded.error) {
      console.error('Seeding villagers failed:', seeded.error.message);
      return false;
    }
    await this.logEvent({
      agent_id: null,
      island: null,
      type: 'system',
      message: 'Alder and Bramble arrive to found the empire.',
    });
    return true;
  }

  async logEvent(e: {
    agent_id: string | null;
    island: TerritoryId | null;
    type: string;
    message: string;
  }) {
    await supabase.from('events').insert({
      session_id: this.session?.id ?? null,
      agent_id: e.agent_id,
      island: e.island,
      type: e.type,
      message: e.message,
    });
  }

  async getMemories(agentId: string, agentName: string): Promise<string[]> {
    const cacheKey = `${this.session?.id ?? 'none'}:${agentId}`;
    const cached = this.memoriesCache.get(cacheKey);
    if (cached) return cached;

    let rows: Array<{ content: string; kind: string }> = [];
    // villagers remember by name across sessions: a new Alder inherits the
    // chronicles of every past Alder — unless this session is amnesiac
    const carryMemories = this.session ? this.session.carry_memories : true;
    if (carryMemories) {
      const { data: namesakes } = await supabase.from('agents').select('id').eq('name', agentName);
      const ids = (namesakes ?? []).map((r) => r.id as string);
      if (ids.length > 0) {
        const { data } = await supabase
          .from('memories')
          .select('content, kind')
          .in('agent_id', ids)
          .order('created_at', { ascending: false })
          .limit(30);
        rows = data ?? [];
      }
    } else {
      const { data } = await supabase
        .from('memories')
        .select('content, kind')
        .eq('agent_id', agentId)
        .order('created_at', { ascending: false })
        .limit(30);
      rows = data ?? [];
    }

    // layered like Eko's workspace: durable knowledge first, then discoveries, then the diary
    const knowledge = rows.filter((r) => r.kind === 'semantic').slice(0, 6).map((r) => `[knowledge] ${r.content}`);
    const discoveries = rows.filter((r) => r.kind === 'discovery').slice(0, 6).map((r) => `[discovery] ${r.content}`);
    const episodes = rows.filter((r) => r.kind === 'episodic').slice(0, 8).map((r) => `[lately] ${r.content}`);
    const list = [...knowledge, ...discoveries, ...episodes];
    this.memoriesCache.set(cacheKey, list);
    return list;
  }

  invalidateMemories(agentId: string) {
    this.memoriesCache.delete(agentId);
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

  private async recordChat(from: AgentState, to: AgentState, message: string) {
    await this.bumpRelationship(from, to, message);
    await this.bumpRelationship(to, from, message);
    const { data: countRow } = await supabase
      .from('agents')
      .select('chat_count')
      .eq('id', from.id)
      .maybeSingle();
    await supabase.from('agents').update({ chat_count: (countRow?.chat_count ?? 0) + 1 }).eq('id', from.id);
  }

  private async bumpRelationship(a: AgentState, other: AgentState, lastMessage: string) {
    let rels = this.relationshipsCache.get(a.id);
    if (!rels) {
      rels = new Map();
      this.relationshipsCache.set(a.id, rels);
    }
    const existing = rels.get(other.name);
    if (existing) {
      existing.strength += 1;
      existing.lastMessage = lastMessage;
      await supabase
        .from('relationships')
        .update({ strength: existing.strength, last_chat_at: new Date().toISOString() })
        .eq('a_id', [a.id, other.id].sort()[0])
        .eq('b_id', [a.id, other.id].sort()[1]);
    } else {
      rels.set(other.name, { withId: other.id, withName: other.name, strength: 1, lastMessage });
      const pair = [a.id, other.id].sort();
      const { error } = await supabase
        .from('relationships')
        .upsert(
          { a_id: pair[0], b_id: pair[1], strength: 1, session_id: this.session?.id ?? null },
          { onConflict: 'a_id,b_id' }
        );
      if (error) console.error('relationship upsert failed:', error.message);
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.error = null;
    this.schedule();
    this.emit();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.emit();
  }

  setSpeed(s: 'slow' | 'normal' | 'fast') {
    this.speed = s;
    this.emit();
  }

  private schedule() {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), this.delay());
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

    const idx = this.snapshot.tick % agents.length;
    const agent = agents[idx];

    this.respawnAnimals();
    this.applyNeeds(agent);

    try {
      await this.runAgentTurn(agent);
      this.error = null;
    } catch (err) {
      agent.status = 'idle';
      this.error = err instanceof Error ? err.message : 'Simulation error';
    }

    this.snapshot.tick++;
    await this.updateAgentRow(agent);
    await this.persistNeeds(agent);
    this.pushHistory();
    this.emit();
    this.schedule();
  }

  private pushHistory() {
    const s = this.snapshot;
    this.history.push({
      tick: s.tick,
      agents: s.agents.map((a) => ({ ...a, pos: { ...a.pos } })),
      objects: s.objects.map((o) => ({ ...o, pos: { ...o.pos } })),
      civ: { ...s.civ },
    });
    if (this.history.length > 400) this.history.shift();
  }

  /** Gathered animals quietly return to their herds once their time is up. */
  private respawnAnimals() {
    const now = Date.now();
    for (const [key, row] of this.pendingRespawns) {
      if (now < row.respawnAt) continue;
      const seed = seedObjects().find((o) => o.id === row.id);
      if (seed && !this.snapshot.objects.some((o) => o.pos.x === seed.pos.x && o.pos.y === seed.pos.y)) {
        this.snapshot.objects.push(seed);
        this.snapshot.objects = [...this.snapshot.objects];
      }
      this.pendingRespawns.delete(key);
    }
  }

  private async runAgentTurn(agent: AgentState) {
    this.focusAgent = agent.id;
    agent.status = 'thinking';
    this.emit();

    const memories = await this.getMemories(agent.id, agent.name);
    agent.relationships = await this.getRelationships(agent);
    const sys = systemPrompt(agent, memories);
    const obs = observe(this.snapshot, agent);

    const decision = await callBrainWithRetry(agent.model, sys, obs);
    agent.status = 'acting';
    this.emit();

    const steps =
      decision.action.type === 'plan'
        ? (decision.action.data as { steps: ActionInput[] }).steps
        : [decision.action];

    for (let i = 0; i < steps.length; i++) {
      const result = await this.executeAction(agent, steps[i], decision.thought, i === 0);
      // a failed step doesn't cancel the rest of the plan — villagers adapt
    }

    agent.status = 'idle';
    this.focusAgent = null;
  }

  private async executeAction(
    agent: AgentState,
    action: ActionInput,
    thought: string,
    isFirst: boolean
  ): Promise<import('./world').ActionResult> {
    const result = step(this.snapshot, agent.id, action);
    agent.island = territoryAt(agent.pos) ?? agent.island;

    await this.logEvent({
      agent_id: agent.id,
      island: agent.island,
      type: action.type,
      message: `${agent.name}: ${result.message}`,
    });

    if (result.memory) {
      await supabase.from('memories').insert({
        session_id: this.session?.id ?? null,
        agent_id: agent.id,
        kind: result.memory.kind,
        content: result.memory.content,
        island: agent.island,
      });
      this.invalidateMemories(agent.id);
    }

    // the villager's diary: every deed becomes an episodic memory it can consult later
    if (result.ok && action.type !== 'remember' && action.type !== 'discover') {
      await supabase.from('memories').insert({
        session_id: this.session?.id ?? null,
        agent_id: agent.id,
        kind: 'episodic',
        content: result.message.slice(0, 240),
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
      const respawnAt = result.depleted.respawnAt
        ? new Date(result.depleted.respawnAt).toISOString()
        : null;
      await supabase.from('depleted_objects').upsert({
        id: result.depleted.id,
        session_id: this.session?.id ?? null,
        respawn_at: respawnAt,
      });
      if (result.depleted.respawnAt) {
        this.pendingRespawns.set(`${this.session?.id ?? ''}:${result.depleted.id}`, {
          id: result.depleted.id,
          respawnAt: result.depleted.respawnAt,
        });
      }
    }

    // mood flavor
    if (!result.ok) {
      agent.mood = 'frustrated';
    } else if (action.type === 'chat') {
      agent.mood = 'chatty';
      agent.lastBubble = `to ${result.chat!.withName}: "${result.chat!.message}"`;
      const target = this.snapshot.agents.find((a) => a.id === result.chat!.withId);
      if (target) {
        await this.recordChat(agent, target, result.chat!.message);
        target.lastBubble = `${agent.name}: "${result.chat!.message}"`;
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
    } else {
      agent.mood = 'curious';
    }

    if (thought && isFirst) {
      agent.lastThought = thought;
      await this.logEvent({
        agent_id: agent.id,
        island: agent.island,
        type: 'thought',
        message: `${agent.name} thinks: ${thought}`,
      });
    }

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

  private async updateAgentRow(agent: AgentState) {
    await supabase
      .from('agents')
      .update({
        position: agent.pos,
        island: agent.island,
        mood: agent.mood,
        status: agent.status,
      })
      .eq('id', agent.id);
  }

  private async persistNeeds(agent: AgentState) {
    await supabase
      .from('agents')
      .update({ hunger: Math.round(agent.hunger), energy: Math.round(agent.energy) })
      .eq('id', agent.id);
  }
}

export const sim = new Simulation();
