// FDH-14 read-only schema probe. Uses service role key to check table/column
// existence in the live DEV Supabase project via PostgREST. NO writes, NO
// row-level data reads (select head-only where possible). Safe to run
// repeatedly; deletes nothing, inserts nothing.
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(url, key, { auth: { persistSession: false } });

const tables = [
  // FDH-1
  'fdh_financial_accounts', 'fdh_source_documents', 'fdh_processing_jobs', 'fdh_transactions',
  // FDH-2
  'fdh_categories', 'fdh_subcategories', 'fdh_mcc_codes', 'fdh_institutions', 'fdh_merchants', 'fdh_merchant_aliases', 'fdh_classification_rules', 'fdh_user_classification_rules',
  // FDH-3
  'fdh_upload_sessions', 'fdh_document_audit_events',
  // R7/FDH-4
  'fdh_bank_statement_uploads', 'fdh_bank_transactions',
  // R8/FDH-6
  'fdh_transaction_links', 'fdh_recurring_transactions',
  // FDH-7
  'fdh_transaction_allocations',
  // FDH-9 + import bridge
  'fdh_payroll_events', 'fhip_import_proposals', 'fhip_import_applications',
  // FDH-10
  'fdh_liability_statements', 'fdh_liability_statement_transactions',
  // FDH-11
  'fdh_investment_statements', 'fdh_investment_statement_activities', 'fdh_investment_statement_positions',
  // FDH-12
  'fdh_retirement_statements', 'fdh_retirement_statement_activities',
  // canonical modules FDH feeds
  'income_sources', 'liabilities', 'retirement_accounts', 'ii_transactions', 'ii_holding_snapshots',
];

const results = [];
for (const t of tables) {
  const { error, count } = await supabase.from(t).select('*', { count: 'exact', head: true });
  results.push({ table: t, exists: !error, error: error ? `${error.code}:${error.message}`.slice(0, 90) : null, count: count ?? null });
}

for (const r of results) {
  console.log(`${r.exists ? 'OK  ' : 'MISS'}  ${r.table.padEnd(38)} ${r.exists ? `rows=${r.count}` : r.error}`);
}
const missing = results.filter((r) => !r.exists);
console.log(`\n${results.length - missing.length}/${results.length} tables exist in live DEV.`);
if (missing.length) console.log('MISSING:', missing.map((m) => m.table).join(', '));
