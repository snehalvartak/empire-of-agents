/**
 * Stub model server - a stand-in for the `agent-brain` edge function.
 *
 * NO MODEL IS INVOLVED. The "villager" is a fixed, scripted policy that reads the
 * observation text. Running the harness against this server verifies the harness
 * plumbing and the app's own parse / retry / step code paths end to end; it says
 * NOTHING about how real models behave. The live-model targets (C1/C2) stay
 * unmeasured until someone runs `npm run harness` with a real key.
 *
 * Answers POST /functions/v1/agent-brain in the shape the real function returns
 * (an OpenAI chat completion: choices[0].message.content holds the JSON string
 * {"thought":..., "action":{type,data}}), which is what callBrain in
 * src/sim/brain.ts reads. Like the real endpoint behind Supabase's gateway it
 * wants `Authorization: Bearer <anon key>` (401 otherwise), answers 400 for a
 * body without model/messages and 200 for OPTIONS (CORS preflight).
 *
 * Policy (deterministic, from the observation, i.e. the last message):
 *   1. a `gather_nearest` line is offered (a resource within reach)   -> gather_nearest
 *   2. a `deposit` line is offered (carrying, beside the Town Center) -> deposit
 *   3. a `goto` hint for the Town Center (carrying)                   -> goto it
 *   4. otherwise the first `goto` hint                                -> goto it
 *   5. otherwise                                                      -> wander
 * Fault injection: every FAULT_EVERY-th turn (not request: the app's retry of a
 * turn is not a new turn) the first reply is deliberately bad, cycling
 *   (a) not valid JSON (alternating: prose without braces / broken braces). Its
 *       retry is also bad on every other (a) turn, so both "retry rescued it" and
 *       "gave up -> fallback" run,
 *   (b) a thought that does not describe the action (mismatch; the retry is right),
 *   (c) a 3-step plan whose thought names all three steps (the plan path).
 *
 * Usage: node scripts/stub-model-server.mjs [--port 54321] [--key anon-key]
 * or import { startStubServer } and call it with { port: 0, anonKey }.
 */

import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const FAULT_EVERY = 15;

const POST_PATH = '/functions/v1/agent-brain';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

/** The scripted villager: observation text in, { thought, action } out. */
export function policy(observation) {
  if (/^- gather_nearest:/m.test(observation)) {
    const what = observation.match(/^- gather_nearest: take \w+ from the ([a-z ]+) beside you/m)?.[1] ?? 'resource';
    return { thought: `I gather from the ${what} beside me.`, action: { type: 'gather_nearest', data: {} } };
  }
  if (/^- deposit:/m.test(observation)) {
    return { thought: 'I deposit what I carry at the Town Center.', action: { type: 'deposit', data: {} } };
  }
  const tcHint = observation.match(/^- goto \((\d+),(\d+)\): Town Center/m);
  if (tcHint) {
    return { thought: 'I march to the Town Center to deposit.', action: { type: 'goto', data: { x: +tcHint[1], y: +tcHint[2] } } };
  }
  const hint = observation.match(/^- goto \((\d+),(\d+)\): ([^\n]*)/m);
  if (hint) {
    return { thought: `I march toward ${hint[3].split(',')[0]}.`, action: { type: 'goto', data: { x: +hint[1], y: +hint[2] } } };
  }
  return { thought: 'I wander to find new ground.', action: { type: 'wander', data: {} } };
}

/** (a) replies that are not valid JSON: with and without braces. */
function invalidReply(variant) {
  return variant % 2 === 0
    ? 'Hmm, hard to say. Perhaps I should head toward the berries, though I am not sure at all.'
    : '{thought: I will go east, action: goto }';
}

/** (b) the right action under a thought that describes something else. */
function mismatchReply(observation) {
  return { thought: 'I doze under a tree for a while.', action: policy(observation).action };
}

/** (c) a plan of three steps and a thought that names a verb of every step. */
function planReply(observation) {
  const hint = observation.match(/^- goto \((\d+),(\d+)\):/m);
  if (hint) {
    return {
      thought: 'I march to the nearest spot, gather what is there, then deposit it at the Town Center.',
      action: {
        type: 'plan',
        data: { steps: [{ type: 'goto', data: { x: +hint[1], y: +hint[2] } }, { type: 'gather_nearest', data: {} }, { type: 'deposit', data: {} }] },
      },
    };
  }
  return {
    thought: 'I wander, then gather what I find, then deposit it.',
    action: { type: 'plan', data: { steps: [{ type: 'wander', data: {} }, { type: 'gather_nearest', data: {} }, { type: 'deposit', data: {} }] } },
  };
}

function completion(model, content) {
  return {
    id: `stub-${Math.random().toString(36).slice(2, 10)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * Starts the server. Resolves to { server, url, port, stats, close }.
 * `url` is what the harness takes as the Supabase URL (the app appends /functions/v1/agent-brain).
 */
export function startStubServer({ port = 0, anonKey = 'stub-anon-key' } = {}) {
  const { handler, stats } = createStubHandler({ anonKey });
  const server = http.createServer(handler);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        server,
        port: actual,
        url: `http://127.0.0.1:${actual}`,
        stats,
        close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
      });
    });
  });
}

/**
 * The stub's request handler on its own, for callers that bring their own server (the end-to-end
 * gateway, scripts/e2e/gateway.mjs). Answers only `POST /functions/v1/agent-brain` (and OPTIONS);
 * everything else is a 404. Returns { handler(req, res), stats }.
 */
export function createStubHandler({ anonKey = 'stub-anon-key' } = {}) {
  const stats = {
    requests: 0, turns: 0, retries: 0, unauthorized: 0, badRequests: 0,
    faultInvalid: 0, faultMismatch: 0, faultPlan: 0, faultInvalidRetryAlsoBad: 0,
  };
  let faultIndex = 0;            // counts injected faults, picks the kind
  let invalidCount = 0;          // counts (a) faults
  let current = null;            // fault state of the turn in progress

  function reply(body) {
    const { messages } = body;
    const system = String(messages[0]?.content ?? '');
    const observation = String(messages[messages.length - 1]?.content ?? '');
    const parseRetry = system.includes('CRITICAL: Your previous reply was not valid');
    const mismatchRetry = /Your thought ".*" (does not describe the action you chose|does not cover every step)/s.test(system);
    stats.requests++;

    if (parseRetry || mismatchRetry) {
      stats.retries++;
      if (parseRetry && current?.kind === 'invalid' && current.retryAlsoBad) {
        stats.faultInvalidRetryAlsoBad++;
        return invalidReply(current.variant + 1);
      }
      return JSON.stringify(policy(observation));
    }

    stats.turns++;
    current = null;
    if (stats.turns % FAULT_EVERY === 0) {
      const kind = ['invalid', 'mismatch', 'plan'][faultIndex++ % 3];
      if (kind === 'invalid') {
        stats.faultInvalid++;
        current = { kind, variant: invalidCount, retryAlsoBad: invalidCount % 2 === 0 };
        invalidCount++;
        return invalidReply(current.variant);
      }
      if (kind === 'mismatch') {
        stats.faultMismatch++;
        current = { kind };
        return JSON.stringify(mismatchReply(observation));
      }
      stats.faultPlan++;
      current = { kind };
      return JSON.stringify(planReply(observation));
    }
    return JSON.stringify(policy(observation));
  }

  const handler = (req, res) => {
    const send = (status, obj) => {
      res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'OPTIONS') { res.writeHead(200, CORS); res.end(); return; }
    if (req.method !== 'POST' || req.url !== POST_PATH) { send(404, { error: `No stub route for ${req.method} ${req.url}` }); return; }
    if (req.headers.authorization !== `Bearer ${anonKey}`) {
      stats.unauthorized++;
      send(401, { error: 'Invalid JWT' });
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
      if (!body || !body.model || !Array.isArray(body.messages) || !body.messages.length) {
        stats.badRequests++;
        send(400, { error: 'Missing required fields: model, messages' });
        return;
      }
      send(200, completion(body.model, reply(body)));
    });
  };

  return { handler, stats };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const arg = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
  const { url, port } = await startStubServer({ port: Number(arg('--port', '0')), anonKey: arg('--key', 'stub-anon-key') });
  console.log(`stub agent-brain listening on ${url}${POST_PATH}  (no model: scripted policy; Ctrl-C to stop)`);
  console.log(`harness: HARNESS_SUPABASE_URL=${url} HARNESS_SUPABASE_ANON_KEY=${arg('--key', 'stub-anon-key')} HARNESS_OUT_DIR=<dir> node scripts/agent-loop-reliability.mjs  (port ${port})`);
}
