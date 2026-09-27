/**
 * Golden pair, Household I: the household's economics arrive ONLY as documents, through the real LOCALHOST
 * routes, in the exact request sequence each import panel sends (components/income/PayslipImportPanel.tsx,
 * components/expenses/BankStatementImportPanel.tsx + app/(app)/financial-data-hub/review/StatementCategoryReview.tsx,
 * components/liabilities/LiabilityImportPanel.tsx, components/investments/AuInvestmentStatementImportPanel.tsx,
 * components/retirement/RetirementStatementImportPanel.tsx, the WP-15 Assets/Expenses proposal panels).
 * Nothing here writes to the database directly.
 *
 *   npx tsx scripts/canonical_cert/golden_pair/journey_i.ts --email <e> --port 3971 --step <step> [--month YYYY-MM]
 *
 * Steps (run in order; each prints what the user would see and appends every response to
 * .canonical-cert/gp/journey-I.jsonl): payslip-upload, payslip-apply, bank-upload, bank-approve, card-upload,
 * card-apply, loan-upload, loan-apply, broker, super, bank-balance, expense-averages, state.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- certification harness: reads untyped JSON route
   responses exactly as the panels do; every value it asserts on is printed and logged, not type-trusted. */
import fs from 'node:fs';
import path from 'node:path';
import { api } from '../lib/session.mjs';
import { parseMonth, previousCompleteMonth, type BuiltDocument } from '../documents/builders';
import { ECON, goldenDocuments } from './economics';

const ECON_MASK = ECON.broker.masked;

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = arg('--email')!;
const port = Number(arg('--port'));
const step = arg('--step')!;
const month = arg('--month') ? parseMonth(arg('--month')!) : previousCompleteMonth();
const RUN = arg('--run') ?? 'GP2';
const DOCS = Object.fromEntries(goldenDocuments(month, RUN).map((d) => [d.key, d])) as Record<string, BuiltDocument>;
const LOG = path.resolve('.canonical-cert', 'gp', 'journey-I.jsonl');
const STATE = path.resolve('.canonical-cert', 'gp', 'journey-I-state.json');
const state: Record<string, unknown> = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1));

type J = { data?: any; error?: string; code?: string; message?: string; [k: string]: any } | null;
async function call(method: string, route: string, opts: { json?: unknown; body?: Uint8Array; contentType?: string } = {}): Promise<{ status: number; json: J }> {
  const t0 = Date.now();
  const r = await api(email, method, route, { port, ...opts, body: opts.body as unknown as BodyInit });
  const ms = Date.now() - t0;
  fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), step, method, route, request: opts.json ?? (opts.body ? `<${opts.body.length} bytes ${opts.contentType}>` : null), status: r.status, ms, response: r.json ?? r.text.slice(0, 2000) }) + '\n');
  console.log(`${r.status} ${String(ms).padStart(6)}ms ${method} ${route.split('?')[0]}${r.status >= 300 ? '  ' + (r.text ?? '').slice(0, 300) : ''}`);
  return { status: r.status, json: r.json as J };
}
const show = (label: string, v: unknown) => console.log(`  ${label}: ${JSON.stringify(v)}`);
function need<T>(v: T | undefined | null, what: string): T { if (v === undefined || v === null) throw new Error(`missing ${what}`); return v; }
const qs = (q: Record<string, string>) => new URLSearchParams(q).toString();

async function uploadCsv(doc: BuiltDocument) {
  return call('POST', `${doc.upload.route}?${qs({ ...doc.upload.query, filename: doc.filename })}`, { body: doc.bytes, contentType: 'text/csv' });
}

const steps: Record<string, () => Promise<void>> = {
  // ---------------------------------------------------------------- payslip (Income -> Import payslip)
  async 'payslip-upload'() {
    const doc = DOCS.payslip;
    const s = await call('POST', '/api/financial-data-hub/documents/upload-sessions', { json: { document_type: 'payslip', source_type: 'pdf_native', country_code: 'AU', declared_mime_type: 'application/pdf', declared_file_size_bytes: doc.bytes.length } });
    const sessionId = need(s.json?.data?.session_id, 'session_id');
    const c = await call('POST', `/api/financial-data-hub/documents/upload-sessions/${sessionId}/complete`, { body: doc.bytes, contentType: 'application/pdf' });
    const docId = need(c.json?.data?.document_id, 'document_id');
    show('complete', { document_id: docId, processing_status: c.json?.data?.processing_status });
    state.payslipDoc = docId; save();
    const p = await call('POST', `/api/financial-data-hub/payslip/${docId}/process`);
    show('process', p.json?.data ?? p.json);
    const g = await call('GET', `/api/financial-data-hub/payslip/${docId}`);
    const ev = g.json?.data?.event ?? g.json?.data?.payroll_event ?? g.json?.data;
    show('review', { keys: Object.keys(g.json?.data ?? {}), gross: ev?.gross_pay, net: ev?.net_pay, tax: ev?.tax_withheld, super: ev?.employer_retirement_contribution, pay_date: ev?.payment_date, freq: ev?.pay_frequency, needs_review: g.json?.data?.needs_review });
  },
  async 'payslip-apply'() {
    const docId = need(state.payslipDoc as string, 'payslipDoc');
    const a = await call('POST', `/api/financial-data-hub/payslip/${docId}/approve`, { json: { income_owner: 'self', acknowledge_review: true, replaces_earlier: false } });
    show('approve', a.json?.data ?? a.json);
    const pr = await call('POST', `/api/financial-data-hub/payslip/${docId}/proposal`);
    const d = pr.json?.data ?? {};
    const fields = (d.fields ?? []) as { fieldName?: string; field_name?: string; proposedValue?: unknown; proposed_value?: unknown; isRecommended?: boolean; is_recommended?: boolean; requiresConfirmation?: boolean; requires_confirmation?: boolean; existingValue?: unknown; existing_value?: unknown }[];
    const norm = fields.map((f) => ({ name: f.fieldName ?? f.field_name, proposed: f.proposedValue ?? f.proposed_value, existing: f.existingValue ?? f.existing_value, rec: f.isRecommended ?? f.is_recommended, conf: f.requiresConfirmation ?? f.requires_confirmation }));
    show('proposal fields', norm);
    const selected = norm.filter((f) => f.rec && !f.conf && f.proposed !== f.existing).map((f) => f.name);
    const decision = d.proposal?.target_entity_id ? 'update_existing' : 'add_new';
    state.payslipProposal = d.proposal_id; save();
    const ap = await call('POST', `/api/financial-data-hub/income-proposals/${d.proposal_id}/apply`, { json: { decision, selectedFields: decision === 'add_new' ? selected : undefined } });
    show('apply', ap.json?.data ?? ap.json);
  },
  // ---------------------------------------------------------------- bank (Expenses -> Import bank statement)
  async 'bank-upload'() {
    for (const key of ['bank_aud', 'bank_inr']) {
      const doc = DOCS[key];
      const up = await uploadCsv(doc);
      const docId = need(up.json?.data?.document_id, 'document_id');
      show(`${key} upload`, { document_id: docId, account_resolution: up.json?.data?.account_resolution, duplicate_of: up.json?.data?.duplicate_of_document_id ?? null });
      state[`${key}Doc`] = docId; save();
      const det = await call('POST', `/api/financial-data-hub/bank-csv/${docId}/detect`);
      show('detect', { status: det.json?.data?.detection_status ?? det.json?.data?.status, format: det.json?.data?.detected_format ?? det.json?.data?.format });
      const pr = await call('POST', `/api/financial-data-hub/bank-csv/${docId}/process`);
      const d = pr.json?.data ?? {};
      show('process', { transactions_created: d.transactions_created, rejected_rows: d.rejected_rows, reconciliation_status: d.reconciliation_status, processing_status: d.processing_status, error_code: d.error_code });
      await call('POST', '/api/financial-data-hub/bank-transactions/categorise');
    }
  },
  async 'bank-review'() {
    for (const key of ['bank_aud', 'bank_inr']) {
      const docId = need(state[`${key}Doc`] as string, `${key}Doc`);
      const r = await call('GET', `/api/financial-data-hub/documents/${docId}/category-review`);
      const d = r.json?.data ?? {};
      show(`${key} counts`, d.counts); show('totals', d.totals); show('statement', d.statement);
      for (const g of d.groups ?? []) show(`group ${g.group_key}`, { label: g.label, count: g.count ?? g.transaction_count, total: g.total ?? g.amount_total, status: g.approval_status ?? g.status });
      for (const n of d.needs_decision ?? []) show('needs_decision', { id: n.id, description: n.description, amount: n.amount, reason: n.reason, suggested: n.suggested_category_id, current: n.current_category_id });
      state[`${key}Review`] = d; save();
    }
  },
  async 'bank-approve'() {
    for (const key of ['bank_aud', 'bank_inr']) {
      const docId = need(state[`${key}Doc`] as string, `${key}Doc`);
      const a = await call('POST', `/api/financial-data-hub/documents/${docId}/category-review/approve-all`, { json: {} });
      show(`${key} approve-all`, a.json?.data ?? a.json);
    }
  },
  async 'bank-categorise'() {
    // What the user picks in the review page's "Needs a decision" list (StatementCategoryReview saveCategory,
    // remember_payee unticked -- the PO default).
    const PICK: Record<string, string> = {
      [`RENT FHIP TEST REALTY ${RUN}`]: '3bacc9d8-f9a7-49fb-ac20-994394805209', // Housing
      [`FHIP TEST HOME LOAN REPAYMENT ${RUN}`]: '526c3f27-34b7-4fb7-b273-0f76a096ffc7', // Loan Principal Repayment
      [`FHIP TEST CARD PAYMENT ${RUN}`]: 'f1013425-8d4a-41ce-8d0e-4f4a324dc8ce', // Credit-Card Payment
    };
    for (const key of ['bank_aud', 'bank_inr']) {
      const docId = need(state[`${key}Doc`] as string, `${key}Doc`);
      const r = await call('GET', `/api/financial-data-hub/documents/${docId}/category-review`);
      for (const n of r.json?.data?.needs_decision ?? []) {
        const cat = PICK[n.description];
        if (!cat) { show('NO PICK for', n.description); continue; }
        const s = await call('POST', `/api/financial-data-hub/bank-transactions/${n.id}/set-category`, { json: { category_id: cat, remember_payee: false } });
        show(`set-category ${n.description}`, s.json?.data ?? s.json);
      }
    }
  },
  // ---------------------------------------------------------------- card + loan (Liabilities -> Import statement)
  async 'liability-upload'() {
    for (const key of ['card', 'loan']) {
      const doc = DOCS[key];
      const up = await uploadCsv(doc);
      const d = up.json?.data ?? {};
      show(`${key} upload`, { document_id: d.document_id, statement_id: d.statement_id, pipeline_status: d.pipeline_status, duplicate: d.duplicate, error: up.json?.error });
      state[`${key}Doc`] = d.document_id; save();
      const g = await call('GET', `/api/financial-data-hub/liability-statement/${d.document_id}`);
      const st = g.json?.data?.statement ?? {};
      show('statement', { keys: Object.keys(g.json?.data ?? {}), type: st.statement_type, opening: st.opening_balance, closing: st.closing_balance, period: [st.statement_period_start, st.statement_period_end], approval: st.approval_status });
      for (const a of g.json?.data?.activities ?? g.json?.data?.transactions ?? []) show('activity', { id: a.id, type: a.activity_type ?? a.transaction_type, amount: a.amount, date: a.activity_date ?? a.transaction_date, principal: a.principal_amount, interest: a.interest_amount, fee: a.fee_amount, bank: a.bank_match_status ?? a.matched_bank_transaction_id });
    }
  },
  async 'liability-apply'() {
    for (const key of ['card', 'loan']) {
      const docId = need(state[`${key}Doc`] as string, `${key}Doc`);
      const a = await call('POST', `/api/financial-data-hub/liability-statement/${docId}/approve`);
      show(`${key} approve`, a.json?.data ?? a.json);
      const p = await call('POST', `/api/financial-data-hub/liability-statement/${docId}/proposal`);
      const d = p.json?.data ?? {};
      const fields = (d.fields ?? []) as { field_name: string; proposed_value: unknown; existing_value: unknown; is_recommended: boolean; requires_confirmation: boolean }[];
      show('proposal fields', fields.map((f) => [f.field_name, f.proposed_value, f.is_recommended, f.requires_confirmation]));
      const selected = fields.filter((f) => f.is_recommended && !f.requires_confirmation && f.proposed_value !== f.existing_value).map((f) => f.field_name);
      const decision = d.proposal?.target_entity_id ? 'update_existing' : 'add_new';
      state[`${key}Proposal`] = d.proposal_id; save();
      const ap = await call('POST', `/api/financial-data-hub/liability-proposals/${d.proposal_id}/apply`, { json: { decision, selectedFields: selected } });
      show('apply', ap.json?.data ?? ap.json);
    }
  },
  // ---------------------------------------------------------------- AU broker (Investments -> AU statement import)
  async broker() {
    const doc = DOCS.broker_portfolio;
    const up = await uploadCsv(doc);
    const docId = need(up.json?.data?.document_id, 'document_id');
    state.brokerDoc = docId; save();
    show('upload', { document_id: docId, pipeline_status: up.json?.data?.pipeline_status, duplicate: up.json?.data?.duplicate });
    const load = async () => (await call('GET', `/api/financial-data-hub/investment-statement/${docId}`)).json?.data ?? {};
    let rv = await load();
    show('review', { keys: Object.keys(rv), positions: (rv.positions ?? []).length, activities: (rv.activities ?? []).length, base_currency: rv.statement?.base_currency });
    // handleMatchAll
    const acct = await call('POST', `/api/financial-data-hub/investment-statement/${docId}/account-match`, { json: { action: 'resolve', account_type: 'broker', currency_code: rv.statement?.base_currency ?? 'AUD' } });
    show('account resolve', acct.json?.data ?? acct.json);
    for (const p of rv.positions ?? []) {
      if (p.security_match_status === 'matched') continue;
      const s = await call('POST', `/api/financial-data-hub/investment-statement/${docId}/security-match`, { json: { table: 'fdh_investment_statement_positions', row_id: p.id } });
      show(`security ${p.ticker_raw ?? p.security_name_raw}`, s.json?.data ?? s.json);
    }
    await call('POST', `/api/financial-data-hub/investment-statement/${docId}/bank-match`);
    // Account: add as a new broker account owned by self (handleAddNewAccount) when nothing matched.
    const outcome = acct.json?.data?.outcome;
    if (outcome !== 'single_match') {
      const n = await call('POST', `/api/financial-data-hub/investment-statement/${docId}/account-match`, { json: { action: 'confirm_new', institution_name: 'FHIP Test Broker', masked_account_identifier: ECON_MASK, currency_code: 'AUD', owner_self: true } });
      show('account confirm_new', n.json?.data ?? n.json);
    } else if (!acct.json?.data?.owner_recorded) {
      const o = await call('POST', `/api/financial-data-hub/investment-statement/${docId}/account-match`, { json: { action: 'set_owner', owner_self: true } });
      show('set_owner', o.json?.data ?? o.json);
    }
    rv = await load();
    for (const p of rv.positions ?? []) {
      if (p.security_match_status === 'matched') continue;
      const s = await call('POST', `/api/financial-data-hub/investment-statement/${docId}/security-match`, { json: { table: 'fdh_investment_statement_positions', row_id: p.id, confirm_new_security: true, instrument_class: 'equity' } });
      show(`create security ${p.ticker_raw ?? p.security_name_raw}`, s.json?.data ?? s.json);
    }
    rv = await load();
    show('positions', (rv.positions ?? []).map((p: any) => [p.ticker_raw, p.quantity, p.market_value, p.security_match_status, p.apply_status]));
  },
  async 'broker-apply'() {
    const docId = need(state.brokerDoc as string, 'brokerDoc');
    const a = await call('POST', `/api/financial-data-hub/investment-statement/${docId}/approve`);
    show('approve', a.json?.data ?? a.json);
    const cmp = await call('GET', `/api/financial-data-hub/investment-statement/${docId}/current-vs-statement`);
    show('compare', cmp.json?.data?.rows);
    const ap = await call('POST', `/api/financial-data-hub/investment-statement/${docId}/apply`);
    show('apply', ap.json?.data ?? ap.json);
  },
  async 'broker-publish'() {
    const docId = need(state.brokerDoc as string, 'brokerDoc');
    const pv = await call('POST', `/api/financial-data-hub/investment-statement/${docId}/publish`, { json: { action: 'preview' } });
    const holdings = (pv.json?.data?.holdings ?? []) as any[];
    show('preview', holdings.map((h) => ({ snapshot_id: h.snapshot_id, name: h.name ?? h.instrument_name, value: h.value ?? h.market_value, published: h.published, eligibility: h.eligibility_status, dups: (h.duplicate_candidates ?? []).length })));
    const decisions = holdings.filter((h) => !h.published && h.eligibility_status !== 'NOT_ELIGIBLE').map((h) => ({ snapshot_id: h.snapshot_id, acknowledged_no_duplicate: false }));
    if (!decisions.length) { show('publish', 'nothing to publish'); return; }
    const pb = await call('POST', `/api/financial-data-hub/investment-statement/${docId}/publish`, { json: { action: 'publish', decisions } });
    show('publish', pb.json?.data ?? pb.json);
  },
  // ---------------------------------------------------------------- retirement (Retirement -> Import statement)
  async super() {
    const doc = DOCS.super;
    const up = await uploadCsv(doc);
    const d = up.json?.data ?? {};
    const docId = need(d.document_id ?? d.statement?.document_id, 'document_id');
    state.superDoc = docId; save();
    show('upload', { document_id: docId, pipeline_status: d.pipeline_status, keys: Object.keys(d) });
    const load = async () => (await call('GET', `/api/financial-data-hub/retirement-statement/${docId}`)).json ?? {};
    let rv: any = await load();
    const body = rv.data ?? rv;
    show('review', { keys: Object.keys(body), closing: body.statement?.closing_balance, account_match: body.statement?.account_match_status });
    const m = await call('POST', `/api/financial-data-hub/retirement-statement/${docId}/account-match`, { json: { action: 'auto' } });
    show('account-match auto', m.json);
    if (!(m.json?.outcome === 'matched' || m.json?.data?.outcome === 'matched')) {
      const n = await call('POST', `/api/financial-data-hub/retirement-statement/${docId}/account-match`, { json: { action: 'confirm_new' } });
      show('account-match confirm_new', n.json);
    }
    const ev = await call('POST', `/api/financial-data-hub/retirement-statement/${docId}/evidence-matches`);
    show('evidence-matches', ev.json);
    rv = await load();
    const b2 = rv.data ?? rv;
    show('activities', (b2.activities ?? []).map((a: any) => [a.activity_type, a.amount, a.match_status ?? a.bank_match_status ?? a.payslip_match_status]));
  },
  async 'super-apply'() {
    const docId = need(state.superDoc as string, 'superDoc');
    const a = await call('POST', `/api/financial-data-hub/retirement-statement/${docId}/approve`);
    show('approve', a.json);
    const p = await call('POST', `/api/financial-data-hub/retirement-statement/${docId}/proposal`);
    const body = p.json ?? {};
    const fields = (body.fields ?? body.data?.fields ?? []) as any[];
    const norm = fields.map((f) => ({ name: f.fieldName ?? f.field_name, proposed: f.proposedValue ?? f.proposed_value, rec: f.isRecommended ?? f.is_recommended, conf: f.requiresConfirmation ?? f.requires_confirmation }));
    show('proposal', { proposal_id: body.proposal_id ?? body.data?.proposal_id, mode: body.recommended_apply_mode, fields: norm });
    // The panel ticks every recommended field that needs no confirmation (D-12: contributions only when ticked).
    // D-12: contribution fields are offered unticked; this household's user ticks them (Household M types its
    // employer contribution too), so the ticked set is every recommended field plus the contribution pair.
    const selected = norm.filter((f) => (f.rec && !f.conf) || f.name === 'employer_contribution' || f.name === 'contribution_frequency').map((f) => f.name);
    const decision = (body.recommended_apply_mode ?? body.data?.recommended_apply_mode) === 'add_new' ? 'add_new' : 'update_existing';
    const ap = await call('POST', `/api/financial-data-hub/retirement-statement/${docId}/apply`, { json: { proposal_id: body.proposal_id ?? body.data?.proposal_id, decision, selected_fields: selected } });
    show('apply', ap.json);
  },
  // ---------------------------------------------------------------- WP-15 proposals (Assets bank balance, Expenses planned-from-actuals)
  async 'bank-balance'() {
    const g = await call('GET', '/api/assets/bank-balances');
    const items = (g.json?.data?.items ?? []) as any[];
    show('items', items);
    for (const it of items) {
      const accountId = it.accountId ?? it.account_id;
      const gen = await call('POST', '/api/assets/bank-balances', { json: { action: 'generate', accountId, targetAssetId: null } });
      const pid = gen.json?.data?.item?.proposalId ?? gen.json?.data?.item?.proposal_id;
      show('generate', gen.json?.data);
      if (!pid) continue;
      const ap = await call('POST', '/api/assets/bank-balances', { json: { action: 'apply', proposalId: pid, decision: 'add_new' } });
      show('apply', ap.json?.data ?? ap.json);
    }
  },
  async 'expense-averages'() {
    const g = await call('POST', '/api/expenses/planned-from-actuals', { json: { action: 'generate' } });
    show('generate', g.json?.data);
    const items = (g.json?.data?.items ?? g.json?.data?.proposals ?? []) as any[];
    const decisions = items.filter((i) => (i.proposalId ?? i.proposal_id) && (i.recommendation ?? i.recommended_action) !== 'keep')
      .map((i) => ({ proposalId: i.proposalId ?? i.proposal_id, decision: (i.recommendation ?? i.recommended_action) === 'update' ? 'update_existing' : 'add_new' }));
    show('decisions', decisions);
    if (!decisions.length) return;
    const ap = await call('POST', '/api/expenses/planned-from-actuals', { json: { action: 'apply', decisions } });
    show('apply', ap.json?.data ?? ap.json);
  },
  async state() {
    console.log(JSON.stringify(state, null, 1).slice(0, 4000));
  },
};

async function main() {
  const list = (step ?? '').split(',').filter(Boolean);
  if (!email || !port || !list.length || list.some((s) => !steps[s])) throw new Error(`usage: journey_i.ts --email e --port p --step <${Object.keys(steps).join('|')}>[,<step>...]`);
  for (const s of list) { console.log(`=== ${s}`); await steps[s](); }
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exitCode = 1; });
