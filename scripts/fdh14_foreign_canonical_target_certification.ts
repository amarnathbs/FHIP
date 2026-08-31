// FDH-14 closure — GAP 2: fresh foreign-canonical-target security tests.
//
// Distinct from fdh14_cross_domain_security_certification.mjs (which proved
// ordinary cross-tenant READ/WRITE/DELETE row isolation, 28/28). THIS script
// proves the more specific claim: can Tenant A make Tenant A's OWN
// evidence/proposal/bridge row point AUTHORITATIVELY at Tenant B's canonical
// target, even though A cannot read or directly modify B's row?
//
// Run with: npx tsx --env-file=.env.local scripts/fdh14_foreign_canonical_target_certification.ts
//
// Uses ONLY synthetic users (email pattern fdh14-closure-*@fhip-test.invalid).
// Every row + both auth users are deleted at the end; deletion is
// independently re-verified by re-query.
import fs from 'node:fs';
import { createAdminClient } from '@/lib/supabase/admin';
import { applyAuStatementActivity } from '@/lib/investment-import-bridge/applyAuStatementActivity';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }),
);
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY!;
const DEV_REF = 'vqycarelcoijzwlpkpcz';
if (!URL_ || !SERVICE) { console.error('FATAL: missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local'); process.exit(2); }
if (!URL_.includes(DEV_REF)) { console.error(`FATAL: refusing to run — NEXT_PUBLIC_SUPABASE_URL (${URL_}) is not the known DEV project (${DEV_REF}).`); process.exit(2); }

const TAG = 'fdh14-closure-g2';
let pass = 0, fail = 0;
const failures: string[] = [];
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; failures.push(label); console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
};

async function rest(p: string, opts: any = {}) {
  const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', Prefer: opts.prefer ?? 'return=representation', ...opts.headers };
  const r = await fetch(`${URL_}/rest/v1/${p}`, { ...opts, headers });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
async function insert(table: string, body: any, track: { table: string; id: string }[]) {
  const r = await rest(table, { method: 'POST', body: JSON.stringify(body) });
  const row = r.json?.[0];
  if (!row) throw new Error(`insert ${table} failed (${r.status}): ${r.text.slice(0, 400)}`);
  track.push({ table, id: row.id });
  return row;
}

async function createUser(tag: string) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `${TAG}-${tag}-${stamp}@fhip-test.invalid`;
  const r = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: `Fdh14G2!${stamp}`, email_confirm: true }),
  });
  const j: any = await r.json();
  if (!j.id) throw new Error(`createUser ${tag} failed: ${JSON.stringify(j).slice(0, 300)}`);
  const now = new Date().toISOString();
  await rest(`user_profiles?user_id=eq.${j.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      full_name: `FDH14 G2 ${tag}`, country_of_residence: 'AU', preferred_currency: 'AUD',
      onboarding_completed: true, employment_status: 'full_time_employed', profile_completion_percentage: 100,
      country_confirmed_at: now, country_source: 'USER_CONFIRMED', country_updated_at: now,
    }),
  });
  return { id: j.id as string, email };
}
async function deleteUser(id: string) {
  await fetch(`${URL_}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
}

const track: { table: string; id: string }[] = [];

async function main() {
  console.log('=== FDH-14 GAP 2: fresh foreign-canonical-target security certification ===');
  const A = await createUser('a');
  const B = await createUser('b');
  console.log(`Tenant A: ${A.email} (${A.id})`);
  console.log(`Tenant B: ${B.email} (${B.id})`);

  try {
    await run(A.id, B.id);
  } finally {
    await cleanup();
    await deleteUser(A.id);
    await deleteUser(B.id);
    let residue = 0;
    for (const { table, id } of track) {
      const r = await rest(`${table}?id=eq.${id}&select=id`);
      if (r.json?.length) { residue++; console.log(`  RESIDUE: ${table} id=${id} still present`); }
    }
    for (const uid of [A.id, B.id]) {
      const r = await fetch(`${URL_}/auth/v1/admin/users/${uid}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
      if (r.status === 200) residue++;
    }
    check('CLEANUP: independent re-query confirms zero synthetic residue', residue === 0, `residue=${residue} rows_created=${track.length}`);
  }

  console.log(`\n${pass}/${pass + fail} PASS`);
  if (failures.length) { console.log('FAILURES:', failures.join(' | ')); process.exitCode = 1; }
}

async function cleanup() {
  console.log('\n=== CLEANUP ===');
  for (const { table, id } of [...track].reverse()) {
    await rest(`${table}?id=eq.${id}`, { method: 'DELETE' });
  }
}

async function run(uidA: string, uidB: string) {
  // --- B's canonical rows (the targets being attacked) ---------------------
  const bIncome = await insert('income_sources', { user_id: uidB, source_name: 'FDH14 G2 B salary', income_type: 'salary', amount: 9999, frequency: 'monthly', currency_code: 'AUD', is_active: true }, track);
  const bLiability = await insert('liabilities', { user_id: uidB, liability_name: 'FDH14 G2 B loan', debt_type: 'personal_loan', balance: 9999, currency_code: 'AUD', is_active: true }, track);
  const bRetirement = await insert('retirement_accounts', { user_id: uidB, account_name: 'FDH14 G2 B super', account_type: 'super', current_balance: 9999, currency_code: 'AUD', is_active: true }, track);
  const bBankTxn = await insert('fdh_financial_accounts', { user_id: uidB, account_type: 'transaction', country_code: 'AU', currency_code: 'AUD', display_name: 'FDH14 G2 B Bank', status: 'active' }, track);
  const bPayrollEvent = await insert('fdh_payroll_events', {
    user_id: uidB, country_code: 'AU', currency_code: 'AUD', net_pay: 9999, pay_frequency: 'monthly', pay_frequency_source: 'stated_on_payslip',
    reconciliation_status: 'reconciled', bank_match_status: 'not_attempted', review_status: 'resolved', approval_status: 'approved', approved_at: new Date().toISOString(),
    payslip_fingerprint: `${TAG}-b-payslip`,
  }, track);
  const bIiAccount = await insert('ii_accounts', { user_id: uidB, country_code: 'AU', currency_code: 'AUD', status: 'active', account_type: 'broker', institution_name: 'FDH14 G2 B Broker' }, track);

  // --- A's own bridge/evidence rows (the attacker's own, legitimately-owned
  // rows) that will attempt to name a B target authoritatively -------------

  console.log("\n--- ATTACK 1: A's import proposal -> attempt to target B's income source ---");
  {
    const attempt = await rest('fhip_import_proposals', {
      method: 'POST',
      body: JSON.stringify({
        user_id: uidA, target_domain: 'income', source_kind: 'payslip', recommended_apply_mode: 'update_existing',
        status: 'ready', generated_at: new Date().toISOString(), target_entity_id: bIncome.id,
      }),
    });
    check('ATTACK 1: BLOCKED at INSERT — A cannot create A-owned proposal authoritatively targeting B income_sources row', attempt.status >= 400 && /cross-tenant/i.test(attempt.text), `status=${attempt.status} text=${attempt.text.slice(0, 250)}`);
    if (attempt.json?.[0]?.id) track.push({ table: 'fhip_import_proposals', id: attempt.json[0].id });
    const bIncomeAfter = (await rest(`income_sources?id=eq.${bIncome.id}&select=amount`)).json?.[0];
    check("ATTACK 1: B's income_sources row is untouched (still $9,999)", Number(bIncomeAfter?.amount) === 9999, `amount=${bIncomeAfter?.amount}`);
  }

  console.log("\n--- ATTACK 2: A's statement -> attempt to target B's liability ---");
  {
    const attempt = await rest('fhip_import_proposals', {
      method: 'POST',
      body: JSON.stringify({
        user_id: uidA, target_domain: 'liability', source_kind: 'liability_statement', recommended_apply_mode: 'update_existing',
        status: 'ready', generated_at: new Date().toISOString(), target_entity_id: bLiability.id,
      }),
    });
    check('ATTACK 2: BLOCKED at INSERT — A cannot create A-owned proposal authoritatively targeting B liabilities row', attempt.status >= 400 && /cross-tenant/i.test(attempt.text), `status=${attempt.status} text=${attempt.text.slice(0, 250)}`);
    if (attempt.json?.[0]?.id) track.push({ table: 'fhip_import_proposals', id: attempt.json[0].id });
    const bLiabAfter = (await rest(`liabilities?id=eq.${bLiability.id}&select=balance`)).json?.[0];
    check("ATTACK 2: B's liabilities row is untouched (still $9,999)", Number(bLiabAfter?.balance) === 9999, `balance=${bLiabAfter?.balance}`);
  }

  console.log("\n--- ATTACK 3: A's retirement import -> attempt to target B's retirement account ---");
  {
    const attempt = await rest('fhip_import_proposals', {
      method: 'POST',
      body: JSON.stringify({
        user_id: uidA, target_domain: 'retirement', source_kind: 'retirement_statement', recommended_apply_mode: 'update_existing',
        status: 'ready', generated_at: new Date().toISOString(), target_entity_id: bRetirement.id,
      }),
    });
    check('ATTACK 3: BLOCKED at INSERT — A cannot create A-owned proposal authoritatively targeting B retirement_accounts row', attempt.status >= 400 && /cross-tenant/i.test(attempt.text), `status=${attempt.status} text=${attempt.text.slice(0, 250)}`);
    if (attempt.json?.[0]?.id) track.push({ table: 'fhip_import_proposals', id: attempt.json[0].id });
    const bRetAfter = (await rest(`retirement_accounts?id=eq.${bRetirement.id}&select=current_balance`)).json?.[0];
    check("ATTACK 3: B's retirement_accounts row is untouched (still $9,999)", Number(bRetAfter?.current_balance) === 9999, `current_balance=${bRetAfter?.current_balance}`);
  }

  console.log("\n--- ATTACK 4a: A's AU investment import -> attempt to use the generic bridge to target ANY investment account (structural reachability check) ---");
  {
    // FDH-11 deliberately never uses fhip_import_proposals/applications at all
    // (its own migration header: "call rather than force-fit the generic
    // bridge onto..."). The bridge's own trigger has no 'investment' branch,
    // so ANY non-null target_entity_id with target_domain='investment' — even
    // one naming A's OWN row — is rejected as "no implemented target guard".
    // This proves the attack surface here is structurally unreachable via
    // this table, not merely blocked by an ownership check.
    const attempt = await rest('fhip_import_proposals', {
      method: 'POST',
      body: JSON.stringify({
        user_id: uidA, target_domain: 'investment', source_kind: 'investment_statement', recommended_apply_mode: 'update_existing',
        status: 'ready', generated_at: new Date().toISOString(), target_entity_id: bIiAccount.id,
      }),
    });
    check("ATTACK 4a: target_domain='investment' with a non-null target_entity_id is REJECTED outright by fhip_import_proposals (no implemented guard for this domain — the bridge is structurally never used for investment targeting)", attempt.status >= 400 && /no implemented target guard/i.test(attempt.text), `status=${attempt.status} text=${attempt.text.slice(0, 250)}`);
    if (attempt.json?.[0]?.id) track.push({ table: 'fhip_import_proposals', id: attempt.json[0].id });
  }

  console.log("\n--- ATTACK 4b: A's AU investment import -> forge canonical_account_id on A's OWN statement to point at B's ii_accounts row (the REAL FDH-11 targeting mechanism) ---");
  {
    const aInvestmentStatement = await insert('fdh_investment_statements', {
      user_id: uidA, canonical_account_id: bIiAccount.id, statement_type: 'broker_transaction_statement', investment_jurisdiction: 'AU', base_currency: 'AUD',
      extraction_status: 'extracted', reconciliation_status: 'reconciled', review_status: 'resolved', approval_status: 'approved',
    }, track);
    // The DB layer has NO trigger validating canonical_account_id ownership
    // (confirmed by reading migration 0106) — the INSERT above succeeding
    // with a forged (B-owned) canonical_account_id proves that surface is
    // live-reachable at the row-write layer, unlike ATTACK 1-3's tables.
    const readBack = (await rest(`fdh_investment_statements?id=eq.${aInvestmentStatement.id}&select=canonical_account_id`)).json?.[0];
    check("ATTACK 4b (reachability): the DB layer accepts A's statement row with canonical_account_id forged to B's ii_accounts.id (no DB trigger polices this column — confirmed live, matching the migration's own architecture)", readBack?.canonical_account_id === bIiAccount.id, `canonical_account_id=${readBack?.canonical_account_id}`);

    const instrument = await insert('ii_instruments', { instrument_name: 'FDH14 G2 Forged Target Stock', instrument_class: 'equity', country_of_domicile: 'AU', base_currency: 'AUD', status: 'verified', is_active: true }, track);
    const activity = await insert('fdh_investment_statement_activities', {
      user_id: uidA, statement_id: aInvestmentStatement.id, activity_type: 'BUY', amount: 12345, currency_code: 'AUD',
      matched_instrument_id: instrument.id, security_match_status: 'matched', bank_match_status: 'not_attempted',
      review_status: 'resolved', apply_status: 'pending',
    }, track);

    // Now invoke the REAL apply function used by the real Apply API route —
    // same module, same code path, called with userId=A (exactly as the
    // authenticated route would derive it server-side from A's own session).
    const result = await applyAuStatementActivity({ userId: uidA, activityId: activity.id });
    check("ATTACK 4b (runtime guard): the real applyAuStatementActivity() FOREIGN_ACCOUNT check rejects the forged target before any canonical write", result.ok === false && (result as any).code === 'FOREIGN_ACCOUNT', `result=${JSON.stringify(result)}`);

    const admin = createAdminClient();
    const { data: bTxns } = await admin.from('ii_transactions').select('id').eq('account_id', bIiAccount.id);
    check("ATTACK 4b (ground truth): zero ii_transactions rows were created against B's account", (bTxns ?? []).length === 0, `count=${(bTxns ?? []).length}`);
  }

  console.log("\n--- ATTACK 5: A's own evidence row references B's payslip / import application (foreign EVIDENCE link) ---");
  {
    const attempt = await rest('fhip_import_proposals', {
      method: 'POST',
      body: JSON.stringify({
        user_id: uidA, target_domain: 'income', source_kind: 'payslip', recommended_apply_mode: 'add_new',
        status: 'ready', generated_at: new Date().toISOString(), source_payroll_event_id: bPayrollEvent.id,
      }),
    });
    check("ATTACK 5: BLOCKED at INSERT — A's own proposal cannot cite B's fdh_payroll_events row as its evidence source", attempt.status >= 400 && /cross-tenant/i.test(attempt.text), `status=${attempt.status} text=${attempt.text.slice(0, 250)}`);
    if (attempt.json?.[0]?.id) track.push({ table: 'fhip_import_proposals', id: attempt.json[0].id });
  }

  console.log("\n--- POSITIVE CONTROL: A targeting A's OWN rows via the same bridge succeeds normally ---");
  {
    const aIncome = await insert('income_sources', { user_id: uidA, source_name: 'FDH14 G2 A salary', income_type: 'salary', amount: 1000, frequency: 'monthly', currency_code: 'AUD', is_active: true }, track);
    const aPayrollEvent = await insert('fdh_payroll_events', {
      user_id: uidA, country_code: 'AU', currency_code: 'AUD', net_pay: 1000, pay_frequency: 'monthly', pay_frequency_source: 'stated_on_payslip',
      reconciliation_status: 'reconciled', bank_match_status: 'not_attempted', review_status: 'resolved', approval_status: 'approved', approved_at: new Date().toISOString(),
      payslip_fingerprint: `${TAG}-a-payslip`,
    }, track);
    const ok = await rest('fhip_import_proposals', {
      method: 'POST',
      body: JSON.stringify({
        user_id: uidA, target_domain: 'income', source_kind: 'payslip', recommended_apply_mode: 'update_existing',
        status: 'ready', generated_at: new Date().toISOString(), target_entity_id: aIncome.id, source_payroll_event_id: aPayrollEvent.id,
      }),
    });
    check('POSITIVE CONTROL: A targeting A\'s own income_sources row via the identical bridge mechanism succeeds (the guard is tenant-specific, not over-broad)', ok.status < 300 && ok.json?.[0]?.id, `status=${ok.status} text=${ok.text.slice(0, 200)}`);
    if (ok.json?.[0]?.id) track.push({ table: 'fhip_import_proposals', id: ok.json[0].id });
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exitCode = 1; });
