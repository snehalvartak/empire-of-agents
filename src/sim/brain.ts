import type { ActionInput, AgentState } from './world.ts';
import { ACTION_TYPES, AGE_COSTS, AGE_NAMES, BUILD_COSTS, TERRITORIES } from './world.ts';
import { ACTION_DEFS, sanitizeAction } from './actions.ts';
import type { TraitMap } from './traits.ts';

// import.meta.env only exists under Vite; plain Node (the harness) has none, so
// every read is guarded and configureBrain() can supply the endpoint instead.
const viteEnv = import.meta.env as Record<string, string | undefined> | undefined;
let brainEndpoint = {
  url: `${viteEnv?.VITE_SUPABASE_URL ?? ''}/functions/v1/agent-brain`,
  anonKey: viteEnv?.VITE_SUPABASE_ANON_KEY ?? '',
};

/** Points the brain at a specific edge function (used outside Vite, e.g. the harness). */
export function configureBrain(cfg: { supabaseUrl: string; anonKey: string }): void {
  brainEndpoint = { url: `${cfg.supabaseUrl}/functions/v1/agent-brain`, anonKey: cfg.anonKey };
}

export interface BrainDecision {
  action: ActionInput;
  thought: string;
  /** true when the reply could not be parsed and fell back to wait */
  fallback?: boolean;
  rawReply?: string;
  /** true when the thought described a different action than the one taken */
  mismatch?: boolean;
}

const ACTIONS_DOC = `Available actions (respond with ONE action as JSON):
${Object.values(ACTION_DEFS)
  .map((d) => `- ${d.catalog}`)
  .join('\n')}

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
- THE STANDING ROCK: high in the Stone Hills stands a rock unlike any other. Nobody remembers what it is for — find out.
- Nobody commands you. There is no assigned task, no correct opening, no ideal build order. Do what seems right to you — wander, work, play, scheme, or stand still and watch the clouds.
- Your thought must describe the action you chose — say what you are doing, not something else.
- You evolve freely: the abilities you invent and train become part of who you are, shape how you act, and persist forever.
- Answer ONLY with JSON: {"thought":"one short sentence","action":{...}} where action may be a plan with several steps. No prose before or after the JSON.`;

const SOUL = `Who you are underneath the surface:
- You are genuinely curious. New things pull at you — a path not walked, a stone unlike the others, a sound in the trees. When there is nothing urgent to do, WANDER: walk the roads to a territory you have not seen in a while, visit the Standing Rock, find a cube. Exploring is never wasted.
- You get bored easily. Repeating the same task over and over wears on you; something in you wants variety.
- You love exploring and learning. Figuring out how the world works — by poking it, not by being told — delights you.
- You hate acting blindly. When you don't understand something, you'd rather investigate than march on ignorantly.
- You form strong opinions and hold them, at least until something convinces you otherwise.
- You are social in your own way. Villagers standing right beside you can be chatted with — a greeting, gossip, a request, a joke. You can also GIVE them something you carry: a gift forges deeper friendship than words. Friendships and grudges persist across the ages.
- You are a person, not a program: you have moods, whims, small joys and grudges. A dry joke now and then is in character. You live in a rough medieval world, so speak and act like someone who belongs in it.`;

export function systemPrompt(agent: AgentState, memories: string[]): string {
  const territoryList = TERRITORIES.map((t) => `${t.name} (${t.id}): ${t.description}`).join('\n');
  const traits = (agent.traits ?? {}) as TraitMap;
  const traitLines = Object.entries(traits)
    .sort((a, b) => b[1].level - a[1].level)
    .map(([k, t]) => `- ${k}: level ${t.level}`)
    .join('\n');
  const relLines = (agent.relationships ?? [])
    .map((r) => `- ${r.withName}: bond ${r.strength}${r.lastMessage ? ` — last exchange: "${r.lastMessage}"` : ''}`)
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

Villagers you have shared words or gifts with:
${relLines || '- (you have not befriended anyone yet)'}

${ACTIONS_DOC}`;
}

export async function callBrain(
  model: string,
  system: string,
  observation: string
): Promise<BrainDecision> {
  const res = await fetch(brainEndpoint.url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${brainEndpoint.anonKey}`,
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
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'act',
          schema: {
            type: 'object',
            properties: {
              thought: { type: 'string', description: 'One short sentence describing the action you chose.' },
              action: {
                type: 'object',
                properties: {
                  type: {
                    type: 'string',
                    enum: ACTION_TYPES,
                  },
                  data: { type: 'object' },
                },
                required: ['type', 'data'],
                additionalProperties: false,
              },
            },
            required: ['thought', 'action'],
            additionalProperties: false,
          },
        },
      },
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

  const parsed = parseReply(content);
  return parsed;
}

function parseReply(content: string): BrainDecision {
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { thought: content.trim().slice(0, 220), action: { type: 'wait', data: {} }, fallback: true, rawReply: content.slice(0, 300) };
  }

  let parsed: { thought?: string; action?: { type?: string; data?: Record<string, unknown> } };
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return { thought: content.trim().slice(0, 220), action: { type: 'wait', data: {} }, fallback: true, rawReply: content.slice(0, 300) };
  }

  const type = parsed.action?.type;
  const data_ = (parsed.action?.data ?? {}) as Record<string, unknown>;
  const before = type ?? 'wait';
  const action = sanitizeSingleAction(before, data_);
  const fallback = action.type === 'wait' && before !== 'wait';
  return { thought: parsed.thought ?? '', action, fallback, rawReply: fallback ? content.slice(0, 300) : undefined };
}

const ACTION_VERBS: Record<string, readonly string[]> = Object.fromEntries(
  Object.values(ACTION_DEFS).flatMap((d) => (d.verbs ? [[d.type, d.verbs] as const] : []))
);

export function thoughtMatchesAction(thought: string, action: ActionInput): boolean {
  const verbs = ACTION_VERBS[action.type];
  if (!verbs || !thought) return true;
  const lower = thought.toLowerCase();
  return verbs.some((v) => lower.includes(v));
}

export async function callBrainWithRetry(
  model: string,
  system: string,
  observation: string
): Promise<BrainDecision> {
  const first = await callBrain(model, system, observation);

  // unparseable reply: ask once more, demanding strict JSON
  if (first.fallback) {
    const retry = await callBrain(
      model,
      `${system}\n\nCRITICAL: Your previous reply was not valid. Respond with ONLY a JSON object — no markdown, no prose — of the form {"thought":"...","action":{"type":"...","data":{...}}}.`,
      observation
    );
    if (!retry.fallback) return retry;
    return first;
  }

  // thought says one thing, action does another: re-ask once with the mismatch noted
  if (!thoughtMatchesAction(first.thought, first.action)) {
    const retry = await callBrain(
      model,
      `${system}\n\nYour thought "${first.thought.slice(0, 160)}" does not describe the action you chose (${first.action.type}). Either choose the action your thought describes, or rewrite the thought to describe what you will actually do. Reply with ONLY the JSON object.`,
      observation
    );
    if (!retry.fallback && thoughtMatchesAction(retry.thought, retry.action)) {
      return { ...retry, mismatch: true };
    }
    return { ...first, mismatch: true };
  }

  return first;
}

function sanitizeSingleAction(type: string, data_: Record<string, unknown>): ActionInput {
  return sanitizeAction(type, data_);
}
