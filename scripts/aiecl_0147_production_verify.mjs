// Verify migration 0147 (GENERIC archive/delete-via-UPDATE bypass fix) is
// genuinely applied and effective on PRODUCTION -- same live behavioral
// reproduction method as the DEV re-check (no queryable object exists for
// this migration; it's a pure function-body replacement), using a real
// disposable synthetic PRODUCTION user, real authenticated (non-service-
// role) session for the actual assertions, full cleanup + independent
// zero-residue re-verification.
import { createClient } from '@supabase/supabase-js';

const URL = 'https://twwpnltizhtjxhamyoxt.supabase.co';
const ANON_KEY = 'sb_publishable_pWgbqCKmXZBCbqOtMr23Cw_V_oM8cZy';
const SERVICE_KEY = process.env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_KEY) {
  console.error('PRODUCTION_SUPABASE_SERVICE_ROLE_KEY not set in environment.');
  process.exit(1);
}

const admin = createClient(URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const stamp = Date.now();
const email = `g5-0147-verify-${stamp}@fhip-internal-test.invalid`;
const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;

let pass = 0, fail = 0;
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
}

let userId, rowId;
try {
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  userId = data.user.id;

  await admin.from('user_profiles').update({
    country_of_residence: 'GB',
    country_confirmed_at: new Date().toISOString(),
    country_source: 'USER_CONFIRMED',
    generic_disclosure_version: 'PROD-0147-VERIFY-V1',
    generic_disclosure_acknowledged_at: new Date().toISOString(),
    generic_disclosure_country: 'GB',
  }).eq('user_id', userId);

  const genericClient = createClient(URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error: signInErr } = await genericClient.auth.signInWithPassword({ email, password });
  if (signInErr) throw signInErr;

  const { data: row, error: insertErr } = await genericClient
    .from('income_sources')
    .insert({ user_id: userId, source_name: '0147 prod verify', income_type: 'salary', amount: 100, frequency: 'monthly', currency_code: 'AUD', is_active: true })
    .select('id')
    .single();
  check('setup: GENERIC user can INSERT (still allowed, unaffected)', !insertErr && !!row, insertErr?.message);
  rowId = row?.id;

  if (rowId) {
    const { error: archiveErr, count: archiveCount } = await genericClient
      .from('income_sources')
      .update({ is_active: false }, { count: 'exact' })
      .eq('id', rowId);
    const blocked = !!archiveErr || archiveCount === 0;
    check('0147 CORE CHECK: GENERIC archive-via-UPDATE (is_active->false) is BLOCKED in production', blocked, archiveErr?.message ?? `count=${archiveCount}`);

    const { data: afterRow } = await admin.from('income_sources').select('is_active').eq('id', rowId).single();
    check('row remains active after the blocked archive attempt', afterRow?.is_active === true, JSON.stringify(afterRow));

    // Positive control: an ordinary field edit (not touching is_active) still works.
    const { error: editErr, count: editCount } = await genericClient
      .from('income_sources')
      .update({ amount: 200 }, { count: 'exact' })
      .eq('id', rowId);
    check('positive control: ordinary field UPDATE (amount) still succeeds, unaffected', !editErr && editCount === 1, editErr?.message ?? `count=${editCount}`);
  }
} catch (e) {
  console.error('SCRIPT ERROR:', e.message);
  fail++;
} finally {
  if (rowId) await admin.from('income_sources').delete().eq('id', rowId);
  if (userId) await admin.auth.admin.deleteUser(userId);
  let residue = 0;
  if (userId) {
    const { data } = await admin.auth.admin.getUserById(userId);
    if (data?.user) { residue++; console.error('RESIDUE: user still exists'); }
  }
  console.log(residue === 0 ? 'Zero residue confirmed.' : `${residue} RESIDUE ITEMS REMAIN.`);
}

console.log(`\n=== SUMMARY: ${pass}/${pass + fail} checks passed ===`);
process.exitCode = fail > 0 ? 1 : 0;
