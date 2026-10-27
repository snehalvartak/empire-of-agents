import type { ActionInput } from './world.ts';
import { normalizeTraitName } from './traits.ts';

/**
 * The single action-definition table (SPEC R3.1).
 *
 * Everything the villager-facing side knows about an action type lives here:
 * its catalog line, its thought/deed verb family and its argument sanitizer.
 * `brain.ts` generates the prompt catalog, the JSON-schema enum, the sanitizer
 * and the mismatch verbs from this table; `world.ts` derives `ACTION_TYPES`
 * from it and its `step()` switch is checked exhaustively against the
 * `ActionInput` union. Keys are typed as `ActionInput['type']`, so a type added
 * to (or removed from) the union without a matching entry here fails typecheck.
 *
 * This module must not import from brain.ts. It imports only types from world.ts.
 */

export type ActionType = ActionInput['type'];
type ActionOf<T extends ActionType> = Extract<ActionInput, { type: T }>;
type RawData = Record<string, unknown>;

export interface ActionDef<T extends ActionType = ActionType> {
  type: T;
  /** Catalog line shown to the villager (one bullet in the prompt). */
  catalog: string;
  /**
   * Verb family for the thought/deed mismatch heuristic: the thought should name
   * one of these. Omitted = no check (the action always counts as matching).
   */
  verbs?: readonly string[];
  /** Turns raw model output into the action's data; null rejects it (becomes wait). */
  sanitize(data: RawData): ActionOf<T>['data'] | null;
}

const GATHER_VERBS = ['gather', 'chop', 'chopping', 'harvest', 'pick', 'forage', 'mine', 'cut'] as const;
const BUILD_STRUCTURES = ['house', 'mill', 'barracks', 'watch_tower', 'wonder'] as const;
type Structure = (typeof BUILD_STRUCTURES)[number];

const direction = (d: RawData) => ({ dx: Number(d.dx) || 0, dy: Number(d.dy) || 0 });

export const ACTION_DEFS: { [T in ActionType]: ActionDef<T> } = {
  goto: {
    type: 'goto',
    catalog: `{"type":"goto","data":{"x":<worldX>,"y":<worldY>}}  march toward a point (auto-pathfinds along roads)`,
    verbs: ['march', 'goto', 'go to', 'walk', 'travel', 'head', 'move toward'],
    sanitize: (d) => ({ x: Number(d.x) || 0, y: Number(d.y) || 0 }),
  },
  move: {
    type: 'move',
    catalog: `{"type":"move","data":{"dx":<-1|0|1>,"dy":<-1|0|1>}}  step one tile`,
    verbs: ['step', 'move', 'walk'],
    sanitize: direction,
  },
  gather: {
    type: 'gather',
    catalog: `{"type":"gather","data":{"object_id":"<id>"}}  attempt to take something from a thing you stand on or directly beside`,
    verbs: GATHER_VERBS,
    sanitize: (d) => ({ object_id: String(d.object_id ?? '') }),
  },
  gather_nearest: {
    type: 'gather_nearest',
    catalog: `{"type":"gather_nearest","data":{}}  take from the closest gatherable thing beside you — no id needed, use this when a resource is in reach`,
    verbs: GATHER_VERBS,
    sanitize: () => ({}),
  },
  deposit: {
    type: 'deposit',
    catalog: `{"type":"deposit","data":{}}  hand what you carry to the Town Center beside you, into the shared stockpile`,
    verbs: ['deposit', 'hand', 'deliver', 'stockpile', 'store', 'unload'],
    sanitize: () => ({}),
  },
  pick_up: {
    type: 'pick_up',
    catalog: `{"type":"pick_up","data":{"object_id":"<id>"}}  pick up an object you stand on or beside (max 1 carried alongside resources)`,
    verbs: ['pick up', 'grab', 'take the'],
    sanitize: (d) => ({ object_id: String(d.object_id ?? '') }),
  },
  place: {
    type: 'place',
    catalog: `{"type":"place","data":{"dx":<-1|0|1>,"dy":<-1|0|1>}}  set a carried object on an adjacent empty tile`,
    verbs: ['place', 'set down', 'put down'],
    sanitize: direction,
  },
  throw: {
    type: 'throw',
    catalog: `{"type":"throw","data":{"dx":<-3..3>,"dy":<-3..3>}}  hurl a carried object up to 3 tiles in a direction`,
    verbs: ['throw', 'hurl', 'toss'],
    sanitize: direction,
  },
  build: {
    type: 'build',
    catalog: `{"type":"build","data":{"structure":"${BUILD_STRUCTURES.join('|')}"}}  construct from the shared stockpile`,
    verbs: ['build', 'construct', 'raise'],
    sanitize: (d) => {
      const s = String(d.structure ?? '');
      return { structure: BUILD_STRUCTURES.includes(s as Structure) ? (s as Structure) : 'house' };
    },
  },
  advance_age: {
    type: 'advance_age',
    catalog: `{"type":"advance_age","data":{}}  advance the whole empire to the next age`,
    verbs: ['advance', 'age'],
    sanitize: () => ({}),
  },
  say: {
    type: 'say',
    catalog: `{"type":"say","data":{"message":"..."}}  declare something aloud (visible in the chronicle)`,
    verbs: ['say', 'declare', 'shout', 'announce', 'call out'],
    sanitize: (d) => ({ message: String(d.message ?? '...') }),
  },
  chat: {
    type: 'chat',
    catalog: `{"type":"chat","data":{"agent_id":"<id>","message":"..."}}  say something directly to a villager standing right beside you (they hear it and may reply on their own turn)`,
    verbs: ['chat', 'talk', 'speak', 'greet', 'converse'],
    sanitize: (d) => ({
      agent_id: String(d.agent_id ?? d.target_id ?? ''),
      message: String(d.message ?? '...').slice(0, 200),
    }),
  },
  gift: {
    type: 'gift',
    catalog: `{"type":"gift","data":{"agent_id":"<id>","item":"wood|food|gold|stone|cube"}}  hand 1 carried item to a villager beside you. A gift deepens a bond far more than a chat — generosity is remembered across the ages.`,
    verbs: ['give', 'gift', 'hand', 'offer', 'present'],
    sanitize: (d) => ({
      agent_id: String(d.agent_id ?? d.target_id ?? ''),
      ...(d.item ? { item: String(d.item).slice(0, 40) } : {}),
    }),
  },
  wander: {
    type: 'wander',
    catalog: `{"type":"wander","data":{}}  step onto ground you have not stood on recently. The empire's edge, the roads, the Standing Rock and the strange cubes are all waiting to be found — wandering is how villagers discover what no map shows.`,
    verbs: ['wander', 'explore', 'roam', 'stroll', 'wander east', 'wander west'],
    sanitize: () => ({}),
  },
  eat: {
    type: 'eat',
    catalog: `{"type":"eat","data":{}}  take 1 food from the shared stockpile and eat it (only worth it when hungry)`,
    verbs: ['eat', 'eating', 'food', 'bite', 'meal'],
    sanitize: () => ({}),
  },
  remember: {
    type: 'remember',
    catalog: `{"type":"remember","data":{"kind":"semantic|episodic","content":"..."}}  write to the empire chronicles`,
    verbs: ['remember', 'write', 'record', 'chronicle'],
    sanitize: (d) => ({
      kind: d.kind === 'semantic' ? 'semantic' : 'episodic',
      content: String(d.content ?? ''),
    }),
  },
  train: {
    type: 'train',
    catalog: `{"type":"train","data":{"ability":"..."}}  train an ability you name — ANY name you choose (e.g. "fishing", "rhetoric", "cartography", "wrestling", "poetry"). You invent abilities freely; each training session deepens your mastery. Your abilities grow from what you do and say.`,
    verbs: ['train', 'practice', 'drill'],
    sanitize: (d) => {
      const name = normalizeTraitName(String(d.ability ?? d.name ?? ''));
      return name ? { ability: name } : null;
    },
  },
  discover: {
    type: 'discover',
    catalog: `{"type":"discover","data":{"insight":"..."}}  record a DISCOVERY — a rule, technique or affordance of the world you noticed. Discoveries persist forever and are shared with every villager: your knowledge becomes the empire's knowledge.`,
    verbs: ['discover', 'note', 'realize', 'insight'],
    sanitize: (d) => ({ insight: String(d.insight ?? '').slice(0, 300) }),
  },
  set_goal: {
    type: 'set_goal',
    catalog: `{"type":"set_goal","data":{"goal":"..."}}  declare your current ambition. It persists across turns and you will be reminded of it.`,
    verbs: ['goal', 'ambition', 'aim', 'resolve'],
    sanitize: (d) => ({ goal: String(d.goal ?? '').slice(0, 160) }),
  },
  plan: {
    type: 'plan',
    catalog: `{"type":"plan","data":{"steps":[<action>, <action>, ...]}}  execute 2-4 actions IN SEQUENCE this turn. Each step is a full action object like {"type":"goto",...}. Steps run one after another; later steps see earlier results.`,
    // No verb family on purpose: how a plan's thought is checked against its
    // steps is a separate piece of work (SPEC T4), not a plan-word heuristic.
    sanitize: (d) => {
      const steps = Array.isArray(d.steps) ? (d.steps as unknown[]) : [];
      const sanitized = steps
        .slice(0, 4)
        .map(sanitizeStep)
        .filter((a): a is ActionInput => a !== null && a.type !== 'plan');
      return sanitized.length ? { steps: sanitized } : null;
    },
  },
  wait: {
    type: 'wait',
    catalog: `{"type":"wait","data":{}}`,
    verbs: ['wait', 'rest', 'pause', 'stand still', 'watch'],
    sanitize: () => ({}),
  },
};

function sanitizeStep(raw: unknown): ActionInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as { type?: string; data?: RawData };
  return sanitizeAction(obj.type ?? 'wait', obj.data ?? {});
}

/**
 * Looks `type` up in ACTION_DEFS and sanitizes `data` with that definition.
 * Unknown types and rejected data become `wait`.
 */
export function sanitizeAction(type: string, data: RawData): ActionInput {
  if (typeof type === 'string' && Object.prototype.hasOwnProperty.call(ACTION_DEFS, type)) {
    const def = ACTION_DEFS[type as ActionType] as ActionDef;
    const cleaned = def.sanitize(data);
    if (cleaned) return { type: def.type, data: cleaned } as ActionInput;
  }
  return { type: 'wait', data: {} };
}
