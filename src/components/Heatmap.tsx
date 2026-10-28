import { useMemo } from 'react';

export interface PositionRow {
  agent_id: string;
  x: number;
  y: number;
}

/**
 * Aggregates position rows into per-tile counts for the heatmap overlay (F2.2).
 * Uses a viridis-like perceptual ramp from dim to bright gold.
 */
export function useHeatmap(rows: PositionRow[]) {
  return useMemo(() => {
    const map = new Map<string, number>();
    for (const r of rows) {
      const key = `${r.x},${r.y}`;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    let max = 0;
    for (const v of map.values()) max = Math.max(max, v);
    const tiles: Array<{ x: number; y: number; intensity: number }> = [];
    for (const [key, count] of map) {
      const [x, y] = key.split(',').map(Number);
      tiles.push({ x, y, intensity: max > 0 ? count / max : 0 });
    }
    return tiles;
  }, [rows]);
}

/** Maps intensity (0-1) to a warm perceptual color. */
export function heatColor(intensity: number): string {
  // dim ember to bright gold
  const r = Math.round(120 + 110 * intensity);
  const g = Math.round(40 + 140 * intensity * intensity);
  const b = Math.round(30 + 20 * (1 - intensity));
  return `rgb(${r},${g},${b})`;
}
