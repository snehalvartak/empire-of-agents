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
 *   - plan mismatches, counted separately (informational; SPEC R8.4) — they
 *     are also part of the mismatch share above
 *
 * Results are printed as a summary table and appended to
 * script-results/agent-loop.jsonl so runs can be compared over time.
 *
 * The harness keeps no private copy of the game: it imports the real world,
 * brain and action-definition modules from src/sim (SPEC R11.1) — the system
 * prompt, the reply parsing and sanitizing (ACTION_DEFS), the thought/deed
 * mismatch check and its retries are all the app's own code. Only the scenario
 * setup and the scoring live here.
 *
 * Usage: npm run harness -- [--ticks 20] [--model openai/gpt-4o-mini]
 *    or: node scripts/agent-loop-reliability.mjs [--ticks 20] [--model ...]
 *
 * Requires Node >= 22.18 (runs the .ts sources directly via built-in type
 * stripping; on Node 22.6-22.17 add --experimental-strip-types), plus a .env at
 * the repo root with VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY. Calls the
 * live model, so it needs network access and costs money.
 */

import { readFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { step, seedObjects, observe, territoryAt } from '../src/sim/world.ts';
import { callBrainWithRetry, configureBrain, systemPrompt } from '../src/sim/brain.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

function env(key) {
  const match = readFileSync(`${root}.env`, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
  if (!match) throw new Error(`Missing ${key} in .env`);
  return match[1].trim().replace(/^["']|["']$/g, '');
}

const SUPABASE_URL = env('VITE_SUPABASE_URL');
const ANON_KEY = env('VITE_SUPABASE_ANON_KEY');
// outside Vite there is no import.meta.env, so hand the real brain its endpoint
configureBrain({ supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY });

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const TICKS = Math.max(1, parseInt(arg('--ticks', '20'), 10));
const MODEL = arg('--model', 'openai/gpt-4o-mini');

// one brain call exactly as the app makes it: real prompt, schema, parsing,
// sanitizing, and the retry on unparseable or mismatched replies
const decide = (system, observation) => callBrainWithRetry(MODEL, system, observation);

/** step() handles one action; a plan is unrolled step by step, as the app does:
 *  a failing step ends the plan there. The turn counts as ok only if every step was. */
function runAction(snapshot, agentId, action) {
  if (action.type !== 'plan') return step(snapshot, agentId, action);
  let result;
  for (const a of action.data.steps) {
    result = step(snapshot, agentId, a);
    if (!result.ok) break;
  }
  return result;
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
async function runExplorationScenario(ticks, model) {
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
      decided = await decide(system, obs);
    } catch (err) {
      console.error(`Exploration tick ${t}: brain request failed: ${err.message}`);
      process.exit(1);
    }
    const action = decided.action;
    const result = runAction(snapshot, agent.id, action);
    agent.island = territoryAt(agent.pos) ?? agent.island;
    agent.recentTiles = [...(agent.recentTiles ?? []), { ...agent.pos }].slice(-24);

    turns.push({ actionType: action.type, ok: result.ok, mismatch: decided.mismatch, planMismatch: decided.planMismatch, fallback: decided.fallback });
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
      decided = await decide(system, obs);
    } catch (err) {
      console.error(`Tick ${t}: brain request failed: ${err.message}`);
      process.exit(1);
    }
    const action = decided.action;
    const result = runAction(snapshot, agent.id, action);
    agent.island = 'forest';

    turns.push({
      tick: t,
      actionType: action.type,
      thought: decided.thought,
      ok: result.ok,
      mismatch: decided.mismatch,
      planMismatch: decided.planMismatch,
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
  const plans = turns.filter((x) => x.actionType === 'plan').length;
  const planMismatches = turns.filter((x) => x.planMismatch).length;

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
  console.log(`plan mismatches:  ${planMismatches} of ${plans} plans  (informational, counted within the thought mismatch above)`);

  console.log('\nScenario 2: exploration (road tile, nothing in reach)');
  console.log('-------');
  const expTurns = await runExplorationScenario(TICKS, MODEL);
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
  console.log(
    `plan mismatches:  ${expTurns.filter((x) => x.planMismatch).length} of ${expTurns.filter((x) => x.actionType === 'plan').length} plans  (informational)`
  );

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
    plans,
    plan_mismatches: planMismatches,
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
