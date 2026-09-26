/**
 * Canonical-upload certification harness: DEV environment loader.
 *
 * - Reads `.env.local` from the current worktree, falling back to D:\FHIP\.env.local.
 * - REFUSES unless NEXT_PUBLIC_SUPABASE_URL is the DEV project (vqycarelcoijzwlpkpcz).
 * - Never prints a secret value. `fingerprint()` gives a sha256 prefix for comparisons.
 * - `childEnv()` returns an env for a child process with every PRODUCTION_* key BLANKED,
 *   so nothing started by this harness can reach production even by accident.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEV_PROJECT_REF = 'vqycarelcoijzwlpkpcz';
export const PROD_PROJECT_REF = 'twwpnltizhtjxhamyoxt';

export function findEnvFile() {
  const candidates = [path.resolve(process.cwd(), '.env.local'), path.join('D:', 'FHIP', '.env.local')];
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) throw new Error('REFUSING: no .env.local in the worktree or D:\\FHIP. Copy D:\\FHIP\\.env.local into your worktree.');
  return hit;
}

export function parseEnvFile(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
}

export function fingerprint(value) {
  return value ? crypto.createHash('sha256').update(value).digest('hex').slice(0, 12) : '(unset)';
}

let cached;
/** Loaded DEV env. Throws unless the target is provably DEV. */
export function loadDevEnv() {
  if (cached) return cached;
  const file = findEnvFile();
  const env = parseEnvFile(file);
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('REFUSING: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are required.');
  }
  const ref = new URL(url).host.split('.')[0];
  if (ref !== DEV_PROJECT_REF) throw new Error(`REFUSING: target project "${ref}" is not DEV (${DEV_PROJECT_REF}).`);
  if (env.PRODUCTION_SUPABASE_URL && env.PRODUCTION_SUPABASE_URL === url) throw new Error('REFUSING: DEV URL equals PRODUCTION_SUPABASE_URL.');
  if (env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY && env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY === env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('REFUSING: SUPABASE_SERVICE_ROLE_KEY equals the production key.');
  }
  cached = { file, env, url, ref, anonKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY };
  return cached;
}

/** Environment for a spawned child (dev server, tsx script): DEV keys only, PRODUCTION_* stripped. */
export function childEnv(extra = {}) {
  const { env } = loadDevEnv();
  const merged = { ...process.env, ...env, ...extra };
  // Set to '' rather than deleted: Next's @next/env only fills a key from .env.local when the key is
  // UNDEFINED in process.env, so an empty string is what actually keeps it out of the dev server.
  for (const k of Object.keys(merged)) if (k.startsWith('PRODUCTION_')) merged[k] = '';
  return merged;
}

export async function serviceClient() {
  const { createClient } = await import('@supabase/supabase-js');
  const { url, serviceKey } = loadDevEnv();
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function anonClient() {
  const { createClient } = await import('@supabase/supabase-js');
  const { url, anonKey } = loadDevEnv();
  return createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
}
