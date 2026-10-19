/* eslint-disable @typescript-eslint/no-explicit-any -- DEV harness: untyped PostgREST/HTTP JSON read back for scoring */
/**
 * DEV verification of the three PDF routes (liability, retirement, Australian investment) over the committed accuracy corpus
 * (docs/ai/pdf_routes_liab_ret_auinv/corpus), through the REAL routes of a local `next dev` wired to the DEV Supabase project
 * (vqycarelcoijzwlpkpcz ONLY), the DEV S3 + GuardDuty real scan, and the real gpt-4o-mini. Label for what this proves: DEV-verified.
 *
 * SAFETY
 *   - DEV only: every request asserts the DEV host; PRODUCTION_* values are never loaded.
 *   - NO password anywhere: PASSWORDLESS synthetic users (reserved @fhip-test.invalid domain), sessions minted with admin generate_link + verify,
 *     deleted in `finally`, residue re-counted.
 *   - Prints no secret and no document text. Ids are shown as 8 character prefixes.
 *   - Real provider spend: only the documents the certified readers cannot read reach the model (about US$0.0005 each).
 *
 * Run (server first, in another terminal):
 *   node scripts/pdf_routes_dev_server.mjs 3993
 *   npx tsx scripts/pdf_routes_dev_run.ts http://localhost:3993 [liability] [retirement] [au_investment] [LB-03 ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { devFetch, BASE, ANON, env, recordArtefact, makeChecker, assertDev } from './aie1_final_dev_harness.mjs';
import { fetchOwnerRequest, resolveSyntheticOwner } from './lib/syntheticOwner.mjs';
import {
  ALL_CORPUS_DOCS, buildCorpusPdf,
  type CorpusDocBase, type InvestmentExpected, type LiabilityExpected, type RetirementExpected,
} from './pdf_routes_corpus';

const APP = process.argv[2] ?? 'http://localhost:3993';
const selected = new Set(process.argv.slice(3));
const want = (d: CorpusDocBase) => selected.size === 0 || selected.has(d.cls) || selected.has(d.id);
const { check, summary } = makeChecker('PDF-ROUTES-DEV');
const RUN = `pdfroutes-${Date.now()}`;
const REF = new URL(BASE).host.split('.')[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const day = (offset: number) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);
const near = (a: unknown, b: number) => a !== null && a !== undefined && Math.abs(Number(a) - b) < 0.005;
const eqText = (a: unknown, b: string) => String(a ?? '').trim().toLowerCase() === b.trim().toLowerCase();
const OUT_DIR = path.resolve(process.cwd(), 'docs/ai/pdf_routes_liab_ret_auinv/evidence');

interface U { id: string; email: string; cookie: string; label: string }
const created: U[] = [];

async function makeUser(label: string, email: string): Promise<U> {
  assertDev(BASE);
  const c = await devFetch('/auth/v1/admin/users', { method: 'POST', body: { email, email_confirm: true } });
  const id = c.json?.id as string;
  if (!id) throw new Error(`create ${label} failed: ${c.status} ${c.text.slice(0, 120)}`);
  recordArtefact({ kind: 'auth_user', id, label, run: RUN });
  const prof = await devFetch(`/rest/v1/user_profiles?user_id=eq.${id}`, {
    method: 'PATCH', prefer: 'return=representation',
    body: { country_of_residence: 'AU', country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED', onboarding_completed: true },
  });
  if (!Array.isArray(prof.json) || prof.json.length !== 1) throw new Error(`profile ${label}: ${prof.status}`);
  const link = await devFetch('/auth/v1/admin/generate_link', { method: 'POST', body: { type: 'magiclink', email } });
  const hashed = link.json?.hashed_token ?? link.json?.properties?.hashed_token;
  if (!hashed) throw new Error(`generate_link ${label} failed: ${link.status}`);
  const v = await fetch(`${BASE}/auth/v1/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON }, body: JSON.stringify({ type: 'magiclink', token_hash: hashed }) });
  const s: any = await v.json();
  if (!s.access_token) throw new Error(`verify ${label} failed: ${v.status}`);
  const session = { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (s.expires_in ?? 3600), expires_in: s.expires_in ?? 3600, token_type: s.token_type ?? 'bearer', user: s.user };
  const encoded = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url');
  const name = `sb-${REF}-auth-token`;
  const CHUNK = 3180;
  const cookie = encoded.length <= CHUNK ? `${name}=${encoded}` : Array.from({ length: Math.ceil(encoded.length / CHUNK) }, (_, i) => `${name}.${i}=${encoded.slice(i * CHUNK, (i + 1) * CHUNK)}`).join('; ');
  const u = { id, email, cookie, label };
  created.push(u);
  return u;
}

async function setPlan(u: U, plan: 'free' | 'premium') {
  const body = plan === 'free' ? { plan_tier: 'free', effective_from: day(-1), effective_to: null } : { plan_tier: 'premium', effective_from: day(-30), effective_to: day(30) };
  const r = await devFetch(`/rest/v1/user_entitlements?user_id=eq.${u.id}`, { method: 'PATCH', prefer: 'return=representation', body });
  if (!Array.isArray(r.json) || r.json.length !== 1) throw new Error(`entitlement ${u.label}: ${r.status}`);
}

async function app(u: U | null, p: string, init: { method?: string; body?: BodyInit; json?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(u ? { Cookie: u.cookie } : {}), ...(init.headers ?? {}) };
  let body = init.body;
  if (init.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(init.json); }
  const res = await fetch(`${APP}${p}`, { method: init.method ?? 'GET', headers, body });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
const cron = async (p: string) => (await fetch(`${APP}${p}`, { method: 'POST', headers: { 'x-cron-secret': env.CRON_SECRET } })).status;
async function rows(table: string, filter: string, select = '*') {
  const r = await devFetch(`/rest/v1/${table}?${filter}&select=${select}`);
  return (Array.isArray(r.json) ? r.json : []) as any[];
}
const row = async (table: string, id: string) => (await rows(table, `id=eq.${id}`))[0] ?? null;
const attemptsFor = (userId: string) => rows('aie_ai_cost_attempt', `user_id=eq.${userId}`, 'idempotency_key,admission_outcome,reserved_usd,settled_usd,model,input_tokens,output_tokens,call_outcome');
async function storageHas(ref: string | null): Promise<boolean> {
  if (!ref) return false;
  const dir = ref.slice(0, ref.lastIndexOf('/'));
  const name = ref.slice(ref.lastIndexOf('/') + 1);
  const list = await devFetch('/storage/v1/object/list/fdh-source-documents', { method: 'POST', body: { prefix: dir, search: name, limit: 10 } });
  return Array.isArray(list.json) && list.json.some((o: any) => o.name === name);
}
async function ownerQuery(u: U, flow: string): Promise<Record<string, string>> {
  const owner = await resolveSyntheticOwner(fetchOwnerRequest(APP, u.cookie), 'self', flow);
  return { owner: JSON.stringify(owner) };
}

// ------------------------------------------------------------------------------------------------ per-class wiring
const FLOW = { liability: 'liability', retirement: 'retirement', au_investment: 'au_investment' } as const;
const ROUTE = { liability: 'liability-statement', retirement: 'retirement-statement', au_investment: 'investment-statement' } as const;

function uploadQuery(d: CorpusDocBase, owner: Record<string, string>): URLSearchParams {
  const q = new URLSearchParams(owner);
  if (d.cls === 'liability') {
    q.set('statement_type', d.declared.statement_type); q.set('country_code', d.declared.country); q.set('currency_code', d.declared.currency);
    if (d.declared.facility_type) q.set('facility_type', d.declared.facility_type);
  } else if (d.cls === 'retirement') {
    q.set('jurisdiction', d.declared.jurisdiction); q.set('currency_code', d.declared.currency);
  } else {
    q.set('csv_kind', d.declared.statement_kind); q.set('currency_code', 'AUD');
  }
  return q;
}
function processBody(d: CorpusDocBase): Record<string, string> {
  const q = Object.fromEntries(uploadQuery(d, {}).entries());
  return q;
}

async function waitForScan(documentId: string) {
  let r = await row('fdh_statement_uploads', documentId);
  const t0 = Date.now();
  while (r && r.processing_status === 'validating' && Date.now() - t0 < 240_000) {
    await sleep(3000);
    await cron('/api/financial-data-hub/documents/cron/malware-scan-sweep');
    r = await row('fdh_statement_uploads', documentId);
  }
  return { doc: r, waitMs: Date.now() - t0 };
}

async function uploadAndResolve(u: U, d: CorpusDocBase, bytesOverride?: Uint8Array) {
  const bytes = bytesOverride ?? new Uint8Array(buildCorpusPdf(d));
  const owner = await ownerQuery(u, FLOW[d.cls]);
  const q = uploadQuery(d, owner);
  const base = `/api/financial-data-hub/${ROUTE[d.cls]}`;
  const up = await app(u, `${base}/upload?${q.toString()}`, { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(bytes.length) } });
  let data = up.json?.data ?? null;
  const documentId = data?.document_id as string | undefined;
  if (documentId) recordArtefact({ kind: 'fdh_statement_uploads', id: documentId, userId: u.id, run: RUN });
  let scan: any = null;
  const pipeline = d.cls === 'retirement' ? data?.pipeline_status : data?.pipeline_status;
  if (documentId && pipeline === 'pending_scan') {
    scan = await waitForScan(documentId);
    const pr = await app(u, `${base}/${documentId}/process`, { method: 'POST', json: processBody(d) });
    data = pr.json?.data ?? null;
    return { up, data, documentId, scan, processStatus: pr.status };
  }
  return { up, data, documentId, scan, processStatus: null as number | null };
}

// ------------------------------------------------------------------------------------------------ scoring
type Score = { correct: number; total: number; misses: string[] };
const newScore = (): Score => ({ correct: 0, total: 0, misses: [] });
function sc(s: Score, label: string, ok: boolean) { s.total += 1; if (ok) s.correct += 1; else s.misses.push(label); }

function scoreLiability(e: LiabilityExpected, st: any, acts: any[]): Score {
  const s = newScore();
  const card = e.statementType === 'credit_card';
  sc(s, 'institution', eqText(st?.institution_name, e.institution));
  sc(s, 'last4', String(st?.masked_identifier ?? '').endsWith(e.last4));
  sc(s, 'periodStart', st?.statement_period_start === e.periodStart);
  sc(s, 'periodEnd', st?.statement_period_end === e.periodEnd);
  if (e.statementDate) sc(s, 'statementDate', st?.statement_date === e.statementDate);
  if (e.dueDate) sc(s, 'dueDate', st?.due_date === e.dueDate);
  sc(s, 'opening', near(card ? st?.opening_balance : st?.opening_principal, e.opening));
  sc(s, 'closing(printed)', near(card ? st?.closing_balance : st?.closing_principal, e.printedClosing));
  if (e.creditLimit !== undefined) sc(s, 'creditLimit', near(st?.credit_limit, e.creditLimit));
  if (e.minimumPayment !== undefined) sc(s, 'minimumPayment', near(st?.minimum_payment, e.minimumPayment));
  if (e.interestRate !== undefined) sc(s, 'interestRate', near(st?.interest_rate, e.interestRate));
  const used = new Set<number>();
  e.activities.forEach((x, i) => {
    const j = acts.findIndex((a, k) => !used.has(k) && near(a.amount, x.amount) && a.activity_date === x.date && a.activity_type === x.type);
    const k = j >= 0 ? j : acts.findIndex((a, kk) => !used.has(kk) && near(a.amount, x.amount));
    if (k >= 0) used.add(k);
    const a = k >= 0 ? acts[k] : null;
    sc(s, `act${i + 1}.date`, !!a && a.activity_date === x.date);
    sc(s, `act${i + 1}.type`, !!a && a.activity_type === x.type);
    sc(s, `act${i + 1}.amount`, !!a);
  });
  return s;
}

function scoreRetirement(e: RetirementExpected, st: any, acts: any[], pos: any[]): Score {
  const s = newScore();
  sc(s, 'fund', eqText(st?.fund_name, e.fund));
  sc(s, 'last4', String(st?.masked_account_identifier ?? '').endsWith(e.last4));
  sc(s, 'periodStart', st?.statement_start_date === e.periodStart);
  sc(s, 'periodEnd', st?.statement_end_date === e.periodEnd);
  sc(s, 'opening', near(st?.opening_balance, e.opening));
  sc(s, 'closing(printed)', near(st?.closing_balance, e.printedClosing));
  const figure = (label: string, scalar: unknown, expected: number | undefined, types: string[]) => {
    if (expected === undefined) return;
    const viaActivity = acts.some((a) => types.includes(a.activity_type) && near(a.amount, expected));
    sc(s, label, near(scalar, expected) || viaActivity);
  };
  figure('employer', st?.employer_contributions, e.employer, ['EMPLOYER_CONTRIBUTION']);
  figure('personal', st?.personal_contributions, e.personal, ['PERSONAL_CONTRIBUTION']);
  figure('salarySacrifice', st?.salary_sacrifice, e.salarySacrifice, ['SALARY_SACRIFICE']);
  figure('government', st?.government_contributions, e.government, ['GOVERNMENT_CONTRIBUTION']);
  figure('rolloversIn', st?.rollovers_in, e.rolloversIn, ['ROLLOVER_IN']);
  figure('earnings', st?.investment_earnings, e.earnings, ['INVESTMENT_EARNINGS', 'INTEREST']);
  figure('fees', st?.fees, e.fees, ['FEE']);
  figure('insurance', st?.insurance_premiums, e.insurance, ['INSURANCE_PREMIUM']);
  figure('tax', st?.tax, e.tax, ['TAX']);
  figure('withdrawals', st?.withdrawals, e.withdrawals, ['WITHDRAWAL']);
  figure('pensionPayments', st?.pension_payments, e.pensionPayments, ['PENSION_PAYMENT']);
  for (const o of e.options) {
    const p = pos.find((x) => eqText(x.option_name_raw, o.name));
    sc(s, `${o.name}.units`, !!p && near(p.units, o.units));
    sc(s, `${o.name}.price`, !!p && near(p.unit_price, o.unitPrice));
    sc(s, `${o.name}.value`, !!p && near(p.market_value, o.value));
  }
  const used = new Set<number>();
  e.activities.forEach((x, i) => {
    const k = acts.findIndex((a, kk) => !used.has(kk) && near(a.amount, x.amount));
    if (k >= 0) used.add(k);
    const a = k >= 0 ? acts[k] : null;
    sc(s, `act${i + 1}.date`, !!a && a.activity_date === x.date);
    sc(s, `act${i + 1}.type`, !!a && a.activity_type === x.type);
    sc(s, `act${i + 1}.amount`, !!a);
  });
  return s;
}

function scoreInvestment(e: InvestmentExpected, st: any, acts: any[], pos: any[]): Score {
  const s = newScore();
  sc(s, 'institution', eqText(st?.institution_name, e.institution));
  if (e.date) sc(s, 'date', st?.statement_date === e.date);
  if (e.periodStart) { sc(s, 'periodStart', st?.statement_start_date === e.periodStart); sc(s, 'periodEnd', st?.statement_end_date === e.periodEnd); }
  if (e.kind === 'holdings') {
    if (e.printedTotal !== undefined) sc(s, 'total', near(st?.closing_portfolio_value, e.printedTotal));
    if (e.cash !== undefined) sc(s, 'cash', near(st?.cash_balance, e.cash));
    const used = new Set<number>();
    e.holdings.forEach((h, i) => {
      const k = pos.findIndex((p, kk) => !used.has(kk) && (eqText(p.ticker_raw, h.code) || eqText(p.security_name_raw, h.name)) && near(p.market_value, h.value));
      const k2 = k >= 0 ? k : pos.findIndex((p, kk) => !used.has(kk) && (eqText(p.ticker_raw, h.code) || eqText(p.security_name_raw, h.name)));
      if (k2 >= 0) used.add(k2);
      const p = k2 >= 0 ? pos[k2] : null;
      sc(s, `h${i + 1}.name`, !!p && (eqText(p.security_name_raw, h.name) || eqText(p.ticker_raw, h.code)));
      sc(s, `h${i + 1}.quantity`, !!p && near(p.quantity, h.quantity));
      sc(s, `h${i + 1}.price`, !!p && near(p.unit_price, h.price));
      sc(s, `h${i + 1}.value`, !!p && near(p.market_value, h.value));
    });
  } else {
    const used = new Set<number>();
    e.transactions.forEach((t, i) => {
      const k = acts.findIndex((a, kk) => !used.has(kk) && near(a.amount, t.amount) && a.trade_date === t.date);
      const k2 = k >= 0 ? k : acts.findIndex((a, kk) => !used.has(kk) && near(a.amount, t.amount));
      if (k2 >= 0) used.add(k2);
      const a = k2 >= 0 ? acts[k2] : null;
      sc(s, `t${i + 1}.date`, !!a && a.trade_date === t.date);
      sc(s, `t${i + 1}.type`, !!a && a.activity_type === t.type);
      sc(s, `t${i + 1}.amount`, !!a);
      if (t.quantity !== null) sc(s, `t${i + 1}.quantity`, !!a && near(a.quantity, t.quantity));
      if (t.price !== null) sc(s, `t${i + 1}.price`, !!a && near(a.unit_price, t.price));
      if (t.brokerage !== null) sc(s, `t${i + 1}.brokerage`, !!a && near(a.brokerage_raw, t.brokerage));
    });
  }
  return s;
}

// ------------------------------------------------------------------------------------------------ confirm (what each panel posts)
async function confirmDraft(u: U, d: CorpusDocBase, documentId: string, draft: any) {
  const base = `/api/financial-data-hub/${ROUTE[d.cls]}/${documentId}/ai-fallback/confirm`;
  if (d.cls === 'liability') {
    const h = draft.header ?? {};
    const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    return app(u, base, { method: 'POST', json: {
      metadata: clean({
        statement_type: d.declared.statement_type, country_code: 'AU', currency_code: 'AUD', institution_name: h.institutionName, masked_identifier: h.maskedIdentifier,
        statement_period_start: h.statementPeriodStart, statement_period_end: h.statementPeriodEnd, statement_date: h.statementDate, due_date: h.dueDate,
        opening_balance: h.openingBalance, closing_balance: h.closingBalance, credit_limit: d.declared.statement_type === 'credit_card' ? h.creditLimit : undefined,
        minimum_payment: d.declared.statement_type === 'credit_card' ? h.minimumPayment : undefined, interest_rate: d.declared.statement_type === 'loan' ? h.interestRate : undefined,
      }),
      facilityType: d.declared.statement_type === 'credit_card' ? 'credit_card' : d.declared.facility_type,
      activities: draft.activities, aiWarnings: draft.warnings,
    } });
  }
  if (d.cls === 'retirement') return app(u, base, { method: 'POST', json: draft });
  return app(u, base, { method: 'POST', json: {
    csv_kind: d.declared.statement_kind, holdings: draft.holdings, activities: draft.activities, institutionName: draft.institutionName, maskedAccountIdentifier: null,
    statementDate: draft.statementDate, statementPeriodStart: draft.statementPeriodStart, statementPeriodEnd: draft.statementPeriodEnd,
  } });
}

async function evidenceFor(d: CorpusDocBase, documentId: string) {
  if (d.cls === 'liability') {
    const [st] = await rows('fdh_liability_statements', `statement_upload_id=eq.${documentId}`);
    const acts = st ? await rows('fdh_liability_statement_activities', `statement_id=eq.${st.id}`) : [];
    return { st, acts, pos: [] as any[] };
  }
  if (d.cls === 'retirement') {
    const [st] = await rows('fdh_retirement_statements', `statement_upload_id=eq.${documentId}`);
    const acts = st ? await rows('fdh_retirement_statement_activities', `statement_id=eq.${st.id}`) : [];
    const pos = st ? await rows('fdh_retirement_statement_positions', `statement_id=eq.${st.id}`) : [];
    return { st, acts, pos };
  }
  const [st] = await rows('fdh_investment_statements', `statement_upload_id=eq.${documentId}`);
  const acts = st ? await rows('fdh_investment_statement_activities', `statement_id=eq.${st.id}`) : [];
  const pos = st ? await rows('fdh_investment_statement_positions', `statement_id=eq.${st.id}`) : [];
  return { st, acts, pos };
}

const results: any[] = [];

async function runDoc(p1: U, d: CorpusDocBase) {
  const t0 = Date.now();
  const before = (await attemptsFor(p1.id)).length;
  const r = await uploadAndResolve(p1, d);
  const data = r.data;
  const documentId = r.documentId;
  const rec: any = { id: d.id, cls: d.cls, role: d.role, http: r.up.status, pipeline: data?.pipeline_status ?? null, failureKind: data?.failure_kind ?? data?.error_message ?? null, expected: d.route };
  if (!documentId) { rec.verdict = 'NO DOCUMENT'; results.push(rec); check(`${d.id} produced a document`, false, `${r.up.status} ${r.up.text.slice(0, 160)}`); return; }
  const scanDoc = (await row('fdh_statement_uploads', documentId));
  rec.scan = { status: scanDoc?.malware_scan_status, boundToObject: !!scanDoc?.malware_scan_object_ref?.ref?.versionId && scanDoc.malware_scan_object_ref.ref.versionId === scanDoc.malware_scan_object_ref.expected?.expectedVersionId };
  let path_ = 'refused';
  let aiAttemptDelta = (await attemptsFor(p1.id)).length - before;
  const exp = (d as any).expected;
  let score: Score | null = null;
  if (data?.pipeline_status === 'ok') path_ = 'deterministic';
  if (data?.pipeline_status === 'ai_fallback_available') {
    path_ = 'ai';
    rec.draftCounts = { activities: data.ai_fallback_draft?.activities?.length ?? null, holdings: data.ai_fallback_draft?.holdings?.length ?? null, positions: data.ai_fallback_draft?.positions?.length ?? null };
    rec.draftWarnings = data.ai_fallback_draft?.warnings ?? data.ai_fallback_draft?.pdfWarnings ?? [];
    const stillStored = scanDoc?.raw_document_storage_reference ? await storageHas(scanDoc.raw_document_storage_reference) : false;
    rec.originalDeletedWhileDraftPending = !stillStored && scanDoc?.raw_document_purge_status === 'purged';
    const c = await confirmDraft(p1, d, documentId, data.ai_fallback_draft);
    rec.confirmHttp = c.status;
    if (c.status !== 200) rec.confirmError = (c.json?.error ?? c.text).toString().slice(0, 200);
  }
  if (data?.pipeline_status === 'duplicate_statement') path_ = 'duplicate';
  rec.path = path_;
  const ev = await evidenceFor(d, documentId);
  if (ev.st) {
    rec.reconciliation = ev.st.reconciliation_status ?? null;
    rec.reviewStatus = ev.st.review_status ?? null;
    rec.warnings = (ev.st.extraction_warnings ?? []).length;
    if (exp) {
      score = d.cls === 'liability' ? scoreLiability(exp, ev.st, ev.acts) : d.cls === 'retirement' ? scoreRetirement(exp, ev.st, ev.acts, ev.pos) : scoreInvestment(exp, ev.st, ev.acts, ev.pos);
      rec.score = { correct: score.correct, total: score.total, misses: score.misses };
    }
    const certified = ev.st.reconciliation_status === 'reconciled' && path_ === 'deterministic' && (ev.st.review_status === 'not_required' || d.cls === 'au_investment') && (d.cls !== 'au_investment' || (ev.st.extraction_warnings ?? []).length === 0);
    rec.outcome = certified ? 'certified' : 'review_required';
  } else {
    rec.outcome = 'refused';
  }
  const after = await row('fdh_statement_uploads', documentId);
  rec.originalDeleted = !(await storageHas(after?.raw_document_storage_reference ?? null)) && after?.raw_document_purge_status === 'purged';
  rec.docStatus = after?.processing_status;
  rec.errorCode = after?.error_code ?? null;
  const att = await attemptsFor(p1.id);
  aiAttemptDelta = att.length - before;
  rec.modelCalls = aiAttemptDelta;
  rec.latencyMs = Date.now() - t0;
  // ---- verdict against the corpus expectation
  const expectPath = d.route.outcome === 'refused' ? 'refused' : d.route.aiRequired ? 'ai' : 'deterministic';
  const pathOk = path_ === expectPath;
  const outcomeOk = rec.outcome === d.route.outcome;
  const reconOk = d.route.reconciliation === null || rec.reconciliation === d.route.reconciliation;
  const callsOk = d.route.aiRequired ? aiAttemptDelta === 1 : aiAttemptDelta === 0;
  rec.verdict = pathOk && outcomeOk && reconOk && callsOk && rec.originalDeleted ? 'MATCHES EXPECTATION' : 'DIFFERS';
  rec.checks = { pathOk, outcomeOk, reconOk, callsOk, originalDeleted: rec.originalDeleted };
  results.push(rec);
  check(`${d.id} (${d.role}): path ${path_} (expected ${expectPath}), outcome ${rec.outcome} (expected ${d.route.outcome}), reconciliation ${rec.reconciliation ?? 'n/a'}, model calls ${aiAttemptDelta}, original deleted ${rec.originalDeleted}${score ? `, fields ${score.correct}/${score.total}` : ''}`,
    rec.verdict === 'MATCHES EXPECTATION', JSON.stringify({ misses: score?.misses, confirm: rec.confirmHttp, pipeline: rec.pipeline, fk: rec.failureKind, doc: rec.docStatus, err: rec.errorCode }).slice(0, 300));
  return { rec, documentId };
}

async function main() {
  console.log(`=== PDF ROUTES on DEV (${RUN}) against ${APP} ===`);
  if ((await fetch(`${APP}/login`).then((r) => r.status).catch(() => 0)) === 0) throw new Error('app not reachable: start scripts/pdf_routes_dev_server.mjs first');
  const ledgerStart = (await rows('aie_ai_cost_ledger', 'id=eq.global'))[0];
  const evidence: Record<string, any> = { run: RUN, app: APP, startedAt: new Date().toISOString(), ledgerStart: { settled: ledgerStart?.settled_usd, reserved: ledgerStart?.reserved_usd } };
  try {
    // One Premium person per class: the upload lifecycle allows 20 upload sessions per person per hour and the corpus has 25 documents.
    const byClass = {
      liability: await makeUser('P-liability', `pdfroutes-pl-${Date.now()}@fhip-test.invalid`),
      retirement: await makeUser('P-retirement', `pdfroutes-pr-${Date.now()}@fhip-test.invalid`),
      au_investment: await makeUser('P-investment', `pdfroutes-pa-${Date.now()}@fhip-test.invalid`),
    } as const;
    const p2 = await makeUser('P2-other-tenant', `pdfroutes-p2-${Date.now()}@fhip-test.invalid`);
    const f1 = await makeUser('F1-free', `pdfroutes-f1-${Date.now()}@fhip-test.invalid`);
    for (const u of Object.values(byClass)) await setPlan(u, 'premium');
    await setPlan(p2, 'premium'); await setPlan(f1, 'free');

    // ---------------- Free refusal: before the body is stored, scanned, read or sent anywhere
    for (const cls of ['liability', 'retirement', 'au_investment'] as const) {
      const d = ALL_CORPUS_DOCS.find((x) => x.cls === cls && x.role === 'clean')!;
      const bytes = new Uint8Array(buildCorpusPdf(d));
      const owner = await ownerQuery(f1, FLOW[cls]);
      const q = uploadQuery(d, owner);
      const res = await app(f1, `/api/financial-data-hub/${ROUTE[cls]}/upload?${q.toString()}`, { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(bytes.length) } });
      const docs = await rows('fdh_statement_uploads', `user_id=eq.${f1.id}`);
      const att = await attemptsFor(f1.id);
      check(`FREE ${cls}: PDF upload refused 403 PREMIUM_REQUIRED, no document row, no scan, no model attempt`, res.status === 403 && res.json?.code === 'PREMIUM_REQUIRED' && docs.length === 0 && att.length === 0, `${res.status} ${JSON.stringify(res.json).slice(0, 120)} docs=${docs.length} attempts=${att.length}`);
    }

    // ---------------- the corpus, as P1
    const docResults: Array<{ rec: any; documentId: string } | undefined> = [];
    for (const d of ALL_CORPUS_DOCS.filter(want)) docResults.push(await runDoc(byClass[d.cls], d));
    evidence.results = results;

    // ---------------- replay, identical re-upload, cross-tenant (first AI document that ran)
    const firstAi = docResults.find((x) => x?.rec.path === 'ai');
    if (firstAi) {
      const d = ALL_CORPUS_DOCS.find((x) => x.id === firstAi.rec.id)!;
      const p1 = byClass[d.cls];
      const beforeCalls = (await attemptsFor(p1.id)).length;
      const again = await uploadAndResolve(p1, d);
      const afterCalls = (await attemptsFor(p1.id)).length;
      check(`REPLAY ${d.id}: a byte-identical re-upload makes NO second model call and carries on with the original`, afterCalls === beforeCalls && (again.data?.duplicate_of_document_id === firstAi.documentId || again.data?.pipeline_status === 'duplicate_statement'), JSON.stringify({ calls: afterCalls - beforeCalls, dup: again.data?.duplicate_of_document_id === firstAi.documentId, pipeline: again.data?.pipeline_status }));
      const replayConfirm = await confirmDraft(p1, d, firstAi.documentId, { activities: [], header: {}, holdings: [], positions: [], warnings: [] });
      check(`REPLAY ${d.id}: confirming the same draft again is refused and charges nothing`, replayConfirm.status >= 400 && (await attemptsFor(p1.id)).length === afterCalls, `${replayConfirm.status}`);
      const foreign = await app(p2, `/api/financial-data-hub/${ROUTE[d.cls]}/${firstAi.documentId}`);
      const foreignConfirm = await confirmDraft(p2, d, firstAi.documentId, { activities: [], header: {}, holdings: [], positions: [], warnings: [] });
      check(`CROSS-TENANT ${d.id}: person B can neither read nor confirm person A's statement`, [403, 404].includes(foreign.status) && foreignConfirm.status >= 400, `${foreign.status}/${foreignConfirm.status}`);
    }

    // ---------------- spend summary for the run
    const att = (await Promise.all(Object.values(byClass).map((u) => attemptsFor(u.id)))).flat();
    evidence.spend = { attempts: att.length, settledUsd: att.reduce((a, x) => a + Number(x.settled_usd ?? 0), 0), models: [...new Set(att.map((x) => x.model))], tokens: att.reduce((a, x) => a + Number(x.input_tokens ?? 0) + Number(x.output_tokens ?? 0), 0), keyPrefixes: [...new Set(att.map((x) => String(x.idempotency_key).split(':')[0]))] };
    check('SPEND: every model call was gpt-4o-mini, attributed to a PDF-route key prefix, and cost well under the US$1 daily cap', att.every((x) => x.model === 'gpt-4o-mini' && /-pdf-ai-fallback$/.test(String(x.idempotency_key).split(':')[0])) && evidence.spend.settledUsd < 1, JSON.stringify(evidence.spend));
  } finally {
    // cleanup: delete synthetic users (cascades), then re-count residue
    const residue: Record<string, number> = {};
    for (const u of created) await devFetch(`/auth/v1/admin/users/${u.id}`, { method: 'DELETE' });
    for (const u of created) {
      for (const t of ['fdh_statement_uploads', 'fdh_liability_statements', 'fdh_retirement_statements', 'fdh_investment_statements', 'fdh_ai_fallback_drafts']) {
        const left = await rows(t, `user_id=eq.${u.id}`, 'id');
        residue[t] = (residue[t] ?? 0) + left.length;
      }
    }
    evidence.residueAfterCleanup = residue;
    const ledgerEnd = (await rows('aie_ai_cost_ledger', 'id=eq.global'))[0];
    evidence.ledgerEnd = { settled: ledgerEnd?.settled_usd, reserved: ledgerEnd?.reserved_usd };
    check('CLEANUP: synthetic users deleted and no residue rows left', Object.values(residue).every((n) => n === 0), JSON.stringify(residue));
    evidence.finishedAt = new Date().toISOString();
    evidence.results = results;
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10).split('-').reverse().join('-');
    fs.writeFileSync(path.join(OUT_DIR, `dev_run_${stamp}.json`), JSON.stringify(evidence, null, 2) + '\n');
    // per-class accuracy table (printed and saved)
    const lines: string[] = [];
    for (const cls of ['liability', 'retirement', 'au_investment']) {
      const rs = results.filter((r) => r.cls === cls);
      const scored = rs.filter((r) => r.score);
      const c = scored.reduce((a, r) => a + r.score.correct, 0);
      const t = scored.reduce((a, r) => a + r.score.total, 0);
      lines.push(`${cls}: documents ${rs.length}; matches expectation ${rs.filter((r) => r.verdict === 'MATCHES EXPECTATION').length}; fields correct ${c}/${t}; certified ${rs.filter((r) => r.outcome === 'certified').length}; review_required ${rs.filter((r) => r.outcome === 'review_required').length}; refused ${rs.filter((r) => r.outcome === 'refused').length}; model calls ${rs.reduce((a, r) => a + (r.modelCalls ?? 0), 0)}`);
    }
    console.log('\n' + lines.join('\n'));
    fs.writeFileSync(path.join(OUT_DIR, `dev_run_${stamp}_accuracy.txt`), lines.join('\n') + '\n');
  }
  summary();
}

main().catch((e) => { console.error(e); process.exit(1); });
