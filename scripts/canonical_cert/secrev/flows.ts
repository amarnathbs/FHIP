/* eslint-disable @typescript-eslint/no-explicit-any -- certification harness: untyped JSON route responses */
// Copied unchanged from origin/feature/canonical-cert-economic-oracles (6d6b6d4) scripts/canonical_cert/econ/flows.ts for the range-D security review journeys.
/**
 * Economic-oracle certifier (range B): the app's own request sequences for each import panel,
 * as reusable steps. Every call goes through the localhost app as the signed-in user.
 */
import { call, uploadBankCsv, bankTxns, csvBank, select, MONTH } from './lib';

export const CATEGORY = {
  credit_card_payment: 'f1013425-8d4a-41ce-8d0e-4f4a324dc8ce',
  transfer_own_account: 'fedc2fe5-41f4-40b7-9fbb-5967533a2e91',
  loan_principal: '526c3f27-34b7-4fb7-b273-0f76a096ffc7',
  income: '0c046122-43e8-431d-94e2-527e734377b1',
  shopping: '353434dd-02e2-43da-a33a-433ece2b8a18',
  food: '5a8ba467-eaf4-4f68-82d5-07ed36931cd0',
  investment_purchase: '3718cf25-df9b-4aad-abfe-695f340e6c68',
  investment_sale: 'e2a6490a-a552-409c-b013-0f9192b8745a',
  cash_withdrawal: 'fcd2c33d-2def-47c7-99a2-91d046712836',
  financial_fees: 'a3d96cce-303f-4c1a-851d-7182187ca0f9',
  retirement_contribution: '80183af8-95a0-48f4-b546-a7a615495557',
  utilities: '8b36f085-487d-4f3e-afa6-2a95dc5a3d43',
} as const;

export async function userIdOf(email: string): Promise<string> {
  const { loadSession } = await import('../lib/session.mjs');
  return loadSession(email).userId as string;
}

export interface BankRowSpec { date: string; description: string; amount: number; category?: keyof typeof CATEGORY | null }

/**
 * Upload -> detect -> process -> categorise, then the user's category choice per row (set-category),
 * then approve-all. Rows with category === null are deliberately left undecided.
 */
export async function importAndApproveBank(email: string, rows: BankRowSpec[], opts: { masked: string; period?: { from: string; to: string }; opening?: number; filename: string; approve?: boolean; ownerRole?: string }) {
  const period = opts.period ?? MONTH;
  const { csv, closing } = csvBank(rows, opts.opening ?? 10000);
  const up = await uploadBankCsv(email, csv, { country_code: 'AU', currency_code: 'AUD', masked_identifier: opts.masked, owner_role: opts.ownerRole ?? 'self', statement_period_start: period.from, statement_period_end: period.to }, opts.filename);
  const userId = await userIdOf(email);
  const txns = await bankTxns(userId, up.documentId);
  const decisions: { id: string; description: string; category: string; status: number; type?: string }[] = [];
  for (const spec of rows) {
    if (!spec.category) continue;
    const t = txns.find((x: any) => x.description_raw === spec.description && Number(x.amount_original) === Math.abs(spec.amount));
    if (!t) throw new Error(`no transaction for ${spec.description}`);
    const r = await call(email, 'POST', `/api/financial-data-hub/bank-transactions/${t.id}/set-category`, { json: { category_id: CATEGORY[spec.category] } });
    decisions.push({ id: t.id, description: spec.description, category: spec.category, status: r.status, type: r.json?.data?.economic_transaction_type });
  }
  let approve: { status: number; json: any } | null = null;
  if (opts.approve !== false) approve = await call(email, 'POST', `/api/financial-data-hub/documents/${up.documentId}/category-review/approve-all`);
  const after = await bankTxns(userId, up.documentId);
  return { documentId: up.documentId, closing, process: up.process, categorise: up.categorise, decisions, approve: approve && { status: approve.status, json: approve.json }, txns: after };
}

export async function uploadLiabilityCsv(email: string, lines: string[], query: Record<string, string>, filename: string) {
  const qs = new URLSearchParams({ ...query, filename });
  const up = await call(email, 'POST', `/api/financial-data-hub/liability-statement/upload?${qs}`, { body: new TextEncoder().encode(lines.join('\n') + '\n'), contentType: 'text/csv' });
  if (up.status !== 200 || !up.json?.data?.statement_id) throw new Error(`liability upload HTTP ${up.status}: ${up.text.slice(0, 400)}`);
  const documentId = up.json.data.document_id as string;
  const review = await call(email, 'GET', `/api/financial-data-hub/liability-statement/${documentId}`);
  return { documentId, statementId: up.json.data.statement_id as string, statement: review.json?.data?.statement, activities: review.json?.data?.activities ?? [], bankCandidates: review.json?.data?.bank_candidates ?? [] };
}

export async function approveAndPropose(email: string, documentId: string) {
  const ap = await call(email, 'POST', `/api/financial-data-hub/liability-statement/${documentId}/approve`);
  const pr = await call(email, 'POST', `/api/financial-data-hub/liability-statement/${documentId}/proposal`);
  return { approve: { status: ap.status, json: ap.json }, proposal: { status: pr.status, json: pr.json }, proposalId: pr.json?.data?.proposal_id as string | undefined, fields: (pr.json?.data?.fields ?? []) as any[] };
}

export function liabilityApplyRoute(proposalId: string) { return `/api/financial-data-hub/liability-proposals/${proposalId}/apply`; }

export async function rowsFor(table: string, userId: string, cols = '*', extra?: (q: any) => any) {
  return select(table, (q) => { let x = q.select(cols).eq('user_id', userId); if (extra) x = extra(x); return x; });
}
