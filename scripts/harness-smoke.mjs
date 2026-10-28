/**
 * Harness smoke test: scripts/agent-loop-reliability.mjs end to end against a stub.
 *
 *   npm run harness:smoke
 *
 * Starts scripts/stub-model-server.mjs on a free port, runs the real harness as a
 * child process pointed at it (HARNESS_SUPABASE_URL / HARNESS_SUPABASE_ANON_KEY,
 * HARNESS_OUT_DIR = a fresh temp dir), then checks the exit code, the output
 * file and that every code path ran (fallback, thought mismatch, plan).
 *
 * WHAT THIS PROVES: the harness plumbing works (arguments, endpoint override,
 * result file, metrics) and the app's own parse / retry / mismatch / plan-unrolling
 * code (src/sim/brain.ts, src/sim/actions.ts, src/sim/world.ts step()) behaves
 * end to end over real HTTP.
 * WHAT IT DOES NOT PROVE: anything about real-model quality. The "model" is a
 * fixed script, so the live-model targets (C1/C2: fallback, mismatch and wait
 * rates, honesty) remain UNMEASURED until someone runs `npm run harness` with a
 * real key. Not part of `npm test`; needs Node >= 22.18 (like the harness).
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStubServer } from './stub-model-server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const TICKS = 60;
const TIMEOUT_MS = 120_000;
const ANON_KEY = `smoke-${Math.random().toString(36).slice(2)}`;
const repoResults = join(root, 'script-results', 'agent-loop.jsonl');

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` (${detail})`}`);
};
const fingerprint = (path) => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'absent');

let stub = null;
let child = null;
let outDir = null;

function cleanup() {
  if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
  if (outDir) rmSync(outDir, { recursive: true, force: true });
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { cleanup(); process.exit(130); });
}

async function main() {
  console.log('Harness smoke test against a STUB model server (scripted policy, no model).');
  console.log('It verifies harness plumbing and the app parse/retry/step paths; it says nothing about real-model quality.\n');

  const repoBefore = fingerprint(repoResults);
  outDir = mkdtempSync(join(tmpdir(), 'harness-smoke-'));
  stub = await startStubServer({ port: 0, anonKey: ANON_KEY });

  // the stub enforces the Authorization header like the real endpoint's gateway
  const wrong = await fetch(`${stub.url}/functions/v1/agent-brain`, {
    method: 'POST',
    headers: { Authorization: 'Bearer wrong-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
  });
  check('stub refuses a request with the wrong anon key (401)', wrong.status === 401, `status ${wrong.status}`);
  stub.stats.unauthorized = 0;

  let output = '';
  child = spawn(process.execPath, [join(root, 'scripts', 'agent-loop-reliability.mjs'), '--ticks', String(TICKS)], {
    cwd: root,
    env: {
      ...process.env,
      HARNESS_SUPABASE_URL: stub.url,
      HARNESS_SUPABASE_ANON_KEY: ANON_KEY,
      HARNESS_OUT_DIR: outDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: null, timedOut: true }); }, TIMEOUT_MS);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut: false }); });
    child.on('error', (err) => { clearTimeout(timer); output += `\nspawn error: ${err.message}`; resolve({ code: null, timedOut: false }); });
  });

  check('harness exited with code 0', exit.code === 0, exit.timedOut ? `timed out after ${TIMEOUT_MS / 1000}s` : `code ${exit.code}`);
  if (exit.code !== 0) console.log(output.split('\n').slice(-15).map((l) => `        ${l}`).join('\n'));

  // output file: in the temp dir, exactly one record, and NOT in the repo
  const files = readdirSync(outDir);
  check('result written to the temp dir (HARNESS_OUT_DIR), as agent-loop.jsonl only', files.length === 1 && files[0] === 'agent-loop.jsonl', files.join(',') || 'empty');
  const lines = files.includes('agent-loop.jsonl') ? readFileSync(join(outDir, 'agent-loop.jsonl'), 'utf8').split('\n').filter(Boolean) : [];
  check('exactly one JSON line was appended', lines.length === 1, `${lines.length} lines`);
  check("repo's script-results/agent-loop.jsonl is untouched", fingerprint(repoResults) === repoBefore);

  let rec = null;
  try { rec = JSON.parse(lines[0]); } catch { /* reported below */ }
  check('the line is valid JSON for this run', rec !== null && rec.ticks === TICKS && typeof rec.model === 'string');
  if (rec) {
    const turnLines = output.split('\n').filter((l) => /^[tw]\s?\d+ /.test(l)).length;
    check(`turns ran: ${turnLines} (both scenarios, ${TICKS} ticks each)`, turnLines === TICKS * 2, `expected ${TICKS * 2}`);
    check(`fallbacks counted (fallback_rate ${rec.fallback_rate}%)`, rec.fallback_rate > 0);
    check(`thought mismatches counted (thought_mismatch_rate ${rec.thought_mismatch_rate}%)`, rec.thought_mismatch_rate > 0);
    check(`plans counted (${rec.plans})`, rec.plans > 0);
    check(`gather success is high with the stub policy (${rec.gather_success_rate}% of ${rec.gather_attempts})`, rec.gather_attempts > 0 && rec.gather_success_rate >= 80);
    check(`exploration scenario recorded (wait ${rec.exploration?.wait_rate}%, moved ${rec.exploration?.moved_rate}%)`, rec.exploration && typeof rec.exploration.moved_rate === 'number');
  }

  const s = stub.stats;
  check(
    `stub served ${s.turns} turns + ${s.retries} retries, injected ${s.faultInvalid} invalid / ${s.faultMismatch} mismatched / ${s.faultPlan} plan replies`,
    s.turns === TICKS * 2 && s.retries > 0 && s.faultInvalid > 0 && s.faultMismatch > 0 && s.faultPlan > 0 && s.unauthorized === 0 && s.badRequests === 0,
    JSON.stringify(s)
  );
  check(`both retry outcomes ran: ${s.faultInvalidRetryAlsoBad} invalid reply kept its fallback, the rest were rescued by the retry`, s.faultInvalidRetryAlsoBad > 0 && s.faultInvalidRetryAlsoBad < s.faultInvalid);
}

try {
  await main();
} catch (err) {
  check('smoke test ran to completion', false, err?.stack ?? String(err));
} finally {
  if (stub) await stub.close().catch(() => {});
  cleanup();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed} passed, ${failed} failed`);
console.log('Reminder: this checked plumbing and code paths with a scripted stub. Real-model quality (C1/C2) is still unmeasured; run `npm run harness` with a real key for that.');
process.exit(failed === 0 ? 0 : 1);
