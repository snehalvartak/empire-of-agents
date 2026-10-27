/**
 * Agent-loop reliability harness (issue #43).
 *
 * Runs a scripted scenario headlessly — no browser, no database writes:
 * one agent placed beside the Town Center in a seeded world, N turns, each
 * turn decided by the deployed agent-brain edge function (the same code
 * path the browser app uses) and applied to the world with step().
 *
 * Metrics (issue #43 targets):
 *   - share of turns ending in wait            (target under 20%)
 *   - share of gather attempts that succeed    (target over 80%)
 *   - share of turns where thought and deed mismatch (target under 10%)
 *
 * Results are printed as a summary table and appended to
 * script-results/agent-loop.jsonl so runs can be compared over time.
 *
 * Usage: node scripts/agent-loop-reliability.mjs [--ticks 20] [--model openai/gpt-4o-mini]
 */

import { readFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { step, seedObjects, observe } from '../src/sim/world.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

function env(key) {
  const match = readFileSync(`${root}.env`, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
  if (!match) throw new Error(`Missing ${key} in .env`);
  return match[1].trim().replace(/^["']|["']$/g, '');
}

const SUPABASE_URL = env('VITE_SUPABASE_URL');
const ANON_KEY = env('VITE_SUPABASE_ANON_KEY');

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const TICKS = Math.max(1, parseInt(arg('--ticks', '20'), 10));
const MODEL = arg('--model', 'openai/gpt-4o-mini');

// thought/deed mismatch: the thought names a word from the chosen action's verb
// family — mirrors the app's ACTION_VERBS heuristic
const VERBS = {
  gather: ['gather', 'chop', 'harvest', 'pick', 'forage', 'mine'],
  gather_nearest: ['gather', 'chop', 'harvest', 'pick', 'forage', 'mine'],
  goto: ['march', 'goto', 'go to', 'walk', 'travel', 'head'],
  deposit: ['deposit', 'hand', 'deliver', 'store', 'unload'],
  wait: ['wait', 'rest', 'pause', 'stand still', 'watch'],
  eat: ['eat', 'food', 'bite', 'meal'],
  chat: ['chat', 'talk', 'speak', 'greet'],
  say: ['say', 'declare', 'announce'],
  build: ['build', 'construct', 'raise'],
  move: ['step', 'move', 'walk'],
  plan: ['plan', 'first', 'then'],
};

async function callBrain(system, observation) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/agent-brain`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
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
              thought: { type: 'string' },
              action: {
                type: 'object',
                properties: {
                  type: { type: 'string' },
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
    const text = await res.text();
    throw new Error(`Brain request failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  if (!content) throw new Error('Model returned empty response');

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { thought: content.trim().slice(0, 200), action: { type: 'wait', data: {} }, fallback: true, mismatch: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return { thought: content.trim().slice(0, 200), action: { type: 'wait', data: {} }, fallback: true, mismatch: false };
  }
  const thought = parsed.thought ?? '';
  const actionType = parsed.action?.type ?? 'wait';
  const actionData = parsed.action?.data ?? {};

  const family = VERBS[actionType] ?? null;
  const mismatch = family !== null && !family.some((v) => thought.toLowerCase().includes(v));

  return { thought, action: { type: actionType, data: actionData }, fallback: false, mismatch };
}

function sanitize(type, d) {
  switch (type) {
    case 'gather': return { type: 'gather', data: { object_id: String(d.object_id ?? '') } };
    case 'gather_nearest': return { type: 'gather_nearest', data: {} };
    case 'goto': return { type: 'goto', data: { x: Number(d.x) || 0, y: Number(d.y) || 0 } };
    case 'move': return { type: 'move', data: { dx: Number(d.dx) || 0, dy: Number(d.dy) || 0 } };
    case 'deposit': return { type: 'deposit', data: {} };
    case 'eat': return { type: 'eat', data: {} };
    case 'wait': return { type: 'wait', data: {} };
    default: return { type: 'wait', data: {} };
  }
}

function describe(a) {
  const d = a.data;
  switch (a.type) {
    case 'goto': return `goto (${d.x},${d.y})`;
    case 'move': return `move (${d.dx},${d.dy})`;
    case 'gather': return `gather ${d.object_id}`;
    case 'gather_nearest': return 'gather_nearest';
    default: return a.type;
  }
}

async function main() {
  // scenario: one agent in the forest beside the Town Center; a berry bush two
  // steps north; empty stockpile; fixed world seed. Deterministic layout.
  const snapshot = {
    tick: 0,
    agents: [],
    objects: seedObjects(),
    civ: { wood: 0, food: 0, gold: 0, stone: 0, age: 1 },
  };
  const agent = {
    id: 'harness-agent',
    name: 'Testa',
    model: MODEL,
    color: '#b3541e',
    island: 'forest',
    pos: { x: 6, y: 7 },
    mood: 'curious',
    persona: 'A practical villager who likes steady work.',
    status: 'idle',
    inventory: [],
    hunger: 0,
    energy: 100,
    traits: {},
    goals: [],
    relationships: [],
  };
  snapshot.agents.push(agent);

  const system = `You are Testa, one villager alive on a small island empire.
Your temperament: practical, steady. Current mood: curious.
Your thought must describe the action you chose.
Answer ONLY with JSON: {"thought":"one short sentence","action":{"type":"...","data":{...}}}. No prose before or after.
Actions: goto {x,y}, move {dx,dy}, gather {object_id}, gather_nearest {}, deposit {}, eat {}, wait {}.
The stockpile is shared. You can carry 2 items. Deposit at the Town Center.`;

  const turns = [];
  const history = [];

  console.log(`\nAgent-loop reliability harness — ${TICKS} ticks, model ${MODEL}\n`);

  for (let t = 1; t <= TICKS; t++) {
    snapshot.tick = t;
    const obs = observe(snapshot, agent, history);
    let decided;
    try {
      decided = await callBrain(system, obs);
    } catch (err) {
      console.error(`Tick ${t}: brain request failed: ${err.message}`);
      process.exit(1);
    }
    const action = sanitize(decided.action.type, decided.action.data);
    const result = step(snapshot, agent.id, action);
    agent.island = 'forest';

    turns.push({
      tick: t,
      actionType: action.type,
      thought: decided.thought,
      ok: result.ok,
      mismatch: decided.mismatch,
      fallback: decided.fallback,
    });

    console.log(
      `t${String(t).padStart(2)} ${describe(action).padEnd(22)} ` +
      `${result.ok ? 'ok  ' : 'FAIL'} ${result.message.slice(0, 70)}`
    );

    history.unshift({ label: describe(action), result: result.ok ? result.message : `failed — ${result.message}` });
    if (history.length > 3) history.pop();
  }

  const total = turns.length;
  const waits = turns.filter((x) => x.actionType === 'wait').length;
  const gathers = turns.filter((x) => x.actionType === 'gather' || x.actionType === 'gather_nearest');
  const gatherOk = gathers.filter((x) => x.ok).length;
  const mismatches = turns.filter((x) => x.mismatch).length;
  const fallbacks = turns.filter((x) => x.fallback).length;

  const waitPct = Math.round((waits / total) * 100);
  const gatherPct = gathers.length ? Math.round((gatherOk / gathers.length) * 100) : 100;
  const mismatchPct = Math.round((mismatches / total) * 100);
  const fallbackPct = Math.round((fallbacks / total) * 100);

  const verdict = (ok) => (ok ? 'PASS' : 'FAIL');
  console.log('\nSummary');
  console.log('-------');
  console.log(`wait rate:        ${waitPct}%  (target < 20%)  ${verdict(waitPct < 20)}`);
  console.log(`gather success:   ${gatherPct}% of ${gathers.length} attempts  (target > 80%)  ${verdict(gatherPct > 80)}`);
  console.log(`thought mismatch: ${mismatchPct}%  (target < 10%)  ${verdict(mismatchPct < 10)}`);
  console.log(`fallback replies: ${fallbackPct}%  (informational)`);

  const outDir = `${root}script-results`;
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const record = {
    date: new Date().toISOString(),
    ticks: TICKS,
    model: MODEL,
    wait_rate: waitPct,
    gather_attempts: gathers.length,
    gather_success_rate: gatherPct,
    thought_mismatch_rate: mismatchPct,
    fallback_rate: fallbackPct,
    pass: waitPct < 20 && gatherPct > 80 && mismatchPct < 10,
  };
  appendFileSync(`${outDir}/agent-loop.jsonl`, JSON.stringify(record) + '\n');
  console.log('\nResult saved to script-results/agent-loop.jsonl');
}

await main();
