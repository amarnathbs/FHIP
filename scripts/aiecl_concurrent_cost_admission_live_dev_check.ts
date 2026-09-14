/**
 * AIE-1 infrastructure-activation mission (section 14: "Atomic reservation
 * before each paid attempt... Concurrent reservations cannot exceed the
 * allowance"). Every prior test of `aie_reserve_ai_cost` in this
 * closure's history (0150/0151/0152, PGlite proof, live-DEV verify) ran
 * reservations SEQUENTIALLY -- proving the single-statement atomicity
 * logic is correct in isolation, but never proving it holds under GENUINE
 * concurrent load, which is the literal thing this mission section asks
 * for and the exact class of bug a naive read-then-write implementation
 * would have.
 *
 * This fires N=20 GENUINELY CONCURRENT (`Promise.all`, real network
 * round trips, no artificial sequencing) reservation calls against the
 * real DEV ledger, each under its own distinct idempotency key, each
 * requesting an amount such that admitting more than the allowance
 * divided by the per-call amount would prove a race condition let the
 * ledger overspend.
 *
 * Run: node scripts/aiecl_concurrent_cost_admission_live_dev_check.mjs
 * (compiled/run via tsx since it imports nothing TS-specific -- kept as
 * .ts to match this closure's own file-naming convention; runs fine
 * under `npx tsx`).
 */
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const raw = fs.readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
const env: Record<string, string> = {};
for (const l of raw.split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

let passed = 0, failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`PASS: ${label}`); }
  else { failed++; console.log(`FAIL: ${label}` + (detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 1500)}` : '')); }
}

interface ReserveRow { reserved: boolean; remaining_usd: number | string }

async function reserve(key: string, amountUsd: number, allowanceUsd: number): Promise<{ data: ReserveRow[] | null; error: { message: string } | null }> {
  return admin.rpc('aie_reserve_ai_cost', { p_ledger_id: 'global', p_amount_usd: amountUsd, p_allowance_usd: allowanceUsd, p_idempotency_key: key });
}

async function main() {
  const stamp = Date.now();
  const ALLOWANCE = 10; // matches the real configured pilot allowance
  const PER_CALL = 1; // 20 concurrent calls at $1 each -- only 10 can legitimately be admitted
  const N = 20;

  // Reset the ledger to a known, clean state for this test.
  await admin.from('aie_ai_cost_ledger').update({ reserved_usd: 0, settled_usd: 0, total_attempts: 0, total_input_tokens: 0, total_output_tokens: 0 }).eq('id', 'global');
  const keys = Array.from({ length: N }, (_, i) => `dev-concurrency-${stamp}-${i}`);
  await admin.from('aie_ai_cost_attempt').delete().in('idempotency_key', keys);

  // THE ACTUAL TEST: genuinely concurrent, not sequential. All N requests
  // are in flight to the real DEV Postgres instance at the same time.
  const results = await Promise.all(keys.map((key) => reserve(key, PER_CALL, ALLOWANCE)));

  const errors = results.filter((r) => r.error);
  check('no RPC-level errors across all 20 concurrent calls', errors.length === 0, errors.map((e) => e.error?.message));

  for (const r of results) {
    check('every concurrent call returned EXACTLY ONE row (0151/0152s fix holds under real concurrency too)', r.data?.length === 1, r.data);
  }

  const admittedCount = results.filter((r) => r.data?.[0]?.reserved === true).length;
  const deniedCount = results.filter((r) => r.data?.[0]?.reserved === false).length;
  console.log(`admitted: ${admittedCount}, denied: ${deniedCount} (expected exactly 10 admitted, 10 denied for a $10 allowance at $1/call x 20 concurrent calls)`);
  check('EXACTLY the right number of concurrent reservations were admitted -- never more than the allowance allows, despite genuine concurrency', admittedCount === ALLOWANCE / PER_CALL, { admittedCount, deniedCount });

  const ledgerAfter = (await admin.from('aie_ai_cost_ledger').select('reserved_usd, total_attempts').eq('id', 'global').single()).data;
  check(
    'the ledgers reserved_usd EXACTLY matches allowance -- no overspend, no underspend, from 20 genuinely concurrent racers',
    Number(ledgerAfter?.reserved_usd) === ALLOWANCE,
    ledgerAfter,
  );
  check('total_attempts counts only the admitted reservations (matches this migrations own semantics, confirmed by design not a bug)', ledgerAfter?.total_attempts === admittedCount, ledgerAfter);

  // Settle every admitted reservation concurrently too -- proves settle's
  // own idempotency-table locking (SELECT ... FOR UPDATE) does not
  // deadlock or corrupt state under genuine concurrent settlement either.
  const admittedKeys = keys.filter((_, i) => results[i].data?.[0]?.reserved === true);
  await Promise.all(admittedKeys.map((key) => admin.rpc('aie_settle_ai_cost', { p_ledger_id: 'global', p_reserved_usd: PER_CALL, p_actual_usd: PER_CALL * 0.5, p_input_tokens: 100, p_output_tokens: 50, p_idempotency_key: key })));

  const ledgerAfterSettle = (await admin.from('aie_ai_cost_ledger').select('reserved_usd, settled_usd, total_input_tokens').eq('id', 'global').single()).data;
  check('after concurrent settlement: reserved_usd fully released (0)', Number(ledgerAfterSettle?.reserved_usd) === 0, ledgerAfterSettle);
  check('after concurrent settlement: settled_usd correctly totals all 10 admitted settlements ($0.50 each = $5.00), no lost or double-counted updates', Number(ledgerAfterSettle?.settled_usd) === 5, ledgerAfterSettle);
  check('after concurrent settlement: total_input_tokens correctly totals 10 x 100 = 1000, no lost or double-counted updates under concurrency', Number(ledgerAfterSettle?.total_input_tokens) === 1000, ledgerAfterSettle);

  // Cleanup.
  await admin.from('aie_ai_cost_ledger').update({ reserved_usd: 0, settled_usd: 0, total_attempts: 0, total_input_tokens: 0, total_output_tokens: 0 }).eq('id', 'global');
  await admin.from('aie_ai_cost_attempt').delete().in('idempotency_key', keys);
  const residue = await admin.from('aie_ai_cost_attempt').select('idempotency_key').in('idempotency_key', keys);
  check('ZERO RESIDUE: all 20 test attempt rows cleaned up', (residue.data ?? []).length === 0, residue.data);
}

main()
  .then(() => {
    console.log(`\n=== SUMMARY: ${passed}/${passed + failed} checks passed ===`);
    process.exitCode = failed > 0 ? 1 : 0;
  })
  .catch((e) => {
    console.error('SCRIPT ERROR:', e);
    process.exitCode = 1;
  });
