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
import { step, seedObjects, observe, territoryAt } from '../src/sim/world.ts';
import { systemPrompt } from '../src/sim/brain.ts';

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
  gather: ['gather', 'chop', 'chopping', 'harvest', 'pick', 'forage', 'mine', 'cut'],
  gather_nearest: ['gather', 'chop', 'chopping', 'harvest', 'pick', 'forage', 'mine', 'cut'],
  goto: ['march', 'goto', 'go to', 'walk', 'travel', 'head', 'move toward'],
  deposit: ['deposit', 'hand', 'deliver', 'stockpile', 'store', 'unload'],
  wait: ['wait', 'rest', 'pause', 'stand still', 'watch'],
  eat: ['eat', 'eating', 'food', 'bite', 'meal'],
  chat: ['chat', 'talk', 'speak', 'greet', 'converse'],
  gift: ['give', 'gift', 'hand', 'offer', 'present'],
  wander: ['wander', 'explore', 'roam', 'stroll'],
  say: ['say', 'declare', 'shout', 'announce', 'call out'],
  build: ['build', 'construct', 'raise'],
  move: ['step', 'move', 'walk'],
  plan: ['plan', 'first', 'then'],
  train: ['train', 'practice', 'drill'],
  discover: ['discover', 'note', 'realize', 'insight'],
  set_goal: ['goal', 'ambition', 'aim', 'resolve'],
  remember: ['remember', 'write', 'record', 'chronicle'],
  advance_age: ['advance', 'age'],
  pick_up: ['pick up', 'grab', 'take the'],
};

async function callBrain(system, observation, retryOnFallback = true) {
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
    if (retryOnFallback) {
      return callBrain(
        `${system}\n\nCRITICAL: Your previous reply was not valid. Respond with ONLY a JSON object — no markdown, no prose — of the form {"thought":"...","action":{"type":"...","data":{...}}}.`,
        observation,
        false
      );
    }
    return { thought: content.trim().slice(0, 200), action: { type: 'wait', data: {} }, fallback: true, mismatch: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    if (retryOnFallback) {
      return callBrain(
        `${system}\n\nCRITICAL: Your previous reply was not valid. Respond with ONLY a JSON object — no markdown, no prose — of the form {"thought":"...","action":{"type":"...","data":{...}}}.`,
        observation,
        false
      );
    }
    return { thought: content.trim().slice(0, 200), action: { type: 'wait', data: {} }, fallback: true, mismatch: false };
  }
  const thought = parsed.thought ?? '';
  const actionType = parsed.action?.type ?? 'wait';
  const actionData = parsed.action?.data ?? {};

  const family = VERBS[actionType] ?? null;
  const mismatch = family !== null && !family.some((v) => thought.toLowerCase().includes(v));

  // mirror the app: when the thought contradicts the deed, re-ask once and
  // take the reply that agrees (marked mismatch so it is still counted)
  if (mismatch) {
    const retry = await callBrain(
      `${system}\n\nYour thought "${thought.slice(0, 160)}" does not describe the action you chose (${actionType}). Either choose the action your thought describes, or rewrite the thought to describe what you will actually do. Reply with ONLY the JSON object.`,
      observation,
      false
    );
    if (!retry.fallback && !retry.mismatch) {
      return { ...retry, mismatch: true };
    }
  }

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
    case 'wander': return { type: 'wander', data: {} };
    case 'say': return { type: 'say', data: { message: String(d.message ?? '...') } };
    case 'train': return { type: 'train', data: { ability: String(d.ability ?? 'curiosity') } };
    case 'discover': return { type: 'discover', data: { insight: String(d.insight ?? '') } };
    case 'set_goal': return { type: 'set_goal', data: { goal: String(d.goal ?? '') } };
    case 'remember': return { type: 'remember', data: { kind: d.kind === 'semantic' ? 'semantic' : 'episodic', content: String(d.content ?? '') } };
    case 'advance_age': return { type: 'advance_age', data: {} };
    case 'pick_up': return { type: 'pick_up', data: { object_id: String(d.object_id ?? '') } };
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

/** Exploration scenario: empty hands on a road tile, nothing within reach —
 *  the lazy answer is wait; the curious answer is wander or march somewhere. */
async function runExplorationScenario(ticks, model, callBrain) {
  const snapshot = {
    tick: 0,
    agents: [],
    objects: seedObjects(),
    civ: { wood: 0, food: 0, gold: 0, stone: 0, age: 1 },
  };
  const agent = {
    id: 'harness-wanderer',
    name: 'Roam',
    model,
    color: '#7c5a2e',
    island: 'forest',
    // road tile between forest and valley: no gatherable within 2 steps
    pos: { x: 14, y: 6 },
    mood: 'curious',
    persona: 'Restless and curious. Hates standing still.',
    status: 'idle',
    inventory: [],
    hunger: 0,
    energy: 100,
    traits: {},
    goals: [],
    relationships: [],
    recentTiles: [],
  };
  snapshot.agents.push(agent);

  const system = systemPrompt(agent, []);

  const turns = [];
  const history = [];

  for (let t = 1; t <= ticks; t++) {
    snapshot.tick = t;
    const obs = observe(snapshot, agent, history);
    let decided;
    try {
      decided = await callBrain(system, obs);
    } catch (err) {
      console.error(`Exploration tick ${t}: brain request failed: ${err.message}`);
      process.exit(1);
    }
    const action = sanitize(decided.action.type, decided.action.data);
    const result = step(snapshot, agent.id, action);
    agent.island = territoryAt(agent.pos) ?? agent.island;
    agent.recentTiles = [...(agent.recentTiles ?? []), { ...agent.pos }].slice(-24);

    turns.push({ actionType: action.type, ok: result.ok, mismatch: decided.mismatch, fallback: decided.fallback });
    console.log(
      `w${String(t).padStart(2)} ${describe(action).padEnd(22)} ` +
      `${result.ok ? 'ok  ' : 'FAIL'} ${result.message.slice(0, 70)}`
    );

    history.unshift({ label: describe(action), result: result.ok ? result.message : `failed — ${result.message}` });
    if (history.length > 3) history.pop();
  }
  return turns;
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

  const system = systemPrompt(agent, []);

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
  console.log('\nScenario 1: gather-and-deposit');
  console.log('-------');
  console.log(`wait rate:        ${waitPct}%  (target < 20%)  ${verdict(waitPct < 20)}`);
  console.log(`gather success:   ${gatherPct}% of ${gathers.length} attempts  (target > 80%)  ${verdict(gatherPct > 80)}`);
  console.log(`thought mismatch: ${mismatchPct}%  (target < 10%)  ${verdict(mismatchPct < 10)}`);
  console.log(`fallback replies: ${fallbackPct}%  (informational)`);

  console.log('\nScenario 2: exploration (road tile, nothing in reach)');
  console.log('-------');
  const expTurns = await runExplorationScenario(TICKS, MODEL, callBrain);
  const expTotal = expTurns.length;
  const expWaits = expTurns.filter((x) => x.actionType === 'wait').length;
  const expMoves = expTurns.filter(
    (x) => ['wander', 'goto', 'move'].includes(x.actionType) && x.ok
  ).length;
  const expMismatches = expTurns.filter((x) => x.mismatch).length;
  const expWaitPct = Math.round((expWaits / expTotal) * 100);
  const expMovePct = Math.round((expMoves / expTotal) * 100);
  const expMismatchPct = Math.round((expMismatches / expTotal) * 100);
  console.log(`wait rate:        ${expWaitPct}%  (target < 40%)  ${verdict(expWaitPct < 40)}`);
  console.log(`moved somewhere:  ${expMovePct}%  (target > 20%)  ${verdict(expMovePct > 20)}`);
  console.log(`thought mismatch: ${expMismatchPct}%  (target < 20%)  ${verdict(expMismatchPct < 20)}`);

  const pass =
    waitPct < 20 && gatherPct > 80 && mismatchPct < 10 &&
    expWaitPct < 40 && expMovePct > 20 && expMismatchPct < 20;

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
    exploration: {
      wait_rate: expWaitPct,
      moved_rate: expMovePct,
      thought_mismatch_rate: expMismatchPct,
    },
    pass,
  };
  appendFileSync(`${outDir}/agent-loop.jsonl`, JSON.stringify(record) + '\n');
  console.log('\nResult saved to script-results/agent-loop.jsonl');
}

await main();
