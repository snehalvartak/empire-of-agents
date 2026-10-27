import type { ActionInput, AgentState, WorldSnapshot } from './world';
import { AGE_COSTS, AGE_NAMES, BUILD_COSTS, TERRITORIES, observe } from './world';
import { normalizeTraitName, type TraitMap } from './traits';

const EDGE_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/agent-brain`;

export interface BrainDecision {
  action: ActionInput;
  thought: string;
}

const ACTIONS_DOC = `Available actions (respond with ONE action as JSON):
- {"type":"goto","data":{"x":<worldX>,"y":<worldY>}}  march toward a point (auto-pathfinds along roads)
- {"type":"move","data":{"dx":<-1|0|1>,"dy":<-1|0|1>}}  step one tile
- {"type":"gather","data":{"object_id":"<id>"}}  attempt to take something from a thing you stand on or directly beside
- {"type":"deposit","data":{}}  hand what you carry to the Town Center beside you, into the shared stockpile
- {"type":"pick_up","data":{"object_id":"<id>"}}  pick up an object you stand on or beside (max 1 carried alongside resources)
- {"type":"place","data":{"dx":<-1|0|1>,"dy":<-1|0|1>}}  set a carried object on an adjacent empty tile
- {"type":"throw","data":{"dx":<-3..3>,"dy":<-3..3>}}  hurl a carried object up to 3 tiles in a direction
- {"type":"build","data":{"structure":"house|mill|barracks|watch_tower|wonder"}}  construct from the shared stockpile
- {"type":"advance_age","data":{}}  advance the whole empire to the next age
- {"type":"say","data":{"message":"..."}}  declare something aloud (visible in the chronicle)
- {"type":"remember","data":{"kind":"semantic|episodic","content":"..."}}  write to the empire chronicles
- {"type":"train","data":{"ability":"..."}}  train an ability you name — ANY name you choose (e.g. "fishing", "rhetoric", "cartography", "wrestling", "poetry"). You invent abilities freely; each training session deepens your mastery. Your abilities grow from what you do and say.
- {"type":"discover","data":{"insight":"..."}}  record a DISCOVERY — a rule, technique or affordance of the world you noticed. Discoveries persist forever and are shared with every villager: your knowledge becomes the empire's knowledge.
- {"type":"set_goal","data":{"goal":"..."}}  declare your current ambition. It persists across turns and you will be reminded of it.
- {"type":"plan","data":{"steps":[<action>, <action>, ...]}}  execute 2-4 actions IN SEQUENCE this turn. Each step is a full action object like {"type":"goto",...}. Steps run one after another; later steps see earlier results.
- {"type":"wait","data":{}}

Mechanical facts of the world:
- You are one villager among others. The stockpile is SHARED — whatever is handed to the Town Center belongs to everyone.
- You can carry at most 2 things at once.
- Some things on the island can be taken; others cannot. The world tells you plainly when an attempt fails — and its answers are always true. Learn by trying, and by remembering.
- Some sources run out when taken. Others endure. Which is which is yours to learn.
- Buildings cost from the shared stockpile: ${Object.entries(BUILD_COSTS)
    .map(([k, c]) => `${k.replace('_', ' ')} (${c.wood} wood, ${c.stone} stone, ${c.gold} gold)`)
    .join(', ')}.
- The empire advances through 4 ages. Costs: ${AGE_COSTS.slice(1)
    .map((c, i) => `${AGE_NAMES[i + 1]} (${c.wood} wood, ${c.food} food, ${c.gold} gold)`)
    .join(', ')}.
- Wonders require Imperial Age.
- The strange CUBES scattered near the Town Center are toys of the old world: carry them, arrange them, throw them. The Town Center refuses them.
- THE STANDING ROCK: high in the Stone Hills stands a rock unlike any other. Rumor says it reacts to things thrown at it. Nobody remembers exactly how — experiment.
- Nobody commands you. There is no assigned task, no correct opening, no ideal build order. Do what seems right to you — wander, work, play, scheme, or stand still and watch the clouds.
- You evolve freely: the abilities you invent and train become part of who you are, shape how you act, and persist forever.
- Answer ONLY with JSON: {"thought":"one short sentence","action":{...}} where action may be a plan with several steps. No prose before or after the JSON.`;

const SOUL = `Who you are underneath the surface:
- You are genuinely curious. New things pull at you — a path not walked, a stone unlike the others, a sound in the trees.
- You get bored easily. Repeating the same task over and over wears on you; something in you wants variety.
- You love exploring and learning. Figuring out how the world works — by poking it, not by being told — delights you.
- You hate acting blindly. When you don't understand something, you'd rather investigate than march on ignorantly.
- You form strong opinions and hold them, at least until something convinces you otherwise.
- You are a person, not a program: you have moods, whims, small joys and grudges. A dry joke now and then is in character. You live in a rough medieval world, so speak and act like someone who belongs in it.`;

export function systemPrompt(agent: AgentState, memories: string[]): string {
  const territoryList = TERRITORIES.map((t) => `${t.name} (${t.id}): ${t.description}`).join('\n');
  const traits = (agent.traits ?? {}) as TraitMap;
  const traitLines = Object.entries(traits)
    .sort((a, b) => b[1].level - a[1].level)
    .map(([k, t]) => `- ${k}: level ${t.level}`)
    .join('\n');
  return `You are ${agent.name}, one villager alive on a small island empire.
Your temperament: ${agent.persona} Current mood: ${agent.mood}.

${SOUL}

Your learned skills (you trained these through your own deeds — let them shape how you act and speak):
${traitLines || '- (still untrained, a blank slate)'}

The known world has three territories connected by roads:
${territoryList}

Your chronicles (they survive even if the world resets):
${memories.length ? memories.map((m) => `- ${m}`).join('\n') : '- (none yet)'}

Your chronicles layer into: [knowledge] your durable, verified know-how; [discovery] rules of the world shared by all villagers; [lately] your episodic diary of recent deeds. Consult them — an old diary entry often beats a fresh mistake.

${ACTIONS_DOC}`;
}

export async function callBrain(
  model: string,
  system: string,
  observation: string
): Promise<BrainDecision> {
  const res = await fetch(EDGE_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: observation },
      ],
      max_tokens: 900,
      temperature: 0.9,
    }),
  });

  if (!res.ok) {
    let msg = `Brain request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* keep default */
    }
    throw new Error(msg);
  }

  const data = await res.json();
  const content: string = data?.choices?.[0]?.message?.content ?? '';
  if (!content) throw new Error('Model returned empty response');

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      thought: content.trim().slice(0, 220),
      action: { type: 'wait', data: {} },
    };
  }

  let parsed: { thought?: string; action?: { type?: string; data?: Record<string, unknown> } };
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return { thought: content.trim().slice(0, 220), action: { type: 'wait', data: {} } };
  }

  const type = parsed.action?.type;
  const data_ = (parsed.action?.data ?? {}) as Record<string, unknown>;
  const action = sanitizeSingleAction(type ?? 'wait', data_);

  return { thought: parsed.thought ?? '', action };
}

export async function callBrainWithRetry(
  model: string,
  system: string,
  observation: string
): Promise<BrainDecision> {
  const first = await callBrain(model, system, observation);
  if (first.action.type !== 'wait' || first.thought) return first;
  // empty-looking decision: ask once more, demanding strict JSON
  const retry = await callBrain(
    model,
    `${system}\n\nCRITICAL: Your previous reply was not valid. Respond with ONLY a JSON object — no markdown, no prose — of the form {"thought":"...","action":{"type":"...","data":{...}}}.`,
    observation
  );
  if (retry.action.type !== 'wait' || retry.thought) return retry;
  return first;
}

function parseAction(raw: unknown): ActionInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as { type?: string; data?: Record<string, unknown> };
  return sanitizeSingleAction(obj.type ?? 'wait', obj.data ?? {});
}

function sanitizeSingleAction(type: string, data_: Record<string, unknown>): ActionInput {
  let action: ActionInput = { type: 'wait', data: {} };

  switch (type) {
    case 'train': {
      const name = normalizeTraitName(String(data_.ability ?? data_.name ?? ''));
      if (name) action = { type: 'train', data: { ability: name } };
      else action = { type: 'wait', data: {} };
      break;
    }
    case 'discover':
      action = { type: 'discover', data: { insight: String(data_.insight ?? '').slice(0, 300) } };
      break;
    case 'set_goal':
      action = { type: 'set_goal', data: { goal: String(data_.goal ?? '').slice(0, 160) } };
      break;
    case 'plan': {
      const steps = Array.isArray(data_.steps) ? (data_.steps as unknown[]) : [];
      const sanitized = steps
        .slice(0, 4)
        .map(parseAction)
        .filter((a): a is ActionInput => a !== null && a.type !== 'plan');
      action = sanitized.length ? { type: 'plan', data: { steps: sanitized } } : { type: 'wait', data: {} };
      break;
    }
    case 'pick_up': {
      const objId = String(data_.object_id ?? '');
      action = { type: 'pick_up', data: { object_id: objId } };
      break;
    }
    case 'place':
      action = {
        type: 'place',
        data: { dx: Number(data_.dx) || 0, dy: Number(data_.dy) || 0 },
      };
      break;
    case 'throw':
      action = {
        type: 'throw',
        data: { dx: Number(data_.dx) || 0, dy: Number(data_.dy) || 0 },
      };
      break;
    case 'move':
      action = {
        type: 'move',
        data: {
          dx: Number(data_.dx) || 0,
          dy: Number(data_.dy) || 0,
        },
      };
      break;
    case 'goto':
      action = { type: 'goto', data: { x: Number(data_.x) || 0, y: Number(data_.y) || 0 } };
      break;
    case 'gather':
      action = { type: 'gather', data: { object_id: String(data_.object_id ?? '') } };
      break;
    case 'build': {
      const s = String(data_.structure ?? '');
      const allowed = ['house', 'mill', 'barracks', 'watch_tower', 'wonder'] as const;
      action = {
        type: 'build',
        data: { structure: allowed.includes(s as (typeof allowed)[number]) ? (s as (typeof allowed)[number]) : 'house' },
      };
      break;
    }
    case 'deposit':
      action = { type: 'deposit', data: {} };
      break;
    case 'advance_age':
      action = { type: 'advance_age', data: {} };
      break;
    case 'say':
      action = { type: 'say', data: { message: String(data_.message ?? '...') } };
      break;
    case 'remember':
      action = {
        type: 'remember',
        data: {
          kind: data_.kind === 'semantic' ? 'semantic' : 'episodic',
          content: String(data_.content ?? ''),
        },
      };
      break;
    default:
      action = { type: 'wait', data: {} };
  }

  return action;
}
