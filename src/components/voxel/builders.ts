import * as THREE from 'three';
import type { TerritoryId, WorldObject } from '@/sim/world';
import { GRID_SIZE, isRoad, territoryAt } from '@/sim/world';

export const TILE = 1;
export const ISLAND_TOP = 0;
export const LAYERS = 3;

/** The single source of truth for ground surface height at a tile — used by
 *  terrain drawing, object placement and villager feet so nothing sinks.
 *  Variation RAISES a tile into a gentle mound; it never lowers it. */
export function groundHeight(x: number, y: number): number {
  const t = territoryAt({ x, y });
  if (!t) return ISLAND_TOP + 1; // roads and water sit at the flat baseline
  return ISLAND_TOP + 1 + tileHeightVariation(x, y, t);
}

const shared = new Map<string, THREE.Material>();
function mat(color: string, opts: { flat?: boolean; rough?: number } = {}): THREE.MeshLambertMaterial {
  const key = color + (opts.flat ? '-f' : '') + (opts.rough ?? 1);
  if (!shared.has(key)) {
    shared.set(
      key,
      new THREE.MeshLambertMaterial({ color, flatShading: opts.flat ?? true })
    );
  }
  return shared.get(key)! as THREE.MeshLambertMaterial;
}

const boxGeo = new THREE.BoxGeometry(TILE, TILE, TILE);

const TERRAIN_COLORS: Record<TerritoryId, { grass: string; dirt: string; rock: string; sand: string }> = {
  forest: { grass: '#5cb85c', dirt: '#7a5230', rock: '#6e6e6e', sand: '#d9c98a' },
  valley: { grass: '#a8c256', dirt: '#8a6234', rock: '#7a7a72', sand: '#e0d294' },
  hills: { grass: '#8a9a5b', dirt: '#6e5236', rock: '#8d8d93', sand: '#cbc08a' },
};

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let u = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    u = (u + Math.imul(u ^ (u >>> 7), 61 | u)) ^ u;
    return ((u ^ (u >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Tile {
  x: number;
  y: number;
  territory: TerritoryId | null;
}

/** Deterministic height offset per tile so islands feel hand-carved, not flat slabs. */
function tileHeightVariation(x: number, y: number, t: TerritoryId): number {
  const rnd = mulberry32(x * 73 + y * 149 + t.length * 7);
  const r = rnd();
  if (t === 'hills') return r < 0.28 ? 1 : 0;
  return r < 0.14 ? 1 : 0;
}

/** Builds the voxel island meshes (grass tops, dirt middles, rock undersides). */
export function buildTerrain(): THREE.Group {
  const group = new THREE.Group();

  for (let x = 0; x < GRID_SIZE; x++) {
    for (let y = 0; y < GRID_SIZE; y++) {
      const territory = territoryAt({ x, y });
      if (!territory && !isRoad({ x, y })) continue;

      const colors = TERRAIN_COLORS[territory ?? 'forest'];
      const bump = territory ? tileHeightVariation(x, y, territory) : 0;
      const surface = groundHeight(x, y);
      const topY = surface - 1;
      const road = isRoad({ x, y });

      for (let layer = 0; layer < LAYERS + bump; layer++) {
        const worldY = topY - layer;
        let color: string;
        if (layer === 0) {
          color = road ? colors.sand : colors.grass;
        } else if (layer < 2) {
          color = colors.dirt;
        } else {
          color = colors.rock;
        }
        const mesh = new THREE.Mesh(boxGeo, mat(color));
        mesh.position.set(x + 0.5, worldY + 0.5, y + 0.5);
        group.add(mesh);
      }
    }
  }
  return group;
}

const STRUCTURE_PARTS: Record<
  WorldObject['kind'],
  Array<{ size: [number, number, number]; offset: [number, number, number]; color: string }>
> = {
  tree: [
    { size: [0.18, 0.7, 0.18], offset: [0, 0.35, 0], color: '#6b4a2b' },
    { size: [0.6, 0.5, 0.6], offset: [0, 0.9, 0], color: '#2f7d32' },
    { size: [0.4, 0.3, 0.4], offset: [0, 1.25, 0], color: '#388e3c' },
  ],
  berry_bush: [
    { size: [0.55, 0.4, 0.55], offset: [0, 0.2, 0], color: '#3d7a3f' },
    { size: [0.16, 0.16, 0.16], offset: [0.15, 0.42, 0.1], color: '#5c6bc0' },
    { size: [0.14, 0.14, 0.14], offset: [-0.18, 0.38, -0.12], color: '#5c6bc0' },
  ],
  gold_mine: [
    { size: [0.7, 0.35, 0.7], offset: [0, 0.17, 0], color: '#8d8d93' },
    { size: [0.3, 0.3, 0.3], offset: [0.1, 0.45, 0.1], color: '#f0c330' },
    { size: [0.2, 0.2, 0.2], offset: [-0.2, 0.4, -0.15], color: '#d4a915' },
  ],
  stone_mine: [
    { size: [0.75, 0.4, 0.75], offset: [0, 0.2, 0], color: '#84848a' },
    { size: [0.35, 0.35, 0.35], offset: [0, 0.55, 0], color: '#9a9aa2' },
  ],
  town_center: [
    { size: [0.9, 0.5, 0.9], offset: [0, 0.25, 0], color: '#b08050' },
    { size: [0.7, 0.4, 0.7], offset: [0, 0.65, 0], color: '#c29058' },
    { size: [0.94, 0.18, 0.94], offset: [0, 0.92, 0], color: '#7a4a2b' },
    { size: [0.3, 0.4, 0.3], offset: [0, 1.2, 0], color: '#e0c060' },
  ],
  house: [
    { size: [0.8, 0.5, 0.8], offset: [0, 0.25, 0], color: '#c9a876' },
    { size: [0.9, 0.4, 0.9], offset: [0, 0.68, 0], color: '#a0522d' },
  ],
  mill: [
    { size: [0.7, 0.6, 0.7], offset: [0, 0.3, 0], color: '#d4b896' },
    { size: [0.9, 0.16, 0.9], offset: [0, 0.68, 0], color: '#8d6e4a' },
    { size: [0.5, 0.14, 0.14], offset: [0, 0.85, 0], color: '#e8dcc8' },
  ],
  barracks: [
    { size: [0.85, 0.45, 0.85], offset: [0, 0.22, 0], color: '#8d8d93' },
    { size: [0.95, 0.3, 0.95], offset: [0, 0.58, 0], color: '#6d6d73' },
    { size: [0.14, 0.5, 0.14], offset: [0.3, 0.85, 0.3], color: '#b03a3a' },
  ],
  watch_tower: [
    { size: [0.55, 0.9, 0.55], offset: [0, 0.45, 0], color: '#9a9aa2' },
    { size: [0.7, 0.2, 0.7], offset: [0, 1, 0], color: '#7a7a80' },
    { size: [0.2, 0.35, 0.2], offset: [0, 1.28, 0], color: '#e0c060' },
  ],
  wonder: [
    { size: [0.9, 0.4, 0.9], offset: [0, 0.2, 0], color: '#e8d8a8' },
    { size: [0.65, 0.5, 0.65], offset: [0, 0.65, 0], color: '#f0e2b8' },
    { size: [0.4, 0.45, 0.4], offset: [0, 1.12, 0], color: '#f5ecc8' },
    { size: [0.2, 0.3, 0.2], offset: [0, 1.5, 0], color: '#ffe97a' },
  ],
  cube: [{ size: [0.45, 0.45, 0.45], offset: [0, 0.24, 0], color: '#d4b24a' }],
  rock: [
    { size: [0.85, 0.7, 0.85], offset: [0, 0.35, 0], color: '#6e6a63' },
    { size: [0.55, 0.4, 0.55], offset: [0.1, 0.85, -0.05], color: '#7d7970' },
    { size: [0.14, 0.14, 0.14], offset: [-0.25, 0.55, 0.3], color: '#c9b458' },
  ],
  shrub: [
    { size: [0.5, 0.3, 0.5], offset: [0, 0.15, 0], color: '#4a8a3d' },
    { size: [0.35, 0.25, 0.35], offset: [0.08, 0.4, -0.05], color: '#57994a' },
  ],
  flower: [
    { size: [0.08, 0.3, 0.08], offset: [0, 0.15, 0], color: '#4a8a3d' },
    { size: [0.16, 0.16, 0.16], offset: [0, 0.36, 0], color: '#e88bb0' },
    { size: [0.1, 0.1, 0.1], offset: [0.14, 0.08, 0.1], color: '#57994a' },
    { size: [0.14, 0.14, 0.14], offset: [0.16, 0.3, 0.12], color: '#f2c14e' },
  ],
  boulder: [
    { size: [0.6, 0.45, 0.6], offset: [0, 0.22, 0], color: '#7d7970' },
    { size: [0.4, 0.3, 0.4], offset: [-0.08, 0.55, 0.06], color: '#8a867c' },
  ],
  outcrop: [
    { size: [0.5, 0.7, 0.5], offset: [0, 0.35, 0], color: '#8d8d93' },
    { size: [0.3, 0.45, 0.3], offset: [0.18, 0.75, -0.1], color: '#9a9aa2' },
    { size: [0.25, 0.3, 0.25], offset: [-0.2, 0.5, 0.15], color: '#84848a' },
  ],
  deer: [
    { size: [0.55, 0.28, 0.25], offset: [0, 0.5, 0], color: '#a9743f' },
    { size: [0.18, 0.22, 0.18], offset: [0.32, 0.72, 0], color: '#b8834c' },
    { size: [0.06, 0.22, 0.06], offset: [0.34, 0.92, 0.05], color: '#8a5a28' },
    { size: [0.06, 0.22, 0.06], offset: [0.34, 0.92, -0.05], color: '#8a5a28' },
    { size: [0.08, 0.36, 0.08], offset: [-0.2, 0.18, 0.08], color: '#8a5a28' },
    { size: [0.08, 0.36, 0.08], offset: [0.2, 0.18, -0.08], color: '#8a5a28' },
    { size: [0.1, 0.12, 0.06], offset: [-0.12, 0.62, 0.14], color: '#f0e0c8' },
  ],
  boar: [
    { size: [0.6, 0.34, 0.3], offset: [0, 0.34, 0], color: '#5a4632' },
    { size: [0.22, 0.24, 0.22], offset: [0.36, 0.44, 0], color: '#6a543c' },
    { size: [0.1, 0.1, 0.04], offset: [0.48, 0.42, 0], color: '#e8dcc8' },
    { size: [0.09, 0.2, 0.09], offset: [-0.2, 0.1, 0.09], color: '#463626' },
    { size: [0.09, 0.2, 0.09], offset: [0.18, 0.1, -0.09], color: '#463626' },
  ],
  sheep: [
    { size: [0.5, 0.36, 0.34], offset: [0, 0.4, 0], color: '#efe9dc' },
    { size: [0.2, 0.2, 0.18], offset: [0.32, 0.56, 0], color: '#3d352c' },
    { size: [0.08, 0.24, 0.08], offset: [-0.16, 0.12, 0.09], color: '#3d352c' },
    { size: [0.08, 0.24, 0.08], offset: [0.16, 0.12, -0.09], color: '#3d352c' },
  ],
};

const ANIMAL_PART_KINDS = new Set(['deer', 'boar', 'sheep']);

/** Builds voxel meshes for every world object (trees, mines, buildings, creatures). */
export function buildObjects(objects: WorldObject[], births?: Map<string, number>): THREE.Group {
  const group = new THREE.Group();
  for (const o of objects) {
    const parts = STRUCTURE_PARTS[o.kind];
    if (!parts) continue;
    const baseY = groundHeight(o.pos.x, o.pos.y);
    const newborn = births?.has(o.id);
    const isAnimal = ANIMAL_PART_KINDS.has(o.kind);
    for (const p of parts) {
      const geo = new THREE.BoxGeometry(...p.size);
      const mesh = new THREE.Mesh(geo, mat(p.color));
      mesh.position.set(o.pos.x + 0.5 + p.offset[0], baseY + p.offset[1], o.pos.y + 0.5 + p.offset[2]);
      mesh.userData.oid = o.id;
      if (isAnimal) {
        mesh.userData.animal = true;
        mesh.userData.baseY = mesh.position.y;
      }
      if (newborn) mesh.scale.setScalar(0.01);
      group.add(mesh);
    }
  }
  return group;
}

export interface VillagerRig {
  group: THREE.Group;
  leftLeg: THREE.Mesh;
  rightLeg: THREE.Mesh;
  leftArm: THREE.Mesh;
  rightArm: THREE.Mesh;
  body: THREE.Mesh;
  head: THREE.Group;
  target: THREE.Vector3;
}

/** Builds a blocky Minecraft-style villager character. */
export function buildVillager(name: string, color: string): VillagerRig {
  const group = new THREE.Group();
  const skin = mat('#d8a878');
  const shirt = mat(color);
  const pants = mat(shadeHex(color, -0.35));
  const dark = mat('#2b2b2b');

  // legs
  const legGeo = new THREE.BoxGeometry(0.16, 0.42, 0.16);
  const leftLeg = new THREE.Mesh(legGeo, pants);
  leftLeg.position.set(-0.09, 0.21, 0);
  const rightLeg = new THREE.Mesh(legGeo, pants);
  rightLeg.position.set(0.09, 0.21, 0);
  group.add(leftLeg, rightLeg);

  // torso
  const bodyGeo = new THREE.BoxGeometry(0.38, 0.44, 0.22);
  const body = new THREE.Mesh(bodyGeo, shirt);
  body.position.set(0, 0.64, 0);
  group.add(body);

  // arms
  const armGeo = new THREE.BoxGeometry(0.12, 0.44, 0.12);
  const leftArm = new THREE.Mesh(armGeo, shirt);
  leftArm.position.set(-0.25, 0.64, 0);
  const rightArm = new THREE.Mesh(armGeo, shirt);
  rightArm.position.set(0.25, 0.64, 0);
  group.add(leftArm, rightArm);

  // head with simple face
  const head = new THREE.Group();
  const headGeo = new THREE.BoxGeometry(0.34, 0.34, 0.34);
  const skull = new THREE.Mesh(headGeo, skin);
  skull.position.y = 0.17;
  head.add(skull);
  const eyeGeo = new THREE.BoxGeometry(0.06, 0.08, 0.02);
  const eyeL = new THREE.Mesh(eyeGeo, dark);
  eyeL.position.set(-0.08, 0.2, 0.18);
  const eyeR = new THREE.Mesh(eyeGeo, dark);
  eyeR.position.set(0.08, 0.2, 0.18);
  head.add(eyeL, eyeR);
  head.position.y = 0.86;
  group.add(head);

  // floating name label
  const label = makeLabel(name, color);
  label.position.y = 1.45;
  group.add(label);

  return { group, leftLeg, rightLeg, leftArm, rightArm, body, head, target: new THREE.Vector3() };
}

function shadeHex(hex: string, amount: number): string {
  const n = hex.replace('#', '');
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  const f = (c: number) =>
    Math.max(0, Math.min(255, Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount))))
      .toString(16)
      .padStart(2, '0');
  return `#${f(r)}${f(g)}${f(b)}`;
}

/** rounded-rect path drawn manually — Safari lacks ctx.roundRect. */
function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function makeLabel(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(10, 8, 5, 0.75)';
  ctx.beginPath();
  roundedRectPath(ctx, 28, 8, 200, 48, 12);
  ctx.fill();
  ctx.font = 'bold 30px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text.slice(0, 12), 128, 34);
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  sprite.scale.set(1.1, 0.28, 1);
  return sprite;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 4);
}

/** Speech (say) or thought bubble rendered as a floating sprite. */
export function makeBubble(text: string, color: string, kind: 'speech' | 'thought'): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 208;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'bold 30px system-ui, sans-serif';
  const lines = wrapText(ctx, text.slice(0, 160), 440);
  const boxW = 480;
  const boxH = lines.length * 38 + 24;
  const y0 = 170 - boxH;

  // bubble background
  ctx.fillStyle = kind === 'thought' ? 'rgba(230, 245, 255, 0.92)' : 'rgba(255, 250, 240, 0.95)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.beginPath();
  roundedRectPath(ctx, 16, y0, boxW, boxH, 18);
  ctx.fill();
  ctx.stroke();

  // tail
  ctx.beginPath();
  ctx.moveTo(236, y0 + boxH - 2);
  ctx.lineTo(256, y0 + boxH + 18);
  ctx.lineTo(276, y0 + boxH - 2);
  ctx.closePath();
  ctx.fillStyle = kind === 'thought' ? 'rgba(230, 245, 255, 0.92)' : 'rgba(255, 250, 240, 0.95)';
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.stroke();

  ctx.fillStyle = '#241a0e';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => ctx.fillText(l, 256, y0 + 22 + i * 38));

  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  sprite.scale.set(3.4, 1.28, 1);
  sprite.center.set(0.5, 0);
  return sprite;
}
