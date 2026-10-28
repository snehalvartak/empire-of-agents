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
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { fetchBlob, needsProxyReexec, reexecWithProxy, resolveImage, tarEntries } from './registry.mjs';

const REPO = 'postgrest/postgrest';

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
  const { token, manifest: m } = await resolveImage({ repo: REPO, ref: version, arch });
  log(`image has ${m.layers.length} layer(s), ${(m.layers.reduce((n, l) => n + (l.size || 0), 0) / 1e6).toFixed(1)} MB compressed`);
  const layers = [];
  for (const layer of m.layers) layers.push(await fetchBlob(REPO, layer.digest, token));
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (needsProxyReexec()) {
    reexecWithProxy(process.argv[1], process.argv.slice(2));
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
