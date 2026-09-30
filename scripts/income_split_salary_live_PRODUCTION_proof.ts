// PRODUCTION proof for the D-07 split-salary duplicate-detection fix in
// lib/read-models/income.ts (computeIncome), commit a0ba377.
//
// WHY THIS SCRIPT EXISTS. scripts/income_split_salary_live_dev_proof.ts already
// proves this fix against DEV (6/6 PASS, merged in the same commit as the fix).
// The AIE-1 final-closure mission (step 4) explicitly asks for a PRODUCTION
// proof, not a repeat of the DEV/unit-test evidence: "prove it fires correctly
// in production with a real synthetic bank statement containing a genuine
// split-salary deposit pattern -- not just the existing unit tests."
//
// Independently confirmed before writing this script (2026-09-30, this
// session): `git merge-base --is-ancestor a0ba377 origin/main` -- true; AWS
// Amplify `list-jobs` on app d3iiacugdm5tup / branch main shows job 265,
// commitId bbd63cea82d7d6ca9455356eca560f669d559324 (origin/main HEAD, which
// contains a0ba377), status SUCCEED, deployed 2026-09-30T17:42:13+10 -- i.e.
// this exact fix is the code actually running in production today, not a
// branch that merely claims to be deployed.
//
// WHAT THIS PROVES. selectIncome() -- the exact function
// app/api/income/actuals/route.ts calls with no test double -- is run against
// REAL Postgres/PostgREST on the PRODUCTION project (twwpnltizhtjxhamyoxt),
// reading rows seeded through the real schema (real FK/CHECK constraints, real
// RLS), under the synthetic user's OWN authenticated session (not the
// service-role client). Same honest-scope disclosure as the DEV script: this
// calls the library function directly rather than driving a browser through
// the Next.js HTTP route, for the same reason (the route is a 6-line
// pass-through with no logic of its own worth re-proving at the HTTP layer) --
// but it is real production Postgres, real production RLS policies, and the
// exact shipped code identified as deployed above, not a mock or a DEV stand-in.
//
// SAFETY. Refuses to run against anything but the known PRODUCTION project
// ref. Every seeded row + the auth user are deleted in a `finally` block, then
// independently re-queried to prove zero residue. No credential value is ever
// printed. Uses a disposable @fhip-synthetic.test account (this codebase's
// established synthetic-account pattern), never a real user's data.
//
// Run: npx tsx --env-file=.env.local scripts/income_split_salary_live_PRODUCTION_proof.ts
// (.env.local here must be the repo-root D:/FHIP/.env.local, which is the only
// place PRODUCTION_SUPABASE_URL / PRODUCTION_SUPABASE_SERVICE_ROLE_KEY live.)
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js';
import { selectIncome } from '../lib/read-models/income';
import { explicitWindow } from '../lib/read-models/core/window';

const repoRoot = 'D:/FHIP';
const env: Record<string, string> = {};
for (const line of fs.readFileSync(path.join(repoRoot, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const BASE = env.PRODUCTION_SUPABASE_URL;
const SERVICE = env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY; // production anon key is NOT in .env.local; derive a public anon-equivalent below if needed
const EXPECTED_PROD_REF = 'twwpnltizhtjxhamyoxt';
if (!BASE || !SERVICE) { console.error('FATAL: missing PRODUCTION_SUPABASE_URL / PRODUCTION_SUPABASE_SERVICE_ROLE_KEY in D:/FHIP/.env.local'); process.exit(2); }
const actualRef = new URL(BASE).host.split('.')[0];
if (actualRef !== EXPECTED_PROD_REF) { console.error(`REFUSING TO RUN: target project "${actualRef}" is not the expected PRODUCTION project (${EXPECTED_PROD_REF}).`); process.exit(2); }

const admin = createSupabaseJsClient(BASE, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const RUN_TAG = `income-split-prod-${Date.now()}`;
const EMAIL = `${RUN_TAG}@fhip-synthetic.test`;
const PASSWORD = `Synthetic!${randomUUID()}`;

let pass = 0, fail = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = '') {
  if (cond) { pass += 1; console.log(`  PASS  ${label}${detail ? ' :: ' + detail : ''}`); }
  else { fail += 1; failures.push(label); console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
}

async function main() {
  console.log(`=== D-07 split-salary PRODUCTION proof (${RUN_TAG}) ===`);
  console.log(`target project ref: ${actualRef}`);
  const { data: created, error: createErr } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true });
  if (createErr || !created.user) throw new Error(`could not create synthetic user: ${createErr?.message}`);
  const userId = created.user.id;
  console.log(`synthetic production user: ${EMAIL} (${userId})`);

  const track: { table: string; id: string }[] = [];
  try {
    const { error: profErr } = await admin
      .from('user_profiles')
      .update({ onboarding_completed: false, country_of_residence: 'AU', preferred_currency: 'AUD', full_name: `Income Split PROD Proof ${RUN_TAG}` })
      .eq('user_id', userId);
    if (profErr) throw new Error(`user_profiles update failed: ${profErr.message}`);

    const { data: account, error: acctErr } = await admin
      .from('fdh_financial_accounts')
      .insert({ user_id: userId, account_type: 'transaction', country_code: 'AU', currency_code: 'AUD', display_name: `${RUN_TAG} bank`, status: 'active' })
      .select('id')
      .single();
    if (acctErr || !account) throw new Error(`fdh_financial_accounts insert failed: ${acctErr?.message}`);
    track.push({ table: 'fdh_financial_accounts', id: account.id });

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

    const { data: source, error: srcErr } = await admin
      .from('income_sources')
      .insert({ user_id: userId, source_name: `${RUN_TAG} salary`, income_type: 'salary', amount: 5000, frequency: 'monthly', currency_code: 'AUD', is_active: true })
      .select('id')
      .single();
    if (srcErr || !source) throw new Error(`income_sources insert failed: ${srcErr?.message}`);
    track.push({ table: 'income_sources', id: source.id });

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

    // Fetch the production anon key live from the production project's own
    // public settings endpoint is not available server-side; instead sign in
    // using the service-role-created user's password against production GoTrue
    // directly via the REST auth endpoint with the production ANON key. The
    // production anon key is not checked into D:/FHIP/.env.local (only DEV's
    // is) -- read it from the Amplify app's own published environment via the
    // same read-only AWS access already used for deployment-identity checks in
    // this session, OR fall back to signInWithPassword using the admin client's
    // own auth surface (service role can also mint a session via
    // `generateLink`/`admin.auth` without needing the anon key at all).
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: 'magiclink', email: EMAIL,
    });
    if (linkErr || !linkData) throw new Error(`generateLink failed: ${linkErr?.message}`);
    // Exchange the generated OTP hash for a real session using the GoTrue verify
    // endpoint directly (no anon key required for the verify call itself when
    // using the token_hash form), giving a genuine user-scoped access token.
    const verifyResp = await fetch(`${BASE}/auth/v1/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SERVICE },
      body: JSON.stringify({ type: 'magiclink', token_hash: (linkData as any).properties?.hashed_token }),
    });
    const verifyJson: any = await verifyResp.json();
    if (!verifyResp.ok || !verifyJson.access_token) throw new Error(`session exchange failed: ${verifyResp.status} ${JSON.stringify(verifyJson)}`);

    const asUser = createSupabaseJsClient(BASE, SERVICE, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${verifyJson.access_token}` } },
    });

    const window = explicitWindow('2026-08-01', '2026-08-31', '2026-09-26', 'Australia/Sydney');
    const model = await selectIncome(userId, { client: asUser, window });
    check('selectIncome returns status ok (real RLS-scoped PRODUCTION read succeeded)', model.status === 'ok', model.status === 'ok' ? '' : JSON.stringify(model));
    if (model.status !== 'ok') throw new Error('selectIncome unavailable -- cannot continue the proof');

    const lineFor = (amount: number) => model.actual.lines.find((l) => l.amountNative === amount);
    const d3000 = lineFor(3000);
    const d2000 = lineFor(2000);
    check('both deposits appear as counted actual income lines', Boolean(d3000 && d2000 && d3000.treatment === 'counted' && d2000.treatment === 'counted'));
    check('the 3,000 deposit is flagged possibleDuplicateOf the planned salary', Boolean(d3000 && d3000.possibleDuplicateOf.length === 1 && d3000.possibleDuplicateOf[0].sourceId === source.id), JSON.stringify(d3000?.possibleDuplicateOf));
    check('the 2,000 deposit is flagged possibleDuplicateOf the SAME planned salary', Boolean(d2000 && d2000.possibleDuplicateOf.length === 1 && d2000.possibleDuplicateOf[0].sourceId === source.id), JSON.stringify(d2000?.possibleDuplicateOf));
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
    const stillThere = await admin.auth.admin.getUserById(userId).then((r) => r, () => ({ data: null }) as any);
    if ((stillThere as any)?.data?.user) { residue += 1; console.log('  RESIDUE: synthetic auth user still present'); }
    check('CLEANUP: independent re-query confirms zero synthetic residue in PRODUCTION', residue === 0, `residue=${residue} rows_created=${track.length}`);
  }

  console.log(`\n${pass}/${pass + fail} PASS`);
  if (failures.length) { console.log('FAILURES:', failures.join(' | ')); process.exitCode = 1; }
}

main().catch((e) => {
  console.error('FATAL:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
