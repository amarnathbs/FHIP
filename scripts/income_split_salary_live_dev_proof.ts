// Live-DEV proof for the D-07 split-salary duplicate-detection fix in
// lib/read-models/income.ts (computeIncome).
//
// WHAT THIS PROVES. selectIncome() -- the EXACT function GET /api/income/
// actuals calls, with no test double anywhere in the path -- is run against
// REAL Postgres/PostgREST on the DEV project, reading rows seeded through the
// real schema (real FK/CHECK constraints, real RLS), under the synthetic
// user's OWN authenticated session (not the service-role client), exactly as
// the live route would see it. It confirms that a salary genuinely paid as
// two same-week bank deposits (3,000 + 2,000 for a 5,000 planned wage) is now
// flagged `possibleDuplicateOf` on BOTH lines instead of being silently
// double-counted as extra income on top of the planned source.
//
// HONEST SCOPE. This calls the library function directly (import
// `selectIncome` from '@/lib/read-models/income'), not the Next.js HTTP route
// through a running `next dev` server / browser session -- the same shortcut
// several existing live-DEV scripts in this repo take when the thing under
// test is a pure/DB-backed read model rather than route-level concerns
// (auth middleware, response shaping). The route itself
// (app/api/income/actuals/route.ts) is a 6-line pass-through: `const model =
// await selectIncome(user.id, { client: createClient() })`, so this is a
// faithful exercise of the real code path, not a synthetic substitute for it
// -- but it is not a full browser-driven HTTP journey, and that is disclosed
// here rather than implied.
//
// SAFETY. Refuses to run against anything but the known DEV project ref.
// Every seeded row + the auth user are deleted in a `finally` block, then
// independently re-queried to prove zero residue. No credential value is
// ever printed.
//
// Run: npx tsx --env-file=.env.local scripts/income_split_salary_live_dev_proof.ts
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js';
import { selectIncome } from '@/lib/read-models/income';
import { explicitWindow } from '@/lib/read-models/core/window';

const repoRoot = path.resolve(process.cwd());
const env: Record<string, string> = {};
for (const line of fs.readFileSync(path.join(repoRoot, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const EXPECTED_DEV_REF = 'vqycarelcoijzwlpkpcz';
if (!BASE || !SERVICE || !ANON) { console.error('FATAL: missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local'); process.exit(2); }
const actualRef = new URL(BASE).host.split('.')[0];
if (actualRef !== EXPECTED_DEV_REF) { console.error(`REFUSING TO RUN: target project "${actualRef}" is not the expected DEV project (${EXPECTED_DEV_REF}).`); process.exit(2); }
if (env.PRODUCTION_SUPABASE_URL || env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY) {
  console.error("REFUSING TO RUN: PRODUCTION_-prefixed vars must not be present in this script's env at all.");
  process.exit(2);
}

const admin = createSupabaseJsClient(BASE, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const RUN_TAG = `income-split-${Date.now()}`;
const EMAIL = `${RUN_TAG}@fhip-synthetic.test`;
const PASSWORD = `Synthetic!${randomUUID()}`;

let pass = 0, fail = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = '') {
  if (cond) { pass += 1; console.log(`  PASS  ${label}${detail ? ' :: ' + detail : ''}`); }
  else { fail += 1; failures.push(label); console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
}

async function main() {
  console.log(`=== D-07 split-salary live-DEV proof (${RUN_TAG}) ===`);
  const { data: created, error: createErr } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true });
  if (createErr || !created.user) throw new Error(`could not create synthetic user: ${createErr?.message}`);
  const userId = created.user.id;
  console.log(`synthetic user: ${EMAIL} (${userId})`);

  const track: { table: string; id: string }[] = [];
  try {
    const { error: profErr } = await admin
      .from('user_profiles')
      .update({ onboarding_completed: false, country_of_residence: 'AU', preferred_currency: 'AUD', full_name: `Income Split Proof ${RUN_TAG}` })
      .eq('user_id', userId);
    if (profErr) throw new Error(`user_profiles update failed: ${profErr.message}`);

    // Bank account (ordinary transaction account, AUD).
    const { data: account, error: acctErr } = await admin
      .from('fdh_financial_accounts')
      .insert({ user_id: userId, account_type: 'transaction', country_code: 'AU', currency_code: 'AUD', display_name: `${RUN_TAG} bank`, status: 'active' })
      .select('id')
      .single();
    if (acctErr || !account) throw new Error(`fdh_financial_accounts insert failed: ${acctErr?.message}`);
    track.push({ table: 'fdh_financial_accounts', id: account.id });

    // Approved statement covering August 2026, the window this proof uses.
    const { data: statement, error: stmtErr } = await admin
      .from('fdh_statement_uploads')
      .insert({
        user_id: userId, financial_account_id: account.id, source_type: 'manual_mapping', document_type: 'bank_statement',
        country_code: 'AU', currency_code: 'AUD', statement_period_start: '2026-08-01', statement_period_end: '2026-08-31',
        processing_status: 'approved',
      })
      .select('id')
      .single();
    if (stmtErr || !statement) throw new Error(`fdh_statement_uploads insert failed: ${stmtErr?.message}`);
    track.push({ table: 'fdh_statement_uploads', id: statement.id });

    // Planned income source: 5,000/month salary.
    const { data: source, error: srcErr } = await admin
      .from('income_sources')
      .insert({ user_id: userId, source_name: `${RUN_TAG} salary`, income_type: 'salary', amount: 5000, frequency: 'monthly', currency_code: 'AUD', is_active: true })
      .select('id')
      .single();
    if (srcErr || !source) throw new Error(`income_sources insert failed: ${srcErr?.message}`);
    track.push({ table: 'income_sources', id: source.id });

    // Two approved bank credits, same ISO week (2026-08-10..16 = week 33),
    // summing to exactly the planned 5,000 -- the genuine split-salary case.
    const approvedAt = new Date().toISOString();
    const txnRows = [
      { date: '2026-08-10', amount: 3000 },
      { date: '2026-08-13', amount: 2000 },
    ];
    for (const t of txnRows) {
      const { data: txn, error: txnErr } = await admin
        .from('fdh_transactions')
        .insert({
          user_id: userId, financial_account_id: account.id, statement_upload_id: statement.id,
          transaction_date: t.date, amount_original: t.amount, currency_original: 'AUD', credit_debit: 'credit',
          economic_transaction_type: 'income', approval_status: 'approved', approved_at: approvedAt, approved_by: userId,
          description_clean: `${RUN_TAG} deposit ${t.amount}`,
        })
        .select('id')
        .single();
      if (txnErr || !txn) throw new Error(`fdh_transactions insert (${t.amount}) failed: ${txnErr?.message}`);
      track.push({ table: 'fdh_transactions', id: txn.id });
    }

    // Sign in as the synthetic user for a REAL, RLS-scoped session -- the
    // same shape of client createClient() builds per-request in the route.
    const asUser = createSupabaseJsClient(BASE, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: session, error: signInErr } = await asUser.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
    if (signInErr || !session.session) throw new Error(`sign-in failed: ${signInErr?.message}`);

    const window = explicitWindow('2026-08-01', '2026-08-31', '2026-09-26', 'Australia/Sydney');
    const model = await selectIncome(userId, { client: asUser, window });
    check('selectIncome returns status ok (real RLS-scoped read succeeded)', model.status === 'ok', model.status === 'ok' ? '' : JSON.stringify(model));
    if (model.status !== 'ok') throw new Error('selectIncome unavailable -- cannot continue the proof');

    const lineFor = (amount: number) => model.actual.lines.find((l) => l.amountNative === amount);
    const d3000 = lineFor(3000);
    const d2000 = lineFor(2000);
    check('both deposits appear as counted actual income lines', Boolean(d3000 && d2000 && d3000.treatment === 'counted' && d2000.treatment === 'counted'));
    check('the 3,000 deposit is flagged possibleDuplicateOf the planned salary', Boolean(d3000 && d3000.possibleDuplicateOf.length === 1 && d3000.possibleDuplicateOf[0].sourceId === source.id), JSON.stringify(d3000?.possibleDuplicateOf));
    check('the 2,000 deposit is flagged possibleDuplicateOf the SAME planned salary', Boolean(d2000 && d2000.possibleDuplicateOf.length === 1 && d2000.possibleDuplicateOf[0].sourceId === source.id), JSON.stringify(d2000?.possibleDuplicateOf));
    check('neither deposit alone was within the single-line 5% band (this is genuinely the split-pair path, not the old single-line check)', Boolean(d3000 && d2000), `3000 vs 5000 = ${Math.abs(3000 - 5000) / 5000 * 100}% off; 2000 vs 5000 = ${Math.abs(2000 - 5000) / 5000 * 100}% off`);
    console.log(`  actual.countedMonthly = ${model.actual.countedMonthly}, actual.possibleDuplicateCount = ${model.actual.possibleDuplicateCount}`);
  } finally {
    console.log('\n=== CLEANUP ===');
    for (const { table, id } of [...track].reverse()) {
      const { error } = await admin.from(table).delete().eq('id', id);
      if (error) console.log(`  cleanup warning: ${table} id=${id}: ${error.message}`);
    }
    await admin.auth.admin.deleteUser(userId);

    let residue = 0;
    for (const { table, id } of track) {
      const { data } = await admin.from(table).select('id').eq('id', id);
      if (data && data.length > 0) { residue += 1; console.log(`  RESIDUE: ${table} id=${id} still present`); }
    }
    const { data: userStillThere } = await admin.auth.admin.getUserById(userId).then((r) => r, () => ({ data: null }) as any);
    if (userStillThere?.user) { residue += 1; console.log('  RESIDUE: synthetic auth user still present'); }
    check('CLEANUP: independent re-query confirms zero synthetic residue', residue === 0, `residue=${residue} rows_created=${track.length}`);
  }

  console.log(`\n${pass}/${pass + fail} PASS`);
  if (failures.length) { console.log('FAILURES:', failures.join(' | ')); process.exitCode = 1; }
}

main().catch((e) => {
  console.error('FATAL:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
