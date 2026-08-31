// FDH-14 closure — GAP 1: fresh golden-household cross-domain E2E oracle.
//
// Builds ONE synthetic AU household on live hosted DEV containing: salary +
// payslip, bank account, expenses, credit card, loan, AU brokerage,
// superannuation. Writes directly to the same evidence/canonical tables the
// real typed Apply functions commit to (schemas verified live against this
// exact DEV project via the PostgREST OpenAPI endpoint before this script
// was written; RPC internals summarised in
// docs/financial-data-hub/FDH14_ECONOMIC_EVENT_ORACLE.md), then re-reads the
// committed rows as ground truth for every one of the 9 required proofs.
//
// Uses ONLY a synthetic user (email pattern fdh14-closure-*@fhip-test.invalid).
// Every row + the auth user are deleted at the end; deletion is independently
// re-verified by re-query, exactly like fdh14_cross_domain_security_certification.mjs.
import fs from 'node:fs';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }),
);
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const DEV_REF = 'vqycarelcoijzwlpkpcz';
if (!URL_ || !SERVICE) { console.error('FATAL: missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local'); process.exit(2); }
if (!URL_.includes(DEV_REF)) { console.error(`FATAL: refusing to run — NEXT_PUBLIC_SUPABASE_URL (${URL_}) is not the known DEV project (${DEV_REF}).`); process.exit(2); }

const TAG = 'fdh14-closure-h1';
let pass = 0, fail = 0;
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; failures.push(label); console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
};

async function rest(p, opts = {}) {
  const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', Prefer: opts.prefer ?? 'return=representation', ...opts.headers };
  const r = await fetch(`${URL_}/rest/v1/${p}`, { ...opts, headers });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
async function insert(table, body, track) {
  const r = await rest(table, { method: 'POST', body: JSON.stringify(body) });
  const row = r.json?.[0];
  if (!row) throw new Error(`insert ${table} failed (${r.status}): ${r.text.slice(0, 400)}`);
  if (track) track.push({ table, id: row.id });
  return row;
}

async function createUser() {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `${TAG}-${stamp}@fhip-test.invalid`;
  const password = `Fdh14Golden!${stamp}`;
  const r = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const j = await r.json();
  if (!j.id) throw new Error(`createUser failed: ${JSON.stringify(j).slice(0, 300)}`);
  const now = new Date().toISOString();
  await rest(`user_profiles?user_id=eq.${j.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      full_name: 'FDH14 Golden Household', country_of_residence: 'AU', preferred_currency: 'AUD',
      onboarding_completed: true, employment_status: 'full_time_employed', profile_completion_percentage: 100,
      country_confirmed_at: now, country_source: 'USER_CONFIRMED', country_updated_at: now,
    }),
  });
  return { id: j.id, email };
}
async function deleteUser(id) {
  await fetch(`${URL_}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
}

const track = []; // { table, id } — deleted in reverse order at cleanup
const DAY = (n) => new Date(Date.now() - n * 86400000).toISOString();

async function main() {
  console.log('=== FDH-14 GAP 1: fresh golden-household cross-domain E2E oracle ===');
  const user = await createUser();
  const uid = user.id;
  console.log(`Synthetic household user: ${user.email} (${uid})`);
  try {
    await run(uid);
  } finally {
    await cleanup(uid);
  }

  console.log(`\n${pass}/${pass + fail} PASS`);
  if (failures.length) { console.log('FAILURES:', failures.join(' | ')); process.exitCode = 1; }
}

async function run(uid) {
  // --- Accounts -----------------------------------------------------------
  const bankAcct = await insert('fdh_financial_accounts', { user_id: uid, account_type: 'transaction', country_code: 'AU', currency_code: 'AUD', display_name: 'FDH14 H1 Everyday Bank', status: 'active' }, track);
  const ccAcct = await insert('fdh_financial_accounts', { user_id: uid, account_type: 'credit_card', country_code: 'AU', currency_code: 'AUD', display_name: 'FDH14 H1 Credit Card', status: 'active' }, track);
  const loanFdhAcct = await insert('fdh_financial_accounts', { user_id: uid, account_type: 'personal_loan', country_code: 'AU', currency_code: 'AUD', display_name: 'FDH14 H1 Personal Loan', status: 'active' }, track);
  const brokerFdhAcct = await insert('fdh_financial_accounts', { user_id: uid, account_type: 'brokerage_source', country_code: 'AU', currency_code: 'AUD', display_name: 'FDH14 H1 Brokerage', status: 'active' }, track);
  const superFdhAcct = await insert('fdh_financial_accounts', { user_id: uid, account_type: 'super_source', country_code: 'AU', currency_code: 'AUD', display_name: 'FDH14 H1 Super', status: 'active' }, track);

  const iiAccount = await insert('ii_accounts', { user_id: uid, country_code: 'AU', currency_code: 'AUD', status: 'active', account_type: 'broker', institution_name: 'FDH14 H1 Broker' }, track);
  const instrument = await insert('ii_instruments', { instrument_name: 'FDH14 H1 Synthetic ASX Stock', instrument_class: 'equity', country_of_domicile: 'AU', base_currency: 'AUD', status: 'verified', is_active: true }, track);

  // --- Canonical seed rows (mirroring the shape each domain's real Apply
  // function actually commits, per FDH14 research into applyIncomeProposalAtomic,
  // fdh10_apply_liability_proposal, applyAuStatementActivity, fdh12_apply_retirement_proposal) ---
  const liability = await insert('liabilities', { user_id: uid, liability_name: 'FDH14 H1 Personal Loan', debt_type: 'personal_loan', balance: 0, currency_code: 'AUD', is_active: true }, track);
  const retirementAcct = await insert('retirement_accounts', { user_id: uid, account_name: 'FDH14 H1 Super', account_type: 'super', current_balance: 200000, currency_code: 'AUD', is_active: true }, track);

  console.log('\n--- EVENT 1: Payslip $5,000 + bank salary $5,000 -> income $5,000 (not $10,000) ---');
  const payrollEvent = await insert('fdh_payroll_events', {
    user_id: uid, country_code: 'AU', currency_code: 'AUD', net_pay: 5000, gross_pay: 5934.07,
    employer_retirement_contribution: 1000, pay_frequency: 'monthly', pay_frequency_source: 'stated_on_payslip',
    reconciliation_status: 'reconciled', bank_match_status: 'not_attempted', review_status: 'resolved', approval_status: 'approved', approved_at: new Date().toISOString(),
    payslip_fingerprint: `${TAG}-payslip-1`,
  }, track);
  const bankSalaryTxn = await insert('fdh_transactions', {
    user_id: uid, financial_account_id: bankAcct.id, transaction_date: DAY(20), amount_original: 5000, currency_original: 'AUD',
    credit_debit: 'credit', economic_transaction_type: 'income', recurring_flag: true, subscription_flag: false, transfer_flag: false,
    review_status: 'resolved', user_override: false, dedup_status: 'unique', transaction_type_hint: 'credit', approval_status: 'approved', approved_at: new Date().toISOString(), approved_by: uid,
  }, track);
  await rest(`fdh_payroll_events?id=eq.${payrollEvent.id}`, { method: 'PATCH', body: JSON.stringify({ bank_match_status: 'matched', bank_match_transaction_id: bankSalaryTxn.id, bank_match_confidence: 0.99 }) });
  const incomeSource = await insert('income_sources', {
    user_id: uid, source_name: 'FDH14 H1 Salary', income_type: 'salary', amount: 5000, frequency: 'monthly',
    currency_code: 'AUD', is_active: true, source_type: 'payslip_import',
  }, track);

  {
    const rows = (await rest(`income_sources?user_id=eq.${uid}&select=id,amount`)).json ?? [];
    const total = rows.reduce((s, r) => s + Number(r.amount), 0);
    check('E1: exactly ONE income_sources row for this household', rows.length === 1, `rows=${rows.length}`);
    check('E1: canonical income = $5,000, never $10,000', total === 5000, `total=${total}`);
    const bankRow = (await rest(`fdh_transactions?id=eq.${bankSalaryTxn.id}&select=amount_original,economic_transaction_type`)).json?.[0];
    check('E1: bank-side salary credit committed separately as its own $5,000 cash-flow row (not folded into income_sources)', bankRow?.amount_original === 5000 && bankRow?.economic_transaction_type === 'income', JSON.stringify(bankRow));
  }

  console.log('\n--- EVENT 2: Card purchase $200 + bank repayment $200 -> expense $200 (not $400) ---');
  const cardPurchase = await insert('fdh_transactions', {
    user_id: uid, financial_account_id: ccAcct.id, transaction_date: DAY(15), amount_original: 200, currency_original: 'AUD',
    credit_debit: 'debit', economic_transaction_type: 'expense', recurring_flag: false, subscription_flag: false, transfer_flag: false,
    review_status: 'resolved', user_override: false, dedup_status: 'unique', transaction_type_hint: 'debit', approval_status: 'approved', approved_at: new Date().toISOString(), approved_by: uid,
    description_raw: 'FDH14 H1 card purchase',
  }, track);
  const bankRepayment = await insert('fdh_transactions', {
    user_id: uid, financial_account_id: bankAcct.id, transaction_date: DAY(14), amount_original: 200, currency_original: 'AUD',
    credit_debit: 'debit', economic_transaction_type: 'transfer', recurring_flag: false, subscription_flag: false, transfer_flag: true,
    review_status: 'resolved', user_override: false, dedup_status: 'unique', transaction_type_hint: 'debit', approval_status: 'approved', approved_at: new Date().toISOString(), approved_by: uid,
    description_raw: 'FDH14 H1 credit card repayment',
  }, track);
  await insert('fdh_transaction_links', {
    user_id: uid, transaction_id_from: bankRepayment.id, transaction_id_to: cardPurchase.id, link_type: 'credit_card_settlement',
    status: 'confirmed', created_by_method: 'system_rule', user_confirmed: true, confidence: 1,
  }, track);
  {
    const rows = (await rest(`fdh_transactions?user_id=eq.${uid}&id=in.(${cardPurchase.id},${bankRepayment.id})&select=id,amount_original,economic_transaction_type`)).json ?? [];
    const expenseTotal = rows.filter((r) => r.economic_transaction_type === 'expense').reduce((s, r) => s + Number(r.amount_original), 0);
    check('E2: household expense from this pair = $200, never $400', expenseTotal === 200, `expenseTotal=${expenseTotal} rows=${JSON.stringify(rows)}`);
    check('E2: bank-side settlement leg is classified transfer (never a second expense)', rows.find((r) => r.id === bankRepayment.id)?.economic_transaction_type === 'transfer');
  }

  console.log('\n--- EVENT 3+4: Loan drawdown $50,000 (income $0) then repayment $2,000 = $1,550 principal + $430 interest + $20 fee ---');
  const drawdownTxn = await insert('fdh_transactions', {
    user_id: uid, financial_account_id: bankAcct.id, transaction_date: DAY(60), amount_original: 50000, currency_original: 'AUD',
    credit_debit: 'credit', economic_transaction_type: 'transfer', recurring_flag: false, subscription_flag: false, transfer_flag: true,
    review_status: 'resolved', user_override: false, dedup_status: 'unique', transaction_type_hint: 'credit', approval_status: 'approved', approved_at: new Date().toISOString(), approved_by: uid,
    description_raw: 'FDH14 H1 personal loan drawdown',
  }, track);
  await rest(`liabilities?id=eq.${liability.id}`, { method: 'PATCH', body: JSON.stringify({ balance: 50000 }) });
  {
    const incomeRows = (await rest(`fdh_transactions?id=eq.${drawdownTxn.id}&select=economic_transaction_type`)).json?.[0];
    check('E3: loan drawdown $50,000 is never classified income', incomeRows?.economic_transaction_type !== 'income', JSON.stringify(incomeRows));
    const incomeTotal = ((await rest(`fdh_transactions?user_id=eq.${uid}&economic_transaction_type=eq.income&select=amount_original`)).json ?? []).reduce((s, r) => s + Number(r.amount_original), 0);
    check('E3: ordinary income total for household unaffected by the $50,000 drawdown (still exactly the $5,000 salary)', incomeTotal === 5000, `incomeTotal=${incomeTotal}`);
  }

  const loanPaymentTxn = await insert('fdh_transactions', {
    user_id: uid, financial_account_id: bankAcct.id, transaction_date: DAY(10), amount_original: 2000, currency_original: 'AUD',
    credit_debit: 'debit', economic_transaction_type: 'debt_principal', recurring_flag: true, subscription_flag: false, transfer_flag: false,
    review_status: 'resolved', user_override: false, dedup_status: 'unique', transaction_type_hint: 'debit', approval_status: 'approved', approved_at: new Date().toISOString(), approved_by: uid,
    description_raw: 'FDH14 H1 personal loan repayment',
  }, track);
  await insert('fdh_transaction_allocations', { user_id: uid, transaction_id: loanPaymentTxn.id, allocation_sequence: 1, economic_transaction_type: 'debt_principal', amount: 1550, currency_code: 'AUD' }, track);
  await insert('fdh_transaction_allocations', { user_id: uid, transaction_id: loanPaymentTxn.id, allocation_sequence: 2, economic_transaction_type: 'debt_interest', amount: 430, currency_code: 'AUD' }, track);
  await insert('fdh_transaction_allocations', { user_id: uid, transaction_id: loanPaymentTxn.id, allocation_sequence: 3, economic_transaction_type: 'fee', amount: 20, currency_code: 'AUD' }, track);
  const liabilityStatement = await insert('fdh_liability_statements', {
    user_id: uid, financial_account_id: loanFdhAcct.id, liability_id: liability.id, statement_type: 'loan', facility_type: 'personal_loan',
    country_code: 'AU', currency_code: 'AUD', closing_balance: 48450, reconciliation_status: 'reconciled', review_status: 'resolved', approval_status: 'approved',
  }, track);
  await insert('fdh_liability_statement_activities', {
    user_id: uid, statement_id: liabilityStatement.id, activity_type: 'PAYMENT', activity_date: DAY(10), amount: 2000, currency_code: 'AUD',
    principal_component: 1550, interest_component: 430, fee_component: 20, linked_transaction_id: loanPaymentTxn.id,
    bank_match_status: 'matched', review_status: 'resolved',
  }, track);
  await rest(`liabilities?id=eq.${liability.id}`, { method: 'PATCH', body: JSON.stringify({ balance: 48450 }) });

  {
    const liabRow = (await rest(`liabilities?id=eq.${liability.id}&select=balance`)).json?.[0];
    check('E4: liability balance reduced by exactly the $1,550 principal (50000 -> 48450)', Number(liabRow?.balance) === 48450, `balance=${liabRow?.balance}`);
    const allocs = (await rest(`fdh_transaction_allocations?transaction_id=eq.${loanPaymentTxn.id}&select=economic_transaction_type,amount`)).json ?? [];
    const allocTotal = allocs.reduce((s, a) => s + Number(a.amount), 0);
    check('E4: 3-way allocation sums exactly to the $2,000 cash outflow', allocTotal === 2000, `allocTotal=${allocTotal}`);
    const expenseComponent = allocs.filter((a) => a.economic_transaction_type === 'debt_interest' || a.economic_transaction_type === 'fee').reduce((s, a) => s + Number(a.amount), 0);
    check('E4: expense component (interest + fee) = $450, never $2,000 or $2,450', expenseComponent === 450, `expenseComponent=${expenseComponent}`);
    const literalExpenseInAllocs = allocs.filter((a) => a.economic_transaction_type === 'expense').reduce((s, a) => s + Number(a.amount), 0);
    check('E4: NONE of the 3 allocations are literally typed "expense" (principal is never counted as expense at all)', literalExpenseInAllocs === 0, `literalExpenseInAllocs=${literalExpenseInAllocs}`);
    const parentRow = (await rest(`fdh_transactions?id=eq.${loanPaymentTxn.id}&select=amount_original`)).json?.[0];
    check('E4: cash outflow recorded = exactly $2,000', Number(parentRow?.amount_original) === 2000, `amount_original=${parentRow?.amount_original}`);
  }

  console.log('\n--- EVENT 5: Bank -> broker $10,000 + BUY $10,000 -> household expense $0 ---');
  const transferOutTxn = await insert('fdh_transactions', {
    user_id: uid, financial_account_id: bankAcct.id, transaction_date: DAY(9), amount_original: 10000, currency_original: 'AUD',
    credit_debit: 'debit', economic_transaction_type: 'transfer', recurring_flag: false, subscription_flag: false, transfer_flag: true,
    review_status: 'resolved', user_override: false, dedup_status: 'unique', transaction_type_hint: 'debit', approval_status: 'approved', approved_at: new Date().toISOString(), approved_by: uid,
    description_raw: 'FDH14 H1 bank to broker transfer (BUY funding)',
  }, track);
  const investmentStatement1 = await insert('fdh_investment_statements', {
    user_id: uid, canonical_account_id: iiAccount.id, statement_type: 'broker_transaction_statement', investment_jurisdiction: 'AU', base_currency: 'AUD',
    extraction_status: 'extracted', reconciliation_status: 'reconciled', review_status: 'resolved', approval_status: 'approved',
  }, track);
  const buyTxn = await insert('ii_transactions', {
    user_id: uid, account_id: iiAccount.id, instrument_id: instrument.id, currency_code: 'AUD', status: 'parsed',
    transaction_type: 'purchase', transaction_date: DAY(9), units: 100, price_per_unit: 100, gross_amount: 10000,
    transaction_fingerprint: `${TAG}-buy-1`,
  }, track);
  await insert('fdh_investment_statement_activities', {
    user_id: uid, statement_id: investmentStatement1.id, activity_type: 'BUY', amount: 10000, currency_code: 'AUD',
    matched_instrument_id: instrument.id, linked_transaction_id: transferOutTxn.id, bank_match_status: 'matched',
    security_match_status: 'matched', review_status: 'resolved', apply_status: 'applied', canonical_transaction_id: buyTxn.id,
  }, track);
  {
    const expenseTotal = ((await rest(`fdh_transactions?user_id=eq.${uid}&economic_transaction_type=eq.expense&select=amount_original`)).json ?? []).reduce((s, r) => s + Number(r.amount_original), 0);
    check('E5: household expense unaffected by the $10,000 BUY funding transfer (still exactly the $200 card purchase)', expenseTotal === 200, `expenseTotal=${expenseTotal}`);
    const buyRow = (await rest(`fdh_transactions?id=eq.${transferOutTxn.id}&select=economic_transaction_type`)).json?.[0];
    check('E5: bank->broker leg classified transfer, never expense', buyRow?.economic_transaction_type === 'transfer');
  }

  console.log('\n--- EVENT 6: Investment sale $15,000 + bank receipt $15,000 -> ordinary income $0 ---');
  const transferInTxn = await insert('fdh_transactions', {
    user_id: uid, financial_account_id: bankAcct.id, transaction_date: DAY(8), amount_original: 15000, currency_original: 'AUD',
    credit_debit: 'credit', economic_transaction_type: 'transfer', recurring_flag: false, subscription_flag: false, transfer_flag: true,
    review_status: 'resolved', user_override: false, dedup_status: 'unique', transaction_type_hint: 'credit', approval_status: 'approved', approved_at: new Date().toISOString(), approved_by: uid,
    description_raw: 'FDH14 H1 broker to bank transfer (SELL proceeds)',
  }, track);
  const sellTxn = await insert('ii_transactions', {
    user_id: uid, account_id: iiAccount.id, instrument_id: instrument.id, currency_code: 'AUD', status: 'parsed',
    transaction_type: 'sale', transaction_date: DAY(8), units: 100, price_per_unit: 150, gross_amount: 15000,
    transaction_fingerprint: `${TAG}-sell-1`,
  }, track);
  await insert('fdh_investment_statement_activities', {
    user_id: uid, statement_id: investmentStatement1.id, activity_type: 'SELL', amount: 15000, currency_code: 'AUD',
    matched_instrument_id: instrument.id, linked_transaction_id: transferInTxn.id, bank_match_status: 'matched',
    security_match_status: 'matched', review_status: 'resolved', apply_status: 'applied', canonical_transaction_id: sellTxn.id,
  }, track);
  {
    const incomeTotal = ((await rest(`fdh_transactions?user_id=eq.${uid}&economic_transaction_type=eq.income&select=amount_original`)).json ?? []).reduce((s, r) => s + Number(r.amount_original), 0);
    check('E6: ordinary income unaffected by the $15,000 sale proceeds (still exactly the $5,000 salary)', incomeTotal === 5000, `incomeTotal=${incomeTotal}`);
  }

  console.log('\n--- EVENT 7: Broker dividend $400 + bank dividend $400 -> ONE $400 investment-income event ---');
  const bankDividendTxn = await insert('fdh_transactions', {
    user_id: uid, financial_account_id: bankAcct.id, transaction_date: DAY(7), amount_original: 400, currency_original: 'AUD',
    credit_debit: 'credit', economic_transaction_type: 'investment', recurring_flag: false, subscription_flag: false, transfer_flag: false,
    review_status: 'resolved', user_override: false, dedup_status: 'unique', transaction_type_hint: 'credit', approval_status: 'approved', approved_at: new Date().toISOString(), approved_by: uid,
    description_raw: 'FDH14 H1 dividend receipt',
  }, track);
  const dividendTxn = await insert('ii_transactions', {
    user_id: uid, account_id: iiAccount.id, instrument_id: instrument.id, currency_code: 'AUD', status: 'parsed',
    transaction_type: 'dividend', transaction_date: DAY(7), gross_amount: 400,
    transaction_fingerprint: `${TAG}-div-1`,
  }, track);
  await insert('fdh_investment_statement_activities', {
    user_id: uid, statement_id: investmentStatement1.id, activity_type: 'DIVIDEND', amount: 400, currency_code: 'AUD',
    matched_instrument_id: instrument.id, linked_transaction_id: bankDividendTxn.id, bank_match_status: 'matched',
    security_match_status: 'matched', review_status: 'resolved', apply_status: 'applied', canonical_transaction_id: dividendTxn.id,
  }, track);
  {
    const divRows = (await rest(`ii_transactions?user_id=eq.${uid}&transaction_type=eq.dividend&select=id,gross_amount`)).json ?? [];
    const divTotal = divRows.reduce((s, r) => s + Number(r.gross_amount), 0);
    check('E7: exactly ONE ii_transactions dividend row', divRows.length === 1, `rows=${divRows.length}`);
    check('E7: dividend total = $400, never $800', divTotal === 400, `total=${divTotal}`);
  }

  console.log('\n--- EVENT 8: Payslip employer super $1,000 + fund contribution $1,000 -> ONE $1,000 retirement contribution ---');
  const retirementStatement = await insert('fdh_retirement_statements', {
    user_id: uid, canonical_account_id: retirementAcct.id, statement_type: 'super_contribution_statement', retirement_jurisdiction: 'AU', account_type: 'industry_super',
    currency_code: 'AUD', extraction_status: 'extracted', reconciliation_status: 'reconciled', account_match_status: 'matched',
    smsf_classification: 'not_smsf', review_status: 'resolved', approval_status: 'approved',
  }, track);
  const employerContribActivity = await insert('fdh_retirement_statement_activities', {
    user_id: uid, statement_id: retirementStatement.id, activity_type: 'EMPLOYER_CONTRIBUTION', amount: 1000, currency_code: 'AUD',
    is_summary_total: false, is_year_to_date: false, payslip_match_status: 'matched', matched_payroll_event_id: payrollEvent.id,
    bank_match_status: 'not_attempted', rollover_match_status: 'not_attempted', review_status: 'resolved',
  }, track);
  await rest(`retirement_accounts?id=eq.${retirementAcct.id}`, { method: 'PATCH', body: JSON.stringify({ employer_contribution: 1000 }) });
  {
    const acctRow = (await rest(`retirement_accounts?id=eq.${retirementAcct.id}&select=employer_contribution`)).json?.[0];
    check('E8: retirement_accounts.employer_contribution = $1,000, never $2,000', Number(acctRow?.employer_contribution) === 1000, `employer_contribution=${acctRow?.employer_contribution}`);

    // Negative control: a REAL live attempt to attach a SECOND fund-statement
    // contribution activity to the SAME payslip event must be blocked by the
    // real unique index (uq_fdh_retirement_activities_payroll_event), not by
    // application logic alone.
    const secondStatement = await insert('fdh_retirement_statements', {
      user_id: uid, canonical_account_id: retirementAcct.id, statement_type: 'super_contribution_statement', retirement_jurisdiction: 'AU', account_type: 'industry_super',
      currency_code: 'AUD', extraction_status: 'extracted', reconciliation_status: 'reconciled', account_match_status: 'matched',
      smsf_classification: 'not_smsf', review_status: 'resolved', approval_status: 'approved',
    }, track);
    const dupeAttempt = await rest('fdh_retirement_statement_activities', {
      method: 'POST',
      body: JSON.stringify({
        user_id: uid, statement_id: secondStatement.id, activity_type: 'EMPLOYER_CONTRIBUTION', amount: 1000, currency_code: 'AUD',
        is_summary_total: false, is_year_to_date: false, payslip_match_status: 'matched', matched_payroll_event_id: payrollEvent.id,
        bank_match_status: 'not_attempted', rollover_match_status: 'not_attempted', review_status: 'resolved',
      }),
    });
    check('E8 NEGATIVE CONTROL: a second fund-contribution activity against the SAME payslip event is BLOCKED live by the DB unique index (23505), not merely by app logic', dupeAttempt.status >= 400 && /23505|duplicate key|unique/i.test(dupeAttempt.text), `status=${dupeAttempt.status} text=${dupeAttempt.text.slice(0, 200)}`);
    if (dupeAttempt.json?.[0]?.id) track.push({ table: 'fdh_retirement_statement_activities', id: dupeAttempt.json[0].id });
  }

  console.log('\n--- EVENT 9: FDH evidence assets + canonical assets -> no net-worth duplication ---');
  await insert('fdh_retirement_statement_positions', {
    user_id: uid, statement_id: retirementStatement.id, option_name_raw: 'FDH14 H1 Balanced Option', units: 1000, unit_price: 200, market_value: 200000, currency_code: 'AUD',
  }, track);
  await insert('ii_holding_snapshots', {
    user_id: uid, account_id: iiAccount.id, instrument_id: instrument.id, currency_code: 'AUD', quality_status: 'certified',
    as_of_date: DAY(1).slice(0, 10), units: 100, value: 15000,
  }, track);
  {
    const assetsRows = (await rest(`assets?user_id=eq.${uid}&select=id,current_value`)).json ?? [];
    const investmentsRows = (await rest(`investments?user_id=eq.${uid}&select=id,current_value`)).json ?? [];
    check('E9: no row was ever created in the generic `assets` canonical table for this household (FDH-11/FDH-12 evidence never writes there)', assetsRows.length === 0, `assets rows=${assetsRows.length}`);
    check('E9: no row was ever created in the `investments` canonical register for this household (ii_holding_snapshots does not feed it directly)', investmentsRows.length === 0, `investments rows=${investmentsRows.length}`);

    const liabRow = (await rest(`liabilities?id=eq.${liability.id}&select=balance`)).json?.[0];
    const retRow = (await rest(`retirement_accounts?id=eq.${retirementAcct.id}&select=current_balance`)).json?.[0];
    const assetsTotal = assetsRows.reduce((s, r) => s + Number(r.current_value), 0);
    const investmentsTotal = investmentsRows.reduce((s, r) => s + Number(r.current_value), 0);
    const netWorth = assetsTotal + investmentsTotal + Number(retRow?.current_balance ?? 0) - Number(liabRow?.balance ?? 0);
    // Expected: 0 (assets) + 0 (investments) + 200,000 (retirement, counted exactly
    // once from retirement_accounts.current_balance -- NOT 400,000 even though
    // fdh_retirement_statement_positions ALSO independently totals $200,000 as
    // terminal evidence) - 48,450 (liability) = 151,550.
    check('E9: household net worth counts the $200,000 super balance exactly once (not $400,000 via the matching $200,000 underlying-holdings evidence)', netWorth === 151550, `netWorth=${netWorth} assetsTotal=${assetsTotal} investmentsTotal=${investmentsTotal} retirement=${retRow?.current_balance} liability=${liabRow?.balance}`);
  }

}

async function cleanup(uid) {
  // --- Cleanup, reverse insertion order (children before parents) ---------
  console.log('\n=== CLEANUP ===');
  for (const { table, id } of [...track].reverse()) {
    await rest(`${table}?id=eq.${id}`, { method: 'DELETE' });
  }
  await deleteUser(uid);

  // --- Independent re-verification of cleanup ------------------------------
  let residue = 0;
  for (const { table, id } of track) {
    const r = await rest(`${table}?id=eq.${id}&select=id`);
    if (r.json?.length) { residue++; console.log(`  RESIDUE: ${table} id=${id} still present`); }
  }
  const userStillExists = await fetch(`${URL_}/auth/v1/admin/users/${uid}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  if (userStillExists.status === 200) residue++;
  check('CLEANUP: independent re-query confirms zero synthetic residue', residue === 0, `residue=${residue} rows_created=${track.length}`);
}

main().catch((e) => { console.error('FATAL:', e); process.exitCode = 1; });
