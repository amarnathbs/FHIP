// AIE-1 infrastructure-activation mission -- live-DEV verification of
// migrations 0151/0152 (aie_reserve_ai_cost/aie_settle_ai_cost single-row +
// idempotency fixes), run against real DEV Supabase after the PO applied
// both migrations via the SQL Editor. Real RPC calls, real ledger state,
// full cleanup with independent zero-residue verification.
//
// This re-runs, against the real database, exactly what
// tests/unit/aieCostAdmissionPglitePostgresProof.test.ts already proved
// against an isolated PGlite Postgres engine before either migration was
// ever applied here -- confirming the two environments agree.
//
// Run: node scripts/aiecl_0152_cost_idempotency_live_dev_verify.mjs
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const raw = fs.readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
const env = {};
for (const l of raw.split(/\r?\n/)) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

let pass = 0, fail = 0;
function check(label, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  if (cond) pass++; else fail++;
}

async function main() {
  const attemptTableProbe = await admin.from('aie_ai_cost_attempt').select('idempotency_key').limit(1);
  check('aie_ai_cost_attempt table exists (0152)', !attemptTableProbe.error, attemptTableProbe.error?.message);

  await admin.from('aie_ai_cost_ledger').update({ reserved_usd: 0, settled_usd: 0, total_attempts: 0, total_input_tokens: 0, total_output_tokens: 0 }).eq('id', 'global');

  const key1 = `dev-verify-0152-${Date.now()}-a`;
  const r1 = await admin.rpc('aie_reserve_ai_cost', { p_ledger_id: 'global', p_amount_usd: 2.0, p_allowance_usd: 10, p_idempotency_key: key1 });
  check('successful reservation returns EXACTLY ONE row (0151/0152 fix, live DEV)', r1.data?.length === 1, r1.error?.message ?? r1.data);
  check('reservation is admitted', r1.data?.[0]?.reserved === true, r1.data);

  const r1b = await admin.rpc('aie_reserve_ai_cost', { p_ledger_id: 'global', p_amount_usd: 2.0, p_allowance_usd: 10, p_idempotency_key: key1 });
  check('repeat reservation call under the same key also returns exactly one row', r1b.data?.length === 1, r1b.data);
  const ledgerAfterRepeatReserve = (await admin.from('aie_ai_cost_ledger').select('reserved_usd, total_attempts').eq('id', 'global').single()).data;
  check('repeat reservation (same key) does not double-reserve against the ledger', Number(ledgerAfterRepeatReserve.reserved_usd) === 2.0 && ledgerAfterRepeatReserve.total_attempts === 1, ledgerAfterRepeatReserve);

  await admin.rpc('aie_settle_ai_cost', { p_ledger_id: 'global', p_reserved_usd: 2.0, p_actual_usd: 1.5, p_input_tokens: 1000, p_output_tokens: 500, p_idempotency_key: key1 });
  const afterFirstSettle = (await admin.from('aie_ai_cost_ledger').select('settled_usd, total_input_tokens').eq('id', 'global').single()).data;
  check('first settle applies correctly', Number(afterFirstSettle.settled_usd) === 1.5, afterFirstSettle);

  await admin.rpc('aie_settle_ai_cost', { p_ledger_id: 'global', p_reserved_usd: 2.0, p_actual_usd: 1.5, p_input_tokens: 1000, p_output_tokens: 500, p_idempotency_key: key1 });
  const afterDuplicateSettle = (await admin.from('aie_ai_cost_ledger').select('settled_usd, total_input_tokens').eq('id', 'global').single()).data;
  check(
    'DUPLICATE settle (same key) is a no-op on real DEV -- the exact defect confirmed live before this fix (settled_usd previously doubled 1.5 -> 3.0)',
    Number(afterDuplicateSettle.settled_usd) === 1.5 && Number(afterDuplicateSettle.total_input_tokens) === 1000,
    afterDuplicateSettle,
  );

  const key2 = `dev-verify-0152-${Date.now()}-b`;
  const r2 = await admin.rpc('aie_reserve_ai_cost', { p_ledger_id: 'global', p_amount_usd: 1.0, p_allowance_usd: 10, p_idempotency_key: key2 });
  check('a different idempotency key reserves independently (fix does not over-collapse unrelated attempts)', r2.data?.[0]?.reserved === true, r2.data);

  await admin.from('aie_ai_cost_ledger').update({ reserved_usd: 0, settled_usd: 0, total_attempts: 0, total_input_tokens: 0, total_output_tokens: 0 }).eq('id', 'global');
  await admin.from('aie_ai_cost_attempt').delete().in('idempotency_key', [key1, key2]);
  const residue = await admin.from('aie_ai_cost_attempt').select('idempotency_key').in('idempotency_key', [key1, key2]);
  check('ZERO RESIDUE: test attempt rows cleaned up', (residue.data ?? []).length === 0, residue.data);
}

await main();
console.log(`\n=== SUMMARY: ${pass}/${pass + fail} checks passed ===`);
process.exitCode = fail > 0 ? 1 : 0;
