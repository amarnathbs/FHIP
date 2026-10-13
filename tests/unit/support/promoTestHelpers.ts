// Shared helpers for the promo / Premium hardening tests (hermetic: no network, no real secrets).
//
// The SECRETS here are test constants. They are not used anywhere else and are long enough and different enough to pass
// the dedicated-secret checks in lib/services/promoSecrets.ts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePromoDigest, generatePromoCode, digestForCreate, promoCodeHint } from '@/lib/services/promoCodeDigest';
import { normalisePromoCode } from '@/lib/services/promoCodes';
import { promoDigestKeys } from '@/lib/services/promoSecrets';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
export const MIG_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
export const SHIM_PATH = path.join(REPO_ROOT, 'scripts', 'db-rebuild-check', 'shim.sql');
export const SEED_PATH = path.join(REPO_ROOT, 'supabase', 'seed.sql');

/** Four DIFFERENT dedicated test secrets, each at least 32 characters. */
export const TEST_ENV: Record<string, string> = {
  PROMO_CODE_DIGEST_SECRET: 'test-digest-secret-aaaaaaaaaaaaaaaaaaaaaaaa-0001',
  PREMIUM_PROMO_EMAIL_BIND_SECRET: 'test-bind-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbb-0002',
  PROMO_IP_HASH_SECRET: 'test-ip-secret-cccccccccccccccccccccccccccc-0003',
  CRON_SECRET: 'test-cron-secret-dddddddddddddddddddddddddd-0004',
};

export function testKeys() {
  const keys = promoDigestKeys(TEST_ENV);
  if (!keys) throw new Error('test digest keys must be valid');
  return keys;
}

export interface MadeCode {
  plain: string;
  digest: string;
  version: number;
  hint: string;
}

/** A plain code (generated, or the one given) plus the digest and hint the database receives. */
export function makeCode(plain?: string, random?: (max: number) => number): MadeCode {
  const code = plain ?? generatePromoCode(undefined, random);
  const { digest, version } = digestForCreate(code, testKeys());
  // the application normalises before it makes the hint, exactly like createPromoCodeWithDigest
  return { plain: code, digest, version, hint: promoCodeHint(normalisePromoCode(code)) };
}

export function digestsFor(plain: string): string[] {
  const keys = testKeys();
  return [computePromoDigest(plain, keys.current)];
}

/** Migration file names in ledger order. */
export function migrationFiles(): string[] {
  return fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
}

/**
 * The text of the NEWEST definition of a function across every migration (the one in force after a full replay).
 * Negative controls mutate this text and restore it, so they must start from the definition that is really live.
 */
export function latestFunctionSql(name: string): string {
  const files = migrationFiles().reverse();
  const re = new RegExp(`create or replace function (?:public\\.)?${name}\\([\\s\\S]*?\\n\\$fn\\$;`);
  for (const f of files) {
    const m = fs.readFileSync(path.join(MIG_DIR, f), 'utf8').match(re);
    if (m) return m[0];
  }
  throw new Error(`could not find a definition of ${name}`);
}

/** Replays every migration (PGlite has no pg_cron or pg_net, so those extension lines are dropped, as in every other replay test). */
export async function replayAll(db: { exec(sql: string): Promise<unknown> }, upTo?: string): Promise<void> {
  await db.exec(fs.readFileSync(SHIM_PATH, 'utf8'));
  const seed = fs.readFileSync(SEED_PATH, 'utf8');
  for (const f of migrationFiles()) {
    if (upTo && f > upTo) break;
    await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
    if (f.startsWith('0001')) await db.exec(seed);
  }
  // The shared shim models auth.users without the confirmation column the real platform has.
  await db.exec('alter table auth.users add column if not exists email_confirmed_at timestamptz');
}

/** Run an assertion against a deliberately broken rule: it MUST go red, with the named assertion, as a real AssertionError. */
export async function expectNamedFailure(assertion: () => unknown | Promise<unknown>, named: string): Promise<void> {
  let failure: Error | null = null;
  try {
    await assertion();
  } catch (e) {
    failure = e as Error;
  }
  if (!failure) throw new Error(`the assertion did NOT fail against the deliberately broken rule (${named}): the test cannot detect this regression`);
  if (failure.name !== 'AssertionError') throw new Error(`the control for "${named}" failed for the wrong reason: ${failure.message}`);
  if (!failure.message.includes(named)) throw new Error(`the control went red on a different assertion than "${named}": ${failure.message}`);
}
