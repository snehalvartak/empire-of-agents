import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ISLAND_MANIFEST_TOML } from '../islandManifest.generated.ts';
import {
  ENGINE_RULES_VERSION,
  ManifestError,
  checkFingerprint,
  expandSeeds,
  fingerprint,
  parseManifest,
  validateManifest,
} from '../manifest.ts';
import type { SeedSource } from '../manifest.ts';
import {
  GRID_SIZE,
  MAX_VILLAGERS,
  ROADS,
  STARTING_VILLAGERS,
  TERRITORIES,
  islandFingerprint,
  isRoad,
  loadIsland,
  seedObjects,
  territoryAt,
} from '../world.ts';

// ---------------------------------------------------------------------------------------------
// F1: the manifest-driven island is identical to the hand-built one captured in golden/island.json

interface Golden {
  gridSize: number;
  tiles: string[][];
  territories: Array<{ id: string; name: string; color: string; offset: { x: number; y: number }; size: number; description: string }>;
  roads: Array<{ from: string; to: string; cells: Array<{ x: number; y: number }> }>;
  objects: Array<{ id: string; territory: string; kind: string; x: number; y: number }>;
  cast: Array<{ name: string; persona: string; territory: string; color: string; x: number; y: number }>;
  maxVillagers: number | null;
}

const golden: Golden = JSON.parse(readFileSync(new URL('./golden/island.json', import.meta.url), 'utf8'));

/**
 * Differences the manifest deliberately made while exporting (reported in the T3 hand-off).
 * Each is listed with the golden value it replaces, so the parity test fails if the golden
 * ever stops containing it and if anything else differs.
 */
const KNOWN_DIVERGENCES = [
  {
    what: 'Bramble was labelled island "valley" but stood at (4,4), a Greenwood Forest tile; a manifest villager must stand in their own territory (R6.3)',
    apply: (g: Golden) => {
      const bramble = g.cast.find((c) => c.name === 'Bramble');
      expect(bramble?.territory, 'golden still holds the old Bramble label').toBe('valley');
      if (bramble) bramble.territory = 'forest';
    },
  },
];

/** The first few differences between two ordered lists of plain rows, as readable lines. */
function firstDiffs<T>(label: string, expected: T[], actual: T[], limit = 5): string[] {
  const out: string[] = [];
  if (expected.length !== actual.length) out.push(`${label}: expected ${expected.length} entries, got ${actual.length}`);
  const n = Math.max(expected.length, actual.length);
  for (let i = 0; i < n && out.length < limit; i++) {
    if (JSON.stringify(expected[i]) !== JSON.stringify(actual[i])) {
      out.push(`${label}[${i}]: expected ${JSON.stringify(expected[i])}, got ${JSON.stringify(actual[i])}`);
    }
  }
  return out;
}

describe('F1: manifest parity with the hand-built island', () => {
  const expected: Golden = JSON.parse(JSON.stringify(golden));
  for (const d of KNOWN_DIVERGENCES) d.apply(expected);

  it('has the same grid and the same tiles (territory, road or water) on every tile', () => {
    expect(GRID_SIZE).toBe(golden.gridSize);
    const actual: string[][] = [];
    for (let y = 0; y < GRID_SIZE; y++) {
      const row: string[] = [];
      for (let x = 0; x < GRID_SIZE; x++) {
        const t = territoryAt({ x, y });
        const r = isRoad({ x, y });
        row.push(t ? (r ? `${t}+road` : t) : r ? 'road' : 'water');
      }
      actual.push(row);
    }
    const diffs = firstDiffs('tile row', golden.tiles, actual);
    for (let y = 0; y < GRID_SIZE && diffs.length < 5; y++) {
      for (let x = 0; x < GRID_SIZE && diffs.length < 5; x++) {
        if (golden.tiles[y][x] !== actual[y][x]) diffs.push(`tile (${x},${y}): expected ${golden.tiles[y][x]}, got ${actual[y][x]}`);
      }
    }
    expect(diffs).toEqual([]);
    expect(actual.flat()).toHaveLength(golden.gridSize * golden.gridSize);
  });

  it('has the same seed objects, in the same order, with the same ids', () => {
    const actual = seedObjects().map((o) => ({ id: o.id, territory: o.territory, kind: o.kind, x: o.pos.x, y: o.pos.y }));
    expect(firstDiffs('seed', golden.objects, actual)).toEqual([]);
    expect(actual).toHaveLength(101);
    expect(actual[0].id).toBe('res_0');
    expect(actual[actual.length - 1].id).toBe('res_100');
  });

  it('has the same territories', () => {
    const actual = TERRITORIES.map((t) => ({ id: t.id, name: t.name, color: t.color, offset: t.offset, size: t.size, description: t.description }));
    expect(firstDiffs('territory', golden.territories, actual)).toEqual([]);
  });

  it('has the same roads, cell for cell', () => {
    const actual = ROADS.map((r) => ({ from: r.a, to: r.b, cells: r.cells }));
    expect(firstDiffs('road', golden.roads, actual)).toEqual([]);
    expect(actual.reduce((n, r) => n + r.cells.length, 0)).toBe(22);
  });

  it('has the same starting cast (apart from the one listed divergence)', () => {
    const actual = STARTING_VILLAGERS.map((v) => ({ name: v.name, persona: v.persona, territory: v.territory, color: v.color, x: v.pos.x, y: v.pos.y }));
    expect(firstDiffs('villager', expected.cast, actual)).toEqual([]);
    expect(KNOWN_DIVERGENCES).toHaveLength(1);
  });

  it('adds the villager cap the old code never had (8)', () => {
    expect(golden.maxVillagers).toBeNull();
    expect(MAX_VILLAGERS).toBe(8);
  });
});

// ---------------------------------------------------------------------------------------------
// Drift guard: the generated module the engine loads is the TOML file on disk

describe('generated manifest module', () => {
  it('matches worlds/founding-island/world.toml exactly (run `npm run manifest` if this fails)', () => {
    const onDisk = readFileSync(new URL('../../../worlds/founding-island/world.toml', import.meta.url), 'utf8');
    expect(ISLAND_MANIFEST_TOML).toBe(onDisk);
  });
});

// ---------------------------------------------------------------------------------------------
// F2: malformed manifests are rejected, never partly loaded, with the offending entry named

/** Edits the real manifest text; fails loudly if the text to replace is not there exactly once. */
function edit(text: string, from: string, to: string): string {
  const parts = text.split(from);
  if (parts.length !== 2) throw new Error(`fixture edit expects exactly one "${from}", found ${parts.length - 1}`);
  return parts.join(to);
}

/** The problems a manifest is rejected with ([] would mean it was accepted). */
function problemsOf(text: string): string[] {
  try {
    parseManifest(text);
  } catch (e) {
    if (e instanceof ManifestError) return e.problems;
    throw e;
  }
  return [];
}

const REAL = ISLAND_MANIFEST_TOML;

const MALFORMED: Array<{ name: string; text: string; names: string[] }> = [
  { name: 'unsupported schema_version', text: edit(REAL, 'schema_version = 1', 'schema_version = 2'), names: ['schema_version 2: unsupported'] },
  { name: 'missing schema_version', text: edit(REAL, 'schema_version = 1\n', ''), names: ['schema_version: missing required field'] },
  {
    name: 'grid_size smaller than the map',
    text: edit(REAL, 'grid_size = 24', 'grid_size = 20'),
    names: ['world.grid_size (20): too small', 'territory[1] (valley): out of bounds'],
  },
  { name: 'grid_size beyond the engine maximum', text: edit(REAL, 'grid_size = 24', 'grid_size = 500'), names: ['world.grid_size (500): must be between 1 and 64'] },
  {
    name: 'overlapping territories',
    text: edit(REAL, 'offset = { x = 17, y = 0 }', 'offset = { x = 10, y = 0 }'),
    names: ['territory[1] (valley): overlaps territory[0] (forest)'],
  },
  {
    name: 'territory out of bounds',
    text: edit(REAL, 'offset = { x = 8, y = 17 }', 'offset = { x = 8, y = 20 }'),
    names: ['territory[2] (hills): out of bounds'],
  },
  { name: 'negative territory offset', text: edit(REAL, 'offset = { x = 0, y = 0 }', 'offset = { x = -2, y = 0 }'), names: ['territory[0] (forest): out of bounds'] },
  {
    name: 'duplicate territory ids',
    text: edit(REAL, 'id = "valley"', 'id = "forest"'),
    names: ['duplicate territory id "forest"'],
  },
  {
    name: 'seed off the map',
    text: edit(REAL, 'kind = "town_center"\nat = [[7, 7]]', 'kind = "town_center"\nat = [[7, 7], [5, 40]]'),
    names: ['seed_group[4] (town_center at 5,40): outside the grid'],
  },
  {
    name: 'seed on water',
    text: edit(REAL, 'kind = "town_center"\nat = [[7, 7]]', 'kind = "town_center"\nat = [[7, 7], [15, 3]]'),
    names: ['seed_group[4] (town_center at 15,3): on water'],
  },
  {
    name: 'seed outside its own territory',
    text: edit(REAL, 'kind = "town_center"\nat = [[7, 7]]', 'kind = "town_center"\nat = [[7, 7], [18, 3]]'),
    names: ['seed_group[4] (town_center at 18,3): outside its territory forest (the tile lies in valley)'],
  },
  {
    name: 'two seeds on one tile',
    text: edit(REAL, 'kind = "town_center"\nat = [[7, 7]]', 'kind = "town_center"\nat = [[7, 7], [2, 2]]'),
    names: ['seed_group[4] (town_center at 2,2): tile already holds seed_group[0] (tree)'],
  },
  {
    name: 'a seed and the mystery machine on one tile',
    text: edit(REAL, 'kind = "town_center"\nat = [[7, 7]]', 'kind = "town_center"\nat = [[7, 7]]\n\n[[seed_object]]\nterritory = "hills"\nkind = "tree"\nat = { x = 10, y = 19 }'),
    names: ['mystery[0] (standing_rock, rock at 10,19): tile already holds seed_object[0] (tree)'],
  },
  {
    name: 'unknown kind',
    text: edit(REAL, 'kind = "town_center"', 'kind = "castle"'),
    names: ['seed_group[4] (castle)', 'unknown kind "castle"'],
  },
  {
    name: 'a mystery may not be placed as an ordinary seed kind',
    text: edit(REAL, 'kind = "town_center"', 'kind = "rock"'),
    names: ['seed_group[4] (rock)', 'unknown kind "rock"'],
  },
  {
    name: 'unknown seed territory',
    text: edit(REAL, 'territory = "forest"\nkind = "town_center"', 'territory = "swamp"\nkind = "town_center"'),
    names: ['unknown territory "swamp"'],
  },
  {
    name: 'unknown on_thrown_cube behavior',
    text: edit(REAL, 'on_thrown_cube = "spawn_two_cubes"', 'on_thrown_cube = "explode"'),
    names: ['mystery[0] (standing_rock, rock at 10,19)', 'unknown on_thrown_cube behavior "explode"'],
  },
  {
    name: 'road cell off the map',
    text: edit(REAL, '{ x = 17, y = 6 }]', '{ x = 17, y = 6 }, { x = 30, y = 6 }]'),
    names: ['road[0] (forest to valley) cell 4 (30,6): off the map'],
  },
  { name: 'road to an unknown territory', text: edit(REAL, 'to = "valley"', 'to = "moon"'), names: ['road[0] (forest to moon)', 'unknown territory "moon"'] },
  {
    name: 'starting villager outside their territory',
    text: edit(REAL, 'at = { x = 3, y = 3 }', 'at = { x = 20, y = 3 }'),
    names: ['starting_villagers[0] (Alder): starts at 20,3, outside its territory forest (the tile lies in valley)'],
  },
  {
    name: 'starting villager on water',
    text: edit(REAL, 'at = { x = 3, y = 3 }', 'at = { x = 15, y = 3 }'),
    names: ['starting_villagers[0] (Alder): starts at 15,3, outside its territory forest (that tile is water)'],
  },
  {
    name: 'starting villager on an occupied tile',
    text: edit(REAL, 'at = { x = 4, y = 4 }', 'at = { x = 3, y = 3 }'),
    names: ['starting_villagers[1] (Bramble): starts at 3,3, a tile occupied by starting_villagers[0] (Alder)'],
  },
  {
    name: 'starting villager on the mystery machine',
    text: edit(REAL, 'territory = "forest"\nat = { x = 4, y = 4 }', 'territory = "hills"\nat = { x = 10, y = 19 }'),
    names: ['starting_villagers[1] (Bramble): starts at 10,19, a tile occupied by mystery standing_rock'],
  },
  {
    name: 'more starting villagers than max_villagers',
    text: edit(REAL, 'max_villagers = 8', 'max_villagers = 1'),
    names: ['starting_villagers: 2 villagers listed but world.max_villagers is 1'],
  },
  { name: 'missing world name', text: edit(REAL, 'name = "The Founding Island"\n', ''), names: ['world: missing required field "name"'] },
  { name: 'missing max_villagers', text: edit(REAL, 'max_villagers = 8\n', ''), names: ['world: missing required field "max_villagers"'] },
  { name: 'missing territory color', text: edit(REAL, 'color = "#22c55e"\n', ''), names: ['territory[0] (forest): missing required field "color"'] },
  { name: 'missing seed kind', text: edit(REAL, 'kind = "town_center"\n', ''), names: ['seed_group[4]: missing required field "kind"'] },
  { name: 'missing [world] table', text: REAL.replace(/\[world\][\s\S]*?\n\n/, ''), names: ['world: missing required table [world]'] },
  { name: 'a misspelled field', text: edit(REAL, 'size = 14', 'size = 14\nsiz = 3'), names: ['territory[0] (forest): unknown field "siz"'] },
  { name: 'text that is not TOML', text: 'schema_version = = 1', names: ['not valid TOML'] },
];

describe('F2: malformed manifests are rejected with the entry named', () => {
  it('accepts the real manifest', () => {
    expect(problemsOf(REAL)).toEqual([]);
  });

  it.each(MALFORMED)('rejects $name', ({ text, names }) => {
    const problems = problemsOf(text);
    expect(problems.length, 'the manifest was rejected').toBeGreaterThan(0);
    for (const fragment of names) {
      expect(problems.some((p) => p.includes(fragment)), `expected a problem containing "${fragment}" in:\n${problems.join('\n')}`).toBe(true);
    }
  });

  it('reports every problem at once in one ManifestError, and loads nothing', () => {
    const text = edit(
      edit(edit(REAL, 'schema_version = 1', 'schema_version = 9'), 'kind = "town_center"\nat = [[7, 7]]', 'kind = "town_center"\nat = [[7, 7], [5, 40]]'),
      'on_thrown_cube = "spawn_two_cubes"',
      'on_thrown_cube = "explode"'
    );
    let caught: unknown;
    try {
      parseManifest(text);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ManifestError);
    const err = caught as ManifestError;
    expect(err.problems).toHaveLength(3);
    expect(err.message).toContain('3 problems');
    for (const p of err.problems) expect(err.message).toContain(p);
  });

  it('refuses to start the engine on an invalid island (loadIsland throws)', () => {
    expect(() => loadIsland(edit(REAL, 'schema_version = 1', 'schema_version = 2'))).toThrow(ManifestError);
  });

  it('validateManifest rejects a value that is not a table', () => {
    expect(() => validateManifest(null)).toThrow(ManifestError);
    expect(() => validateManifest([])).toThrow(ManifestError);
  });
});

// ---------------------------------------------------------------------------------------------
// Compact authoring form (R6.4)

/** Rewrites the real manifest's seed section: every object its own seed_group of one tile. */
function singleEntryForm(): string {
  const m = parseManifest(REAL);
  const head = REAL.slice(0, REAL.indexOf('[[seed_group]]'));
  const tail = REAL.slice(REAL.indexOf('[[starting_villagers]]'));
  const rock = m.seeds.findIndex((s) => s.mystery);
  const entries = m.seeds
    .filter((s) => !s.mystery)
    .map((s) => `[[seed_group]]\nterritory = "${s.territory}"\nkind = "${s.kind}"\nat = [[${s.pos.x}, ${s.pos.y}]]\n`);
  const mystery = `[[mystery]]\nid = "standing_rock"\nterritory = "hills"\nat = { x = 10, y = 19 }\nkind = "rock"\non_thrown_cube = "spawn_two_cubes"\nafter_seed_group = ${rock}\n`;
  return `${head}${entries.join('\n')}\n${mystery}\n${tail}`;
}

describe('compact seed form expands to one entry per object', () => {
  it('groups with many coordinates equal the one-object-per-group form, ids included', () => {
    const compact = parseManifest(REAL);
    const verbose = parseManifest(singleEntryForm());
    expect(verbose.seeds).toEqual(compact.seeds);
    expect(verbose.seeds).toHaveLength(101);
    expect(fingerprint(verbose)).toBe(fingerprint(compact));
  });

  it('[[seed_object]] entries equal [[seed_group]] entries, numbered after the groups', () => {
    const withoutRock = REAL.replace(/\[\[mystery\]\][\s\S]*?\n\n/, '');
    expect(withoutRock).not.toContain('[[mystery]]\nid');
    const compact = parseManifest(withoutRock);
    const head = withoutRock.slice(0, withoutRock.indexOf('[[seed_group]]'));
    const tail = withoutRock.slice(withoutRock.indexOf('[[starting_villagers]]'));
    const objects = compact.seeds
      .map((s) => `[[seed_object]]\nterritory = "${s.territory}"\nkind = "${s.kind}"\nat = { x = ${s.pos.x}, y = ${s.pos.y} }\n`)
      .join('\n');
    const verbose = parseManifest(`${head}${objects}\n${tail}`);
    expect(verbose.seeds).toEqual(compact.seeds);
    expect(compact.seeds.map((s) => s.id).slice(0, 3)).toEqual(['res_0', 'res_1', 'res_2']);
  });

  it('expandSeeds numbers groups in order, slots a mystery after the named group, then appends single objects', () => {
    const source: SeedSource = {
      groups: [
        { territory: 'a', kind: 'tree', at: [{ x: 0, y: 0 }, { x: 1, y: 0 }] },
        { territory: 'a', kind: 'cube', at: [{ x: 2, y: 0 }] },
      ],
      objects: [{ territory: 'a', kind: 'flower', at: { x: 3, y: 0 } }],
      mysteries: [{ id: 'm', territory: 'a', kind: 'rock', pos: { x: 9, y: 9 }, onThrownCube: 'none', afterSeedGroup: 1 }],
    };
    expect(expandSeeds(source).map((s) => `${s.id}:${s.kind}`)).toEqual(['res_0:tree', 'res_1:tree', 'res_2:rock', 'res_3:cube', 'res_4:flower']);
  });

  it('puts the Standing Rock at res_95, between the creatures and the cubes, as before', () => {
    const rock = seedObjects().find((o) => o.kind === 'rock');
    expect(rock?.id).toBe('res_95');
    expect(seedObjects().find((o) => o.id === 'res_96')?.kind).toBe('cube');
  });
});

// ---------------------------------------------------------------------------------------------
// Fingerprint (R6.5)

describe('fingerprint', () => {
  it('is stable across two independent loads of the same text', () => {
    expect(fingerprint(parseManifest(REAL))).toBe(fingerprint(parseManifest(REAL)));
    expect(fingerprint(loadIsland())).toBe(islandFingerprint);
  });

  it('looks like a fixed-length hex string', () => {
    expect(islandFingerprint).toMatch(/^[0-9a-f]{28}$/);
  });

  it('changes when one seed moves by a single tile', () => {
    const moved = edit(REAL, 'kind = "town_center"\nat = [[7, 7]]', 'kind = "town_center"\nat = [[0, 0]]');
    expect(fingerprint(parseManifest(moved))).not.toBe(fingerprint(parseManifest(REAL)));
  });

  it('ignores comments and spacing, which are not part of the world', () => {
    const reworded = `# a new comment\n\n${REAL.replace('[world]', '[world]   ')}`;
    expect(fingerprint(parseManifest(reworded))).toBe(fingerprint(parseManifest(REAL)));
  });

  it('changes when the starting cast changes', () => {
    const changed = edit(REAL, 'Restless and easily bored.', 'Calm and patient.');
    expect(fingerprint(parseManifest(changed))).not.toBe(fingerprint(parseManifest(REAL)));
  });

  it('changes when the engine rules version changes (and defaults to ENGINE_RULES_VERSION)', () => {
    const m = parseManifest(REAL);
    expect(fingerprint(m, ENGINE_RULES_VERSION + 1)).not.toBe(fingerprint(m, ENGINE_RULES_VERSION));
    expect(fingerprint(m)).toBe(fingerprint(m, ENGINE_RULES_VERSION));
    expect(ENGINE_RULES_VERSION).toBe(1);
  });
});

describe('checkFingerprint (E2)', () => {
  it('accepts a checkpoint whose fingerprint equals the current world', () => {
    expect(checkFingerprint(islandFingerprint, islandFingerprint)).toEqual({ ok: true, message: expect.any(String) });
  });

  it('refuses a different fingerprint in plain language', () => {
    const other = fingerprint(parseManifest(edit(REAL, 'kind = "town_center"\nat = [[7, 7]]', 'kind = "town_center"\nat = [[0, 0]]')));
    const r = checkFingerprint(other, islandFingerprint);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('different world');
    expect(r.message).toContain('replay');
  });

  it('refuses a missing fingerprint (a checkpoint from before fingerprints existed)', () => {
    for (const stored of [undefined, '']) {
      const r = checkFingerprint(stored, islandFingerprint);
      expect(r.ok).toBe(false);
      expect(r.message).toContain('before worlds carried a fingerprint');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The mystery's behavior comes from the manifest (R6.2)

describe('on_thrown_cube', () => {
  afterEach(() => {
    vi.doUnmock('../islandManifest.generated.ts');
    vi.resetModules();
  });

  /** Loads a fresh world.ts whose island text is the real one with the rock's behavior replaced. */
  async function worldWithBehavior(behavior: string) {
    vi.resetModules();
    vi.doMock('../islandManifest.generated.ts', () => ({
      ISLAND_MANIFEST_TOML: edit(REAL, 'on_thrown_cube = "spawn_two_cubes"', `on_thrown_cube = "${behavior}"`),
    }));
    return import('../world.ts');
  }

  async function throwAtRock(behavior: string) {
    const w = await worldWithBehavior(behavior);
    const objects = w.seedObjects().filter((o) => o.kind === 'rock' || o.kind === 'town_center');
    const rock = objects.find((o) => o.kind === 'rock');
    if (!rock) throw new Error('no rock');
    const agent: import('../world.ts').AgentState = {
      id: 'a', name: 'Alder', model: 'stub', color: '#000000', island: 'hills',
      pos: { x: rock.pos.x - 3, y: rock.pos.y }, mood: 'curious', persona: 'test', status: 'idle',
      inventory: ['cube'], hunger: 0, energy: 100, traits: {}, goals: [], relationships: [],
    };
    const snap = { tick: 1, agents: [agent], objects, civ: { wood: 0, food: 0, gold: 0, stone: 0, age: 1 }, nextId: 1 };
    const result = w.step(snap, 'a', { type: 'throw', data: { dx: 3, dy: 0 } });
    return { result, snap, rock };
  }

  it('spawn_two_cubes: the thrown cube is swallowed and two new cubes appear', async () => {
    const { result } = await throwAtRock('spawn_two_cubes');
    expect(result.ok).toBe(true);
    expect(result.spawned).toHaveLength(2);
  });

  it('none: the cube just lands on the tile before the rock and nothing spawns', async () => {
    const { result, snap, rock } = await throwAtRock('none');
    expect(result.ok).toBe(true);
    expect(result.spawned).toBeUndefined();
    const cubes = snap.objects.filter((o) => o.kind === 'cube');
    expect(cubes).toHaveLength(1);
    expect(cubes[0].pos).toEqual({ x: rock.pos.x - 1, y: rock.pos.y });
  });
});
