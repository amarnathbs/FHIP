/* eslint-disable @typescript-eslint/no-explicit-any -- certification harness: untyped JSON route responses */
/**
 * SECURITY/INTEGRITY REVIEW (range D) -- two live DEV probes on one approved bank statement.
 *
 *  R9  (residual of the economic-oracle fix D1): the user files the broker SALE PROCEEDS credit
 *      (15,000) as "Income" while reviewing the bank statement (every categorisation sets
 *      user_override). The broker statement is then approved and applied with its SELL matched to
 *      that credit. Oracle: SELL 15,000 -> ordinary income 0. Measured: the change in counted
 *      actual income.
 *  CUR (WP-15 bank balance -> cash asset): fdh15_apply_asset_proposal re-derives the BALANCE from the
 *      approved statement, but not its CURRENCY. A hand-made proposal carrying the right number with
 *      currency_code 'INR' on an AUD account is applied as the user, straight through the RPC.
 *
 *   CERT_PORT=3974 npx tsx scripts/canonical_cert/secrev/scenario_sell_override.ts --email E [--salt D]
 */
import { call, measure, delta, expect, results, saveEvidence } from './lib';
import { importAndApproveBank, rowsFor, userIdOf } from './flows';
import { brokerTransactionStatement } from '../documents/builders';
import { loadDevEnv } from '../lib/env.mjs';
import { loadSession } from '../lib/session.mjs';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = arg('--email')!;
const salt = arg('--salt') ?? 'D';
const only = arg('--only');
const evidence: Record<string, unknown> = { email };
const log = (label: string, r: { status: number; json: any }) => { console.log(`  ${label} -> HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`); return r; };

/** PostgREST as the signed-in user (the RPC path the app itself uses). */
async function asUser(method: string, path: string, body?: unknown) {
  const { url, anonKey } = loadDevEnv();
  const s = loadSession(email);
  const chunk = (n: string) => { const m = n.match(/^sb-[a-z0-9]+-auth-token(?:\.(\d+))?$/); return m ? Number(m[1] ?? -1) : null; };
  const raw = Object.entries(s.cookies as Record<string, string>).filter(([n]) => chunk(n) !== null).sort(([a], [b]) => (chunk(a) as number) - (chunk(b) as number)).map(([, v]) => v).join('');
  const token = JSON.parse(raw.startsWith('base64-') ? Buffer.from(raw.slice(7), 'base64url').toString('utf8') : raw).access_token;
  const res = await fetch(`${url}${path}`, { method, headers: { apikey: anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

async function main() {
  const userId = await userIdOf(email);
  const m0 = await measure(email);
  evidence.m0 = m0;

  // One bank statement: the sale proceeds filed by the user as INCOME (the residual), plus the funding debit.
  const bank = await importAndApproveBank(email, [
    { date: '2026-08-04', description: `TRANSFER TO FHIP TEST BROKER ${salt}`, amount: -10000, category: 'investment_purchase' },
    { date: '2026-08-20', description: `FHIP TEST BROKER SALE PROCEEDS ${salt}`, amount: 15000, category: 'income' },
    { date: '2026-08-25', description: `FHIP TEST DIVIDEND BHP ${salt}`, amount: 400, category: 'income' },
  ], { masked: 'xxxx7406', filename: `fhip-test-bank-secrev-${salt}.csv`, opening: 5000 });
  evidence.bank = { documentId: bank.documentId, closing: bank.closing, decisions: bank.decisions, approve: bank.approve, txns: bank.txns };
  expect(bank.approve?.status === 200, 'bank statement approved', bank.approve);
  const sale = bank.txns.find((t: any) => t.description_raw.startsWith('FHIP TEST BROKER SALE PROCEEDS'));
  expect(sale?.user_override === true && sale?.economic_transaction_type === 'income', 'sale proceeds line carries the user decision (income, user_override)', { type: sale?.economic_transaction_type, override: sale?.user_override });

  if (only !== 'cur') {
    const doc = brokerTransactionStatement({ year: 2026, month: 8 }, salt);
    const qs = new URLSearchParams({ ...doc.upload.query, masked_account_identifier: 'xxxx2546', filename: doc.filename });
    const up = log('broker upload', await call(email, 'POST', `/api/financial-data-hub/investment-statement/upload?${qs}`, { body: doc.bytes, contentType: 'text/csv' }));
    const documentId = up.json?.data?.document_id as string;
    if (!up.json?.data?.statement_id) throw new Error('investment upload produced no statement');
    const acct = log('account-match resolve', await call(email, 'POST', `/api/financial-data-hub/investment-statement/${documentId}/account-match`, { json: { action: 'resolve', account_type: 'broker', currency_code: 'AUD' } }));
    if (acct.json?.data?.outcome !== 'single_match') {
      log('account-match confirm_new', await call(email, 'POST', `/api/financial-data-hub/investment-statement/${documentId}/account-match`, { json: { action: 'confirm_new', institution_name: 'FHIP Test Broker', masked_account_identifier: 'xxxx2546', currency_code: 'AUD', owner_self: true } }));
    } else if (!acct.json?.data?.owner_recorded) {
      log('account-match set_owner', await call(email, 'POST', `/api/financial-data-hub/investment-statement/${documentId}/account-match`, { json: { action: 'set_owner', owner_self: true } }));
    }
    let review = await call(email, 'GET', `/api/financial-data-hub/investment-statement/${documentId}`);
    const acts = (review.json?.data?.activities ?? []) as any[];
    const poss = (review.json?.data?.positions ?? []) as any[];
    for (const [table, row] of [...poss.map((p) => ['fdh_investment_statement_positions', p]), ...acts.map((a) => ['fdh_investment_statement_activities', a])] as [string, any][]) {
      if (row.security_match_status === 'matched' || !(row.ticker_raw || row.security_name_raw || row.isin)) continue;
      const r = await call(email, 'POST', `/api/financial-data-hub/investment-statement/${documentId}/security-match`, { json: { table, row_id: row.id } });
      if (r.json?.data?.outcome !== 'matched' && r.json?.data?.outcome !== 'single_match') {
        await call(email, 'POST', `/api/financial-data-hub/investment-statement/${documentId}/security-match`, { json: { table, row_id: row.id, confirm_new_security: true, instrument_class: 'equity' } });
      }
    }
    log('bank-match', await call(email, 'POST', `/api/financial-data-hub/investment-statement/${documentId}/bank-match`));
    review = await call(email, 'GET', `/api/financial-data-hub/investment-statement/${documentId}`);
    const sell = ((review.json?.data?.activities ?? []) as any[]).find((a) => a.activity_type === 'SELL');
    expect(sell?.linked_transaction_id === sale?.id, 'broker SELL 15,000 matched to the user-filed 15,000 credit', { sell: sell?.linked_transaction_id, bank: sale?.id });
    log('broker approve', await call(email, 'POST', `/api/financial-data-hub/investment-statement/${documentId}/approve`));
    const ap = log('broker apply', await call(email, 'POST', `/api/financial-data-hub/investment-statement/${documentId}/apply`));
    evidence.brokerApply = ap.json;
    const saleAfter = (await rowsFor('fdh_transactions', userId, 'id,economic_transaction_type,user_override', (q) => q.eq('id', sale.id)))[0];
    evidence.saleAfter = saleAfter;
    const m1 = await measure(email);
    evidence.m1 = m1;
    const dIncome = delta(m0, m1, 'income.countedMonthly');
    const dGross = delta(m0, m1, 'dashboard.grossMonthlyIncome');
    evidence.deltas = { dIncome, dGross };
    expect(dIncome === 400, 'R9 ORACLE: SELL 15,000 matched on an approved+applied broker statement -> ordinary income 0 (only the 400 dividend counts)', { dCountedMonthly: dIncome, dDashboardGross: dGross, saleAfter });
  }

  if (only !== 'r9') {
    // CUR: hand-made bank-balance proposal with the statement's exact balance but a different currency.
    const account = bank.txns[0]?.financial_account_id as string;
    const bal = bank.closing;
    const p = await asUser('POST', '/rest/v1/fhip_import_proposals', { user_id: userId, target_domain: 'asset', source_kind: 'bank_statement', source_statement_upload_id: bank.documentId, status: 'ready', currency_code: 'INR', recommended_apply_mode: 'add_new' });
    log('hand-made asset proposal (INR on an AUD account)', p);
    const pid = p.json?.[0]?.id;
    for (const [f, k, v] of [['asset_name', 'text', 'SECREV cash'], ['asset_class', 'enum', 'cash'], ['current_value', 'money', bal.toFixed(2)], ['currency_code', 'enum', 'INR']]) {
      const r = await asUser('POST', '/rest/v1/fhip_import_proposal_fields', { user_id: userId, proposal_id: pid, field_name: f, value_kind: k, proposed_value: v });
      if (r.status >= 300) log(`field ${f}`, r);
    }
    const ap = log('fdh15_apply_asset_proposal as the user', await asUser('POST', '/rest/v1/rpc/fdh15_apply_asset_proposal', { p_proposal_id: pid, p_decision: 'add_new' }));
    const asset = (await rowsFor('assets', userId, 'id,current_value,currency_code,source_type,source_financial_account_id', (q) => q.eq('source_financial_account_id', account)))[0];
    const acct = (await rowsFor('fdh_financial_accounts', userId, 'id,currency_code', (q) => q.eq('id', account)))[0];
    evidence.cur = { apply: ap.json, asset, account: acct, balance: bal };
    expect(!(ap.json?.ok === true && asset && asset.currency_code !== acct?.currency_code), 'CUR: a bank balance is never applied in a currency other than its account/statement currency', { apply: ap.json?.ok ?? ap.json?.code, asset, accountCurrency: acct?.currency_code });
  }

  saveEvidence(`secrev_scenario_${salt}`, { evidence, results });
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
}
main().catch((e) => { console.error(e); saveEvidence(`secrev_scenario_${salt}_error`, { evidence, results, error: String(e?.stack ?? e) }); process.exitCode = 1; });
