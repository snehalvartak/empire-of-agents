import { useRef, useState, useEffect } from 'react';
import type { WorldSnapshot } from '@/sim/world';

export interface ReplayCheckpoint {
  tick: number;
  snapshot: WorldSnapshot;
}

/**
 * Checkpoint-backed replay scrubber (spec F2.5). Loaded from the checkpoints
 * table (one snapshot every 50 ticks), with play/pause and 1-8x speed.
 */
export function useReplayPlayer(checkpoints: ReplayCheckpoint[], active: boolean) {
  const [tick, setTick] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 2 | 4 | 8>(1);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const maxTick = checkpoints.length ? checkpoints[checkpoints.length - 1].tick : 0;

  useEffect(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    if (!playing || !active || checkpoints.length === 0) return;
    timer.current = setInterval(() => {
      setTick((t) => {
        const next = t + speed;
        if (next >= maxTick) {
          setPlaying(false);
          return maxTick;
        }
        return next;
      });
    }, 400 / speed);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [playing, active, speed, maxTick, checkpoints.length]);

  function reset(to = 0) {
    setPlaying(false);
    setTick(to);
  }

  const current = checkpoints.length ? nearestCheckpoint(checkpoints, tick) : null;

  return { tick, setTick, playing, setPlaying, speed, setSpeed, maxTick, current, reset };
}

export function nearestCheckpoint(
  checkpoints: ReplayCheckpoint[],
  tick: number
): ReplayCheckpoint | null {
  if (checkpoints.length === 0) return null;
  let best = checkpoints[0];
  for (const c of checkpoints) {
    if (c.tick <= tick) best = c;
    else break;
  }
  return best;
}
