/**
 * Fetches a real PostgREST binary WITHOUT docker and without GitHub, straight from the
 * Docker Hub registry HTTP API (anonymous pull token -> manifest list -> linux/amd64 image
 * manifest -> layer blobs -> extract the static `postgrest` executable). No dependencies.
 *
 *   node scripts/e2e/fetch-postgrest.mjs            prints the path of a working binary
 *
 * Env: E2E_CACHE_DIR (default <os tmp>/empire-of-agents-e2e-cache; never inside the repo),
 *      POSTGREST_VERSION (default v13.0.8; any tag of postgrest/postgrest), POSTGREST_ARCH
 *      (default amd64 or arm64 to match this machine).
 *
 * The binary is cached as <cache>/postgrest-<version>/postgrest and verified with
 * `postgrest --version` before the path is returned; a cached binary that no longer runs is
 * fetched again. Docker Hub rate-limits anonymous pulls (100 manifest requests per hour per
 * IP, and the sandbox proxy shares IPs), so a 429 is retried with back-off.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const REPO = 'postgrest/postgrest';
const REGISTRY = 'https://registry-1.docker.io';
const ACCEPT_INDEX = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET with retries on 429 / 5xx / network errors (each attempt may use a fresh token). */
async function getWithRetry(label, makeRequest, { attempts = 12 } = {}) {
  let last = '';
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await makeRequest();
      if (res.ok) return res;
      last = `${res.status} ${res.statusText}`;
      if (res.status !== 429 && res.status < 500) {
        throw new Error(`${label}: HTTP ${last} ${(await res.text()).slice(0, 300)}`);
      }
    } catch (err) {
      if (String(err.message).startsWith(`${label}: HTTP`)) throw err;
      last = String(err.message ?? err);
    }
    await sleep(Math.min(3000 * i, 20000));
  }
  throw new Error(`${label}: gave up after ${attempts} attempts (last: ${last})`);
}

async function pullToken() {
  const res = await getWithRetry('token', () =>
    fetch(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${REPO}:pull`));
  const body = await res.json();
  if (!body.token) throw new Error('token: no token in the response');
  return body.token;
}

/** Runs `fn(token)` and, on a rate limit, starts over with a new token. */
async function manifest(ref, token, accept) {
  const res = await getWithRetry(`manifest ${ref.slice(0, 19)}`, () =>
    fetch(`${REGISTRY}/v2/${REPO}/manifests/${ref}`, { headers: { Authorization: `Bearer ${token}`, Accept: accept } }));
  return res.json();
}

async function blob(digest, token) {
  const res = await getWithRetry(`blob ${digest.slice(0, 19)}`, () =>
    fetch(`${REGISTRY}/v2/${REPO}/blobs/${digest}`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'follow' }));
  const buf = Buffer.from(await res.arrayBuffer());
  const got = `sha256:${createHash('sha256').update(buf).digest('hex')}`;
  if (got !== digest) throw new Error(`blob ${digest}: sha256 mismatch (got ${got})`);
  return buf;
}

/** Minimal tar reader (ustar + GNU long names + PAX paths): yields { name, type, data } for each entry. */
function* tarEntries(tar) {
  let off = 0;
  let longName = null;
  let paxPath = null;
  const str = (s, e) => {
    const raw = tar.subarray(s, e);
    const z = raw.indexOf(0);
    return raw.subarray(0, z < 0 ? raw.length : z).toString('utf8');
  };
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    let name = str(off, off + 100);
    const size = parseInt(str(off + 124, off + 136).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = str(off + 345, off + 500);
    if (prefix && str(off + 257, off + 262) === 'ustar') name = `${prefix}/${name}`;
    const data = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = data.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (type === 'x') {
      const m = data.toString('utf8').match(/(?:^|\n)\d+ path=([^\n]*)\n/);
      if (m) paxPath = m[1];
      continue;
    }
    if (type === 'g') continue;
    yield { name: paxPath ?? longName ?? name, type, data };
    longName = null;
    paxPath = null;
  }
}

/** Layers are applied in order; the last layer that holds a regular file named `postgrest` wins. */
function findPostgrest(layers) {
  let found = null;
  for (const gz of layers) {
    const tar = gunzipSync(gz);
    for (const e of tarEntries(tar)) {
      const base = e.name.replace(/^\.\//, '');
      if ((e.type === '0' || e.type === '\0') && /(^|\/)postgrest$/.test(base) && e.data.length > 1_000_000) {
        found = { path: base, data: Buffer.from(e.data) };
      }
    }
  }
  return found;
}

function runsOk(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000 });
  return r.status === 0 ? `${r.stdout}${r.stderr}`.trim() : null;
}

export async function ensurePostgrest({ log = () => {} } = {}) {
  const version = process.env.POSTGREST_VERSION || 'v13.0.8';
  const arch = process.env.POSTGREST_ARCH || (process.arch === 'arm64' ? 'arm64' : 'amd64');
  const cache = process.env.E2E_CACHE_DIR || join(tmpdir(), 'empire-of-agents-e2e-cache');
  const dir = join(cache, `postgrest-${version}-${arch}`);
  const bin = join(dir, 'postgrest');

  if (existsSync(bin)) {
    const v = runsOk(bin);
    if (v) { log(`PostgREST cached: ${bin} (${v})`); return { bin, version: v }; }
    rmSync(dir, { recursive: true, force: true });
  }

  log(`fetching ${REPO}:${version} (linux/${arch}) from Docker Hub ...`);
  const token = await pullToken();
  let m = await manifest(version, token, ACCEPT_INDEX);
  if (Array.isArray(m.manifests)) {
    // manifest list / OCI index -> the real linux image (not the attestation entries, which have platform unknown/unknown)
    const pick = m.manifests.find((x) => x.platform?.os === 'linux' && x.platform?.architecture === arch);
    if (!pick) throw new Error(`no linux/${arch} entry in the manifest list of ${REPO}:${version}`);
    m = await manifest(pick.digest, token, ACCEPT_INDEX);
  }
  if (!Array.isArray(m.layers) || m.layers.length === 0) throw new Error('image manifest has no layers');
  log(`image has ${m.layers.length} layer(s), ${(m.layers.reduce((n, l) => n + (l.size || 0), 0) / 1e6).toFixed(1)} MB compressed`);
  const layers = [];
  for (const layer of m.layers) layers.push(await blob(layer.digest, token));
  const found = findPostgrest(layers);
  if (!found) throw new Error('no `postgrest` executable in any layer');
  log(`extracted ${found.path} (${(found.data.length / 1e6).toFixed(1)} MB)`);

  mkdirSync(dir, { recursive: true });
  const tmp = `${bin}.part-${process.pid}`;
  writeFileSync(tmp, found.data);
  chmodSync(tmp, 0o755);
  renameSync(tmp, bin);
  const v = runsOk(bin);
  if (!v) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`the extracted binary does not run (${bin} --version failed)`);
  }
  log(`PostgREST ready: ${bin} (${v})`);
  return { bin, version: v };
}

// Node's fetch only honours HTTPS_PROXY when NODE_USE_ENV_PROXY=1 (Node >= 22.21); re-run once with it.
function needsProxyReexec() {
  return Boolean(process.env.HTTPS_PROXY || process.env.https_proxy) && process.env.NODE_USE_ENV_PROXY !== '1';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (needsProxyReexec()) {
    const child = spawn(process.execPath, [process.argv[1], ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' },
    });
    child.on('exit', (code) => process.exit(code ?? 1));
  } else {
    try {
      const { bin } = await ensurePostgrest({ log: (s) => console.error(s) });
      console.log(bin);
    } catch (err) {
      console.error(`FAIL  ${err.message}`);
      process.exit(1);
    }
  }
}
