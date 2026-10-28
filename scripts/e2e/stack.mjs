/**
 * Brings the whole real stack up and tears it down: PostgreSQL 16 + migrations, PostgREST, the gateway
 * (agent-brain stub, settings-key, realtime refusal), the REAL production bundle built against the
 * gateway, and a static server for it. Every process and directory is removed by stop(), also after a failure.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, startDatabase, startPostgrest } from './backend.mjs';
import { startGateway } from './gateway.mjs';
import { roleToken } from './jwt.mjs';

export const REPO = fileURLToPath(new URL('../..', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.map': 'application/json' };

function runCapture(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code, out }));
  });
}

function staticServer(dir) {
  const server = http.createServer((req, res) => {
    const path = decodeURIComponent(req.url.split('?')[0]);
    let file = normalize(join(dir, path));
    if (!file.startsWith(dir)) { res.writeHead(403); res.end(); return; }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, stop: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }) }));
  });
}

export async function startStack({ log = console.log, outDir } = {}) {
  const cleanups = [];
  const stop = async () => {
    for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* keep tearing down */ } }
    cleanups.length = 0;
  };
  try {
    // 1. the PostgREST binary (a child process: it needs Node's proxy support switched on)
    const fetched = await runCapture(process.execPath, [join(REPO, 'scripts/e2e/fetch-postgrest.mjs')], { env: process.env });
    if (fetched.code !== 0) throw new Error(`PostgREST could not be fetched:\n${fetched.out}`);
    const postgrestBin = fetched.out.trim().split('\n').pop();

    // 2. database and PostgREST
    const jwtSecret = `e2e-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}-secret-padding`;
    const anonKey = roleToken('anon', jwtSecret);
    const db = await startDatabase({ migrationsDir: join(REPO, 'supabase/migrations'), log });
    cleanups.push(() => db.stop());
    const rest = await startPostgrest({ bin: postgrestBin, dbPort: db.port, jwtSecret, anonToken: anonKey, work: db.work, log });
    cleanups.push(() => rest.stop());

    // 3. the gateway in front of it
    const gateway = await startGateway({ postgrestUrl: rest.url, anonKey });
    cleanups.push(() => gateway.stop());
    log(`gateway on ${gateway.url} (/rest/v1 -> PostgREST, /functions/v1 -> stub brain, realtime refused)`);

    // 4. the real bundle, built against the gateway
    mkdirSync(outDir, { recursive: true });
    const dist = join(outDir, 'dist');
    rmSync(dist, { recursive: true, force: true });
    // `npx vite build` skips the repo's `prebuild` hook (npm run manifest); run it so the generated manifest cannot be stale
    spawnSync(process.execPath, [join(REPO, 'scripts/build-manifest.mjs')], { cwd: REPO, stdio: 'ignore' });
    const t0 = Date.now();
    const built = await runCapture('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir'], {
      cwd: REPO,
      env: { ...process.env, VITE_SUPABASE_URL: gateway.url, VITE_SUPABASE_ANON_KEY: anonKey },
    });
    if (built.code !== 0) throw new Error(`vite build failed:\n${built.out.slice(-2000)}`);
    log(`production bundle built in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${dist}`);

    // 5. static server for it
    const app = await staticServer(dist);
    cleanups.push(() => app.stop());
    log(`app served on http://127.0.0.1:${app.port}`);

    return { db, rest, gateway, anonKey, jwtSecret, appUrl: `http://127.0.0.1:${app.port}`, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

export function makeOutDir() {
  return process.env.E2E_OUT_DIR
    ? (mkdirSync(process.env.E2E_OUT_DIR, { recursive: true }), process.env.E2E_OUT_DIR)
    : mkdtempSync(join(tmpdir(), 'empire-e2e-out-'));
}
export { freePort };
