import { useMemo, useState } from 'react';
import { categoryColor, CATEGORY_LEGEND } from '@/components/paperUtils';

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

export interface DiscoveryEntry {
  id: string;
  agent_id: string | null;
  content: string;
  tick: number | null;
  created_at: string;
}

/** Parchment list of a session's discoveries, newest first (memory kind = 'discovery'). */
export function Discoveries({
  entries,
  agents,
}: {
  entries: DiscoveryEntry[];
  agents: TimelineAgent[];
}) {
  if (entries.length === 0) {
    return (
      <p className="p-2 text-sm text-amber-100/40">
        No discoveries yet. When a villager notes a rule of the world, it is inscribed here for
        every generation after.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {entries.map((d) => {
        const agent = agents.find((a) => a.id === d.agent_id);
        return (
          <div
            key={d.id}
            className="rounded-xl border border-cyan-800/30 bg-[#15100a]/60 px-3 py-2.5"
          >
            <div className="mb-1 flex items-center gap-2">
              <span
                className="h-2 w-2 rounded-sm"
                style={{ backgroundColor: agent?.color ?? '#4cc9d4' }}
              />
              <span className="text-xs font-medium text-amber-100">
                {agent?.name ?? 'The empire'}
              </span>
              <span className="rounded bg-cyan-500/20 px-1.5 py-0.5 text-[10px] text-cyan-300">
                discovery
              </span>
              {typeof d.tick === 'number' && (
                <span className="ml-auto text-[10px] text-amber-100/35">t{d.tick}</span>
              )}
            </div>
            <p className="text-sm italic leading-relaxed text-amber-50/85">“{d.content}”</p>
          </div>
        );
      })}
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
