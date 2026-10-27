import { useMemo, useState } from 'react';

export interface TimelineEvent {
  id: string;
  agent_id: string | null;
  type: string;
  message: string;
  tick: number | null;
}

export interface TimelineAgent {
  id: string;
  name: string;
  color: string;
}

/** Category colors for activity bars, keyed by event type. */
export function categoryColor(type: string): string {
  if (type === 'gather') return '#9ccc3f';
  if (type === 'build') return '#5b8f3a';
  if (type === 'deposit') return '#3b82c4';
  if (type === 'say') return '#f0a04a';
  if (type === 'chat') return '#e0679a';
  if (type === 'advance_age') return '#e2b04a';
  if (type === 'train' || type === 'level_up') return '#f2d24b';
  if (type === 'discover') return '#4cc9d4';
  if (type === 'eat') return '#d98e5f';
  if (type === 'wait') return '#6b675e';
  if (type === 'move' || type === 'goto') return '#8a8375';
  if (type === 'remember' || type === 'thought') return '#7f9fc4';
  return '#b5ab97';
}

export const CATEGORY_LEGEND: Array<[string, string]> = [
  ['gather', 'Gathering'],
  ['build', 'Building'],
  ['deposit', 'Depositing'],
  ['say', 'Speaking'],
  ['chat', 'Chatting'],
  ['advance_age', 'Age advance'],
  ['level_up', 'Ability'],
  ['discover', 'Discovery'],
  ['eat', 'Eating / resting'],
];

const ZOOMS: Array<[string, number | null]> = [
  ['50', 50],
  ['200', 200],
  ['all', null],
];

/** Per-villager horizontal activity bars colored by category (spec F2.1). */
export function Timeline({
  events,
  agents,
  onJump,
}: {
  events: TimelineEvent[];
  agents: TimelineAgent[];
  onJump?: (tick: number) => void;
}) {
  const [who, setWho] = useState<string>('all');
  const [zoom, setZoom] = useState<number | null>(50);

  const ticked = useMemo(() => events.filter((e) => typeof e.tick === 'number'), [events]);
  const maxTick = useMemo(
    () => ticked.reduce((m, e) => Math.max(m, e.tick ?? 0), 0),
    [ticked]
  );
  const minTick = zoom === null ? 0 : Math.max(0, maxTick - zoom);

  const shown = ticked.filter((e) => (e.tick ?? 0) >= minTick);
  const span = Math.max(1, maxTick - minTick);
  const rows = who === 'all' ? agents : agents.filter((a) => a.id === who);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1">
        <button
          onClick={() => setWho('all')}
          className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase ${
            who === 'all'
              ? 'border-amber-500/60 bg-amber-600/25 text-amber-200'
              : 'border-amber-900/40 bg-[#15100a]/60 text-amber-100/45 hover:text-amber-100/75'
          }`}
        >
          All
        </button>
        {agents.map((a) => (
          <button
            key={a.id}
            onClick={() => setWho(a.id)}
            className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase ${
              who === a.id
                ? 'border-amber-500/60 bg-amber-600/25 text-amber-200'
                : 'border-amber-900/40 bg-[#15100a]/60 text-amber-100/45 hover:text-amber-100/75'
            }`}
          >
            {a.name}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-1">
          <span className="text-[10px] uppercase tracking-wide text-amber-100/35">zoom</span>
          {ZOOMS.map(([label, z]) => (
            <button
              key={label}
              onClick={() => setZoom(z)}
              className={`rounded border px-1.5 py-0.5 text-[10px] ${
                zoom === z
                  ? 'border-amber-500/60 bg-amber-600/25 text-amber-200'
                  : 'border-amber-900/40 text-amber-100/45 hover:text-amber-100/75'
              }`}
            >
              {label}
            </button>
          ))}
        </span>
      </div>

      {rows.length === 0 || shown.length === 0 ? (
        <p className="p-2 text-sm text-amber-100/40">
          No ticked activity yet. Every deed is charted here once the simulation runs.
        </p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((a) => {
            const evts = shown.filter((e) => e.agent_id === a.id);
            return (
              <div key={a.id} className="flex items-center gap-2">
                <span className="w-20 shrink-0 truncate text-right text-[11px] text-amber-100/70">
                  {a.name}
                </span>
                <div className="relative h-4 flex-1 overflow-hidden rounded border border-amber-900/40 bg-[#15100a]">
                  {evts.map((e) => {
                    const left = (((e.tick ?? 0) - minTick) / span) * 100;
                    return (
                      <button
                        key={e.id}
                        title={`t${e.tick} · ${e.type} · ${e.message.replace(/^.*?: /, '')}`}
                        onClick={() => onJump?.(e.tick ?? 0)}
                        className="absolute top-0 h-full w-[3px] min-w-[2px] hover:opacity-100"
                        style={{
                          left: `${left}%`,
                          backgroundColor: categoryColor(e.type),
                          opacity: 0.85,
                        }}
                      />
                    );
                  })}
                </div>
                <span className="w-8 shrink-0 text-[10px] text-amber-100/35">{evts.length}</span>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1">
        {CATEGORY_LEGEND.map(([type, label]) => (
          <span key={type} className="flex items-center gap-1 text-[10px] text-amber-100/50">
            <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: categoryColor(type) }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

export interface KeyMoment {
  kind: string;
  label: string;
  tone: 'gold' | 'grass' | 'water' | 'ember' | 'stone';
  tick: number;
  agentName: string;
  agentColor: string;
  quote: string;
}

/** Rule-based detection of firsts: first build, age advance, discovery, ability, chat (F2.4). */
export function detectKeyMoments(
  events: TimelineEvent[],
  agents: TimelineAgent[]
): KeyMoment[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const targets: Array<{ type: string; label: string; tone: KeyMoment['tone'] }> = [
    { type: 'build', label: 'First structure raised', tone: 'grass' },
    { type: 'advance_age', label: 'The empire advances', tone: 'gold' },
    { type: 'discover', label: 'A rule of the world discovered', tone: 'water' },
    { type: 'level_up', label: 'Ability invented', tone: 'gold' },
    { type: 'chat', label: 'First conversation', tone: 'stone' },
    { type: 'pick_up', label: 'First creature taken', tone: 'ember' },
  ];
  const moments: KeyMoment[] = [];
  for (const t of targets) {
    const e = events.find((e) => e.type === t.type && typeof e.tick === 'number');
    if (!e) continue;
    const agent = e.agent_id ? byId.get(e.agent_id) : undefined;
    moments.push({
      kind: t.type,
      label: t.label,
      tone: t.tone,
      tick: e.tick ?? 0,
      agentName: agent?.name ?? 'The empire',
      agentColor: agent?.color ?? '#8a6d3b',
      quote: e.message.replace(/^.*?: /, ''),
    });
  }
  return moments.sort((a, b) => a.tick - b.tick).slice(0, 8);
}
