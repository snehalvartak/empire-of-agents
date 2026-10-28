/**
 * Docker Hub registry HTTP API client shared by the e2e fetchers (fetch-postgrest.mjs, fetch-realtime.mjs).
 * No docker daemon, no dependencies. Only auth.docker.io (anonymous pull token) and registry-1.docker.io are contacted.
 *
 *   pullToken(repo)                          anonymous pull token
 *   resolveImage({ repo, ref, arch })        tag or digest -> the linux/<arch> image manifest (+ the digest of what the tag
 *                                            pointed at); every manifest fetched by digest is hashed and compared
 *   fetchBlob(repo, digest, token)           a blob, sha256 verified against its digest before it is returned
 *   tarEntries(tar)                          minimal tar reader (ustar, GNU long names/links, PAX path/linkpath/uid/gid)
 *   extractLayer(tar, rootDir)               applies one layer on top of rootDir: whiteouts (`.wh.name`, `.wh..wh..opq`),
 *                                            regular files, directories, symlinks, hard links, modes and (as root) owners;
 *                                            every path is resolved INSIDE rootDir (a symlink can never lead out of it)
 *   reexecWithProxy(script)                  Node's fetch honours HTTPS_PROXY only with NODE_USE_ENV_PROXY=1: re-run once
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, chownSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, rmSync,
  symlinkSync, writeSync,
} from 'node:fs';
import { posix } from 'node:path';

export const REGISTRY = 'https://registry-1.docker.io';
export const ACCEPT_ANY = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const sha256 = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`;

/** GET with retries on 429 / 5xx / network errors (each attempt may use a fresh token). */
export async function getWithRetry(label, makeRequest, { attempts = 12 } = {}) {
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

export async function pullToken(repo) {
  const res = await getWithRetry('token', () =>
    fetch(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`));
  const body = await res.json();
  if (!body.token) throw new Error('token: no token in the response');
  return body.token;
}

/** A manifest as raw bytes plus the digest of those bytes. When `ref` is itself a digest the bytes must hash to it. */
async function manifestBytes(repo, ref, token, accept) {
  const res = await getWithRetry(`manifest ${ref.slice(0, 19)}`, () =>
    fetch(`${REGISTRY}/v2/${repo}/manifests/${ref}`, { headers: { Authorization: `Bearer ${token}`, Accept: accept } }));
  const raw = Buffer.from(await res.arrayBuffer());
  const digest = sha256(raw);
  if (ref.startsWith('sha256:') && digest !== ref) throw new Error(`manifest ${ref}: sha256 mismatch (got ${digest})`);
  return { raw, digest, json: JSON.parse(raw.toString('utf8')) };
}

/**
 * Resolves `ref` (a tag or a sha256 digest) of `repo` to the linux/<arch> image manifest.
 * Resolves to { token, refDigest (what the tag pointed at), manifestDigest, manifest }.
 */
export async function resolveImage({ repo, ref, arch, token }) {
  token ??= await pullToken(repo);
  const top = await manifestBytes(repo, ref, token, ACCEPT_ANY);
  let { json: manifest, digest: manifestDigest } = top;
  if (Array.isArray(manifest.manifests)) {
    // manifest list / OCI index -> the real linux image (not the attestation entries, which have platform unknown/unknown)
    const pick = manifest.manifests.find((x) => x.platform?.os === 'linux' && x.platform?.architecture === arch);
    if (!pick) throw new Error(`no linux/${arch} entry in the manifest list of ${repo}:${ref}`);
    const inner = await manifestBytes(repo, pick.digest, token, ACCEPT_ANY);
    manifest = inner.json;
    manifestDigest = inner.digest;
  }
  if (!Array.isArray(manifest.layers) || manifest.layers.length === 0) throw new Error('image manifest has no layers');
  return { token, refDigest: top.digest, manifestDigest, manifest };
}

/** A blob, with its sha256 verified against the digest it was asked for. */
export async function fetchBlob(repo, digest, token) {
  const res = await getWithRetry(`blob ${digest.slice(0, 19)}`, () =>
    fetch(`${REGISTRY}/v2/${repo}/blobs/${digest}`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'follow' }));
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== digest) throw new Error(`blob ${digest}: sha256 mismatch (got ${got})`);
  return buf;
}

// ---------------------------------------------------------------------------------------------- tar
function paxRecords(data) {
  const out = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const len = Number(data.subarray(i, sp).toString('latin1'));
    if (!Number.isInteger(len) || len <= 0) break;
    const rec = data.subarray(sp + 1, i + len - 1).toString('utf8'); // up to the trailing \n
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/** Yields { name, type, mode, uid, gid, linkname, data } for each entry of an (uncompressed) tar. */
export function* tarEntries(tar) {
  let off = 0;
  let longName = null;
  let longLink = null;
  let pax = {};
  const str = (s, e) => {
    const raw = tar.subarray(s, e);
    const z = raw.indexOf(0);
    return raw.subarray(0, z < 0 ? raw.length : z).toString('utf8');
  };
  const oct = (s, e) => parseInt(str(s, e).trim() || '0', 8);
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    let name = str(off, off + 100);
    const size = oct(off + 124, off + 136);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = str(off + 345, off + 500);
    if (prefix && str(off + 257, off + 262) === 'ustar') name = `${prefix}/${name}`;
    const data = tar.subarray(off + 512, off + 512 + size);
    const entry = { name, type, mode: oct(off + 100, off + 108), uid: oct(off + 108, off + 116), gid: oct(off + 116, off + 124), linkname: str(off + 157, off + 257), data };
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = data.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (type === 'K') { longLink = data.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (type === 'x') { pax = { ...pax, ...paxRecords(data) }; continue; }
    if (type === 'g') continue;
    if (longName !== null) entry.name = longName;
    if (longLink !== null) entry.linkname = longLink;
    if (pax.path !== undefined) entry.name = pax.path;
    if (pax.linkpath !== undefined) entry.linkname = pax.linkpath;
    if (pax.uid !== undefined) entry.uid = Number(pax.uid);
    if (pax.gid !== undefined) entry.gid = Number(pax.gid);
    if (type === '\0') entry.type = '0';
    yield entry;
    longName = null;
    longLink = null;
    pax = {};
  }
}

// ---------------------------------------------------------------------------------------------- extraction
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function cleanRel(name) {
  const parts = [];
  for (const p of name.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') throw new Error(`unsafe path in layer: ${name}`);
    parts.push(p);
  }
  return parts;
}

/**
 * Resolves `parts` (path components relative to the image root) to a real path under `root`, following symlinks of the
 * parent components as the image itself would see them (an absolute target is re-rooted at `root`), never leaving `root`.
 * The last component is returned unresolved (the entry itself is what is being created or replaced).
 */
function resolveParent(root, parts) {
  let cur = []; // resolved components relative to root
  const todo = parts.slice(0, -1);
  let hops = 0;
  while (todo.length) {
    const p = todo.shift();
    if (p === '..') { cur.pop(); continue; }
    const real = posix.join(root, ...cur, p);
    let st = null;
    try { st = lstatSync(real); } catch { /* does not exist yet */ }
    if (st?.isSymbolicLink()) {
      if (++hops > 40) throw new Error('too many symlinks in layer path');
      const target = readlinkSync(real);
      if (target.startsWith('/')) cur = [];
      todo.unshift(...target.split('/').filter((x) => x && x !== '.'));
    } else {
      cur.push(p);
    }
  }
  return { dir: posix.join(root, ...cur), name: parts[parts.length - 1] };
}

function removeAny(path) {
  rmSync(path, { recursive: true, force: true });
}

/**
 * Applies one decompressed layer onto `rootDir`. Returns counts for logging.
 * Whiteouts are applied before the layer's own entries, so they only ever remove what lower layers put there.
 */
export function extractLayer(tar, rootDir) {
  const entries = [...tarEntries(tar)];
  const stats = { files: 0, dirs: 0, symlinks: 0, hardlinks: 0, whiteouts: 0, skipped: 0 };
  // 1. whiteouts
  for (const e of entries) {
    const parts = cleanRel(e.name);
    const base = parts[parts.length - 1];
    if (!base?.startsWith('.wh.')) continue;
    stats.whiteouts++;
    if (base === '.wh..wh..opq') {
      const { dir } = resolveParent(rootDir, [...parts.slice(0, -1), 'x']);
      if (existsSync(dir)) for (const child of readdirSync(dir)) removeAny(posix.join(dir, child));
    } else {
      const { dir } = resolveParent(rootDir, parts);
      removeAny(posix.join(dir, base.slice(4)));
    }
  }
  // 2. the entries
  const dirModes = [];
  const own = (path, e) => { if (isRoot) { try { chownSync(path, e.uid, e.gid); } catch { /* keep going */ } } };
  for (const e of entries) {
    const parts = cleanRel(e.name);
    if (parts.length === 0) continue;
    if (parts[parts.length - 1].startsWith('.wh.')) continue;
    const { dir, name } = resolveParent(rootDir, parts);
    mkdirSync(dir, { recursive: true });
    const path = posix.join(dir, name);
    let st = null;
    try { st = lstatSync(path); } catch { /* new */ }
    if (e.type === '5') {
      if (st && !st.isDirectory()) { removeAny(path); st = null; }
      if (!st) mkdirSync(path, { mode: 0o755 });
      own(path, e);
      dirModes.push([path, e.mode & 0o7777]);
      stats.dirs++;
      continue;
    }
    if (st) removeAny(path); // a file, symlink or directory from a lower layer is replaced
    if (e.type === '0') {
      const fd = openSync(path, 'w', 0o600);
      try {
        let w = 0;
        while (w < e.data.length) w += writeSync(fd, e.data, w, Math.min(e.data.length - w, 1 << 20));
      } finally { closeSync(fd); }
      own(path, e);
      chmodSync(path, e.mode & 0o7777);
      stats.files++;
    } else if (e.type === '2') {
      symlinkSync(e.linkname, path);
      own(path, e);
      stats.symlinks++;
    } else if (e.type === '1') {
      const target = resolveParent(rootDir, cleanRel(e.linkname));
      linkSync(posix.join(target.dir, target.name), path);
      stats.hardlinks++;
    } else {
      stats.skipped++; // device nodes, fifos: never needed by an application image
    }
  }
  for (const [path, mode] of dirModes.reverse()) { try { chmodSync(path, mode); } catch { /* removed by a later entry */ } }
  return stats;
}

// ---------------------------------------------------------------------------------------------- proxy
/** Node's fetch only honours HTTPS_PROXY when NODE_USE_ENV_PROXY=1 (Node >= 22.21); re-run once with it. */
export function needsProxyReexec() {
  return Boolean(process.env.HTTPS_PROXY || process.env.https_proxy) && process.env.NODE_USE_ENV_PROXY !== '1';
}
export function reexecWithProxy(script, args = []) {
  const child = spawn(process.execPath, [script, ...args], {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' },
  });
  child.on('exit', (code) => process.exit(code ?? 1));
}
