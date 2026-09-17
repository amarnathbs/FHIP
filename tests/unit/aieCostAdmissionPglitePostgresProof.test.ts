/**
 * M12D TRACEABILITY — Product-Owner requirement ids this file is evidence for.
 *
 * Added by the M12 Phase D mapping pass. Each id below was checked against this
 * file's ACTUAL assertions; ids it only touches incidentally are deliberately
 * omitted, and where this file does NOT discharge a neighbouring requirement,
 * that is said so explicitly rather than left to be assumed.
 * Full matrix: docs/aie-programme/AIE_1_REQUIREMENT_TRACEABILITY_FINAL_2026-09-15.md
 *
 *   AIE10-QA-05      Create a proof that repeated jobs collapse to one provider attempt
 *                    — on real Postgres, seeded from the repository's own full
 *                    migration chain.
 *   AIE11-CST-05     Collapse concurrent identical calls under one idempotency
 *                    identity.
 *   AIE16-IDEM-11    Verify one provider charge/decision/write and immutable conflict
 *                    outcomes.
 */
/**
 * AIE-1 infrastructure-activation mission (section 11: "Test actual
 * database behaviour. SQL source inspection alone is not live
 * certification.") — real Postgres proof of migration 0152's
 * `aie_reserve_ai_cost`/`aie_settle_ai_cost` idempotency fix, run against
 * a REAL, ISOLATED, ephemeral PGlite Postgres instance built from this
 * repository's OWN full migration chain (0001 through the latest) — not a
 * hand-rolled mock of the SQL, not a JS re-implementation of the logic.
 *
 * This is possible, and safe, WITHOUT any DDL channel into the real hosted
 * DEV project: PGlite is a real Postgres engine compiled to run in-process,
 * seeded from this repo's own migration files, torn down at the end of the
 * test. It is how this repository already validates other migrations
 * before asking an operator to apply them for real (see
 * tests/unit/aiInsightPack20HouseholdE2E.test.ts and its harness).
 *
 * Proves, against a real Postgres engine, before this migration is ever
 * applied to a real database:
 *   1. aie_reserve_ai_cost's admission decision is still correct (a
 *      genuine successor to the 0150/0151 behavior, not a regression).
 *   2. A successful reservation returns EXACTLY ONE row (0151's original
 *      fix, re-proven here on the final signature).
 *   3. A REPEAT reservation under the SAME idempotency key does not
 *      reserve a second time against the ledger -- returns the stored
 *      outcome instead.
 *   4. A REPEAT settlement under the SAME idempotency key is a no-op --
 *      does not double-count settled_usd or token counts (the exact
 *      defect this migration fixes, confirmed live against real DEV
 *      before the fix existed).
 *   5. Two DIFFERENT idempotency keys are each honoured independently.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPABASE_ROOT = path.resolve(HERE, '..', '..', 'supabase');
const MIG_DIR = path.join(SUPABASE_ROOT, 'migrations');
const SHIM = path.join(SUPABASE_ROOT, '..', 'scripts', 'db-rebuild-check', 'shim.sql');

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(fs.readFileSync(SHIM, 'utf8'));
  const seed = fs.readFileSync(path.join(SUPABASE_ROOT, 'seed.sql'), 'utf8');
  const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
    if (f.startsWith('0001')) await db.exec(seed);
  }
}, 60_000);

afterAll(async () => {
  await db?.close();
});

interface ReserveRow {
  reserved: boolean;
  remaining_usd: string | number;
}

async function reserve(key: string, amount: number, allowance = 10): Promise<ReserveRow[]> {
  const res = await db.query<ReserveRow>(
    `select * from aie_reserve_ai_cost($1, $2, $3, $4)`,
    ['global', amount, allowance, key],
  );
  return res.rows;
}

async function settle(key: string, reservedUsd: number, actualUsd: number, inputTokens = 100, outputTokens = 50): Promise<void> {
  await db.query(`select aie_settle_ai_cost($1, $2, $3, $4, $5, $6)`, ['global', reservedUsd, actualUsd, inputTokens, outputTokens, key]);
}

async function ledger(): Promise<{ reserved_usd: string; settled_usd: string; total_attempts: number; total_input_tokens: string; total_output_tokens: string }> {
  const res = await db.query<{ reserved_usd: string; settled_usd: string; total_attempts: number; total_input_tokens: string; total_output_tokens: string }>(
    `select reserved_usd, settled_usd, total_attempts, total_input_tokens, total_output_tokens from aie_ai_cost_ledger where id = 'global'`,
  );
  return res.rows[0];
}

async function resetLedger(): Promise<void> {
  await db.query(`update aie_ai_cost_ledger set reserved_usd = 0, settled_usd = 0, total_attempts = 0, total_input_tokens = 0, total_output_tokens = 0 where id = 'global'`);
  await db.query(`delete from aie_ai_cost_attempt`);
}

describe('migration 0152 — aie_reserve_ai_cost / aie_settle_ai_cost idempotency, against a real Postgres engine', () => {
  it('a successful reservation returns EXACTLY ONE row (re-proves 0151s fix on the final signature)', async () => {
    await resetLedger();
    const rows = await reserve('pglite-attempt-1', 2.0);
    expect(rows).toHaveLength(1);
    expect(rows[0].reserved).toBe(true);
  });

  it('a denied reservation (would exceed allowance) also returns exactly one row', async () => {
    await resetLedger();
    await reserve('pglite-attempt-2a', 6.0);
    const rows = await reserve('pglite-attempt-2b', 6.0); // 6 + 6 = 12 > 10
    expect(rows).toHaveLength(1);
    expect(rows[0].reserved).toBe(false);
  });

  it('a REPEAT reservation under the SAME idempotency key does not reserve a second time', async () => {
    await resetLedger();
    const first = await reserve('pglite-attempt-3-stable', 3.0);
    expect(first[0].reserved).toBe(true);
    const afterFirst = await ledger();
    expect(Number(afterFirst.reserved_usd)).toBe(3.0);
    expect(afterFirst.total_attempts).toBe(1);

    // Same key, called again -- simulates a genuine cross-process retry.
    const second = await reserve('pglite-attempt-3-stable', 3.0);
    expect(second[0].reserved).toBe(true); // same stored outcome replayed
    const afterSecond = await ledger();
    expect(Number(afterSecond.reserved_usd)).toBe(3.0); // UNCHANGED -- not reserved twice
    expect(afterSecond.total_attempts).toBe(1); // UNCHANGED -- not counted twice
  });

  it('a REPEAT settlement under the SAME idempotency key is a no-op (THE defect this migration fixes, confirmed live against real DEV before this fix existed)', async () => {
    await resetLedger();
    await reserve('pglite-attempt-4', 2.0);
    await settle('pglite-attempt-4', 2.0, 1.5, 1000, 500);
    const afterFirstSettle = await ledger();
    expect(Number(afterFirstSettle.settled_usd)).toBe(1.5);
    expect(Number(afterFirstSettle.total_input_tokens)).toBe(1000);

    // Duplicate settle -- same key, same params, simulating a retry.
    await settle('pglite-attempt-4', 2.0, 1.5, 1000, 500);
    const afterDuplicate = await ledger();
    expect(Number(afterDuplicate.settled_usd)).toBe(1.5); // UNCHANGED, not 3.0
    expect(Number(afterDuplicate.total_input_tokens)).toBe(1000); // UNCHANGED, not 2000
  });

  it('M12C M2-OPEN-5: a RETRY-SUMMED settlement replayed under the same key is still a single settlement (never double-settle the summed figure)', async () => {
    // The M12C change makes a single settlement carry the SUM of every
    // provider attempt's usage (e.g. a 429 reporting 70/5 followed by a
    // success reporting 100/40 settles 170/45, not 100/40). That makes each
    // settlement LARGER, so it matters more that a replay cannot apply it
    // twice. This proves it against a real Postgres engine, not by inference
    // from the TypeScript layer.
    await resetLedger();
    await reserve('m12c-retry-summed', 2.0);
    // 170 input + 45 output tokens = the retry-summed figure.
    await settle('m12c-retry-summed', 2.0, 1.25, 170, 45);
    const afterFirst = await ledger();
    expect(Number(afterFirst.settled_usd)).toBe(1.25);
    expect(Number(afterFirst.total_input_tokens)).toBe(170);
    expect(Number(afterFirst.total_output_tokens)).toBe(45);

    // Genuine cross-process replay: same key, same summed params.
    await settle('m12c-retry-summed', 2.0, 1.25, 170, 45);
    const afterReplay = await ledger();
    expect(Number(afterReplay.settled_usd)).toBe(1.25); // not 2.50
    expect(Number(afterReplay.total_input_tokens)).toBe(170); // not 340
    expect(Number(afterReplay.total_output_tokens)).toBe(45); // not 90
  });

  it('two DIFFERENT idempotency keys are each honoured independently (the fix does not over-collapse unrelated attempts)', async () => {
    await resetLedger();
    await reserve('pglite-attempt-5a', 1.0);
    await reserve('pglite-attempt-5b', 1.0);
    const afterBoth = await ledger();
    expect(Number(afterBoth.reserved_usd)).toBe(2.0); // both counted -- genuinely different attempts
    expect(afterBoth.total_attempts).toBe(2);

    await settle('pglite-attempt-5a', 1.0, 0.8);
    await settle('pglite-attempt-5b', 1.0, 0.6);
    const afterSettles = await ledger();
    expect(Number(afterSettles.settled_usd)).toBeCloseTo(1.4, 5); // both settlements applied
  });
});
