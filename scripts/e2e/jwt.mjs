/** Tiny HS256 JWT signer (node:crypto only) - what Supabase issues for its `anon` key, minus the project fluff. */
import { createHmac } from 'node:crypto';

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

export function signJwt(payload, secret) {
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
  return `${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`;
}

/** { role: 'anon' } valid for 24 hours, like the long-lived keys a Supabase project hands out. */
export function roleToken(role, secret, nowSec = Math.floor(Date.now() / 1000)) {
  return signJwt({ iss: 'e2e-scratch', role, iat: nowSec, exp: nowSec + 86400 }, secret);
}
