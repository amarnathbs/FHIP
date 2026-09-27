/* eslint-disable @typescript-eslint/no-explicit-any -- certification harness: untyped JSON route responses */
// Copied unchanged from origin/feature/canonical-cert-economic-oracles (6d6b6d4) scripts/canonical_cert/econ/lib.ts for the range-D security review journeys.
/**
 * Economic-oracle certifier (range B) -- shared journey helpers.
 *
 * Every BEHAVIOUR under test goes through the real localhost app routes as the signed-in user
 * (`api()` from lib/session.mjs). The service-role client here is used ONLY to observe rows
 * (read-only selects) and never to write.
 */
import fs from 'node:fs';
import path from 'node:path';
import { api } from '../lib/session.mjs';
import { serviceClient } from '../lib/env.mjs';

export const PORT = Number(process.env.CERT_PORT ?? 3102);
export const OUT_DIR = path.resolve(process.cwd(), '.canonical-cert', 'econ');
fs.mkdirSync(OUT_DIR, { recursive: true });

export type ApiResult = { status: number; json: any; text: string };

export async function call(email: string, method: string, route: string, opts: Record<string, unknown> = {}): Promise<ApiResult> {
  const r = await api(email, method, route, { port: PORT, ...opts });
  return { status: r.status, json: r.json, text: r.text };
}

let svcP: Promise<any> | null = null;
/** Service-role client: OBSERVATION ONLY (selects). */
export function svc(): Promise<any> {
  if (!svcP) svcP = serviceClient();
  return svcP;
}

export async function select(table: string, build: (q: any) => any): Promise<any[]> {
  const sb = await svc();
  const { data, error } = await build(sb.from(table));
  if (error) throw new Error(`observe ${table}: ${error.message}`);
  return data ?? [];
}

export function expect(cond: boolean, label: string, detail?: unknown): boolean {
  const line = `${cond ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`;
  console.log(line);
  results.push({ ok: cond, label, detail });
  return cond;
}
export const results: { ok: boolean; label: string; detail?: unknown }[] = [];

export function saveEvidence(name: string, data: unknown) {
  fs.writeFileSync(path.join(OUT_DIR, `${name}.json`), JSON.stringify(data, null, 2));
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------------------------
// Measurement through the app's own read surfaces (routes), as the user.
// ---------------------------------------------------------------------------------------------
export interface Figures {
  expenses: { actualMonthly: number; combinedMonthly: number; plannedMonthly: number; actualTotalInWindow: number; nonSpending: Record<string, { totalInWindow: number; count: number; monthly: number }>; unknownPendingCount: number; refundsNetted: number; refundsUnlinked: number; coveredMonths: string[]; lineCount: number } | { unavailable: string };
  income: { countedMonthly: number; representedCount: number; grossMonthly: number; netMonthly: number | null; netKnownMonthly: number; lines: number; raw: any } | { unavailable: string };
  dashboard: { grossMonthlyIncome: number; netMonthlyIncome: number; totalMonthlyExpenses: number; debtMonthlyRepayments: number; costOfDebtMonthly: number | null; monthlySurplus: number; totalLiabilities: number; netWorth: number; totalAssets: number; totalInvestments: number; totalRetirement: number; retirementEmployerMonthlyContribution: number | null; retirementPersonalMonthlyContribution: number | null; totalMonthlyExpensesPlusDebt: number; basis: string | null; unknownPendingCount: number | null; bankBalanceEvidence: unknown; importedNotInNetWorth: unknown } | { unavailable: string };
}

export async function measure(email: string): Promise<Figures> {
  const e = await call(email, 'GET', '/api/expenses/actuals?pageSize=500');
  const i = await call(email, 'GET', '/api/income/actuals');
  const d = await call(email, 'GET', '/api/dashboard/summary');
  const ed = e.json?.data;
  const id = i.json?.data;
  const dd = d.json?.data;
  const expenses: Figures['expenses'] = e.status !== 200 || ed?.status !== 'ok'
    ? { unavailable: `HTTP ${e.status} ${ed?.reason ?? e.text.slice(0, 200)}` }
    : {
      actualMonthly: ed.totals.actualMonthly, combinedMonthly: ed.totals.combinedMonthly, plannedMonthly: ed.totals.plannedMonthly,
      actualTotalInWindow: ed.totals.actualTotalInWindow,
      nonSpending: Object.fromEntries(ed.nonSpending.map((b: any) => [b.bucket, { totalInWindow: b.totalInWindow, count: b.count, monthly: b.monthly }])),
      unknownPendingCount: ed.unknownPendingCount, refundsNetted: ed.refundsNetted.totalInWindow, refundsUnlinked: ed.refundsUnlinked.totalInWindow,
      coveredMonths: ed.window.coveredMonths, lineCount: ed.lineCount,
    };
  const income: Figures['income'] = i.status !== 200 || id?.status !== 'ok'
    ? { unavailable: `HTTP ${i.status} ${id?.reason ?? i.text.slice(0, 200)}` }
    : {
      countedMonthly: id.actual?.countedMonthly ?? id.countedMonthly ?? NaN,
      representedCount: id.actual?.representedCount ?? id.representedCount ?? NaN,
      grossMonthly: id.combined?.grossMonthly ?? NaN, netMonthly: id.combined?.netMonthly ?? null, netKnownMonthly: id.combined?.netKnownMonthly ?? NaN,
      lines: (id.actual?.lines ?? id.lines ?? []).length, raw: id,
    };
  const dashboard: Figures['dashboard'] = d.status !== 200 || !dd
    ? { unavailable: `HTTP ${d.status} ${d.text.slice(0, 200)}` }
    : {
      grossMonthlyIncome: dd.grossMonthlyIncome, netMonthlyIncome: dd.netMonthlyIncome, totalMonthlyExpenses: dd.totalMonthlyExpenses,
      debtMonthlyRepayments: dd.debtMonthlyRepayments, costOfDebtMonthly: dd.dataStatus?.costOfDebtMonthly ?? null,
      retirementEmployerMonthlyContribution: dd.retirementEmployerMonthlyContribution ?? null, retirementPersonalMonthlyContribution: dd.retirementPersonalMonthlyContribution ?? null,
      totalMonthlyExpensesPlusDebt: round2((dd.totalMonthlyExpenses ?? 0) + (dd.debtMonthlyRepayments ?? 0)),
      basis: dd.dataStatus?.basis ?? null, unknownPendingCount: dd.dataStatus?.unknownPendingCount ?? null,
      bankBalanceEvidence: dd.dataStatus?.bankBalanceEvidence ?? null, importedNotInNetWorth: dd.dataStatus?.importedNotInNetWorth ?? null,
      monthlySurplus: dd.monthlySurplus, totalLiabilities: dd.totalLiabilities, netWorth: dd.netWorth,
      totalAssets: dd.totalAssets, totalInvestments: dd.totalInvestments, totalRetirement: dd.totalRetirement,
    };
  return { expenses, income, dashboard };
}

export function num(v: unknown): number { return typeof v === 'number' ? v : NaN; }

/** delta of a numeric path between two Figures objects. */
export function delta(before: any, after: any, pathStr: string): number {
  const get = (o: any) => pathStr.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
  return round2(num(get(after)) - num(get(before)));
}

// ---------------------------------------------------------------------------------------------
// Bank statement journey (the Expenses -> Import Bank Statement panel's request sequence).
// ---------------------------------------------------------------------------------------------
export async function uploadBankCsv(email: string, csv: string, query: Record<string, string>, filename: string) {
  const qs = new URLSearchParams({ ...query, filename });
  const up = await call(email, 'POST', `/api/financial-data-hub/bank-csv/upload?${qs}`, { body: new TextEncoder().encode(csv), contentType: 'text/csv' });
  if (up.status >= 300) throw new Error(`bank upload HTTP ${up.status}: ${up.text.slice(0, 300)}`);
  const documentId = up.json?.data?.document_id as string;
  if (up.json?.data?.duplicate_of_document_id) return { documentId, duplicateOf: up.json.data.duplicate_of_document_id as string, upload: up.json.data };
  const det = await call(email, 'POST', `/api/financial-data-hub/bank-csv/${documentId}/detect`);
  if (det.status >= 300) throw new Error(`detect HTTP ${det.status}: ${det.text.slice(0, 300)}`);
  const proc = await call(email, 'POST', `/api/financial-data-hub/bank-csv/${documentId}/process`);
  if (proc.status >= 300) throw new Error(`process HTTP ${proc.status}: ${proc.text.slice(0, 300)}`);
  const cat = await call(email, 'POST', '/api/financial-data-hub/bank-transactions/categorise');
  return { documentId, duplicateOf: null as string | null, upload: up.json.data, process: proc.json?.data, categorise: { status: cat.status, data: cat.json?.data } };
}

export async function bankTxns(userId: string, documentId: string) {
  return select('fdh_transactions', (q) => q.select('id, transaction_date, description_clean, description_raw, amount_original, credit_debit, economic_transaction_type, category_id, subcategory_id, approval_status, dedup_status, user_override, financial_account_id, classification_method').eq('user_id', userId).eq('statement_upload_id', documentId).order('transaction_date'));
}

export async function categoryIdByKey(key: string): Promise<string> {
  const rows = await select('fdh_categories', (q) => q.select('id, category_key').eq('category_key', key));
  if (!rows[0]) throw new Error(`no fdh_categories row ${key}`);
  return rows[0].id;
}

export async function listCategories() {
  return select('fdh_categories', (q) => q.select('id, category_key, display_name, default_economic_type:fhip_mapping_key').order('category_key'));
}

export async function reviewSummary(email: string, documentId: string) {
  return call(email, 'GET', `/api/financial-data-hub/documents/${documentId}/category-review`);
}

export function csvBank(rows: { date: string; description: string; amount: number }[], opening: number): { csv: string; closing: number } {
  let bal = Math.round(opening * 100);
  const lines = ['Date,Description,Amount,Balance'];
  for (const r of rows) { bal += Math.round(r.amount * 100); lines.push([r.date, r.description, r.amount.toFixed(2), (bal / 100).toFixed(2)].join(',')); }
  return { csv: lines.join('\n') + '\n', closing: bal / 100 };
}

export const MONTH = { from: '2026-08-01', to: '2026-08-31' };
