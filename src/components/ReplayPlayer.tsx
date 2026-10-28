import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';

export function ReplayControls({
  tick,
  maxTick,
  playing,
  speed,
  onSeek,
  onPlayPause,
  onSpeed,
  onStep,
}: {
  tick: number;
  maxTick: number;
  playing: boolean;
  speed: 1 | 2 | 4 | 8;
  onSeek: (t: number) => void;
  onPlayPause: () => void;
  onSpeed: (s: 1 | 2 | 4 | 8) => void;
  onStep: (d: number) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          onClick={onPlayPause}
          disabled={maxTick === 0}
          className="flex h-8 w-8 items-center justify-center rounded-md border border-amber-700/50 bg-amber-900/30 text-amber-200 hover:bg-amber-800/40 disabled:opacity-40"
          title={playing ? 'Pause' : 'Play'}
        >
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button
          onClick={() => onStep(-50)}
          disabled={maxTick === 0}
          className="flex h-8 w-8 items-center justify-center rounded-md border border-amber-900/40 text-amber-100/60 hover:bg-amber-900/30 disabled:opacity-40"
          title="Back one checkpoint"
        >
          <SkipBack size={12} />
        </button>
        <button
          onClick={() => onStep(50)}
          disabled={maxTick === 0}
          className="flex h-8 w-8 items-center justify-center rounded-md border border-amber-900/40 text-amber-100/60 hover:bg-amber-900/30 disabled:opacity-40"
          title="Forward one checkpoint"
        >
          <SkipForward size={12} />
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(1, maxTick)}
          value={Math.min(tick, maxTick)}
          onChange={(e) => onSeek(Number(e.target.value))}
          className="flex-1 accent-amber-500"
        />
        <span className="w-20 text-right text-[10px] text-amber-100/40">
          t{Math.min(tick, maxTick)}
        </span>
      </div>
      <div className="flex items-center gap-1">
        <span className="text-[10px] uppercase tracking-wide text-amber-100/35">speed</span>
        {([1, 2, 4, 8] as const).map((s) => (
          <button
            key={s}
            onClick={() => onSpeed(s)}
            className={`rounded border px-1.5 py-0.5 text-[10px] ${
              speed === s
                ? 'border-amber-500/60 bg-amber-600/25 text-amber-200'
                : 'border-amber-900/40 text-amber-100/45 hover:text-amber-100/75'
            }`}
          >
            {s}×
          </button>
        ))}
      </div>
    </div>
  );
}
