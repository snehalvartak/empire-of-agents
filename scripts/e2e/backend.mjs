/**
 * The real backend for the end-to-end run: a scratch PostgreSQL 16 with every migration applied,
 * and a real PostgREST in front of it, configured the way a Supabase project is
 * (anon role `anon`, schema `public`, JWT secret, a non-superuser `authenticator` login role that
 * switches to `anon` per request, db-max-rows 1000). Nothing here is mocked.
 *
 * Differences from a Supabase project, all deliberate and listed in TESTING.md: no `auth`/`storage`
 * schemas, no Kong gateway (scripts/e2e/gateway.mjs plays that part), no Realtime, and NO default
 * privileges for the API roles (Supabase grants new tables to anon/authenticated/service_role
 * automatically; here only what the migrations GRANT themselves exists, which is the stricter test).
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PG_BIN = process.env.PG_BIN || '/usr/lib/postgresql/16/bin';

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts the cluster, creates the Supabase stand-ins (roles, publication) and applies the migrations in filename order.
 * Resolves to { port, work, psql(sql), query(sql) -> rows, stop() }.
 */
export async function startDatabase({ migrationsDir, log = () => {} }) {
  for (const b of ['initdb', 'pg_ctl', 'psql']) {
    if (!existsSync(join(PG_BIN, b))) throw new Error(`PostgreSQL 16 binary not found: ${join(PG_BIN, b)} (set PG_BIN)`);
  }
  const work = mkdtempSync(join(tmpdir(), 'empire-e2e-db-'));
  let createdUser = null;
  let runAs = [];
  if (process.getuid && process.getuid() === 0) {
    // PostgreSQL refuses to run as root: use the postgres OS user, or a throwaway user removed on stop
    let user = process.env.PG_OS_USER || '';
    if (!user) {
      if (spawnSync('id', ['postgres']).status === 0) user = 'postgres';
      else {
        user = `pge2e${process.pid}`;
        execFileSync('useradd', ['--system', '--no-create-home', '--shell', '/usr/sbin/nologin', user]);
        createdUser = user;
      }
    }
    execFileSync('chown', [user, work]);
    runAs = ['runuser', '-u', user, '--'];
  }
  const run = (cmd, args, opts = {}) => execFileSync(runAs[0] ?? cmd, [...runAs.slice(1), ...(runAs.length ? [cmd] : []), ...args], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  const port = await freePort();
  const data = join(work, 'data');
  let started = false;

  const stop = () => {
    if (started) {
      try { run(join(PG_BIN, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop']); } catch { /* already down */ }
      started = false;
    }
    rmSync(work, { recursive: true, force: true });
    if (createdUser) { spawnSync('userdel', [createdUser]); createdUser = null; }
  };

  try {
    run(join(PG_BIN, 'initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '--locale=C', '-E', 'UTF8']);
    run(join(PG_BIN, 'pg_ctl'), ['-D', data, '-w', '-l', join(work, 'server.log'),
      '-o', `-p ${port} -k ${work} -c listen_addresses=127.0.0.1 -c fsync=off -c full_page_writes=off -c max_connections=100`, 'start']);
    started = true;
  } catch (err) {
    stop();
    throw new Error(`could not start the scratch cluster: ${String(err.stderr || err.message).slice(0, 500)}`);
  }

  const env = { ...process.env, PGHOST: '127.0.0.1', PGPORT: String(port), PGUSER: 'postgres', PGDATABASE: 'postgres', PGOPTIONS: '-c client_min_messages=warning' };
  const psqlArgs = ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1'];
  const psql = (sql) => execFileSync(join(PG_BIN, 'psql'), [...psqlArgs, '-c', sql], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  /** Rows of any SELECT as parsed JSON. */
  const query = (sql) => {
    const out = psql(`SELECT coalesce(json_agg(_r), '[]'::json) FROM (${sql}) _r`);
    return JSON.parse(out || '[]');
  };

  try {
    // stand-ins for what a Supabase project already has before the first migration (see check-migrations.sh)
    psql(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE ROLE authenticator LOGIN NOINHERIT NOCREATEDB NOCREATEROLE;
      GRANT anon, authenticated, service_role TO authenticator;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      CREATE PUBLICATION supabase_realtime;`);
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      const r = spawnSync(join(PG_BIN, 'psql'), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', join(migrationsDir, f)], { env, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`migration ${f} failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
    }
    log(`PostgreSQL 16 scratch cluster on 127.0.0.1:${port}, ${files.length} migrations applied`);
  } catch (err) {
    stop();
    throw err;
  }
  return { port, work, psql, query, stop, env };
}

/** Starts PostgREST against the database. Resolves to { port, url, jwtSecret, stop() } once it answers. */
export async function startPostgrest({ bin, dbPort, jwtSecret, anonToken, work, log = () => {} }) {
  if (jwtSecret.length < 32) throw new Error('jwt secret must be at least 32 characters');
  const port = await freePort();
  const conf = join(work, 'postgrest.conf');
  writeFileSync(conf, [
    `db-uri = "postgres://authenticator@127.0.0.1:${dbPort}/postgres"`,
    'db-schemas = "public"',
    'db-anon-role = "anon"',
    `jwt-secret = "${jwtSecret}"`,
    'db-max-rows = 1000',
    'server-host = "127.0.0.1"',
    `server-port = ${port}`,
    'log-level = "warn"',
    '',
  ].join('\n'));
  chmodSync(conf, 0o644);
  const child = spawn(bin, [conf], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  let exited = false;
  child.on('exit', () => { exited = true; });
  const stop = () => { if (!exited) child.kill('SIGKILL'); };
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    if (exited) throw new Error(`PostgREST exited during start-up:\n${out.slice(0, 1500)}`);
    try {
      // 200 for a real anon request means the server is up AND has loaded its schema cache (503 while it loads)
      const res = await fetch(`${url}/sessions?select=id&limit=1`, { headers: { Authorization: `Bearer ${anonToken}`, apikey: anonToken } });
      if (res.ok) { log(`PostgREST listening on ${url}`); return { port, url, stop, output: () => out }; }
    } catch { /* not up yet */ }
    await sleep(100);
  }
  stop();
  throw new Error(`PostgREST did not come up:\n${out.slice(0, 1500)}`);
}
