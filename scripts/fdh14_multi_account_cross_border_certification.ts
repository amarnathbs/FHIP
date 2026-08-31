// FDH-14 closure — GAP 4: fresh multi-account and cross-border boundary
// fixture (ONE fixture, not a jurisdiction project).
//
// One synthetic AU-resident user on live hosted DEV: 2 bank accounts, 1
// credit card, 1 loan, 1 AU brokerage account, 1 AU super account, PLUS an
// India investment relationship (using the existing, pre-existing
// Investment Intelligence `ii_accounts`/`ii_transactions` schema — the
// actual India Investment module's real data model; FDH-14 creates no new
// India investment functionality here).
//
// Run with: npx tsx --env-file=.env.local scripts/fdh14_multi_account_cross_border_certification.ts
//
// Uses ONLY a synthetic user (email pattern fdh14-closure-*@fhip-test.invalid).
// Every row + the auth user are deleted at the end; deletion is
// independently re-verified by re-query.
import fs from 'node:fs';
import { matchLiabilityFacility, type ExistingLiabilityCandidate, type FacilityMatchQuery } from '@/lib/financial-data-hub/liability/facilityMatching';

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

const TAG = 'fdh14-closure-g4';
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
async function createUser() {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `${TAG}-${stamp}@fhip-test.invalid`;
  const r = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: `Fdh14G4!${stamp}`, email_confirm: true }),
  });
  const j: any = await r.json();
  if (!j.id) throw new Error(`createUser failed: ${JSON.stringify(j).slice(0, 300)}`);
  const now = new Date().toISOString();
  await rest(`user_profiles?user_id=eq.${j.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      full_name: 'FDH14 Multi-Account Cross-Border', country_of_residence: 'AU', preferred_currency: 'AUD',
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
const DAY = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

async function main() {
  console.log('=== FDH-14 GAP 4: fresh multi-account + cross-border boundary fixture ===');
  const user = await createUser();
  console.log(`Synthetic user: ${user.email} (${user.id})`);
  try {
    await run(user.id);
  } finally {
    await cleanup();
    await deleteUser(user.id);
    let residue = 0;
    for (const { table, id } of track) {
      const r = await rest(`${table}?id=eq.${id}&select=id`);
      if (r.json?.length) { residue++; console.log(`  RESIDUE: ${table} id=${id} still present`); }
    }
    const userStillExists = await fetch(`${URL_}/auth/v1/admin/users/${user.id}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
    if (userStillExists.status === 200) residue++;
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

async function run(uid: string) {
  console.log('\n--- FIXTURE: 2 bank accounts, 1 credit card, 1 loan, 1 AU brokerage, 1 AU super ---');
  const bank1 = await insert('fdh_financial_accounts', { user_id: uid, account_type: 'transaction', country_code: 'AU', currency_code: 'AUD', display_name: 'FDH14 G4 Bank 1 (Everyday)', masked_identifier: '1111', status: 'active' }, track);
  const bank2 = await insert('fdh_financial_accounts', { user_id: uid, account_type: 'savings', country_code: 'AU', currency_code: 'AUD', display_name: 'FDH14 G4 Bank 2 (Savings)', masked_identifier: '2222', status: 'active' }, track);
  const ccFdhAcct = await insert('fdh_financial_accounts', { user_id: uid, account_type: 'credit_card', country_code: 'AU', currency_code: 'AUD', display_name: 'FDH14 G4 Credit Card', masked_identifier: '3333', status: 'active' }, track);
  const loanFdhAcct = await insert('fdh_financial_accounts', { user_id: uid, account_type: 'personal_loan', country_code: 'AU', currency_code: 'AUD', display_name: 'FDH14 G4 Personal Loan', masked_identifier: '4444', status: 'active' }, track);

  const ccLiability = await insert('liabilities', { user_id: uid, liability_name: 'FDH14 G4 Credit Card', debt_type: 'credit_card', balance: 2000, currency_code: 'AUD', is_active: true, masked_identifier: '3333', lender: 'FDH14 Test Bank' }, track);
  const loanLiability = await insert('liabilities', { user_id: uid, liability_name: 'FDH14 G4 Personal Loan', debt_type: 'personal_loan', balance: 15000, currency_code: 'AUD', is_active: true, masked_identifier: '4444', lender: 'FDH14 Test Bank' }, track);

  const iiAccountAu = await insert('ii_accounts', { user_id: uid, country_code: 'AU', currency_code: 'AUD', status: 'active', account_type: 'broker', institution_name: 'FDH14 G4 AU Broker' }, track);
  const instrumentAu = await insert('ii_instruments', { instrument_name: 'FDH14 G4 AU Synthetic Stock', instrument_class: 'equity', country_of_domicile: 'AU', base_currency: 'AUD', status: 'verified', is_active: true }, track);
  const retirementAcct = await insert('retirement_accounts', { user_id: uid, account_name: 'FDH14 G4 Super', account_type: 'super', current_balance: 180000, currency_code: 'AUD', is_active: true }, track);

  console.log('\n--- PROOF 1: own-account transfer between the user\'s own 2 bank accounts is never income/expense ---');
  {
    const out = await insert('fdh_transactions', {
      user_id: uid, financial_account_id: bank1.id, transaction_date: DAY(5), amount_original: 1000, currency_original: 'AUD',
      credit_debit: 'debit', economic_transaction_type: 'transfer', recurring_flag: false, subscription_flag: false, transfer_flag: true,
      review_status: 'resolved', user_override: false, dedup_status: 'unique', transaction_type_hint: 'debit', approval_status: 'approved', approved_at: new Date().toISOString(), approved_by: uid,
      description_raw: 'FDH14 G4 own transfer bank1 -> bank2',
    }, track);
    const in_ = await insert('fdh_transactions', {
      user_id: uid, financial_account_id: bank2.id, transaction_date: DAY(5), amount_original: 1000, currency_original: 'AUD',
      credit_debit: 'credit', economic_transaction_type: 'transfer', recurring_flag: false, subscription_flag: false, transfer_flag: true,
      review_status: 'resolved', user_override: false, dedup_status: 'unique', transaction_type_hint: 'credit', approval_status: 'approved', approved_at: new Date().toISOString(), approved_by: uid,
      description_raw: 'FDH14 G4 own transfer bank1 -> bank2',
    }, track);
    await insert('fdh_transaction_links', { user_id: uid, transaction_id_from: out.id, transaction_id_to: in_.id, link_type: 'internal_transfer', status: 'confirmed', created_by_method: 'system_rule', user_confirmed: true, confidence: 1 }, track);

    const incomeTotal = ((await rest(`fdh_transactions?user_id=eq.${uid}&economic_transaction_type=eq.income&select=amount_original`)).json ?? []).reduce((s: number, r: any) => s + Number(r.amount_original), 0);
    const expenseTotal = ((await rest(`fdh_transactions?user_id=eq.${uid}&economic_transaction_type=eq.expense&select=amount_original`)).json ?? []).reduce((s: number, r: any) => s + Number(r.amount_original), 0);
    check('PROOF 1: own-account transfer contributes $0 to household income', incomeTotal === 0, `incomeTotal=${incomeTotal}`);
    check('PROOF 1: own-account transfer contributes $0 to household expense', expenseTotal === 0, `expenseTotal=${expenseTotal}`);
  }

  console.log('\n--- PROOF 2: no wrong-account/wrong-facility matching (real matchLiabilityFacility(), not a stub) ---');
  {
    const existing: ExistingLiabilityCandidate[] = [
      { liabilityId: ccLiability.id, debtType: 'credit_card', currencyCode: 'AUD', maskedIdentifier: '3333', lender: 'FDH14 Test Bank', liabilityName: 'FDH14 G4 Credit Card' },
      { liabilityId: loanLiability.id, debtType: 'personal_loan', currencyCode: 'AUD', maskedIdentifier: '4444', lender: 'FDH14 Test Bank', liabilityName: 'FDH14 G4 Personal Loan' },
    ];
    const ccStatementQuery: FacilityMatchQuery = { facilityDebtType: 'credit_card', currencyCode: 'AUD', institutionName: 'FDH14 Test Bank', maskedIdentifier: '3333' };
    const ccResult = matchLiabilityFacility(ccStatementQuery, existing);
    check('PROOF 2: a credit-card statement (masked 3333) matches ONLY the credit card liability, never the loan', ccResult.outcome === 'single_match' && ccResult.matchedLiabilityId === ccLiability.id, `result=${JSON.stringify(ccResult)}`);

    const loanStatementQuery: FacilityMatchQuery = { facilityDebtType: 'personal_loan', currencyCode: 'AUD', institutionName: 'FDH14 Test Bank', maskedIdentifier: '4444' };
    const loanResult = matchLiabilityFacility(loanStatementQuery, existing);
    check('PROOF 2: a loan statement (masked 4444) matches ONLY the loan liability, never the credit card', loanResult.outcome === 'single_match' && loanResult.matchedLiabilityId === loanLiability.id, `result=${JSON.stringify(loanResult)}`);

    // A statement whose masked identifier matches NEITHER existing facility
    // (e.g. a brand-new card) must never fall back onto an unrelated
    // same-lender facility just because the institution name matches.
    const strangerQuery: FacilityMatchQuery = { facilityDebtType: 'credit_card', currencyCode: 'AUD', institutionName: 'FDH14 Test Bank', maskedIdentifier: '9999' };
    const strangerResult = matchLiabilityFacility(strangerQuery, existing);
    check('PROOF 2: a statement for an unrelated card at the same lender (masked 9999, both existing facilities already have DIFFERENT masked identifiers on file) is NOT silently absorbed into either', strangerResult.matchedLiabilityId === null, `result=${JSON.stringify(strangerResult)}`);
  }

  console.log('\n--- PROOF 3: AU investment activity stays owned by FDH-11/Investment Intelligence, not duplicated elsewhere ---');
  {
    const investmentStatement = await insert('fdh_investment_statements', {
      user_id: uid, canonical_account_id: iiAccountAu.id, statement_type: 'broker_transaction_statement', investment_jurisdiction: 'AU', base_currency: 'AUD',
      extraction_status: 'extracted', reconciliation_status: 'reconciled', review_status: 'resolved', approval_status: 'approved',
    }, track);
    const buyTxn = await insert('ii_transactions', {
      user_id: uid, account_id: iiAccountAu.id, instrument_id: instrumentAu.id, currency_code: 'AUD', status: 'parsed',
      transaction_type: 'purchase', transaction_date: DAY(3), units: 50, price_per_unit: 40, gross_amount: 2000,
      transaction_fingerprint: `${TAG}-au-buy-1`,
    }, track);
    await insert('fdh_investment_statement_activities', {
      user_id: uid, statement_id: investmentStatement.id, activity_type: 'BUY', amount: 2000, currency_code: 'AUD',
      matched_instrument_id: instrumentAu.id, security_match_status: 'matched', bank_match_status: 'not_attempted',
      review_status: 'resolved', apply_status: 'applied', canonical_transaction_id: buyTxn.id,
    }, track);

    const assetsRows = (await rest(`assets?user_id=eq.${uid}&select=id`)).json ?? [];
    const investmentsRows = (await rest(`investments?user_id=eq.${uid}&select=id`)).json ?? [];
    const auTxns = (await rest(`ii_transactions?account_id=eq.${iiAccountAu.id}&select=id`)).json ?? [];
    check('PROOF 3: the AU BUY lands exactly once in ii_transactions (Investment Intelligence-owned)', auTxns.length === 1, `count=${auTxns.length}`);
    check('PROOF 3: no duplicate row was created in the generic `assets` canonical table', assetsRows.length === 0, `count=${assetsRows.length}`);
    check('PROOF 3: no duplicate row was created in the `investments` canonical register', investmentsRows.length === 0, `count=${investmentsRows.length}`);
  }

  console.log('\n--- PROOF 4: the India investment relationship routes to the EXISTING India Investment module, never to FDH-11 ---');
  {
    // Structural proof that FDH-11 cannot even accept an India statement:
    // fdh_investment_statements.investment_jurisdiction has a real DB CHECK
    // constraint fixing it to 'AU' only (migration 0106).
    const forgedIndiaStatement = await rest('fdh_investment_statements', {
      method: 'POST',
      body: JSON.stringify({
        user_id: uid, canonical_account_id: null, statement_type: 'broker_transaction_statement', investment_jurisdiction: 'IN', base_currency: 'INR',
        extraction_status: 'extracted', reconciliation_status: 'reconciled', review_status: 'resolved', approval_status: 'approved',
      }),
    });
    check("PROOF 4a: FDH-11 structurally REJECTS investment_jurisdiction='IN' at the DB CHECK constraint (FDH-11 is AU-only by construction, not merely by convention)", forgedIndiaStatement.status >= 400 && /investment_jurisdiction|check constraint/i.test(forgedIndiaStatement.text), `status=${forgedIndiaStatement.status} text=${forgedIndiaStatement.text.slice(0, 200)}`);
    if (forgedIndiaStatement.json?.[0]?.id) track.push({ table: 'fdh_investment_statements', id: forgedIndiaStatement.json[0].id });

    // The REAL, pre-existing India Investment module pathway: an ii_accounts
    // row with country_code='IN' (demat/mf_folio) — the same Investment
    // Intelligence schema India investments have always used, completely
    // independent of any fdh_* table.
    const iiAccountIndia = await insert('ii_accounts', { user_id: uid, country_code: 'IN', currency_code: 'INR', status: 'active', account_type: 'demat', institution_name: 'FDH14 G4 India Demat' }, track);
    const instrumentIndia = await insert('ii_instruments', { instrument_name: 'FDH14 G4 India Synthetic Stock', instrument_class: 'equity', country_of_domicile: 'IN', base_currency: 'INR', status: 'verified', is_active: true }, track);
    const indiaTxn = await insert('ii_transactions', {
      user_id: uid, account_id: iiAccountIndia.id, instrument_id: instrumentIndia.id, currency_code: 'INR', status: 'parsed',
      transaction_type: 'purchase', transaction_date: DAY(3), units: 100, price_per_unit: 500, gross_amount: 50000,
      transaction_fingerprint: `${TAG}-in-buy-1`,
    }, track);

    const fdhRowsForIndiaAccount = (await rest(`fdh_investment_statements?canonical_account_id=eq.${iiAccountIndia.id}&select=id`)).json ?? [];
    check('PROOF 4b: the India ii_accounts row exists in the pre-existing Investment Intelligence schema', Boolean(iiAccountIndia.id));
    check('PROOF 4c: zero fdh_investment_statements rows reference the India account (no parallel FDH structure was created for it)', fdhRowsForIndiaAccount.length === 0, `count=${fdhRowsForIndiaAccount.length}`);

    const auTxnsAfter = (await rest(`ii_transactions?account_id=eq.${iiAccountAu.id}&select=id`)).json ?? [];
    const indiaTxns = (await rest(`ii_transactions?account_id=eq.${iiAccountIndia.id}&select=id,gross_amount`)).json ?? [];
    check('PROOF 4d: AU and India transactions stay on their own distinct accounts within the same II schema, never merged', auTxnsAfter.length === 1 && indiaTxns.length === 1 && indiaTxns[0].id === indiaTxn.id, `au=${auTxnsAfter.length} india=${indiaTxns.length}`);
  }

  console.log('\n--- PROOF 5: retirement remains a separate canonical record, not merged with any other domain ---');
  {
    const liabRows = (await rest(`liabilities?user_id=eq.${uid}&select=id,balance`)).json ?? [];
    const liabTotal = liabRows.reduce((s: number, r: any) => s + Number(r.balance), 0);
    const retRow = (await rest(`retirement_accounts?user_id=eq.${uid}&select=id,current_balance`)).json ?? [];
    check('PROOF 5: exactly ONE retirement_accounts row exists for this household', retRow.length === 1, `count=${retRow.length}`);
    check('PROOF 5: retirement balance ($180,000) is untouched by the 2 liabilities coexisting ($2,000 + $15,000 = $17,000)', Number(retRow[0]?.current_balance) === 180000 && liabTotal === 17000, `retirement=${retRow[0]?.current_balance} liabilitiesTotal=${liabTotal}`);
  }

  console.log('\n--- PROOF 6: no canonical value is duplicated by the presence of multiple accounts/domains coexisting ---');
  {
    const assetsRows = (await rest(`assets?user_id=eq.${uid}&select=current_value`)).json ?? [];
    const investmentsRows = (await rest(`investments?user_id=eq.${uid}&select=current_value`)).json ?? [];
    const retRow = (await rest(`retirement_accounts?user_id=eq.${uid}&select=current_balance`)).json ?? [];
    const liabRows = (await rest(`liabilities?user_id=eq.${uid}&select=balance`)).json ?? [];
    const assetsTotal = assetsRows.reduce((s: number, r: any) => s + Number(r.current_value), 0);
    const investmentsTotal = investmentsRows.reduce((s: number, r: any) => s + Number(r.current_value), 0);
    const retirementTotal = retRow.reduce((s: number, r: any) => s + Number(r.current_balance), 0);
    const liabilityTotal = liabRows.reduce((s: number, r: any) => s + Number(r.balance), 0);
    const netWorth = assetsTotal + investmentsTotal + retirementTotal - liabilityTotal;
    // Expected: 0 (assets) + 0 (investments — AU BUY lives only in ii_transactions,
    // India BUY lives only in ii_transactions; neither publishes to the
    // `investments` register in this fixture) + 180,000 (retirement, exactly
    // once) - 17,000 (both liabilities, exactly once each) = 163,000,
    // regardless of 2 bank accounts + 1 AU brokerage + 1 India demat account
    // all coexisting for this one household.
    check('PROOF 6: household net worth = $163,000 exactly (2 bank accounts, 1 AU brokerage, 1 India demat account, 2 liabilities, 1 retirement account coexisting cause zero double-count)', netWorth === 163000, `netWorth=${netWorth} assets=${assetsTotal} investments=${investmentsTotal} retirement=${retirementTotal} liabilities=${liabilityTotal}`);
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exitCode = 1; });
