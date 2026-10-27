import { parse as parseToml } from 'smol-toml';

/**
 * World manifests (SPEC section 6): a world is described as data, never as engine behavior.
 * This module parses and validates the TOML, expands the compact seed forms, and fingerprints
 * the result. It must stay loadable under plain Node type-stripping (no enums, no parameter
 * properties) and must not import world.ts (world.ts imports this).
 */

export const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * Engine rules version (R6.5). Part of every world fingerprint, so a checkpoint made under
 * different rules refuses to restore (SPEC section 9). Bump it by one whenever the engine's
 * behavior changes in a way an old checkpoint could not survive: build or age costs, caps,
 * XP curves, respawn rules (including ANIMAL_RESPAWN_TICKS), or what any action does. Changes
 * that do not alter how a world plays (UI, prompts' wording, refactors) do not bump it.
 */
export const ENGINE_RULES_VERSION = 1;

/** Largest grid the engine and renderer are built for. */
export const MAX_GRID_SIZE = 64;

/** Kinds a manifest may place as ordinary seed objects (R6.1: the vocabulary lives in code). */
export const SEED_KINDS = [
  'tree',
  'berry_bush',
  'gold_mine',
  'stone_mine',
  'town_center',
  'shrub',
  'flower',
  'boulder',
  'outcrop',
  'deer',
  'boar',
  'sheep',
  'cube',
] as const;
export type SeedKind = (typeof SEED_KINDS)[number];

/** Kinds a [[mystery]] may be. */
export const MYSTERY_KINDS = ['rock'] as const;
export type MysteryKind = (typeof MYSTERY_KINDS)[number];

/** The complete set of mystery-machine behaviors (R6.2). */
export const THROWN_CUBE_BEHAVIORS = ['none', 'spawn_two_cubes'] as const;
export type ThrownCubeBehavior = (typeof THROWN_CUBE_BEHAVIORS)[number];

export interface Pos {
  x: number;
  y: number;
}

export interface ManifestTerritory {
  id: string;
  name: string;
  color: string;
  offset: Pos;
  size: number;
  description: string;
}

export interface ManifestRoad {
  from: string;
  to: string;
  cells: Pos[];
}

/** One placed object after the compact forms are expanded. `id` is res_<n> in expansion order. */
export interface ManifestSeed {
  id: string;
  territory: string;
  kind: SeedKind | MysteryKind;
  pos: Pos;
  /** Set when this object is a mystery machine: the mystery's manifest id. */
  mystery?: string;
}

export interface ManifestMystery {
  id: string;
  territory: string;
  kind: MysteryKind;
  pos: Pos;
  onThrownCube: ThrownCubeBehavior;
}

/** A mystery as authored: where its object takes its id slot is authoring detail, not part of the world. */
export interface MysteryPlacement extends ManifestMystery {
  /** Number of seed_group entries whose objects come before this one in id order. */
  afterSeedGroup: number;
}

export interface ManifestVillager {
  name: string;
  persona: string;
  territory: string;
  pos: Pos;
  color?: string;
}

export interface SeedGroup {
  territory: string;
  kind: SeedKind;
  at: Pos[];
}

export interface SeedObject {
  territory: string;
  kind: SeedKind;
  at: Pos;
}

/** The validated world: what a world contains. Seeds are fully expanded. */
export interface WorldManifest {
  schemaVersion: number;
  world: { name: string; description: string; gridSize: number; maxVillagers: number };
  territories: ManifestTerritory[];
  roads: ManifestRoad[];
  seeds: ManifestSeed[];
  mysteries: ManifestMystery[];
  startingVillagers: ManifestVillager[];
}

/** Everything wrong with a manifest, found in one pass. Nothing is loaded when this is thrown. */
export class ManifestError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(
      `The world manifest is not valid (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n` +
        problems.map((p) => `  - ${p}`).join('\n')
    );
    this.name = 'ManifestError';
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------------------------
// Expansion

export interface SeedSource {
  groups: SeedGroup[];
  objects: SeedObject[];
  mysteries: MysteryPlacement[];
}

/**
 * Expands the compact forms into one entry per object and numbers them res_0, res_1, ...
 * Order (this is what ids depend on, so it is fixed): the [[seed_group]] entries in file order,
 * each group in the order of its `at` list; a [[mystery]] takes its slot after the first
 * `afterSeedGroup` groups (files order for ties); then every [[seed_object]] in file order.
 */
export function expandSeeds(source: SeedSource): ManifestSeed[] {
  const out: ManifestSeed[] = [];
  const push = (territory: string, kind: SeedKind | MysteryKind, pos: Pos, mystery?: string) => {
    const seed: ManifestSeed = { id: `res_${out.length}`, territory, kind, pos: { x: pos.x, y: pos.y } };
    if (mystery !== undefined) seed.mystery = mystery;
    out.push(seed);
  };
  const placeMysteries = (afterGroups: number) => {
    for (const m of source.mysteries) if (m.afterSeedGroup === afterGroups) push(m.territory, m.kind, m.pos, m.id);
  };
  placeMysteries(0);
  source.groups.forEach((g, i) => {
    for (const p of g.at) push(g.territory, g.kind, p);
    placeMysteries(i + 1);
  });
  for (const o of source.objects) push(o.territory, o.kind, o.at);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Validation

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const asRecs = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const tileKey = (p: Pos) => `${p.x},${p.y}`;

interface Ctx {
  problems: string[];
}

function unknownFields(o: Rec, allowed: readonly string[], label: string, ctx: Ctx) {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) ctx.problems.push(`${label}: unknown field "${k}" (allowed: ${allowed.join(', ')})`);
  }
}

function reqString(o: Rec, key: string, label: string, ctx: Ctx): string | undefined {
  const v = o[key];
  if (typeof v === 'string' && v.trim() !== '') return v;
  ctx.problems.push(`${label}: ${v === undefined ? 'missing required field' : 'invalid field'} "${key}" (a non-empty string is required)`);
  return undefined;
}

function reqInt(o: Rec, key: string, label: string, ctx: Ctx): number | undefined {
  const v = o[key];
  if (isInt(v)) return v;
  ctx.problems.push(`${label}: ${v === undefined ? 'missing required field' : 'invalid field'} "${key}" (a whole number is required)`);
  return undefined;
}

/** A point written as { x = 1, y = 2 }. */
function reqPoint(o: Rec, key: string, label: string, ctx: Ctx): Pos | undefined {
  const v = o[key];
  if (isRec(v) && isInt(v.x) && isInt(v.y)) return { x: v.x, y: v.y };
  ctx.problems.push(`${label}: ${v === undefined ? 'missing required field' : 'invalid field'} "${key}" (a point like { x = 1, y = 2 } is required)`);
  return undefined;
}

const readPoint = (v: unknown): Pos | undefined => (isRec(v) && isInt(v.x) && isInt(v.y) ? { x: v.x, y: v.y } : undefined);

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Validates untrusted parsed data and returns the typed, expanded world; throws ManifestError otherwise. */
export function validateManifest(raw: unknown): WorldManifest {
  const ctx: Ctx = { problems: [] };
  const bad = (msg: string) => ctx.problems.push(msg);

  if (!isRec(raw)) throw new ManifestError(['the manifest is empty or not a table']);
  unknownFields(raw, ['schema_version', 'world', 'territory', 'road', 'seed_group', 'seed_object', 'mystery', 'starting_villagers'], 'manifest', ctx);

  // schema_version
  const schemaVersion = raw.schema_version;
  if (schemaVersion === undefined) bad('schema_version: missing required field');
  else if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    bad(`schema_version ${JSON.stringify(schemaVersion)}: unsupported (this engine reads schema_version ${SUPPORTED_SCHEMA_VERSION})`);
  }

  // [world]
  let gridSize = 0;
  let maxVillagers = 0;
  let worldName = '';
  let worldDescription = '';
  if (!isRec(raw.world)) bad('world: missing required table [world]');
  else {
    unknownFields(raw.world, ['name', 'description', 'grid_size', 'max_villagers'], 'world', ctx);
    worldName = reqString(raw.world, 'name', 'world', ctx) ?? '';
    worldDescription = reqString(raw.world, 'description', 'world', ctx) ?? '';
    const g = reqInt(raw.world, 'grid_size', 'world', ctx);
    if (g !== undefined) {
      if (g < 1 || g > MAX_GRID_SIZE) bad(`world.grid_size (${g}): must be between 1 and ${MAX_GRID_SIZE}`);
      else gridSize = g;
    }
    const m = reqInt(raw.world, 'max_villagers', 'world', ctx);
    if (m !== undefined) {
      if (m < 1) bad(`world.max_villagers (${m}): must be at least 1`);
      else maxVillagers = m;
    }
  }
  const onGrid = (p: Pos) => p.x >= 0 && p.y >= 0 && p.x < gridSize && p.y < gridSize;

  // [[territory]]
  const territories: ManifestTerritory[] = [];
  const territoryIndex = new Map<string, number>();
  const tLabel = (i: number, id?: string) => `territory[${i}]${id ? ` (${id})` : ''}`;
  asRecs(raw.territory).forEach((entry, i) => {
    if (!isRec(entry)) return bad(`${tLabel(i)}: must be a table`);
    const label = tLabel(i, typeof entry.id === 'string' ? entry.id : undefined);
    unknownFields(entry, ['id', 'name', 'color', 'offset', 'size', 'description'], label, ctx);
    const id = reqString(entry, 'id', label, ctx);
    const name = reqString(entry, 'name', label, ctx);
    const color = reqString(entry, 'color', label, ctx);
    const offset = reqPoint(entry, 'offset', label, ctx);
    const size = reqInt(entry, 'size', label, ctx);
    const description = reqString(entry, 'description', label, ctx);
    if (color !== undefined && !HEX_COLOR.test(color)) bad(`${label}: color "${color}" must look like #22c55e`);
    if (size !== undefined && size < 1) bad(`${label}: size ${size} must be at least 1`);
    if (id === undefined || name === undefined || color === undefined || !offset || size === undefined || description === undefined) return;
    if (territoryIndex.has(id)) return bad(`${label}: duplicate territory id "${id}" (also territory[${territoryIndex.get(id)}])`);
    territoryIndex.set(id, i);
    territories.push({ id, name, color, offset, size, description });
  });
  if (!Array.isArray(raw.territory) || raw.territory.length === 0) bad('territory: at least one [[territory]] is required');

  const tByIndex = (id: string) => territoryIndex.get(id) ?? -1;
  const territoryOf = (p: Pos): ManifestTerritory | undefined =>
    territories.find((t) => p.x >= t.offset.x && p.x < t.offset.x + t.size && p.y >= t.offset.y && p.y < t.offset.y + t.size);

  let needed = 0;
  for (const t of territories) {
    const label = tLabel(tByIndex(t.id), t.id);
    needed = Math.max(needed, t.offset.x + t.size, t.offset.y + t.size);
    if (t.offset.x < 0 || t.offset.y < 0 || (gridSize > 0 && (t.offset.x + t.size > gridSize || t.offset.y + t.size > gridSize))) {
      bad(`${label}: out of bounds (covers x ${t.offset.x}..${t.offset.x + t.size - 1}, y ${t.offset.y}..${t.offset.y + t.size - 1} on a ${gridSize}x${gridSize} grid)`);
    }
  }
  for (let a = 0; a < territories.length; a++) {
    for (let b = a + 1; b < territories.length; b++) {
      const p = territories[a];
      const q = territories[b];
      const overlap = p.offset.x < q.offset.x + q.size && q.offset.x < p.offset.x + p.size && p.offset.y < q.offset.y + q.size && q.offset.y < p.offset.y + p.size;
      if (overlap) bad(`${tLabel(tByIndex(q.id), q.id)}: overlaps ${tLabel(tByIndex(p.id), p.id)}`);
    }
  }

  // [[road]]
  const roads: ManifestRoad[] = [];
  asRecs(raw.road).forEach((entry, i) => {
    if (!isRec(entry)) return bad(`road[${i}]: must be a table`);
    const label = `road[${i}]${typeof entry.from === 'string' && typeof entry.to === 'string' ? ` (${entry.from} to ${entry.to})` : ''}`;
    unknownFields(entry, ['from', 'to', 'cells'], label, ctx);
    const from = reqString(entry, 'from', label, ctx);
    const to = reqString(entry, 'to', label, ctx);
    for (const [key, id] of [['from', from], ['to', to]] as const) {
      if (id !== undefined && !territoryIndex.has(id)) bad(`${label}: ${key} names unknown territory "${id}"`);
    }
    if (!Array.isArray(entry.cells) || entry.cells.length === 0) {
      bad(`${label}: missing required field "cells" (a list of { x, y } points)`);
      return;
    }
    const cells: Pos[] = [];
    entry.cells.forEach((c: unknown, j: number) => {
      const p = readPoint(c);
      if (!p) return bad(`${label} cell ${j}: must be a point like { x = 1, y = 2 }`);
      if (gridSize > 0 && !onGrid(p)) return bad(`${label} cell ${j} (${p.x},${p.y}): off the map (the grid is ${gridSize}x${gridSize})`);
      needed = Math.max(needed, p.x + 1, p.y + 1);
      cells.push(p);
    });
    if (from !== undefined && to !== undefined) roads.push({ from, to, cells });
  });

  if (gridSize > 0 && needed > gridSize) {
    bad(`world.grid_size (${gridSize}): too small for the map, whose territories and roads reach ${needed} tiles across`);
  }

  // seeds: [[seed_group]], [[seed_object]], [[mystery]]
  const occupied = new Map<string, string>();
  /** Checks one placed object; returns true when it is fine to keep. */
  const checkPlacement = (label: string, territoryId: string, p: Pos): boolean => {
    const fail = (why: string) => {
      bad(`${label}: ${why}`);
      return false;
    };
    if (gridSize > 0 && !onGrid(p)) return fail('outside the grid');
    const here = territoryOf(p);
    if (!here) return fail('on water (no territory covers that tile)');
    if (here.id !== territoryId) return fail(`outside its territory ${territoryId} (the tile lies in ${here.id})`);
    const prior = occupied.get(tileKey(p));
    if (prior) return fail(`tile already holds ${prior}`);
    return true;
  };
  const seedLabel = (kind: string, p: Pos) => `${kind} at ${p.x},${p.y}`;

  const groups: SeedGroup[] = [];
  const objects: SeedObject[] = [];

  asRecs(raw.seed_group).forEach((entry, i) => {
    const base = `seed_group[${i}]`;
    if (!isRec(entry)) return bad(`${base}: must be a table`);
    unknownFields(entry, ['territory', 'kind', 'at'], base, ctx);
    const territory = reqString(entry, 'territory', base, ctx);
    const kind = reqString(entry, 'kind', base, ctx);
    const kindLabel = `${base}${kind ? ` (${kind})` : ''}`;
    let kindOk = false;
    if (kind !== undefined) {
      if ((SEED_KINDS as readonly string[]).includes(kind)) kindOk = true;
      else bad(`${kindLabel}: unknown kind "${kind}" (known kinds: ${SEED_KINDS.join(', ')})`);
    }
    let territoryOk = false;
    if (territory !== undefined) {
      if (territoryIndex.has(territory)) territoryOk = true;
      else bad(`${kindLabel}: unknown territory "${territory}"`);
    }
    if (!Array.isArray(entry.at) || entry.at.length === 0) {
      bad(`${kindLabel}: missing required field "at" (a list of [x, y] pairs)`);
      return;
    }
    const at: Pos[] = [];
    let allGood = kindOk && territoryOk;
    entry.at.forEach((c: unknown, j: number) => {
      if (!(Array.isArray(c) && c.length === 2 && isInt(c[0]) && isInt(c[1]))) {
        bad(`${kindLabel} item ${j}: must be an [x, y] pair of whole numbers`);
        allGood = false;
        return;
      }
      const p = { x: c[0] as number, y: c[1] as number };
      if (!kindOk || !territoryOk) return;
      const label = `${base} (${seedLabel(kind as string, p)})`;
      if (checkPlacement(label, territory as string, p)) {
        occupied.set(tileKey(p), `${base} (${kind})`);
        at.push(p);
      } else allGood = false;
    });
    if (allGood) groups.push({ territory: territory as string, kind: kind as SeedKind, at });
  });

  asRecs(raw.seed_object).forEach((entry, i) => {
    const base = `seed_object[${i}]`;
    if (!isRec(entry)) return bad(`${base}: must be a table`);
    unknownFields(entry, ['territory', 'kind', 'at'], base, ctx);
    const territory = reqString(entry, 'territory', base, ctx);
    const kind = reqString(entry, 'kind', base, ctx);
    const at = reqPoint(entry, 'at', base, ctx);
    if (territory === undefined || kind === undefined || !at) return;
    const label = `${base} (${seedLabel(kind, at)})`;
    let ok = true;
    if (!(SEED_KINDS as readonly string[]).includes(kind)) {
      bad(`${label}: unknown kind "${kind}" (known kinds: ${SEED_KINDS.join(', ')})`);
      ok = false;
    }
    if (!territoryIndex.has(territory)) {
      bad(`${label}: unknown territory "${territory}"`);
      ok = false;
    }
    if (ok && checkPlacement(label, territory, at)) {
      occupied.set(tileKey(at), `${base} (${kind})`);
      objects.push({ territory, kind: kind as SeedKind, at });
    }
  });

  const mysteries: MysteryPlacement[] = [];
  const mysteryIds = new Set<string>();
  const groupCount = Array.isArray(raw.seed_group) ? raw.seed_group.length : 0;
  asRecs(raw.mystery).forEach((entry, i) => {
    const base = `mystery[${i}]`;
    if (!isRec(entry)) return bad(`${base}: must be a table`);
    unknownFields(entry, ['id', 'territory', 'at', 'kind', 'on_thrown_cube', 'after_seed_group'], base, ctx);
    const id = reqString(entry, 'id', base, ctx);
    const territory = reqString(entry, 'territory', base, ctx);
    const at = reqPoint(entry, 'at', base, ctx);
    const kind = reqString(entry, 'kind', base, ctx);
    const behavior = reqString(entry, 'on_thrown_cube', base, ctx);
    let after = groupCount;
    if (entry.after_seed_group !== undefined) {
      if (isInt(entry.after_seed_group) && entry.after_seed_group >= 0 && entry.after_seed_group <= groupCount) after = entry.after_seed_group;
      else bad(`${base}${id ? ` (${id})` : ''}: after_seed_group ${JSON.stringify(entry.after_seed_group)} must be a whole number from 0 to ${groupCount}`);
    }
    if (id === undefined || territory === undefined || !at || kind === undefined || behavior === undefined) return;
    const label = `${base} (${id}, ${seedLabel(kind, at)})`;
    let ok = true;
    if (mysteryIds.has(id)) {
      bad(`${label}: duplicate mystery id "${id}"`);
      ok = false;
    }
    if (!(MYSTERY_KINDS as readonly string[]).includes(kind)) {
      bad(`${label}: unknown kind "${kind}" (mystery kinds: ${MYSTERY_KINDS.join(', ')})`);
      ok = false;
    }
    if (!(THROWN_CUBE_BEHAVIORS as readonly string[]).includes(behavior)) {
      bad(`${label}: unknown on_thrown_cube behavior "${behavior}" (known behaviors: ${THROWN_CUBE_BEHAVIORS.join(', ')})`);
      ok = false;
    }
    if (!territoryIndex.has(territory)) {
      bad(`${label}: unknown territory "${territory}"`);
      ok = false;
    }
    if (ok && checkPlacement(label, territory, at)) {
      mysteryIds.add(id);
      occupied.set(tileKey(at), `${base} (${id})`);
      mysteries.push({ id, territory, kind: kind as MysteryKind, pos: at, onThrownCube: behavior as ThrownCubeBehavior, afterSeedGroup: after });
    }
  });

  // [[starting_villagers]]
  const startingVillagers: ManifestVillager[] = [];
  const standing = new Map<string, string>();
  const names = new Map<string, number>();
  asRecs(raw.starting_villagers).forEach((entry, i) => {
    const base = `starting_villagers[${i}]`;
    if (!isRec(entry)) return bad(`${base}: must be a table`);
    const label = `${base}${typeof entry.name === 'string' ? ` (${entry.name})` : ''}`;
    unknownFields(entry, ['name', 'persona', 'territory', 'at', 'color'], label, ctx);
    const name = reqString(entry, 'name', label, ctx);
    const persona = reqString(entry, 'persona', label, ctx);
    const territory = reqString(entry, 'territory', label, ctx);
    const at = reqPoint(entry, 'at', label, ctx);
    let color: string | undefined;
    if (entry.color !== undefined) {
      if (typeof entry.color === 'string' && HEX_COLOR.test(entry.color)) color = entry.color;
      else bad(`${label}: color ${JSON.stringify(entry.color)} must look like #e2b04a`);
    }
    if (name === undefined || persona === undefined || territory === undefined || !at) return;
    let ok = true;
    if (names.has(name)) {
      bad(`${label}: duplicate villager name "${name}" (also starting_villagers[${names.get(name)}])`);
      ok = false;
    }
    if (!territoryIndex.has(territory)) {
      bad(`${label}: unknown territory "${territory}"`);
      ok = false;
    } else if (gridSize > 0 && !onGrid(at)) {
      bad(`${label}: starts at ${at.x},${at.y}, outside the grid`);
      ok = false;
    } else {
      const here = territoryOf(at);
      if (!here || here.id !== territory) {
        bad(`${label}: starts at ${at.x},${at.y}, outside its territory ${territory}${here ? ` (the tile lies in ${here.id})` : ' (that tile is water)'}`);
        ok = false;
      }
    }
    if (!ok) return;
    const key = tileKey(at);
    const rock = mysteries.find((m) => tileKey(m.pos) === key);
    if (rock) {
      bad(`${label}: starts at ${at.x},${at.y}, a tile occupied by mystery ${rock.id}`);
      return;
    }
    if (standing.has(key)) {
      bad(`${label}: starts at ${at.x},${at.y}, a tile occupied by ${standing.get(key)}`);
      return;
    }
    names.set(name, i);
    standing.set(key, `starting_villagers[${i}] (${name})`);
    const villager: ManifestVillager = { name, persona, territory, pos: at };
    if (color) villager.color = color;
    startingVillagers.push(villager);
  });
  if (maxVillagers > 0 && asRecs(raw.starting_villagers).length > maxVillagers) {
    bad(`starting_villagers: ${asRecs(raw.starting_villagers).length} villagers listed but world.max_villagers is ${maxVillagers}`);
  }

  if (ctx.problems.length > 0) throw new ManifestError(ctx.problems);

  return {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    world: { name: worldName, description: worldDescription, gridSize, maxVillagers },
    territories,
    roads,
    seeds: expandSeeds({ groups, objects, mysteries }),
    mysteries: mysteries.map(({ id, territory, kind, pos, onThrownCube }) => ({ id, territory, kind, pos, onThrownCube })),
    startingVillagers,
  };
}

/** Parses manifest text (TOML) and validates it. Throws ManifestError with every problem found. */
export function parseManifest(text: string): WorldManifest {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (e) {
    throw new ManifestError([`the file is not valid TOML: ${e instanceof Error ? e.message : String(e)}`]);
  }
  return validateManifest(raw);
}

// ---------------------------------------------------------------------------------------------
// Fingerprint (R6.5)

/** Canonical JSON: object keys sorted, so equal data always serializes identically. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isRec(v)) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** cyrb53: a small, fast, well-mixed 53-bit string hash (public domain, by bryc). */
function cyrb53(str: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * A deterministic fingerprint of the validated, expanded world plus the engine rules version.
 * Synchronous and dependency-free (two cyrb53 passes, 28 hex characters). It is an identity
 * check against accidental mismatch, not a security hash. The rules version is injectable so
 * tests can prove that bumping it changes the result.
 */
export function fingerprint(manifest: WorldManifest, engineRulesVersion: number = ENGINE_RULES_VERSION): string {
  const text = canonicalJson({ rules: engineRulesVersion, world: manifest });
  const part = (seed: number) => cyrb53(text, seed).toString(16).padStart(14, '0');
  return part(0) + part(1);
}

/** Decides whether a stored checkpoint fingerprint may be restored into the current world (E2). */
export function checkFingerprint(stored: string | undefined, current: string): { ok: boolean; message: string } {
  if (!stored) {
    return {
      ok: false,
      message:
        'This checkpoint was saved before worlds carried a fingerprint, so it cannot be safely restored into this world. You can still replay it, but not resume from it.',
    };
  }
  if (stored !== current) {
    return {
      ok: false,
      message:
        'This checkpoint was saved in a different world: the island map or the engine rules have changed since (fingerprint mismatch). It cannot be restored here. You can still replay it.',
    };
  }
  return { ok: true, message: 'The checkpoint matches this world.' };
}
