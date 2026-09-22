import fs from 'node:fs';
import path from 'node:path';
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js';
import { II_STORAGE_BUCKET } from '@/lib/services/investment-intelligence/storage';

const envFile = path.join(path.resolve(process.cwd()), '.env.local');
const env: Record<string, string> = {};
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^([A-Za-z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const admin = createSupabaseJsClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const userId = process.argv[2];
if (!userId) { console.error('usage: nav1_cleanup_orphaned_user.ts <userId>'); process.exit(1); }

async function main() {
  console.log(`cleaning up orphaned test user ${userId}`);
  await admin.from('ii_capital_gains_computations').delete().eq('user_id', userId).then(() => {}, () => {});
  await admin.from('ii_tax_lot_consumptions').delete().eq('user_id', userId).then(() => {}, () => {});
  await admin.from('ii_tax_lots').delete().eq('user_id', userId).then(() => {}, () => {});
  const { data: accIds } = await admin.from('ii_accounts').select('id').eq('user_id', userId);
  const accountIds = (accIds ?? []).map((r: any) => r.id);
  console.log('accounts:', accountIds);
  if (accountIds.length > 0) {
    await admin.from('ii_portfolio_truth_status').delete().in('account_id', accountIds);
    await admin.from('ii_holding_snapshots').delete().in('account_id', accountIds);
    await admin.from('ii_transactions').delete().in('account_id', accountIds);
  }
  await admin.from('ii_reconciliation_cases').delete().eq('user_id', userId);
  await admin.from('ii_transaction_source_links').delete().eq('user_id', userId).then(() => {}, () => {});
  const { data: docIds } = await admin.from('ii_source_documents').select('id, storage_path').eq('user_id', userId);
  console.log('source documents:', docIds);
  for (const d of docIds ?? []) {
    await admin.storage.from(II_STORAGE_BUCKET).remove([d.storage_path as string]).then(() => {}, () => {});
  }
  await admin.from('ii_document_parse_runs').delete().eq('user_id', userId).then(() => {}, () => {});
  await admin.from('ii_source_documents').delete().eq('user_id', userId);
  await admin.from('ii_accounts').delete().eq('user_id', userId);
  const { data: hhIds } = await admin.from('households').select('id').eq('user_id', userId);
  console.log('households:', hhIds);
  for (const hh of hhIds ?? []) {
    await admin.from('household_members').delete().eq('household_id', hh.id as string);
  }
  await admin.from('households').delete().eq('user_id', userId);
  const { error: delErr } = await admin.auth.admin.deleteUser(userId);
  console.log('auth user delete error (expect null):', delErr?.message ?? null);

  // Also remove the orphaned provisional instrument this run minted, and any
  // NAV rows / import batches it may have touched -- this instrument was
  // created ONLY by this test run's own defect-triggering upload, it is not
  // a real user's data and not part of PC6's real reference catalogue.
  const ORPHAN_INSTRUMENT_ID = '8d89c612-b192-49f1-9ada-fd872288b742';
  const { data: orphanCheck } = await admin.from('ii_instruments').select('id, instrument_name, status, created_at').eq('id', ORPHAN_INSTRUMENT_ID).maybeSingle();
  console.log('orphan instrument found:', JSON.stringify(orphanCheck));
  if (orphanCheck) {
    await admin.from('ii_instrument_identifiers').delete().eq('instrument_id', ORPHAN_INSTRUMENT_ID);
    await admin.from('ii_prices_nav').delete().eq('instrument_id', ORPHAN_INSTRUMENT_ID);
    const { error: instErr } = await admin.from('ii_instruments').delete().eq('id', ORPHAN_INSTRUMENT_ID);
    console.log('orphan instrument delete error (expect null):', instErr?.message ?? null);
  }

  // Independent re-verification.
  console.log('\n--- independent zero-residue verification ---');
  for (const table of ['ii_accounts', 'ii_transactions', 'ii_source_documents', 'ii_portfolio_truth_status', 'households', 'ii_holding_snapshots']) {
    const { count } = await admin.from(table).select('id', { count: 'exact', head: true }).eq('user_id', userId);
    console.log(`  ${table}: ${count}`);
  }
  const { data: authUser } = await admin.auth.admin.getUserById(userId).catch(() => ({ data: null }) as any);
  console.log('  auth user still exists:', !!authUser?.user);
  const { data: orphanRecheck } = await admin.from('ii_instruments').select('id').eq('id', ORPHAN_INSTRUMENT_ID).maybeSingle();
  console.log('  orphan instrument still exists:', !!orphanRecheck);
}

main();
