// Live-DEV verification of migration 0090 (SMSF current_balance integrity
// guard) against the REAL Supabase DEV project -- not PGlite. This exists
// specifically because the first draft of 0090 passed 68/68 in PGlite but
// failed on real Supabase with 42501 (PGlite doesn't reproduce Supabase's
// restricted, non-superuser `postgres` role). This script creates one real
// synthetic auth user, drives everything through the actual PostgREST API
// with that user's own JWT (exactly what the app itself does), and deletes
// the user (cascade) at the end.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const admin = createClient(URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

let pass = 0, fail = 0;
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); }
  else { fail++; console.log(`  FAIL  ${label} ${detail}`); }
}

const testEmail = `smsf-0090-livecheck-${Date.now()}@fhip-test.invalid`;
let userId;

try {
  console.log('=== 0090 LIVE-DEV VERIFICATION (real Supabase, real PostgREST, real JWT) ===\n');

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: testEmail, password: 'Test-Pass-0090!', email_confirm: true,
  });
  if (createErr) throw new Error(`user create failed: ${createErr.message}`);
  userId = created.user.id;
  console.log(`synthetic user created: ${userId}`);

  const { data: signIn, error: signInErr } = await admin.auth.signInWithPassword
    ? await admin.auth.signInWithPassword({ email: testEmail, password: 'Test-Pass-0090!' })
    : { data: null, error: 'no signInWithPassword on admin client' };
  if (signInErr) throw new Error(`sign-in failed: ${JSON.stringify(signInErr)}`);
  const jwt = signIn.session.access_token;

  const asUser = createClient(URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Prerequisite: smsf_create_fund is gated to AU-resident users (0084's
  // AU-only jurisdiction gate) -- set that up via service role, same as a
  // real onboarding flow would.
  const { error: profileErr } = await admin.from('user_profiles').upsert({ user_id: userId, country_of_residence: 'AU' });
  if (profileErr) throw new Error(`user_profiles setup failed: ${profileErr.message}`);

  // 1. Create a real SMSF fund via the certified RPC, as the real user.
  const { data: fund, error: fundErr } = await asUser.rpc('smsf_create_fund', {
    p_account_name: 'Live Guard Check SMSF',
    p_fund_name: 'Live Guard Check Fund',
    p_summary_balance: 250000,
    p_summary_balance_date: '2026-08-01',
    p_owner: 'self',
    p_currency_code: 'AUD',
    p_country_code: 'AU',
  });
  if (fundErr) throw new Error(`smsf_create_fund failed: ${fundErr.message}`);
  const raId = fund[0].retirement_account_id;
  const fundId = fund[0].smsf_fund_id;
  check('setup: smsf_create_fund succeeded (certified INSERT path, unaffected by guard)', !!raId && !!fundId);

  const { data: afterCreate } = await asUser.from('retirement_accounts').select('current_balance').eq('id', raId).single();
  check('setup: current_balance seeded correctly at creation (250000)', Number(afterCreate.current_balance) === 250000, `(got ${afterCreate?.current_balance})`);

  // 2. THE ATTACK: raw PATCH to retirement_accounts.current_balance via
  // PostgREST, exactly what a direct API/curl call with the user's own JWT
  // would do, bypassing the app's UI entirely.
  const { error: attackErr } = await asUser.from('retirement_accounts').update({ current_balance: 999999 }).eq('id', raId);
  check('GUARD 0090 LIVE: raw PostgREST PATCH of current_balance is REJECTED on real DEV', !!attackErr, attackErr ? `(rejected: ${attackErr.message.slice(0, 140)})` : '(NOT rejected -- SECURITY GAP STILL OPEN)');

  const { data: afterAttack } = await asUser.from('retirement_accounts').select('current_balance').eq('id', raId).single();
  check('GUARD 0090 LIVE: balance genuinely unchanged after the attack', Number(afterAttack.current_balance) === 250000, `(got ${afterAttack?.current_balance})`);

  // 3. Certified Summary-edit path must still work live.
  const { error: summaryErr } = await asUser.from('smsf_funds').update({ summary_balance: 260000, summary_balance_date: '2026-08-25' }).eq('id', fundId);
  check('GUARD 0090 LIVE: certified Summary edit does NOT error', !summaryErr, summaryErr ? `(${summaryErr.message})` : '');
  const { data: afterSummary } = await asUser.from('retirement_accounts').select('current_balance').eq('id', raId).single();
  check('GUARD 0090 LIVE: certified Summary edit DOES propagate to current_balance (260000)', Number(afterSummary.current_balance) === 260000, `(got ${afterSummary?.current_balance})`);

  // 4. Negative control: a non-SMSF retirement row remains freely editable.
  const { data: otherIns, error: otherInsErr } = await asUser.from('retirement_accounts').insert({
    user_id: userId, account_name: 'Live Guard Check Industry Super', account_type: 'super', current_balance: 40000,
    currency_code: 'AUD', country_code: 'AU', owner: 'self', master_item_key: 'industry_super', is_active: true,
  }).select('id').single();
  check('setup: non-SMSF row created', !otherInsErr && !!otherIns, otherInsErr ? `(${otherInsErr.message})` : '');
  if (otherIns) {
    const { error: otherUpdErr } = await asUser.from('retirement_accounts').update({ current_balance: 45000 }).eq('id', otherIns.id);
    check('GUARD 0090 LIVE NEGATIVE CONTROL: non-SMSF row current_balance remains freely editable', !otherUpdErr, otherUpdErr ? `(${otherUpdErr.message})` : '');
  }

  // Cleanup of created rows (belt-and-braces; user delete cascades anyway).
  if (otherIns) await asUser.from('retirement_accounts').delete().eq('id', otherIns.id);
  await asUser.from('smsf_funds').delete().eq('id', fundId);
  await asUser.from('retirement_accounts').delete().eq('id', raId);
} catch (e) {
  console.error('UNCAUGHT:', e.message);
  fail++;
} finally {
  if (userId) {
    const { error: delErr } = await admin.auth.admin.deleteUser(userId);
    console.log(delErr ? `\nWARNING: synthetic user cleanup failed: ${delErr.message}` : `\nsynthetic user ${userId} deleted (cascade)`);
  }
}

console.log(`\n0090 LIVE-DEV VERIFICATION: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
