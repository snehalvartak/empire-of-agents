import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Brain, BookOpen, ScrollText, Swords, TreePine, Wheat, Coins, Mountain, History, UserSearch,
  Archive, PlayCircle, Eye, ArrowLeft, Zap, Volume2, VolumeX, ChartNoAxesColumn, Lightbulb, Music,
} from 'lucide-react';
import { Timeline, Discoveries, type TimelineEvent, type DiscoveryEntry, type KeyMoment } from '@/components/PaperViews';
import { ReplayControls } from '@/components/ReplayPlayer';
import { toReplayCheckpoint, useReplayPlayer, type ReplayCheckpoint } from '@/components/replay';
import { detectKeyMoments } from '@/components/paperUtils';
import { useHeatmap } from '@/components/Heatmap';
import { Panel } from '@/components/ui/Pixel';
import { supabase } from '@/lib/supabase';
import { sim } from '@/sim/simulation';
import type { SessionRow } from '@/sim/simulation';
import { soundOn, setSoundOn, playEventSound } from '@/lib/sounds';
import { VoxelWorld } from '@/components/VoxelWorld';
import { AgentAvatar } from '@/components/AgentAvatar';
import type { TerritoryId, WorldSnapshot } from '@/sim/world';
import { AGE_COSTS, AGE_NAMES, MAX_VILLAGERS, TERRITORIES, seedObjects } from '@/sim/world';

interface EventRow {
  id: string;
  session_id?: string | null;
  agent_id: string | null;
  island: string | null;
  type: string;
  message: string;
  created_at: string;
}

interface MemoryRow {
  id: string;
  session_id?: string | null;
  agent_id: string;
  kind: string;
  content: string;
  created_at: string;
}

interface AgentRow {
  id: string;
  name: string;
  model: string;
  color: string;
  island: string;
  mood: string;
  status: string;
  persona: string;
  traits?: Record<string, { level: number; xp: number }>;
  goals?: Array<{ text: string; createdAt: number }>;
  hunger?: number;
  energy?: number;
}

interface CivRow {
  wood: number;
  food: number;
  gold: number;
  stone: number;
  age: number;
}

const MODELS = [
  { id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash (cheap)' },
  { id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash (cheap)' },
];

const COLORS = ['#e2b04a', '#4ade80', '#38bdf8', '#f87171', '#c084fc', '#fb923c', '#2dd4bf', '#facc15'];
const PERSONAS = [
  'Restless and easily bored. Starts five things at once, finishes three.',
  'Grumpy but observant. Complains first, notices everything.',
  'Playful and inventive. Turns work into little games with made-up rules.',
  'Quiet and stubborn. Watches for a long time, then acts without warning.',
  'Bold and impatient. Would rather try and fail than stand and wonder.',
  'Warm and talkative. Greets strangers, collects gossip, remembers birthdays.',
  'Melancholy and poetic. Sees signs and omens in ordinary weather.',
  'Proud and particular. Insists things be done properly, and by themselves.',
  'Dreamy and distractible. Follows butterflies mid-errand and never apologizes.',
  'Practical and unimpressed. Trusts what worked yesterday, suspicious of novelty.',
  'Cheerful and lucky. Accidentally finds things and cannot explain how.',
  'Careful and methodical. Writes everything down, twice, in order.',
];

function ResourceIcon({ kind }: { kind: 'wood' | 'food' | 'gold' | 'stone' }) {
  const cls = 'h-3.5 w-3.5';
  switch (kind) {
    case 'wood': return <TreePine className={cls} />;
    case 'food': return <Wheat className={cls} />;
    case 'gold': return <Coins className={cls} />;
    case 'stone': return <Mountain className={cls} />;
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function WorldApp() {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [memories, setMemories] = useState<MemoryRow[]>([]);
  const [civ, setCiv] = useState<CivRow>({ wood: 0, food: 0, gold: 0, stone: 0, age: 1 });
  const [running, setRunning] = useState(sim.running);
  const [driverNote, setDriverNote] = useState<string | null>(sim.driverNote);
  const [speed, setSpeed] = useState(sim.speed);
  const [error, setError] = useState<string | null>(sim.error);
  const [tick, setTick] = useState(0);
  const [feedFilter, setFeedFilter] = useState<string | null>(null);
  const [memoryAgent, setMemoryAgent] = useState<string | null>(null);
  const [memorySearch, setMemorySearch] = useState('');
  const [suspectedFalse, setSuspectedFalse] = useState<Set<string>>(new Set());
  const [heatRows, setHeatRows] = useState<Array<{ agent_id: string; x: number; y: number }>>([]);
  const [heatmapOn, setHeatmapOn] = useState(false);
  const [tab, setTab] = useState<'log' | 'timeline' | 'memories' | 'minds' | 'discoveries' | 'replay'>('log');
  const [sayEvent, setSayEvent] = useState<{ id: string; agentId: string; message: string } | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [model, setModel] = useState(MODELS[0].id);
  const [territory, setTerritory] = useState<TerritoryId>('forest');
  const [persona, setPersona] = useState(PERSONAS[0]);
  const [adding, setAdding] = useState(false);

  const [showSettings, setShowSettings] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [keyStatus, setKeyStatus] = useState<'unknown' | 'set' | 'missing'>('unknown');
  const [replayTick, setReplayTick] = useState(0);
  const [inspectAgent, setInspectAgent] = useState<string | null>(null);

  // session state
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(sim.session?.id ?? null);
  const [sessionTitle, setSessionTitle] = useState<string | null>(sim.session?.title ?? null);
  const [viewing, setViewing] = useState<'live' | string>('live');
  const [archivedSnapshot, setArchivedSnapshot] = useState<WorldSnapshot | null>(null);
  const [checkpoints, setCheckpoints] = useState<ReplayCheckpoint[]>([]);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [showNewSession, setShowNewSession] = useState(false);
  const [carryMemories, setCarryMemories] = useState(true);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [cpTicks, setCpTicks] = useState<Record<string, number>>({});
  const [forkBusy, setForkBusy] = useState<string | null>(null);
  const [confirmFork, setConfirmFork] = useState<string | null>(null);
  const [forkNotice, setForkNotice] = useState<{ id: string; ok: boolean; message: string } | null>(null);
  const [endedNotice, setEndedNotice] = useState<string | null>(null);
  const [hotbarFocus, setHotbarFocus] = useState<string | null>(null);
  const [bubblesOn, setBubblesOn] = useState(() => {
    try {
      return localStorage.getItem('bubblesOn') !== 'off';
    } catch {
      return true;
    }
  });
  const [sound, setSound] = useState(() => soundOn());
  const [civDeltas, setCivDeltas] = useState<Record<string, number>>({});
  const prevCivRef = useRef<CivRow | null>(null);

  useEffect(() => {
    void loadAll();
    const unsub = sim.subscribe(() => {
      setRunning(sim.running);
      setDriverNote(sim.driverNote);
      setSpeed(sim.speed);
      setError(sim.error);
      setTick(sim.snapshot.tick);
      setCiv({ ...sim.snapshot.civ });
      const prev = prevCivRef.current;
      if (prev && (prev.wood !== sim.snapshot.civ.wood || prev.food !== sim.snapshot.civ.food || prev.gold !== sim.snapshot.civ.gold || prev.stone !== sim.snapshot.civ.stone)) {
        setCivDeltas({
          wood: sim.snapshot.civ.wood - prev.wood,
          food: sim.snapshot.civ.food - prev.food,
          gold: sim.snapshot.civ.gold - prev.gold,
          stone: sim.snapshot.civ.stone - prev.stone,
        });
      }
      prevCivRef.current = { ...sim.snapshot.civ };
      setAgents(
        sim.snapshot.agents.map((a) => ({
          id: a.id,
          name: a.name,
          model: a.model,
          color: a.color,
          island: a.island,
          mood: a.mood,
          status: a.status,
          persona: a.persona,
          traits: a.traits,
          goals: a.goals,
          hunger: Math.round(a.hunger),
          energy: Math.round(a.energy),
        }))
      );
      if (sim.session && sim.session.id !== sessionId) {
        setSessionId(sim.session.id);
        setSessionTitle(sim.session.title);
      }
    });
    const channel = supabase
      .channel('world-feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'events' }, (payload) => {
        const row = payload.new as EventRow;
        if (viewing !== 'live' || row.session_id !== sim.session?.id) return;
        setEvents((prev) => [row, ...prev].slice(0, 100));
        playEventSound(row.type);
        if (row.type === 'say' && row.agent_id) {
          setSayEvent({ id: row.id, agentId: row.agent_id, message: row.message.replace(/^[^:]*:\s*/, '') });
        }
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'memories' }, (payload) => {
        const row = payload.new as MemoryRow;
        if (viewing !== 'live' || row.session_id !== sim.session?.id) return;
        setMemories((prev) => [row, ...prev].slice(0, 120));
      })
      .subscribe();
    return () => {
      unsub();
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // hotbar keys 1-9 select villagers
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > 9) return;
      const a = agents[n - 1];
      if (a) setHotbarFocus((cur) => (cur === a.id ? null : a.id));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [agents]);

  function toggleBubbles() {
    setBubblesOn((v) => {
      const next = !v;
      try {
        localStorage.setItem('bubblesOn', next ? 'on' : 'off');
      } catch {
        /* private mode */
      }
      return next;
    });
  }

  function toggleSound() {
    setSound((v) => {
      const next = !v;
      setSoundOn(next);
      return next;
    });
  }

  async function loadAll() {
    await sim.load();
    setSessionId(sim.session?.id ?? null);
    setSessionTitle(sim.session?.title ?? null);
    await refreshSessions();
    if (sim.session) await loadFeed(sim.session.id);
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/settings-key`, {
      headers: { 'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}` },
    });
    if (res.ok) {
      const body = await res.json();
      if (typeof body?.set === 'boolean') setKeyStatus(body.set ? 'set' : 'missing');
    }
  }

  async function refreshSessions() {
    const { data } = await supabase.from('sessions').select('*').order('seq', { ascending: false });
    setSessions((data ?? []) as unknown as SessionRow[]);
    // latest checkpoint per era: "Continue from here" needs one to exist
    const { data: cps } = await supabase.from('checkpoints').select('session_id, tick');
    const latest: Record<string, number> = {};
    for (const c of cps ?? []) if (c.session_id) latest[c.session_id] = Math.max(latest[c.session_id] ?? 0, c.tick);
    setCpTicks(latest);
  }

  /** Forks a new live era from an archived era's latest checkpoint; a live era must be ended first, so ask once. */
  async function continueFrom(s: SessionRow) {
    if (sessionId && confirmFork !== s.id) {
      setConfirmFork(s.id);
      return;
    }
    setConfirmFork(null);
    setForkBusy(s.id);
    const res = await sim.forkFromCheckpoint(s.id);
    setForkBusy(null);
    setForkNotice({ id: s.id, ok: res.ok, message: res.message });
    setSessionId(sim.session?.id ?? null);
    setSessionTitle(sim.session?.title ?? null);
    if (res.ok) {
      setEndedNotice(null);
      setViewing('live');
      setArchivedSnapshot(null);
      setCheckpoints([]);
      setInspectAgent(null);
    }
    await refreshSessions();
    if (res.ok && sim.session) await loadFeed(sim.session.id);
  }

  async function loadFeed(sid: string) {
    const { data: eventRows } = await supabase
      .from('events')
      .select('*')
      .eq('session_id', sid)
      .order('created_at', { ascending: false })
      .limit(100);
    const { data: memoryRows } = await supabase
      .from('memories')
      .select('*')
      .eq('session_id', sid)
      .order('created_at', { ascending: false })
      .limit(120);
    setEvents(eventRows ?? []);
    setMemories(memoryRows ?? []);
  }

  /** Opens an archived session read-only: final world + its chronicle. */
  async function viewArchived(s: SessionRow) {
    const { data: cpRows } = await supabase
      .from('checkpoints')
      .select('tick, snapshot')
      .eq('session_id', s.id)
      .order('tick', { ascending: true });
    const cps = (cpRows ?? []).flatMap((r) => toReplayCheckpoint(r) ?? []);
    setCheckpoints(cps);
    replay.reset(0);
    const { data: agentRows } = await supabase.from('agents').select('*').eq('session_id', s.id);
    const { data: builtRows } = await supabase.from('structures').select('*').eq('session_id', s.id);
    const { data: civRow } = await supabase.from('civ').select('*').eq('session_id', s.id).maybeSingle();
    const built = (builtRows ?? []).filter((r) => r.kind !== 'cube');
    setArchivedSnapshot({
      tick: s.ticks ?? 0,
      agents: (agentRows ?? []).map((row) => ({
        id: row.id,
        name: row.name,
        model: row.model,
        color: row.color,
        island: row.island as TerritoryId,
        pos: row.position as { x: number; y: number },
        mood: row.mood,
        persona: row.persona,
        status: 'idle',
        inventory: [],
        traits: row.traits ?? {},
        goals: row.goals ?? [],
        hunger: row.hunger ?? 0,
        energy: row.energy ?? 100,
      })),
      objects: [...seedObjects(), ...built.map((r) => ({
        id: r.id,
        territory: r.territory as TerritoryId,
        pos: r.position as { x: number; y: number },
        kind: r.kind,
        builtBy: r.built_by,
      }))],
      civ: civRow
        ? { wood: civRow.wood, food: civRow.food, gold: civRow.gold, stone: civRow.stone, age: civRow.age }
        : { wood: s.wood ?? 0, food: s.food ?? 0, gold: s.gold ?? 0, stone: s.stone ?? 0, age: s.age ?? 1 },
      nextId: 1,
    });
    setViewing(s.id);
    setInspectAgent(null);
    await loadFeed(s.id);
  }

  function returnToLive() {
    setViewing('live');
    setArchivedSnapshot(null);
    setCheckpoints([]);
    setInspectAgent(null);
    setReplayTick(0);
    replay.reset(0);
    if (sim.session) void loadFeed(sim.session.id);
  }

  async function endSession() {
    setSessionBusy(true);
    const title = await sim.endSession();
    setConfirmEnd(false);
    setSessionBusy(false);
    setSessionId(null);
    setSessionTitle(null);
    if (title) setEndedNotice(title);
    await refreshSessions();
  }

  async function startNewSession() {
    setSessionBusy(true);
    const ok = await sim.startSession(carryMemories);
    setSessionBusy(false);
    setShowNewSession(false);
    if (ok) {
      setEndedNotice(null);
      setSessionId(sim.session?.id ?? null);
      setSessionTitle(sim.session?.title ?? null);
      await refreshSessions();
      if (sim.session) await loadFeed(sim.session.id);
    }
  }

  async function addAgent() {
    if (!name.trim()) return;
    setAdding(true);
    const color = COLORS[agents.length % COLORS.length];
    await sim.addAgent({ name: name.trim(), model, color, island: territory, persona });
    setName('');
    setAdding(false);
    setShowAdd(false);
  }

  async function saveKey() {
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/settings-key`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ key: apiKey.trim() }),
    });
    if (!res.ok) {
      setKeyStatus('missing');
      setError('Could not save the API key. Try again.');
    } else {
      setKeyStatus('set');
    }
    setApiKey('');
    setShowSettings(false);
  }

  const inspectAgentState = sim.history.length
    ? sim.history[Math.min(replayTick, sim.history.length - 1)].agents.find((a) => a.id === inspectAgent)
    : undefined;
  const inspectEvents = useMemo(
    () => events.filter((e) => e.agent_id === inspectAgent).slice(0, 40),
    [events, inspectAgent]
  );
  const replayCiv = sim.history.length ? sim.history[Math.min(replayTick, sim.history.length - 1)].civ : null;

  const replay = useReplayPlayer(checkpoints, viewing !== 'live' && checkpoints.length > 0);
  const heatTiles = useHeatmap(heatRows);
  const viewingArchived = viewing !== 'live' ? sessions.find((s) => s.id === viewing) ?? null : null;
  const replayActive = viewingArchived !== null && checkpoints.length > 0;
  const worldSnapshot = replayActive && replay.current ? replay.current.snapshot : viewingArchived ? archivedSnapshot : sim.snapshot;

  const statusDot = (s: string) =>
    s === 'thinking' ? 'bg-amber-400 animate-pulse' : s === 'acting' ? 'bg-emerald-400' : 'bg-stone-500';

  return (
    <div className="min-h-screen bg-[#15100a] text-amber-50">
      {/* header */}
      <header className="border-b-2 border-amber-900/50 bg-gradient-to-b from-[#2a2118] to-[#1c1610] shadow-lg">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-amber-700/60 bg-amber-900/30 text-amber-400">
              <Swords size={20} />
            </div>
            <div>
              <h1 className="font-serif text-xl font-bold leading-tight tracking-wide text-amber-200">
                Empires of the Machines
              </h1>
              <p className="text-xs text-amber-100/50">
                {viewingArchived
                  ? `Replaying: ${viewingArchived.title}`
                  : sessionTitle
                    ? `Now playing: ${sessionTitle}`
                    : 'AI villagers gather, build and advance through the ages'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="mr-2 hidden text-xs text-amber-100/40 sm:block">tick {tick}</span>
            <button
              onClick={toggleBubbles}
              title={bubblesOn ? 'Speech bubbles on' : 'Speech bubbles off'}
              className="rounded-md border border-amber-800/50 p-1.5 text-amber-200/70 hover:bg-amber-900/30"
            >
              {bubblesOn ? <Volume2 size={14} /> : <VolumeX size={14} />}
            </button>
            <button
              onClick={toggleSound}
              title={sound ? 'Sound effects on' : 'Sound effects muted'}
              className="rounded-md border border-amber-800/50 p-1.5 text-amber-200/70 hover:bg-amber-900/30"
            >
              {sound ? <Music size={14} /> : <VolumeX size={14} />}
            </button>
            <button
              onClick={() => setShowSettings(true)}
              className="flex items-center gap-1.5 rounded-lg border border-amber-800/50 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-900/30"
            >
              <Brain size={14} />
              <span className={keyStatus === 'set' ? 'text-emerald-400' : 'text-amber-400'}>
                {keyStatus === 'set' ? 'Key set' : 'Add API key'}
              </span>
            </button>
            {viewingArchived ? (
              <button
                onClick={returnToLive}
                className="flex items-center gap-1.5 rounded-lg border border-amber-600/60 bg-amber-600/90 px-4 py-1.5 text-sm font-bold text-[#1a140d] hover:bg-amber-500"
              >
                <ArrowLeft size={14} /> Return to live
              </button>
            ) : sessionId ? (
              <>
                {running ? (
                  <button
                    onClick={() => sim.stop()}
                    className="rounded-lg border border-red-800/60 bg-red-950/50 px-4 py-1.5 text-sm font-medium text-red-200 hover:bg-red-900/50"
                  >
                    Halt
                  </button>
                ) : (
                  <button
                    onClick={() => void sim.start()}
                    disabled={agents.length === 0}
                    className="rounded-lg border border-amber-600/60 bg-amber-600/90 px-4 py-1.5 text-sm font-bold text-[#1a140d] hover:bg-amber-500 disabled:opacity-40"
                  >
                    {driverNote ? 'Try to take over' : 'Begin'}
                  </button>
                )}
                <button
                  onClick={() => setConfirmEnd(true)}
                  className="flex items-center gap-1.5 rounded-lg border border-amber-800/50 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-900/30"
                >
                  <Archive size={14} /> End session
                </button>
              </>
            ) : (
              <button
                onClick={() => setShowNewSession(true)}
                className="flex items-center gap-1.5 rounded-lg border border-amber-600/60 bg-amber-600/90 px-4 py-1.5 text-sm font-bold text-[#1a140d] hover:bg-amber-500"
              >
                <PlayCircle size={14} /> New session
              </button>
            )}
          </div>
        </div>
      </header>

      {/* resource bar with age progress and per-tick deltas */}
      <div className="border-b border-amber-900/40 bg-[#1c1610]/90">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-1 px-6 py-2 text-sm">
          <span className="font-serif text-sm font-bold tracking-wider text-amber-300">
            {AGE_NAMES[civ.age - 1]}
          </span>
          {civ.age < 4 && (() => {
            const cost = AGE_COSTS[civ.age];
            const ratios = [
              Math.min(1, civ.wood / Math.max(1, cost.wood)),
              Math.min(1, civ.food / Math.max(1, cost.food)),
              Math.min(1, civ.gold / Math.max(1, cost.gold)),
            ];
            const pct = Math.round((ratios.reduce((a, b) => a + b, 0) / 3) * 100);
            return (
              <span className="flex items-center gap-2" title={`Progress toward ${AGE_NAMES[civ.age]}`}>
                <span className="h-1.5 w-24 overflow-hidden rounded-full bg-amber-950">
                  <div className="h-full rounded-full bg-amber-500/80 transition-all duration-500" style={{ width: `${pct}%` }} />
                </span>
                <span className="text-[10px] text-amber-100/40">{pct}% to {AGE_NAMES[civ.age]}</span>
              </span>
            );
          })()}
          <span className="h-4 w-px bg-amber-800/50" />
          {(['wood', 'food', 'gold', 'stone'] as const).map((k) => {
            const d = civDeltas[k] ?? 0;
            return (
              <span key={k} className="flex items-center gap-1.5 text-amber-100/90">
                <ResourceIcon kind={k} />
                <span className="font-mono font-semibold">{civ[k]}</span>
                <span className="text-xs capitalize text-amber-100/50">{k}</span>
                {d !== 0 && (
                  <span className={`text-[10px] font-bold ${d > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {d > 0 ? '▲' : '▼'}{Math.abs(d)}
                  </span>
                )}
              </span>
            );
          })}
        </div>
      </div>

      <main className="mx-auto grid max-w-7xl gap-6 px-6 py-6 lg:grid-cols-[1fr_380px]">
        {/* left column */}
        <div className="space-y-4">
          {error && (
            <div className="rounded-xl border border-red-800/50 bg-red-950/40 px-4 py-3 text-sm text-red-200">
              {error}
            </div>
          )}
          {endedNotice && !sessionId && (
            <div className="rounded-xl border border-amber-700/50 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
              The chronicle closes on <span className="font-serif font-bold">{endedNotice}</span>. It is saved in the
              Replay tab forever. Begin a new session whenever you are ready.
            </div>
          )}
          {viewingArchived && (
            <div className="flex items-center justify-between rounded-xl border border-sky-800/50 bg-sky-950/40 px-4 py-3 text-sm text-sky-200">
              <span className="flex items-center gap-2">
                <Eye size={14} />
                You are watching <span className="font-serif font-bold">{viewingArchived.title}</span> (archived) — the
                world is read-only.
              </span>
              <button onClick={returnToLive} className="rounded-lg border border-sky-700/60 px-3 py-1 text-xs hover:bg-sky-900/40">
                Return to live
              </button>
            </div>
          )}

          {worldSnapshot && (
            <VoxelWorld
              snapshot={worldSnapshot}
              sayEvent={viewing === 'live' ? sayEvent : null}
              focusAgentId={hotbarFocus}
              bubblesOn={bubblesOn}
              heatmap={heatmapOn ? heatTiles : null}
            />
          )}
          <div className="flex items-center justify-between">
            <p className="text-xs text-amber-100/40">Drag to orbit the world. Scroll or pinch to zoom.</p>
            <button
              onClick={async () => {
                const next = !heatmapOn;
                setHeatmapOn(next);
                if (next && heatRows.length === 0 && sessionId) {
                  const { data } = await supabase
                    .from('agent_positions')
                    .select('agent_id, x, y')
                    .eq('session_id', sessionId)
                    .limit(5000);
                  setHeatRows((data ?? []) as Array<{ agent_id: string; x: number; y: number }>);
                }
              }}
              className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                heatmapOn
                  ? 'border-amber-500/60 bg-amber-600/25 text-amber-200'
                  : 'border-amber-900/40 text-amber-100/45 hover:text-amber-100/75'
              }`}
            >
              Heatmap
            </button>
          </div>

          {/* villager hotbar: keys 1-9, click to focus the camera */}
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {agents.slice(0, 9).map((a, i) => (
              <button
                key={a.id}
                onClick={() => setHotbarFocus((cur) => (cur === a.id ? null : a.id))}
                title={`${a.name} — press ${i + 1}`}
                className={`flex min-w-[76px] flex-col items-center gap-1 rounded-lg border-2 px-2 py-1.5 transition-colors ${
                  hotbarFocus === a.id
                    ? 'border-amber-400 bg-amber-900/40'
                    : 'border-amber-900/40 bg-[#1c1610]/70 hover:bg-amber-900/20'
                }`}
              >
                <AgentAvatar name={a.name} color={a.color} size={26} status={a.status} />
                <span className="max-w-[68px] truncate text-[10px] text-amber-100/80">{a.name}</span>
                <span className="text-[9px] font-bold text-amber-100/35">{i + 1}</span>
              </button>
            ))}
            {agents.length === 0 && (
              <span className="rounded-lg border border-amber-900/40 bg-[#1c1610]/70 px-4 py-3 text-xs text-amber-100/40">
                The island is quiet. No villagers have set out yet.
              </span>
            )}
          </div>

          {viewing === 'live' && driverNote && (
            <p className="rounded-lg border border-amber-700/40 bg-amber-900/20 px-3 py-2 text-xs text-amber-200">
              {driverNote}
            </p>
          )}

          {viewing === 'live' && (
            <div className="flex items-center gap-2 text-xs text-amber-100/60">
              <span>Chronicle pace:</span>
              {(['slow', 'normal', 'fast'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => sim.setSpeed(s)}
                  disabled={!!driverNote}
                  className={`rounded-md px-2.5 py-1 capitalize disabled:opacity-40 ${
                    speed === s
                      ? 'bg-amber-600/30 text-amber-200'
                      : 'hover:bg-amber-900/30'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {/* villager roster */}
          <Panel className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-serif text-sm font-bold tracking-wide text-amber-200">
                {viewingArchived ? 'Villagers of that age' : `Villagers (${agents.length})`}
              </h2>
              {viewing === 'live' && sessionId && (
                <button
                  onClick={() => setShowAdd((v) => !v)}
                  className="rounded-lg border border-amber-700/50 bg-amber-900/30 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-800/40"
                >
                  + Recruit villager
                </button>
              )}
            </div>

            {showAdd && viewing === 'live' && (
              <div className="mb-4 space-y-3 rounded-xl border border-amber-900/40 bg-[#15100a]/80 p-4">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Name (e.g. Aldric)"
                  className="w-full rounded-lg border border-amber-900/50 bg-[#0f0b07] px-3 py-2 text-sm text-amber-50 outline-none focus:border-amber-600/60"
                />
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full rounded-lg border border-amber-900/50 bg-[#0f0b07] px-3 py-2 text-sm text-amber-50 outline-none"
                >
                  {MODELS.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
                <select
                  value={territory}
                  onChange={(e) => setTerritory(e.target.value as TerritoryId)}
                  className="w-full rounded-lg border border-amber-900/50 bg-[#0f0b07] px-3 py-2 text-sm text-amber-50 outline-none"
                >
                  {TERRITORIES.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-xs text-amber-100/50">Profile</span>
                    <button
                      type="button"
                      onClick={() => setPersona(PERSONAS[(PERSONAS.indexOf(persona) + 1 + PERSONAS.length) % PERSONAS.length])}
                      className="text-xs text-amber-400 hover:text-amber-200"
                    >
                      Surprise me
                    </button>
                  </div>
                  <select
                    value={PERSONAS.includes(persona) ? persona : ''}
                    onChange={(e) => setPersona(e.target.value)}
                    className="w-full rounded-lg border border-amber-900/50 bg-[#0f0b07] px-3 py-2 text-sm text-amber-50 outline-none"
                  >
                    <option value="">Write your own…</option>
                    {PERSONAS.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                  <textarea
                    value={persona}
                    onChange={(e) => setPersona(e.target.value)}
                    rows={2}
                    placeholder="Describe this villager's character…"
                    className="mt-2 w-full rounded-lg border border-amber-900/50 bg-[#0f0b07] px-3 py-2 text-sm text-amber-50 outline-none focus:border-amber-600/60"
                  />
                </div>
                {agents.length >= MAX_VILLAGERS && (
                  <p className="text-xs text-red-300">
                    This world holds at most {MAX_VILLAGERS} villagers and every place is taken. Dismiss a villager to make room.
                  </p>
                )}
                <button
                  onClick={() => void addAgent()}
                  disabled={adding || !name.trim() || agents.length >= MAX_VILLAGERS || !!driverNote}
                  className="w-full rounded-lg border border-amber-600/60 bg-amber-600/90 py-2 text-sm font-bold text-[#1a140d] hover:bg-amber-500 disabled:opacity-40"
                >
                  {adding ? 'Recruiting...' : 'Join the empire'}
                </button>
              </div>
            )}

            <div className="space-y-2">
              {agents.length === 0 && (
                <p className="text-sm text-amber-100/40">
                  {viewingArchived ? 'No villagers recorded in this session.' : 'No villagers yet. Begin a session to found the empire.'}
                </p>
              )}
              {agents.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center justify-between rounded-xl border border-amber-900/30 bg-[#15100a]/60 px-3 py-2.5"
                >
                  <div className="flex items-center gap-3">
                    <AgentAvatar name={a.name} color={a.color} size={30} status={a.status} />
                    <div>
                      <div className="flex items-center gap-2 text-sm font-medium text-amber-100">
                        {a.name}
                        <span className={`h-1.5 w-1.5 rounded-full ${statusDot(a.status)}`} />
                      </div>
                      <div className="text-xs text-amber-100/40">
                        {a.model.split('/').pop()} · {TERRITORIES.find((t) => t.id === a.island)?.name ?? a.island} · {a.mood}
                      </div>
                      {a.goals && a.goals.length > 0 && (
                        <div className="mt-1 text-[11px] italic text-amber-100/50">
                          Aims: {a.goals.map((g) => g.text).join(' · ')}
                        </div>
                      )}
                      {a.traits && Object.keys(a.traits).length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {Object.entries(a.traits)
                            .sort((x, y) => y[1].level - x[1].level)
                            .slice(0, 6)
                            .map(([k, tr]) => (
                              <span
                                key={k}
                                className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] text-amber-200"
                                title={`${tr.xp} XP toward level ${tr.level + 1}`}
                              >
                                {k} {tr.level}
                              </span>
                            ))}
                        </div>
                      )}
                      {typeof a.hunger === 'number' && typeof a.energy === 'number' && (
                        <div className="mt-1.5 flex items-center gap-2">
                          <div className="flex items-center gap-1" title={`Hunger ${a.hunger}/100`}>
                            <Wheat size={10} className="text-amber-100/40" />
                            <div className="h-1 w-14 overflow-hidden rounded-full bg-amber-950">
                              <div
                                className={`h-full rounded-full ${a.hunger >= 60 ? 'bg-red-400' : 'bg-amber-500/70'}`}
                                style={{ width: `${a.hunger}%` }}
                              />
                            </div>
                          </div>
                          <div className="flex items-center gap-1" title={`Energy ${a.energy}/100`}>
                            <Zap size={10} className="text-amber-100/40" />
                            <div className="h-1 w-14 overflow-hidden rounded-full bg-amber-950">
                              <div
                                className={`h-full rounded-full ${a.energy <= 25 ? 'bg-red-400' : 'bg-sky-400/70'}`}
                                style={{ width: `${a.energy}%` }}
                              />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  {viewing === 'live' && (
                    <button
                      onClick={() => void sim.removeAgent(a.id)}
                      disabled={!!driverNote}
                      className="rounded-md px-2 py-1 text-xs text-amber-100/40 hover:bg-red-950/40 hover:text-red-300 disabled:opacity-40"
                    >
                      Dismiss
                    </button>
                  )}
                </div>
              ))}
            </div>
          </Panel>
        </div>

        {/* right column */}
        <div className="space-y-4">
          <Panel>
            <div className="flex flex-wrap border-b border-amber-900/40">
              <button
                onClick={() => setTab('log')}
                className={`flex flex-1 items-center justify-center gap-2 px-4 py-3 text-sm ${
                  tab === 'log'
                    ? 'border-b-2 border-amber-500 text-amber-200'
                    : 'text-amber-100/40'
                }`}
              >
                <ScrollText size={14} /> Chronicle
              </button>
              <button
                onClick={() => setTab('memories')}
                className={`flex flex-1 items-center justify-center gap-2 px-4 py-3 text-sm ${
                  tab === 'memories'
                    ? 'border-b-2 border-amber-500 text-amber-200'
                    : 'text-amber-100/40'
                }`}
              >
                <BookOpen size={14} /> Records
              </button>
              <button
                onClick={() => setTab('minds')}
                className={`flex flex-1 items-center justify-center gap-2 px-4 py-3 text-sm ${
                  tab === 'minds'
                    ? 'border-b-2 border-amber-500 text-amber-200'
                    : 'text-amber-100/40'
                }`}
              >
                <Brain size={14} /> Minds
              </button>
              <button
                onClick={() => setTab('timeline')}
                className={`flex flex-1 items-center justify-center gap-2 px-4 py-3 text-sm ${
                  tab === 'timeline'
                    ? 'border-b-2 border-amber-500 text-amber-200'
                    : 'text-amber-100/40'
                }`}
              >
                <ChartNoAxesColumn size={14} /> Timeline
              </button>
              <button
                onClick={() => setTab('discoveries')}
                className={`flex flex-1 items-center justify-center gap-2 px-4 py-3 text-sm ${
                  tab === 'discoveries'
                    ? 'border-b-2 border-amber-500 text-amber-200'
                    : 'text-amber-100/40'
                }`}
              >
                <Lightbulb size={14} /> Discoveries
              </button>
              <button
                onClick={() => setTab('replay')}
                className={`flex flex-1 items-center justify-center gap-2 px-4 py-3 text-sm ${
                  tab === 'replay'
                    ? 'border-b-2 border-amber-500 text-amber-200'
                    : 'text-amber-100/40'
                }`}
              >
                <History size={14} /> Replay
              </button>
            </div>
            <div className="max-h-[560px] space-y-1.5 overflow-y-auto p-3">
              {tab === 'log' && (
                <>
                  <div className="flex flex-wrap gap-1 pb-1">
                    {['all', 'gather', 'build', 'deposit', 'say', 'chat', 'advance_age', 'system'].map((f) => (
                      <button
                        key={f}
                        onClick={() => setFeedFilter(f === 'all' ? null : f)}
                        className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                          (f === 'all' && !feedFilter) || feedFilter === f
                            ? 'border-amber-500/60 bg-amber-600/25 text-amber-200'
                            : 'border-amber-900/40 bg-[#15100a]/60 text-amber-100/45 hover:text-amber-100/75'
                        }`}
                      >
                        {f.replace('_', ' ')}
                      </button>
                    ))}
                  </div>
                  {events.length === 0 ? (
                    <p className="p-2 text-sm text-amber-100/40">The chronicle is empty.</p>
                  ) : (
                    events
                      .filter((e) => !feedFilter || e.type === feedFilter)
                      .map((e) => (
                    <div key={e.id} className="rounded-lg px-3 py-2 text-sm hover:bg-amber-900/20">
                      <span
                        className={`mr-2 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                          e.type === 'advance_age'
                            ? 'bg-amber-500/25 text-amber-200'
                            : e.type === 'build'
                              ? 'bg-emerald-500/20 text-emerald-300'
                              : e.type === 'gather'
                                ? 'bg-lime-500/15 text-lime-300'
                                : e.type === 'deposit'
                                  ? 'bg-sky-500/15 text-sky-300'
                                  : e.type === 'say'
                                  ? 'bg-orange-500/15 text-orange-300'
                                  : e.type === 'chat'
                                  ? 'bg-pink-500/20 text-pink-300'
                                  : e.type === 'thought'
                                      ? 'bg-cyan-500/15 text-cyan-300 italic'
                                      : e.type === 'level_up'
                                        ? 'bg-yellow-400/20 text-yellow-300'
                                        : e.type === 'memory'
                                          ? 'bg-violet-500/15 text-violet-300'
                                          : 'bg-amber-900/40 text-amber-100/50'
                        }`}
                      >
                        {e.type.replace('_', ' ')}
                      </span>
                      <span className="text-amber-50/85">{e.message}</span>
                      {typeof (e as { tick?: number }).tick === 'number' && (
                        <span className="ml-2 text-[10px] text-amber-100/30">
                          t{(e as { tick?: number }).tick}
                        </span>
                      )}
                    </div>
                  ))
                  )}
                </>
              )}
              {tab === 'timeline' && (
                <div className="space-y-3">
                  <Timeline
                    events={events as unknown as TimelineEvent[]}
                    agents={agents.map((a) => ({ id: a.id, name: a.name, color: a.color }))}
                    onJump={(t) => {
                      setReplayTick(Math.min(t, Math.max(0, sim.history.length - 1)));
                      setTab('replay');
                    }}
                  />
                  {(() => {
                    const moments: KeyMoment[] = detectKeyMoments(
                      events as unknown as TimelineEvent[],
                      agents.map((a) => ({ id: a.id, name: a.name, color: a.color }))
                    );
                    if (moments.length === 0) return null;
                    return (
                      <div className="border-t border-amber-900/40 pt-3">
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-100/50">
                          Key moments
                        </p>
                        <div className="grid grid-cols-1 gap-2">
                          {moments.map((m, i) => (
                            <button
                              key={`${m.kind}-${i}`}
                              onClick={() => {
                                setReplayTick(Math.min(m.tick, Math.max(0, sim.history.length - 1)));
                                setTab('replay');
                              }}
                              className="rounded-xl border border-amber-900/40 bg-[#15100a]/60 px-3 py-2 text-left hover:bg-amber-900/20"
                            >
                              <div className="flex items-center gap-2">
                                <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: m.agentColor }} />
                                <span className="text-sm font-bold text-amber-200">{m.label}</span>
                                <span className="ml-auto text-[10px] text-amber-100/35">t{m.tick}</span>
                              </div>
                              <p className="mt-0.5 text-xs italic text-amber-50/70">“{m.quote}”</p>
                              <p className="text-[10px] text-amber-100/40">— {m.agentName}</p>
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
              {tab === 'minds' && (
                <div className="space-y-2">
                  {agents.length === 0 ? (
                    <p className="p-2 text-sm text-amber-100/40">No minds to watch yet.</p>
                  ) : (
                    agents.map((a) => {
                      const last = events.find((e) => e.agent_id === a.id);
                      const thought = events.find((e) => e.agent_id === a.id && e.type === 'thought');
                      const lastAction = events.find((e) => e.agent_id === a.id && e.type !== 'thought' && e.type !== 'system');
                      return (
                        <div
                          key={a.id}
                          className="rounded-xl border border-amber-900/30 bg-[#15100a]/60 px-3 py-2.5"
                        >
                          <div className="mb-1 flex items-center gap-2">
                            <AgentAvatar name={a.name} color={a.color} size={22} status={a.status} />
                            <span className="text-sm font-medium text-amber-100">{a.name}</span>
                            {lastAction && (
                              <span className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-200/70">
                                {lastAction.type.replace('_', ' ')}
                              </span>
                            )}
                            {a.status === 'thinking' && viewing === 'live' && (
                              <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-amber-400">
                                <span className="h-1.5 w-1.5 animate-ping rounded-full bg-amber-400" />
                                thinking
                              </span>
                            )}
                          </div>
                          {thought && (
                            <p className="border-l-2 border-cyan-500/50 pl-2 text-sm italic text-cyan-200/80">
                              “{thought.message.replace(/^.*? thinks: /, '')}”
                            </p>
                          )}
                          {last && last.type !== 'thought' && (
                            <p className="mt-1 text-xs text-amber-100/50">{last.message}</p>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              )}
              {tab === 'replay' && (
                <div className="space-y-3 p-2">
                  {/* session browser */}
                  <div>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-100/50">
                      Past sessions
                    </p>
                    {sessions.filter((s) => s.status === 'archived').length === 0 ? (
                      <p className="rounded-lg bg-[#15100a]/60 px-3 py-2 text-xs text-amber-100/40">
                        No archived sessions yet. End the current session to preserve it here.
                      </p>
                    ) : (
                      <div className="space-y-1.5">
                        {sessions
                          .filter((s) => s.status === 'archived')
                          .map((s) => (
                            <div key={s.id}>
                            <button
                              onClick={() => (viewing === s.id ? returnToLive() : void viewArchived(s))}
                              className={`w-full rounded-lg border px-3 py-2 text-left ${
                                viewing === s.id
                                  ? 'border-sky-600/60 bg-sky-950/40'
                                  : 'border-amber-900/30 bg-[#15100a]/60 hover:bg-amber-900/20'
                              }`}
                            >
                              <div className="flex items-center justify-between">
                                <span className="text-sm font-medium text-amber-100">{s.title}</span>
                                <span className="text-[10px] uppercase tracking-wide text-amber-100/40">
                                  {formatDate(s.started_at)}
                                </span>
                              </div>
                              <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
                                <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
                                  {AGE_NAMES[(s.age ?? 1) - 1] ?? `Age ${s.age ?? 1}`}
                                </span>
                                {(['wood', 'food', 'gold', 'stone'] as const).map((k) => (
                                  <span key={k} className="flex items-center gap-0.5 text-[11px] text-amber-100/70">
                                    <ResourceIcon kind={k} />
                                    {s[k] ?? 0}
                                  </span>
                                ))}
                                <span className="text-[10px] text-amber-100/35">t{s.ticks ?? 0}</span>
                              </div>
                              {s.summary && (
                                <div className="mt-0.5 text-xs text-amber-100/50">{s.summary}</div>
                              )}
                            </button>
                            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 px-1">
                              <button
                                onClick={() => void continueFrom(s)}
                                disabled={cpTicks[s.id] === undefined || forkBusy !== null}
                                title={
                                  cpTicks[s.id] === undefined
                                    ? 'No checkpoint was recorded for this era, so it cannot be continued.'
                                    : `Start a new era from this one's latest checkpoint (tick ${cpTicks[s.id]})`
                                }
                                className="rounded-lg border border-amber-700/50 px-3 py-1 text-xs text-amber-200 hover:bg-amber-900/30 disabled:opacity-40"
                              >
                                {forkBusy === s.id
                                  ? 'Continuing…'
                                  : confirmFork === s.id
                                    ? 'Confirm: this ends the current era'
                                    : 'Continue from here'}
                              </button>
                              {cpTicks[s.id] === undefined && (
                                <span className="text-[10px] text-amber-100/40">No checkpoint was recorded for this era.</span>
                              )}
                              {forkNotice?.id === s.id && (
                                <span className={`text-[11px] ${forkNotice.ok ? 'text-emerald-300' : 'text-red-300'}`}>
                                  {forkNotice.message}
                                </span>
                              )}
                            </div>
                            </div>
                          ))}
                      </div>
                    )}
                  </div>

                  {/* archived replay: checkpoint-based scrubber with playback */}
                  {viewingArchived && (
                    <div className="border-t border-amber-900/40 pt-3">
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-100/50">
                        Replay of {viewingArchived.title}
                      </p>
                      {checkpoints.length === 0 ? (
                        <p className="p-2 text-sm text-amber-100/40">
                          No checkpoints recorded for this session — it predates the replay system. The final
                          world is shown instead.
                        </p>
                      ) : (
                        <ReplayControls
                          tick={replay.tick}
                          maxTick={replay.maxTick}
                          playing={replay.playing}
                          speed={replay.speed}
                          onSeek={(t) => replay.setTick(t)}
                          onPlayPause={() => replay.setPlaying(!replay.playing)}
                          onSpeed={replay.setSpeed}
                          onStep={(d) => replay.setTick(Math.max(0, Math.min(replay.maxTick, replay.tick + d)))}
                        />
                      )}
                    </div>
                  )}

                  {/* live timeline scrubber (in-memory history of the live session) */}
                  {viewing === 'live' && (
                    <div className="border-t border-amber-900/40 pt-3">
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-100/50">
                        Live session timeline
                      </p>
                      {sim.history.length === 0 ? (
                        <p className="p-2 text-sm text-amber-100/40">
                          No history yet. Begin the simulation and every tick is recorded here.
                        </p>
                      ) : (
                        <>
                          <div>
                            <div className="mb-1 flex items-center justify-between text-xs text-amber-100/50">
                              <span>Tick {replayTick} of {sim.history.length - 1}</span>
                              {replayCiv && (
                                <span>{replayCiv.wood}w {replayCiv.food}f {replayCiv.gold}g {replayCiv.stone}s · Age {replayCiv.age}</span>
                              )}
                            </div>
                            <input
                              type="range"
                              min={0}
                              max={sim.history.length - 1}
                              value={Math.min(replayTick, sim.history.length - 1)}
                              onChange={(e) => setReplayTick(Number(e.target.value))}
                              className="w-full accent-amber-500"
                            />
                          </div>
                          <div className="mt-2 space-y-1.5">
                            {sim.history[Math.min(replayTick, sim.history.length - 1)].agents.map((a) => (
                              <button
                                key={a.id}
                                onClick={() => setInspectAgent(a.id === inspectAgent ? null : a.id)}
                                className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm ${
                                  a.id === inspectAgent
                                    ? 'border-amber-600/60 bg-amber-900/30 text-amber-100'
                                    : 'border-amber-900/30 bg-[#15100a]/60 text-amber-50/85 hover:bg-amber-900/20'
                                }`}
                              >
                                <span className="flex items-center gap-2">
                                  <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: a.color }} />
                                  {a.name}
                                  <span className="text-xs text-amber-100/40">({a.pos.x}, {a.pos.y})</span>
                                </span>
                                <span className="text-xs text-amber-100/50">{a.mood} · carrying {a.inventory.length ? a.inventory.join(', ') : 'nothing'}</span>
                              </button>
                            ))}
                          </div>
                          {inspectAgentState && (
                            <div className="mt-2 rounded-xl border border-amber-900/40 bg-[#15100a]/60 p-3">
                              <div className="mb-2 flex items-center gap-2">
                                <UserSearch size={14} className="text-amber-400" />
                                <span className="text-sm font-bold text-amber-200">{inspectAgentState.name} — transcript</span>
                              </div>
                              {inspectAgentState.goals && inspectAgentState.goals.length > 0 && (
                                <p className="mb-2 text-xs italic text-amber-100/60">
                                  Aims: {inspectAgentState.goals.map((g) => g.text).join(' · ')}
                                </p>
                              )}
                              <div className="max-h-52 space-y-1 overflow-y-auto">
                                {inspectEvents.length === 0 ? (
                                  <p className="text-xs text-amber-100/40">No chronicle entries for this villager.</p>
                                ) : (
                                  inspectEvents.map((e) => (
                                    <p key={e.id} className="text-xs leading-relaxed text-amber-50/75">
                                      <span className="mr-1.5 rounded bg-amber-900/40 px-1 py-0.5 text-[9px] uppercase text-amber-100/60">{e.type.replace('_', ' ')}</span>
                                      {e.message.replace(/^.*?: /, '')}
                                    </p>
                                  ))
                                )}
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
              {tab === 'discoveries' && (() => {
                const discoveryEntries: DiscoveryEntry[] = memories
                  .filter((m) => m.kind === 'discovery')
                  .map((m) => ({
                    id: m.id,
                    agent_id: m.agent_id,
                    content: m.content,
                    tick: typeof (m as { tick?: number }).tick === 'number' ? (m as { tick?: number }).tick! : null,
                    created_at: m.created_at,
                  }));
                return (
                  <Discoveries
                    entries={discoveryEntries}
                    agents={agents.map((a) => ({ id: a.id, name: a.name, color: a.color }))}
                  />
                );
              })()}
              {tab === 'memories' && (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-1">
                    <button
                      onClick={() => setMemoryAgent(null)}
                      className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase ${
                        memoryAgent === null
                          ? 'border-amber-500/60 bg-amber-600/25 text-amber-200'
                          : 'border-amber-900/40 bg-[#15100a]/60 text-amber-100/45 hover:text-amber-100/75'
                      }`}
                    >
                      All
                    </button>
                    {agents.map((a) => (
                      <button
                        key={a.id}
                        onClick={() => setMemoryAgent(a.id)}
                        className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase ${
                          memoryAgent === a.id
                            ? 'border-amber-500/60 bg-amber-600/25 text-amber-200'
                            : 'border-amber-900/40 bg-[#15100a]/60 text-amber-100/45 hover:text-amber-100/75'
                        }`}
                      >
                        {a.name}
                      </button>
                    ))}
                  </div>
                  <input
                    value={memorySearch}
                    onChange={(e) => setMemorySearch(e.target.value)}
                    placeholder="Search records…"
                    className="w-full rounded-lg border border-amber-900/40 bg-[#0f0b07] px-3 py-1.5 text-xs text-amber-50 outline-none focus:border-amber-600/60"
                  />
                  {(() => {
                    const filtered = memories.filter(
                      (m) =>
                        (!memoryAgent || m.agent_id === memoryAgent) &&
                        (!memorySearch || m.content.toLowerCase().includes(memorySearch.toLowerCase()))
                    );
                    if (filtered.length === 0)
                      return (
                        <p className="p-2 text-sm text-amber-100/40">
                          {memories.length === 0
                            ? 'No records yet. Villagers write these themselves.'
                            : 'No records match.'}
                        </p>
                      );
                    return filtered.map((m) => {
                      const agent = agents.find((a) => a.id === m.agent_id);
                      return (
                        <div
                          key={m.id}
                          className={`rounded-lg border bg-[#15100a]/60 px-3 py-2 ${
                            suspectedFalse.has(m.id) ? 'border-red-700/60' : 'border-amber-900/30'
                          }`}
                        >
                          <div className="mb-1 flex items-center gap-2">
                            <span
                              className="h-2 w-2 rounded-sm"
                              style={{ backgroundColor: agent?.color ?? '#8a6d3b' }}
                            />
                            <span className="text-xs font-medium text-amber-100">{agent?.name ?? 'Unknown'}</span>
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] ${
                                m.kind === 'discovery'
                                  ? 'bg-cyan-500/20 text-cyan-300'
                                  : m.kind === 'semantic'
                                    ? 'bg-violet-500/15 text-violet-300'
                                    : 'bg-amber-900/40 text-amber-100/50'
                              }`}
                            >
                              {m.kind}
                            </span>
                            {suspectedFalse.has(m.id) && (
                              <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-red-300">
                                false belief?
                              </span>
                            )}
                            <button
                              onClick={() =>
                                setSuspectedFalse((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(m.id)) next.delete(m.id);
                                  else next.add(m.id);
                                  return next;
                                })
                              }
                              title="Mark as a suspected false belief"
                              className="ml-auto text-[10px] text-amber-100/30 hover:text-red-300"
                            >
                              {suspectedFalse.has(m.id) ? 'unflag' : 'flag'}
                            </button>
                          </div>
                          <p className="text-sm text-amber-50/80">{m.content}</p>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </div>
          </Panel>

          <Panel className="p-4 text-xs leading-relaxed text-amber-100/50">
            <p className="mb-2 font-serif text-sm font-bold text-amber-200">How this works</p>
            <p>
              Each villager is powered by a language model via OpenRouter. On its turn it observes
              the world and acts freely: march, gather, deposit at the Town Center, construct
              buildings, advance the age, or write in the chronicles. Each session is one age of the
              empire: ending it preserves the world forever in the Replay tab, and a new session
              starts a fresh founding. By default villagers remember their past selves across
              sessions — unless you start one amnesiac.
            </p>
          </Panel>
        </div>
      </main>

      {/* end session confirm modal */}
      {confirmEnd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-2xl border border-amber-800/50 bg-[#1c1610] p-6">
            <h3 className="mb-2 font-serif text-lg font-bold text-amber-200">End this session?</h3>
            <p className="mb-4 text-sm text-amber-100/60">
              The chronicle closes, the world is archived forever in the Replay tab, and the
              simulation stops. You can begin a new session afterwards — the villagers will carry
              their memories forward unless you start amnesiac.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmEnd(false)}
                className="rounded-lg px-4 py-2 text-sm text-amber-100/50 hover:bg-amber-900/30"
              >
                Keep playing
              </button>
              <button
                onClick={() => void endSession()}
                disabled={sessionBusy}
                className="rounded-lg border border-amber-600/60 bg-amber-600/90 px-4 py-2 text-sm font-bold text-[#1a140d] hover:bg-amber-500 disabled:opacity-40"
              >
                {sessionBusy ? 'Closing…' : 'End session'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* new session modal */}
      {showNewSession && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-2xl border border-amber-800/50 bg-[#1c1610] p-6">
            <h3 className="mb-2 font-serif text-lg font-bold text-amber-200">Begin a new session</h3>
            <p className="mb-4 text-sm text-amber-100/60">
              A fresh world: new villagers, an empty stockpile, tick zero. Past sessions remain
              replayable in the Replay tab.
            </p>
            <label className="mb-4 flex cursor-pointer items-start gap-2 rounded-xl border border-amber-900/40 bg-[#15100a]/60 p-3 text-sm text-amber-100/80">
              <input
                type="checkbox"
                checked={carryMemories}
                onChange={(e) => setCarryMemories(e.target.checked)}
                className="mt-0.5 accent-amber-500"
              />
              <span>
                Villagers remember past sessions
                <span className="block text-xs text-amber-100/40">
                  Uncheck to start amnesiac — new villagers know nothing of the ages before them.
                </span>
              </span>
            </label>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowNewSession(false)}
                className="rounded-lg px-4 py-2 text-sm text-amber-100/50 hover:bg-amber-900/30"
              >
                Cancel
              </button>
              <button
                onClick={() => void startNewSession()}
                disabled={sessionBusy}
                className="rounded-lg border border-amber-600/60 bg-amber-600/90 px-4 py-2 text-sm font-bold text-[#1a140d] hover:bg-amber-500 disabled:opacity-40"
              >
                {sessionBusy ? 'Founding…' : 'Found the empire'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* settings modal */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-2xl border border-amber-800/50 bg-[#1c1610] p-6">
            <h3 className="mb-1 font-serif text-lg font-bold text-amber-200">OpenRouter API key</h3>
            <p className="mb-4 text-sm text-amber-100/50">
              The villagers think with paid OpenRouter models. Paste your key (starts with{' '}
              <code className="text-amber-200">sk-or-</code>) to bring the empire to life.
            </p>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-or-..."
              className="mb-4 w-full rounded-lg border border-amber-900/50 bg-[#0f0b07] px-3 py-2 text-sm text-amber-50 outline-none focus:border-amber-600/60"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowSettings(false)}
                className="rounded-lg px-4 py-2 text-sm text-amber-100/50 hover:bg-amber-900/30"
              >
                Cancel
              </button>
              <button
                onClick={() => void saveKey()}
                disabled={!apiKey.trim()}
                className="rounded-lg border border-amber-600/60 bg-amber-600/90 px-4 py-2 text-sm font-bold text-[#1a140d] hover:bg-amber-500 disabled:opacity-40"
              >
                Save key
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
