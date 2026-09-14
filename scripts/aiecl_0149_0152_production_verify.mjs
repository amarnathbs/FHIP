// Independent production verification of migrations 0149-0152, applied by
// the user today. Real read-only schema checks + real functional RPC calls
// against PRODUCTION, using a synthetic cost-ledger scope ("pilot allowance
// scope" per 0150's own comment) that touches no real user data
// (aie_ai_cost_ledger/aie_ai_cost_attempt are internal cost-tracking
// tables, never the real 'global' scope). Cleaned up afterward.
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.PRODUCTION_SUPABASE_URL;
const SERVICE_KEY = process.env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('PRODUCTION_SUPABASE_URL / PRODUCTION_SUPABASE_SERVICE_ROLE_KEY not set');
  process.exit(1);
}
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

let pass = 0, fail = 0;
const failures = [];
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; failures.push(label); console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
}

const stamp = Date.now();
const LEDGER_ID = `prod-verify-${stamp}`; // a NEW, disposable scope -- never the real 'global' row

async function main() {
  // --- 0149: aie_document_intake purge columns ---
  const { error: intakeErr } = await admin
    .from('aie_document_intake')
    .select('purge_status, purge_due_at, purged_at, purge_reason')
    .limit(1);
  check('0149: aie_document_intake.purge_status/purge_due_at/purged_at/purge_reason columns exist', !intakeErr, intakeErr?.message);

  // --- 0150: aie_ai_cost_ledger table exists (real column is `id`, not `ledger_id`) ---
  const { error: ledgerTableErr } = await admin.from('aie_ai_cost_ledger').select('id').limit(1);
  check('0150: aie_ai_cost_ledger table exists and is queryable', !ledgerTableErr, ledgerTableErr?.message);

  // --- 0152: aie_ai_cost_attempt table exists ---
  const { error: attemptTableErr } = await admin.from('aie_ai_cost_attempt').select('idempotency_key').limit(1);
  check('0152: aie_ai_cost_attempt table exists and is queryable', !attemptTableErr, attemptTableErr?.message);

  // Set up a disposable synthetic ledger scope (0150's own design: "one row
  // per pilot allowance scope" -- a real row must exist before reserve/
  // settle can act on it; never touches the real 'global' scope).
  const { error: seedErr } = await admin.from('aie_ai_cost_ledger').insert({ id: LEDGER_ID, allowance_usd: 10.0 });
  check('setup: disposable synthetic ledger scope created', !seedErr, seedErr?.message);

  // --- 0151/0152: aie_reserve_ai_cost, current 4-arg signature, single-row return ---
  const idemKey1 = `${LEDGER_ID}-reserve-1`;
  const { data: reserve1, error: reserve1Err } = await admin.rpc('aie_reserve_ai_cost', {
    p_ledger_id: LEDGER_ID,
    p_amount_usd: 0.01,
    p_allowance_usd: 10.0,
    p_idempotency_key: idemKey1,
  });
  check('0151/0152: aie_reserve_ai_cost (4-arg, with idempotency_key) callable', !reserve1Err, reserve1Err?.message);
  check('0151: reserve returns exactly ONE row (the single-row fix)', Array.isArray(reserve1) && reserve1.length === 1, JSON.stringify(reserve1));
  const row1 = Array.isArray(reserve1) ? reserve1[0] : null;
  check('reservation admitted (within allowance)', row1?.reserved === true, JSON.stringify(row1));

  // Duplicate reserve with the SAME idempotency key -- must replay the same
  // stored outcome, never double-reserve against the ledger.
  const { data: reserve1Dup, error: reserve1DupErr } = await admin.rpc('aie_reserve_ai_cost', {
    p_ledger_id: LEDGER_ID,
    p_amount_usd: 0.01,
    p_allowance_usd: 10.0,
    p_idempotency_key: idemKey1,
  });
  check('0152: duplicate reserve (same idempotency_key) does not error', !reserve1DupErr, reserve1DupErr?.message);
  const row1Dup = Array.isArray(reserve1Dup) ? reserve1Dup[0] : null;
  check('0152: duplicate reserve replays the SAME outcome, not a fresh reservation', row1Dup?.reserved === row1?.reserved && row1Dup?.remaining_usd === row1?.remaining_usd, `first=${JSON.stringify(row1)} dup=${JSON.stringify(row1Dup)}`);

  const { data: ledgerAfterDupReserve } = await admin.from('aie_ai_cost_ledger').select('reserved_usd, total_attempts').eq('id', LEDGER_ID).maybeSingle();
  check('0152: duplicate reserve did NOT double-reserve against the ledger (reserved_usd == 0.01, not 0.02)', Number(ledgerAfterDupReserve?.reserved_usd) === 0.01, JSON.stringify(ledgerAfterDupReserve));

  // --- 0152: aie_settle_ai_cost, current 6-arg signature, idempotent duplicate settle ---
  const idemKeySettle = `${LEDGER_ID}-settle-1`;
  const { error: settle1Err } = await admin.rpc('aie_settle_ai_cost', {
    p_ledger_id: LEDGER_ID,
    p_reserved_usd: 0.01,
    p_actual_usd: 0.008,
    p_input_tokens: 100,
    p_output_tokens: 20,
    p_idempotency_key: idemKeySettle,
  });
  check('0152: aie_settle_ai_cost (6-arg, with idempotency_key) callable', !settle1Err, settle1Err?.message);

  const { data: ledgerAfterFirstSettle } = await admin
    .from('aie_ai_cost_ledger')
    .select('settled_usd, total_input_tokens, total_output_tokens')
    .eq('id', LEDGER_ID)
    .maybeSingle();
  console.log('    ledger after 1st settle:', JSON.stringify(ledgerAfterFirstSettle));

  // Duplicate settle, SAME idempotency key -- must be a no-op (0152's whole point).
  // Note: idemKeySettle was never used in a *reserve* call, so
  // aie_ai_cost_attempt has no row for it yet -- per the migration's own
  // documented caveat, settle's idempotency guard only protects a key that
  // was actually reserved first. Reserve+settle under the SAME key below
  // is the realistic path the app's gateway actually uses.
  const idemKeyFull = `${LEDGER_ID}-full-cycle`;
  await admin.rpc('aie_reserve_ai_cost', { p_ledger_id: LEDGER_ID, p_amount_usd: 0.02, p_allowance_usd: 10.0, p_idempotency_key: idemKeyFull });
  await admin.rpc('aie_settle_ai_cost', { p_ledger_id: LEDGER_ID, p_reserved_usd: 0.02, p_actual_usd: 0.015, p_input_tokens: 200, p_output_tokens: 40, p_idempotency_key: idemKeyFull });
  const { data: ledgerAfterRealCycleSettle } = await admin.from('aie_ai_cost_ledger').select('settled_usd, total_input_tokens, total_output_tokens').eq('id', LEDGER_ID).maybeSingle();

  const { error: settleDupErr } = await admin.rpc('aie_settle_ai_cost', {
    p_ledger_id: LEDGER_ID,
    p_reserved_usd: 0.02,
    p_actual_usd: 0.015,
    p_input_tokens: 200,
    p_output_tokens: 40,
    p_idempotency_key: idemKeyFull,
  });
  check('duplicate settle (same idempotency_key, real reserve+settle cycle) does not error', !settleDupErr, settleDupErr?.message);

  const { data: ledgerAfterDupSettle } = await admin.from('aie_ai_cost_ledger').select('settled_usd, total_input_tokens, total_output_tokens').eq('id', LEDGER_ID).maybeSingle();
  console.log('    ledger after real cycle settle:', JSON.stringify(ledgerAfterRealCycleSettle));
  console.log('    ledger after duplicate settle on that same key:', JSON.stringify(ledgerAfterDupSettle));

  check(
    '0152: duplicate settle did NOT double-count settled_usd',
    Number(ledgerAfterRealCycleSettle?.settled_usd) === Number(ledgerAfterDupSettle?.settled_usd),
    `before-dup=${ledgerAfterRealCycleSettle?.settled_usd} after-dup=${ledgerAfterDupSettle?.settled_usd}`
  );
  check(
    '0152: duplicate settle did NOT double-count tokens',
    Number(ledgerAfterRealCycleSettle?.total_input_tokens) === Number(ledgerAfterDupSettle?.total_input_tokens),
    `before-dup=${ledgerAfterRealCycleSettle?.total_input_tokens} after-dup=${ledgerAfterDupSettle?.total_input_tokens}`
  );
}

async function cleanup() {
  console.log('\n--- CLEANUP ---');
  const { error: attemptDelErr } = await admin.from('aie_ai_cost_attempt').delete().eq('ledger_id', LEDGER_ID);
  const { error: ledgerDelErr } = await admin.from('aie_ai_cost_ledger').delete().eq('id', LEDGER_ID);
  console.log('attempt rows deleted:', !attemptDelErr, attemptDelErr?.message ?? '');
  console.log('ledger row deleted:', !ledgerDelErr, ledgerDelErr?.message ?? '');

  const { data: residueLedger } = await admin.from('aie_ai_cost_ledger').select('id').eq('id', LEDGER_ID);
  const { data: residueAttempt } = await admin.from('aie_ai_cost_attempt').select('ledger_id').eq('ledger_id', LEDGER_ID);
  const residue = (residueLedger?.length ?? 0) + (residueAttempt?.length ?? 0);
  console.log(residue === 0 ? 'Zero residue confirmed.' : `${residue} RESIDUE ITEMS REMAIN.`);
}

try {
  await main();
} catch (e) {
  console.error('SCRIPT ERROR:', e.stack || e.message);
  fail++;
  failures.push('script-level exception: ' + e.message);
} finally {
  await cleanup();
}

console.log(`\n=== SUMMARY: ${pass}/${pass + fail} checks passed ===`);
if (failures.length) console.log('FAILED:', failures);
process.exitCode = fail > 0 ? 1 : 0;
