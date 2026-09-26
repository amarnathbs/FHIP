/**
 * Harness self-test / worked example: one real journey through the LOCALHOST app as a signed-in
 * fixture user -- upload the synthetic oracle bank CSV, detect, process -- exactly the request sequence
 * components/expenses/BankStatementImportPanel.tsx sends. Nothing here writes to the database directly.
 *
 *   npx tsx scripts/canonical_cert/smoke_journey.ts --email <signed-in email> --port 3970 [--salt Z] [--month 2026-08]
 *
 * Prerequisites: dev_server.mjs running on --port; residue.mjs baseline + prepare done for the email
 * (prepare signs the user in and confirms the fixture country through the app route).
 */
import { oracleBankStatement, parseMonth, previousCompleteMonth } from './documents/builders';
import { api } from './lib/session.mjs';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = arg('--email');
const port = Number(arg('--port'));
if (!email || !port) throw new Error('usage: smoke_journey.ts --email <email> --port <port> [--salt Z] [--month YYYY-MM]');
const month = arg('--month') ? parseMonth(arg('--month')!) : previousCompleteMonth();
const doc = oracleBankStatement(month, arg('--salt') ?? 'Z');

type ApiResult = { status: number; json: { data?: Record<string, unknown>; error?: string } | null; text: string };
const call = async (method: string, route: string, opts: Record<string, unknown> = {}): Promise<ApiResult> => api(email, method, route, { port, ...opts });

async function main() {
  const qs = new URLSearchParams({ ...doc.upload.query, filename: doc.filename });
  const up = await call('POST', `/api/financial-data-hub/bank-csv/upload?${qs}`, { body: doc.bytes, contentType: 'text/csv' });
  console.log(`upload -> HTTP ${up.status} ${up.json?.error ?? ''}`);
  const documentId = up.json?.data?.document_id as string | undefined;
  if (!documentId) { console.log(up.text.slice(0, 400)); process.exitCode = 1; return; }
  console.log(`document_id ${documentId}; account_resolution ${String(up.json?.data?.account_resolution)}; duplicate_of ${String(up.json?.data?.duplicate_of_document_id ?? null)}`);

  const det = await call('POST', `/api/financial-data-hub/bank-csv/${documentId}/detect`);
  console.log(`detect -> HTTP ${det.status} status=${String(det.json?.data?.detection_status ?? det.json?.data?.status ?? '')} ${det.json?.error ?? ''}`);

  const proc = await call('POST', `/api/financial-data-hub/bank-csv/${documentId}/process`);
  const d = proc.json?.data ?? {};
  console.log(`process -> HTTP ${proc.status} ${proc.json?.error ?? ''}`);
  console.log(JSON.stringify({ transactions_created: d.transactions_created, rejected_rows: d.rejected_rows, declared_row_count: d.declared_row_count, parsed_row_count: d.parsed_row_count, reconciliation_status: d.reconciliation_status, processing_status: d.processing_status }));
  if (d.transactions_created !== doc.oracle.rows) { console.error(`FAIL: ${String(d.transactions_created)} transactions created, oracle ${String(doc.oracle.rows)}`); process.exitCode = 1; }
  console.log(`oracle: ${JSON.stringify({ rows: doc.oracle.rows, closingBalance: doc.oracle.closingBalance })}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
