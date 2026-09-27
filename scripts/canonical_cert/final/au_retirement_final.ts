/* eslint-disable @typescript-eslint/no-explicit-any -- certification harness: untyped JSON route responses */
/**
 * FINAL live-DEV verification (feature/canonical-cert-final-au-retirement-0218-live).
 *
 *   1. AU investment: upload broker statement -> approve -> Apply -> "Imported, not yet in Net Worth"
 *      -> Add to Net Worth -> Net Worth + Investments tab both update.
 *   2. Retirement: a summary statement with several fields ticked (D-12), including a bank-leg
 *      confirmation step, Apply, evidence history visible.
 *
 * Every step goes through the real localhost app routes as the signed-in fixture user. The service
 * role is used ONLY to observe (never to write).
 *
 *   npx tsx scripts/canonical_cert/final/au_retirement_final.ts --step <step> --email <e> --port 3973
 */
import fs from 'node:fs';
import path from 'node:path';
import { api } from '../lib/session.mjs';
import { serviceClient } from '../lib/env.mjs';
import { bankCsv, retirementSummaryStatement, previousCompleteMonth, type Month } from '../documents/builders';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = arg('--email')!;
const port = Number(arg('--port'));
const step = arg('--step')!;
const OUT_DIR = path.resolve('.canonical-cert', 'final');
fs.mkdirSync(OUT_DIR, { recursive: true });
const LOG = path.join(OUT_DIR, 'journey.jsonl');
const STATE = path.join(OUT_DIR, 'state.json');
const state: Record<string, any> = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1));

async function call(method: string, route: string, opts: { json?: unknown; body?: Uint8Array; contentType?: string } = {}) {
  const t0 = Date.now();
  const r = await api(email, method, route, { port, ...opts, body: opts.body as unknown as BodyInit });
  const ms = Date.now() - t0;
  fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), step, method, route, status: r.status, ms, request: opts.json ?? null, response: r.json ?? r.text.slice(0, 2000) }) + '\n');
  console.log(`${r.status} ${String(ms).padStart(6)}ms ${method} ${route.split('?')[0]}${r.status >= 300 ? '  ' + (r.text ?? '').slice(0, 400) : ''}`);
  return { status: r.status, json: r.json as any };
}
const show = (label: string, v: unknown) => console.log(`  ${label}: ${JSON.stringify(v)}`);
function need<T>(v: T | undefined | null, what: string): T { if (v === undefined || v === null) throw new Error(`missing ${what}`); return v; }
const qs = (q: Record<string, string>) => new URLSearchParams(q).toString();

let svcP: Promise<any> | null = null;
function svc() { if (!svcP) svcP = serviceClient(); return svcP; }
async function userIdOf(): Promise<string> {
  if (state.userId) return state.userId;
  const admin = await svc();
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;
  const hit = data.users.find((u: any) => u.email === email);
  if (!hit) throw new Error(`no such user ${email}`);
  state.userId = hit.id; save();
  return hit.id;
}
async function select(table: string, build: (q: any) => any) {
  const sb = await svc();
  const { data, error } = await build(sb.from(table));
  if (error) throw new Error(`observe ${table}: ${error.message}`);
  return data ?? [];
}

const salt = 'AURET';
const MONTH: Month = { year: 2026, month: 8 };
const FUND_B_NAME = 'FHIP Test Super Fund Final';
const MASK_B = 'xxxx9931';
const MASK_BROKER = 'xxxx9941';
const MASK_BANK = 'xxxx9951';

// ---------------------------------------------------------------------------------------------
// Custom documents (not the shared oracle pack -- these need specific narrative/date shapes for
// the retirement bank-leg step, which the generic builder's documents do not exercise).
// ---------------------------------------------------------------------------------------------
function brokerPortfolioCsv(): string {
  // FDH-11 au_generic_portfolio_csv_v1 layout (see brokerPortfolioStatement in builders.ts).
  const lines = [
    'Security Name,Code,Quantity,Price,Market Value,Valuation Date',
    `FHIP Test Equity ${salt},FTF,100,50.00,5000.00,31/08/${MONTH.year}`,
  ];
  return lines.join('\n') + '\n';
}

function retirementSummaryCsv(items: [string, number][]): string {
  const period = `${MONTH.year}-08-01 to ${MONTH.year}-08-31`;
  return ['Item,Amount,Period', ...items.map(([k, v]) => `${k},${v.toFixed(2)},${period}`)].join('\n') + '\n';
}

function retirementTransactionCsv(rows: { date: string; description: string; amount: number }[]): string {
  const lines = ['Date,Description,Amount', ...rows.map((r) => `${r.date},${r.description},${r.amount.toFixed(2)}`)];
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------
const steps: Record<string, () => Promise<void>> = {

  // =============================================================== AU INVESTMENT (broker) =====
  async 'au-broker-upload'() {
    const csv = brokerPortfolioCsv();
    const qs2 = qs({ csv_kind: 'portfolio', currency_code: 'AUD', institution_name: 'FHIP Test Broker Final', masked_account_identifier: MASK_BROKER, statement_date: `${MONTH.year}-08-31`, filename: `fhip-test-broker-portfolio-final-${salt}.csv` });
    const up = await call('POST', `/api/financial-data-hub/investment-statement/upload?${qs2}`, { body: new TextEncoder().encode(csv), contentType: 'text/csv' });
    const docId = need(up.json?.data?.document_id, 'document_id');
    state.brokerDoc = docId; save();
    const load = async () => (await call('GET', `/api/financial-data-hub/investment-statement/${docId}`)).json?.data ?? {};
    let rv = await load();
    show('review0', { keys: Object.keys(rv), positions: (rv.positions ?? []).length, base_currency: rv.statement?.base_currency });
    const acct = await call('POST', `/api/financial-data-hub/investment-statement/${docId}/account-match`, { json: { action: 'resolve', account_type: 'broker', currency_code: rv.statement?.base_currency ?? 'AUD' } });
    show('account resolve', acct.json?.data ?? acct.json);
    const outcome = acct.json?.data?.outcome;
    if (outcome !== 'single_match') {
      const n = await call('POST', `/api/financial-data-hub/investment-statement/${docId}/account-match`, { json: { action: 'confirm_new', institution_name: 'FHIP Test Broker Final', masked_account_identifier: MASK_BROKER, currency_code: 'AUD', owner_self: true } });
      show('account confirm_new', n.json?.data ?? n.json);
    } else if (!acct.json?.data?.owner_recorded) {
      const o = await call('POST', `/api/financial-data-hub/investment-statement/${docId}/account-match`, { json: { action: 'set_owner', owner_self: true } });
      show('set_owner', o.json?.data ?? o.json);
    }
    await call('POST', `/api/financial-data-hub/investment-statement/${docId}/bank-match`);
    rv = await load();
    for (const p of rv.positions ?? []) {
      if (p.security_match_status === 'matched') continue;
      const s = await call('POST', `/api/financial-data-hub/investment-statement/${docId}/security-match`, { json: { table: 'fdh_investment_statement_positions', row_id: p.id, confirm_new_security: true, instrument_class: 'equity' } });
      show(`create security ${p.ticker_raw ?? p.security_name_raw}`, s.json?.data ?? s.json);
    }
    rv = await load();
    show('positions', (rv.positions ?? []).map((p: any) => [p.ticker_raw, p.quantity, p.market_value, p.security_match_status, p.apply_status]));
  },

  async 'au-broker-apply'() {
    const docId = need(state.brokerDoc, 'brokerDoc');
    const userId = await userIdOf();
    const unpub0 = await call('GET', '/api/investments/imported-statements');
    show('unpublished BEFORE approve/apply', unpub0.json?.data?.unpublished);
    const a = await call('POST', `/api/financial-data-hub/investment-statement/${docId}/approve`);
    show('approve', a.json?.data ?? a.json);
    const cmp = await call('GET', `/api/financial-data-hub/investment-statement/${docId}/current-vs-statement`);
    show('compare', cmp.json?.data?.rows);
    const ap = await call('POST', `/api/financial-data-hub/investment-statement/${docId}/apply`);
    show('apply', ap.json?.data ?? ap.json);
    const unpub1 = await call('GET', '/api/investments/imported-statements');
    show('unpublished AFTER apply (should show "Imported, not yet in Net Worth")', unpub1.json?.data?.unpublished);
    const dash1 = await call('GET', '/api/dashboard/summary');
    show('dashboard.totalInvestments AFTER apply (should be unchanged: not yet in Net Worth)', dash1.json?.data?.totalInvestments);
    state.unpubAfterApply = unpub1.json?.data?.unpublished;
    state.dashAfterApply = dash1.json?.data?.totalInvestments;
    save();
    void userId;
  },

  async 'au-broker-publish'() {
    const docId = need(state.brokerDoc, 'brokerDoc');
    const dash0 = await call('GET', '/api/dashboard/summary');
    const invPage0 = await call('GET', '/api/investments/imported-statements');
    show('dashboard.totalInvestments BEFORE publish', dash0.json?.data?.totalInvestments);
    const pv = await call('POST', `/api/financial-data-hub/investment-statement/${docId}/publish`, { json: { action: 'preview' } });
    const holdings = (pv.json?.data?.holdings ?? []) as any[];
    show('preview', holdings.map((h) => ({ snapshot_id: h.snapshot_id, name: h.name ?? h.instrument_name, value: h.value ?? h.market_value, published: h.published, eligibility: h.eligibility_status })));
    const decisions = holdings.filter((h) => !h.published && h.eligibility_status !== 'NOT_ELIGIBLE').map((h) => ({ snapshot_id: h.snapshot_id, acknowledged_no_duplicate: false }));
    if (!decisions.length) { console.log('  publish: nothing eligible to publish -- see preview above'); return; }
    const pb = await call('POST', `/api/financial-data-hub/investment-statement/${docId}/publish`, { json: { action: 'publish', decisions } });
    show('publish (Add to Net Worth)', pb.json?.data ?? pb.json);
    const dash1 = await call('GET', '/api/dashboard/summary');
    const invPage1 = await call('GET', '/api/investments/imported-statements');
    const invTab = await call('GET', '/api/investments/holdings');
    show('dashboard.totalInvestments AFTER publish', dash1.json?.data?.totalInvestments);
    show('unpublished bucket AFTER publish (should be gone/zero)', invPage1.json?.data?.unpublished);
    show('Investments tab holdings AFTER publish', invTab.status === 200 ? (invTab.json?.data ?? invTab.json) : `HTTP ${invTab.status}`);
    state.result_au = {
      unpublishedBeforePublish: invPage0.json?.data?.unpublished,
      dashboardBeforePublish: dash0.json?.data?.totalInvestments,
      dashboardAfterApply: state.dashAfterApply,
      unpublishedAfterApply: state.unpubAfterApply,
      unpublishedAfterPublish: invPage1.json?.data?.unpublished,
      dashboardAfterPublish: dash1.json?.data?.totalInvestments,
      netWorthMoved: (dash1.json?.data?.totalInvestments ?? 0) !== (dash0.json?.data?.totalInvestments ?? 0),
    };
    save();
    console.log('RESULT au-investment:', JSON.stringify(state.result_au, null, 1));
  },

  // =============================================================== RETIREMENT (summary, D-12) ===
  async 'ret-fundb-upload'() {
    const csv = retirementSummaryCsv([
      ['Opening balance', 100000],
      ['Employer contributions', 575],
      ['Contributions tax', 86.25],
      ['Closing balance', 100488.75],
    ]);
    const qs2 = qs({ jurisdiction: 'AU', currency_code: 'AUD', fund_name: FUND_B_NAME, masked_account_identifier: MASK_B, statement_period_start: `${MONTH.year}-08-01`, statement_period_end: `${MONTH.year}-08-31`, filename: `fhip-test-super-final-${salt}.csv` });
    const up = await call('POST', `/api/financial-data-hub/retirement-statement/upload?${qs2}`, { body: new TextEncoder().encode(csv), contentType: 'text/csv' });
    const d = up.json?.data ?? {};
    const docId = need(d.document_id ?? d.statement?.document_id, 'document_id');
    state.retDoc = docId; save();
    const load = async () => (await call('GET', `/api/financial-data-hub/retirement-statement/${docId}`)).json ?? {};
    let rv: any = await load();
    show('review0', { keys: Object.keys(rv.data ?? rv) });
    const m = await call('POST', `/api/financial-data-hub/retirement-statement/${docId}/account-match`, { json: { action: 'auto' } });
    show('account-match auto', m.json);
    if (!(m.json?.outcome === 'matched' || m.json?.data?.outcome === 'matched')) {
      const n = await call('POST', `/api/financial-data-hub/retirement-statement/${docId}/account-match`, { json: { action: 'confirm_new' } });
      show('account-match confirm_new', n.json);
    }
    const ev = await call('POST', `/api/financial-data-hub/retirement-statement/${docId}/evidence-matches`);
    show('evidence-matches', ev.json);
  },

  async 'ret-fundb-apply'() {
    const docId = need(state.retDoc, 'retDoc');
    const a = await call('POST', `/api/financial-data-hub/retirement-statement/${docId}/approve`);
    show('approve', a.json);
    const p = await call('POST', `/api/financial-data-hub/retirement-statement/${docId}/proposal`);
    const body = p.json ?? {};
    const fields = (body.fields ?? body.data?.fields ?? []) as any[];
    const norm = fields.map((f) => ({ name: f.fieldName ?? f.field_name, proposed: f.proposedValue ?? f.proposed_value, existing: f.existingValue ?? f.existing_value, rec: f.isRecommended ?? f.is_recommended, conf: f.requiresConfirmation ?? f.requires_confirmation }));
    show('proposal fields (several offered; several ticked)', norm);
    // Tick every recommended field that needs no confirmation PLUS the contribution pair (D-12: the
    // user explicitly ticks contribution fields; they are offered unticked by default).
    const selected = [...new Set(norm.filter((f) => f.rec && !f.conf).map((f) => f.name).concat(norm.filter((f) => /employer_contribution|contribution_frequency/.test(f.name)).map((f) => f.name)))];
    const notTicked = norm.filter((f) => !selected.includes(f.name)).map((f) => f.name);
    show('selected_fields (ticked)', selected);
    show('NOT ticked (must NOT apply)', notTicked);
    const decision = (body.recommended_apply_mode ?? body.data?.recommended_apply_mode) === 'add_new' ? 'add_new' : 'update_existing';
    const proposalId = body.proposal_id ?? body.data?.proposal_id;
    const ap = await call('POST', `/api/financial-data-hub/retirement-statement/${docId}/apply`, { json: { proposal_id: proposalId, decision, selected_fields: selected } });
    show('apply', ap.json);
    state.retTicked = selected; state.retNotTicked = notTicked; state.retApply = ap.json; save();
    const userId = await userIdOf();
    const accounts = await select('retirement_accounts', (q: any) => q.select('id,account_name,current_balance,employer_contribution,contribution_frequency,personal_contribution').eq('user_id', userId));
    show('retirement_accounts AFTER apply (observe only)', accounts.filter((r: any) => String(r.account_name ?? '').includes('Final')));
    state.retAccountId = accounts.find((r: any) => String(r.account_name ?? '').includes('Final'))?.id;
    save();
  },

  async 'ret-history-check'() {
    const docId = need(state.retDoc, 'retDoc');
    const hist = await call('GET', `/api/financial-data-hub/retirement-statement/${docId}`);
    show('statement evidence detail (for Retirement tab statement history)', hist.json?.data ?? hist.json);
    const acct = state.retAccountId;
    if (acct) {
      const evList = await call('GET', `/api/financial-data-hub/retirement-statement?account_id=${acct}`);
      show('retirement-statement list for this account (evidence history)', evList.status === 200 ? evList.json?.data : `HTTP ${evList.status}`);
    }
  },

  // =============================================================== RETIREMENT bank-leg (WP-13) ===
  async 'ret-bankleg-setup-bank'() {
    // A bank statement carrying a debit whose narrative corroborates the fund name (tokens after
    // dropping generic words: "fhip", "test", "final") and whose amount/date will match the
    // personal-contribution activity below (BANK_MATCH_WINDOW_DAYS = 10, zero amount tolerance).
    const { csv } = bankCsv([
      { date: `${MONTH.year}-08-01`, description: 'FHIP TEST EMPLOYER PTY LTD SALARY FINAL', amount: 5000 },
      { date: `${MONTH.year}-08-20`, description: `BPAY ${FUND_B_NAME} PERSONAL CONTRIBUTION`, amount: -500 },
    ], 10000);
    const qs2 = qs({ country_code: 'AU', currency_code: 'AUD', masked_identifier: MASK_BANK, owner_role: 'self', statement_period_start: `${MONTH.year}-08-01`, statement_period_end: `${MONTH.year}-08-31`, filename: `fhip-test-bank-final-${salt}.csv` });
    const up = await call('POST', `/api/financial-data-hub/bank-csv/upload?${qs2}`, { body: new TextEncoder().encode(csv), contentType: 'text/csv' });
    const documentId = need(up.json?.data?.document_id, 'document_id');
    state.bankDoc = documentId; save();
    await call('POST', `/api/financial-data-hub/bank-csv/${documentId}/detect`);
    await call('POST', `/api/financial-data-hub/bank-csv/${documentId}/process`);
    await call('POST', '/api/financial-data-hub/bank-transactions/categorise');
    const rv = await call('GET', `/api/financial-data-hub/documents/${documentId}/category-review`);
    const needs = (rv.json?.data?.needs_decision ?? []) as any[];
    show('needs_decision', needs.map((n) => [n.id, n.direction, n.description]));
    const FOOD = '5a8ba467-eaf4-4f68-82d5-07ed36931cd0';
    const INCOME = '0c046122-43e8-431d-94e2-527e734377b1';
    for (const item of needs) {
      if (!item.can_choose_category) continue;
      await call('POST', `/api/financial-data-hub/bank-transactions/${item.id}/set-category`, { json: { category_id: item.direction === 'in' ? INCOME : FOOD, remember_payee: false } });
    }
    const appr = await call('POST', `/api/financial-data-hub/documents/${documentId}/category-review/approve-all`, { json: {} });
    show('approve-all', appr.json?.data ?? appr.json);
    // BEFORE bank-leg confirmation: this debit counts as ordinary spending (the oracle this step proves).
    const before = await call('GET', '/api/expenses/actuals?pageSize=500');
    state.expensesBeforeBankLeg = before.json?.data?.totals;
    show('expenses totals BEFORE bank-leg confirm (contribution counted as spending)', before.json?.data?.totals);
    save();
  },

  async 'ret-bankleg-upload-transaction'() {
    // A SEPARATE, dated "contribution history" export for the SAME fund/account (FDH-12's
    // transaction-format adapter: Date,Description,Amount) -- this is the layout that produces
    // fdh_retirement_statement_activities rows a bank leg can be confirmed against.
    const csv = retirementTransactionCsv([
      { date: `${MONTH.year}-08-20`, description: 'Personal contribution to ' + FUND_B_NAME, amount: 500 },
    ]);
    const qs2 = qs({ jurisdiction: 'AU', currency_code: 'AUD', fund_name: FUND_B_NAME, masked_account_identifier: MASK_B, statement_period_start: `${MONTH.year}-08-01`, statement_period_end: `${MONTH.year}-08-31`, filename: `fhip-test-super-final-txn-${salt}.csv` });
    const up = await call('POST', `/api/financial-data-hub/retirement-statement/upload?${qs2}`, { body: new TextEncoder().encode(csv), contentType: 'text/csv' });
    const d = up.json?.data ?? {};
    const docId = need(d.document_id ?? d.statement?.document_id, 'document_id');
    state.retTxnDoc = docId; save();
    const m = await call('POST', `/api/financial-data-hub/retirement-statement/${docId}/account-match`, { json: { action: 'auto' } });
    show('account-match auto (should match the existing Fund Final account)', m.json);
    const ev = await call('POST', `/api/financial-data-hub/retirement-statement/${docId}/evidence-matches`);
    show('evidence-matches (bank pass should now attempt a match)', ev.json);
    const rv = await call('GET', `/api/financial-data-hub/retirement-statement/${docId}`);
    const body = rv.json?.data ?? rv.json;
    show('activities', (body.activities ?? []).map((a: any) => [a.id, a.activity_type, a.amount, a.bank_match_status, a.matched_transaction_id]));
    const personal = (body.activities ?? []).find((a: any) => a.activity_type === 'PERSONAL_CONTRIBUTION');
    state.retTxnActivityId = personal?.id;
    state.retTxnActivityMatch = personal?.bank_match_status;
    save();
  },

  async 'ret-bankleg-confirm'() {
    const activityId = need(state.retTxnActivityId, 'retTxnActivityId (run ret-bankleg-upload-transaction first; bank_match_status must be matched)');
    const docId = need(state.retTxnDoc, 'retTxnDoc');
    const a = await call('POST', `/api/financial-data-hub/retirement-statement/${docId}/approve`);
    show('approve (transaction statement)', a.json);
    const before = await call('GET', '/api/expenses/actuals?pageSize=500');
    const c = await call('POST', `/api/financial-data-hub/retirement-statement/${docId}/bank-leg`, { json: { activity_id: activityId } });
    show('bank-leg confirm', c.json);
    const after = await call('GET', '/api/expenses/actuals?pageSize=500');
    show('expenses totals AFTER bank-leg confirm (contribution should drop OUT of spending: transfer, not spend)', after.json?.data?.totals);
    state.result_retirement_bankleg = { before: before.json?.data?.totals, confirm: c.json, after: after.json?.data?.totals };
    save();
    console.log('RESULT retirement bank-leg:', JSON.stringify(state.result_retirement_bankleg, null, 1));
  },

  async summary() {
    console.log(JSON.stringify(state, null, 1));
  },
};

const fn = steps[step];
if (!fn) throw new Error(`unknown step ${step}; known: ${Object.keys(steps).join(', ')}`);
fn().catch((e) => { console.error(e); process.exitCode = 1; });
