/**
 * ONE-TIME CAPTURE of the pre-manifest island (SPEC T3, check F1).
 *
 * This script was run once, against the hand-built island in src/sim/world.ts and
 * src/sim/simulation.ts as they were BEFORE the world became data. It wrote
 * src/sim/__tests__/golden/island.json, the fixed answer that the manifest parity
 * test (src/sim/__tests__/manifest.test.ts) compares the loaded island against.
 *
 * Do not re-run it against the manifest-driven world.ts: it would capture the new code
 * instead of the old and the parity proof would be circular (and it can no longer find the
 * cast literals in simulation.ts). It is kept so the golden file's provenance is reviewable;
 * it runs only on a checkout from before T3.
 *
 * Usage (on the pre-manifest commit): node scripts/capture-golden-island.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { GRID_SIZE, ROADS, TERRITORIES, isRoad, seedObjects, territoryAt } from '../src/sim/world.ts';

// tiles[y][x] = "<territory id>" | "<territory id>+road" | "road" | "water"
const tiles = [];
for (let y = 0; y < GRID_SIZE; y++) {
  const row = [];
  for (let x = 0; x < GRID_SIZE; x++) {
    const t = territoryAt({ x, y });
    const r = isRoad({ x, y });
    row.push(t ? (r ? `${t}+road` : t) : r ? 'road' : 'water');
  }
  tiles.push(row);
}

const objects = seedObjects().map((o) => ({ id: o.id, territory: o.territory, kind: o.kind, x: o.pos.x, y: o.pos.y }));

const territories = TERRITORIES.map((t) => ({
  id: t.id,
  name: t.name,
  color: t.color,
  offset: { x: t.offset.x, y: t.offset.y },
  size: t.size,
  description: t.description,
}));

const roads = ROADS.map((r) => ({ from: r.a, to: r.b, cells: r.cells.map((c) => ({ x: c.x, y: c.y })) }));

// The starting cast lives in simulation.ts (it imports the database client, so it cannot be
// imported under plain Node). Read the literal rows out of the source text instead.
const sim = readFileSync(new URL('../src/sim/simulation.ts', import.meta.url), 'utf8');
const fn = sim.slice(sim.indexOf('async seedStartingVillagers'));
const start = fn.indexOf('.insert(') + '.insert('.length;
const end = fn.lastIndexOf(']', fn.indexOf('.select()')) + 1;
const rowsText = fn.slice(start, end).replace(/this\.session\.id/g, "'s'");
const rows = new Function('MODELS_DEFAULT', `return (${rowsText.trim()});`)('model');
const cast = rows.map((r) => ({
  name: r.name,
  persona: r.persona,
  territory: r.island,
  color: r.color,
  x: r.position.x,
  y: r.position.y,
}));

// There was no villager cap anywhere in the roster/add path (addAgent in simulation.ts and the
// add form in WorldApp.tsx); recorded as null so the manifest's max_villagers is a deliberate addition.
const maxVillagers = /max_?villagers|MAX_VILLAGERS|MAX_AGENTS/i.test(sim) ? 'FOUND-CHECK-BY-HAND' : null;

const golden = { gridSize: GRID_SIZE, tiles, territories, roads, objects, cast, maxVillagers };
writeFileSync(new URL('../src/sim/__tests__/golden/island.json', import.meta.url), JSON.stringify(golden, null, 1) + '\n');
console.log(`golden: ${GRID_SIZE}x${GRID_SIZE} tiles, ${objects.length} seed objects, ${territories.length} territories, ${roads.length} roads, ${cast.length} cast`);
