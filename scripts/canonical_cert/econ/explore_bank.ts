/** Exploration: upload a bank CSV for a user and print what the pipeline produced (types, review state). */
import { call, uploadBankCsv, bankTxns, csvBank, MONTH, select } from './lib';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = arg('--email')!;
const rowsJson = arg('--rows')!;
const masked = arg('--masked') ?? 'xxxx9001';

async function main() {
  const rows = JSON.parse(rowsJson) as { date: string; description: string; amount: number }[];
  const { csv } = csvBank(rows, 10000);
  const res = await uploadBankCsv(email, csv, { country_code: 'AU', currency_code: 'AUD', masked_identifier: masked, owner_role: 'self', statement_period_start: MONTH.from, statement_period_end: MONTH.to }, `explore-${masked}.csv`);
  console.log(JSON.stringify({ documentId: res.documentId, upload: res.upload, process: res.process, categorise: res.categorise }, null, 1).slice(0, 3000));
  const users = await select('fdh_statement_uploads', (q) => q.select('user_id, processing_status, financial_account_id').eq('id', res.documentId));
  const txns = await bankTxns(users[0].user_id, res.documentId);
  console.log(JSON.stringify(txns, null, 1));
  const rv = await call(email, 'GET', `/api/financial-data-hub/documents/${res.documentId}/category-review`);
  console.log('category-review', rv.status, rv.text.slice(0, 3000));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
