/**
 * ONE-TIME EXPORT of the pre-manifest island to worlds/founding-island/world.toml (SPEC R6.6, T3).
 *
 * Reads the golden description captured from the hand-built island
 * (src/sim/__tests__/golden/island.json, see capture-golden-island.mjs) and writes the manifest.
 * Seeds are written in the compact [[seed_group]] form: each group is a run of same-territory,
 * same-kind objects in the exact order the old code created them, so the expanded ids
 * (res_0, res_1, ...) are identical. The Standing Rock is a [[mystery]] that takes its id slot
 * after the seed group named by `after_seed_group`.
 *
 * The world.toml is the source of truth from now on and is edited by hand or by the assistant;
 * do not re-run this to overwrite it.
 *
 * Usage: node scripts/export-island-manifest.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const golden = JSON.parse(readFileSync(new URL('../src/sim/__tests__/golden/island.json', import.meta.url), 'utf8'));
const q = (s) => JSON.stringify(s);
const pt = (p) => `{ x = ${p.x}, y = ${p.y} }`;
const out = [];

out.push('# The Founding Island: the one world this build ships (SPEC section 6).');
out.push('# All coordinates are absolute grid coordinates. Kinds and behaviors come from the engine vocabulary.');
out.push('# Seeds get ids res_0, res_1, ... in this order: each seed_group in file order (each group in the order of its');
out.push('# "at" list), then each seed_object. A mystery takes its id slot after the first `after_seed_group` groups.');
out.push('schema_version = 1');
out.push('');
out.push('[world]');
out.push('name = "The Founding Island"');
out.push('description = "Three territories, one empire, a mystery in the hills."');
out.push(`grid_size = ${golden.gridSize}`);
out.push('max_villagers = 8');

for (const t of golden.territories) {
  out.push('', '[[territory]]');
  out.push(`id = ${q(t.id)}`, `name = ${q(t.name)}`, `color = ${q(t.color)}`);
  out.push(`offset = ${pt(t.offset)}`, `size = ${t.size}`, `description = ${q(t.description)}`);
}

for (const r of golden.roads) {
  out.push('', '[[road]]');
  out.push(`from = ${q(r.from)}`, `to = ${q(r.to)}`);
  out.push(`cells = [${r.cells.map(pt).join(', ')}]`);
}

// seeds: maximal runs of same territory + kind, split where the mystery sits
const rock = golden.objects.find((o) => o.kind === 'rock');
const groups = [];
let afterGroups = 0;
let splitNext = false; // the rock splits a run so ids keep their old slots
for (const o of golden.objects) {
  if (o === rock) {
    afterGroups = groups.length;
    splitNext = true;
    continue;
  }
  const last = groups[groups.length - 1];
  if (last && !splitNext && last.territory === o.territory && last.kind === o.kind) last.at.push([o.x, o.y]);
  else groups.push({ territory: o.territory, kind: o.kind, at: [[o.x, o.y]] });
  splitNext = false;
}
for (const g of groups) {
  out.push('', '[[seed_group]]');
  out.push(`territory = ${q(g.territory)}`, `kind = ${q(g.kind)}`);
  const lines = g.at.map(([x, y]) => `[${x}, ${y}]`);
  out.push(`at = [${lines.join(', ')}]`);
}

if (rock) {
  out.push('', '[[mystery]]');
  out.push('id = "standing_rock"', `territory = ${q(rock.territory)}`, `at = ${pt(rock)}`, 'kind = "rock"');
  out.push('on_thrown_cube = "spawn_two_cubes"', `after_seed_group = ${afterGroups}`);
}

// The old code placed Bramble at (4,4) but labelled her island "valley" while (4,4) is Greenwood
// Forest. A manifest villager must stand in their own territory (R6.3), so the export labels
// her with the territory her tile is actually in. The parity test lists this as its one known divergence.
const within = (t, p) => p.x >= t.offset.x && p.x < t.offset.x + t.size && p.y >= t.offset.y && p.y < t.offset.y + t.size;
for (const c of golden.cast) {
  const own = golden.territories.find((t) => t.id === c.territory);
  if (!within(own, c)) {
    const actual = golden.territories.find((t) => within(t, c));
    console.log(`note: ${c.name} stood at (${c.x},${c.y}) outside ${c.territory}; exporting territory ${actual.id}`);
    c.territory = actual.id;
  }
  out.push('', '[[starting_villagers]]');
  out.push(`name = ${q(c.name)}`, `persona = ${q(c.persona)}`, `territory = ${q(c.territory)}`);
  out.push(`at = ${pt(c)}`, `color = ${q(c.color)}`);
}

mkdirSync(new URL('../worlds/founding-island/', import.meta.url), { recursive: true });
writeFileSync(new URL('../worlds/founding-island/world.toml', import.meta.url), out.join('\n') + '\n');
console.log(`world.toml: ${groups.length} seed groups, rock after group ${afterGroups}`);
