// DEV only. Removes the rows a journey created for ONE fixture user (by user_id), so the journey can be re-run from a clean state.
//   node scripts/nav2_stage3/reset_user.mjs holder [--dry]
// Deletes: investments created by publishing, publications, tax rows, reconciliation cases, truth/holding/transaction rows, report versions
// (and their pins/render tokens by cascade), accounts, parse runs, stored files and source documents of THAT user. Does not touch
// anything of another user, the shared NAV table, instruments, or the audit log (append-only; reported as residue).
import { db, USERS, userIdOf } from './_lib.mjs';
const key = process.argv[2];
const dry = process.argv.includes('--dry');
if (!USERS[key]) throw new Error('usage: reset_user.mjs <holder|other|free|spare|admin> [--dry]');
const userId = await userIdOf(USERS[key]);
console.log(`reset ${key} (${USERS[key]}) ${userId.slice(0, 8)} ${dry ? 'DRY RUN' : ''}`);
const del = async (table, col = 'user_id', val = userId) => {
  const c = await db.from(table).select('*', { count: 'exact', head: true }).eq(col, val);
  if (c.error) { console.log(`  ${table}: skipped (${c.error.message.slice(0, 50)})`); return; }
  if (!dry && (c.count ?? 0) > 0) { const r = await db.from(table).delete().eq(col, val); if (r.error) console.log(`  ${table}: DELETE FAILED ${r.error.message}`); }
  console.log(`  ${table}: ${c.count}`);
};
const pubs = (await db.from('ii_fhip_publications').select('published_row_id, publication_target').eq('user_id', userId)).data ?? [];
const invIds = pubs.filter((p) => p.publication_target === 'investments' && p.published_row_id).map((p) => p.published_row_id);
console.log(`  investments created by publishing: ${invIds.length}`);
if (!dry && invIds.length) {
  await db.from('goal_funding_sources').delete().in('investment_id', invIds).then(() => {}, () => {});
  const r = await db.from('investments').delete().in('id', invIds).eq('user_id', userId);
  if (r.error) console.log('  investments DELETE FAILED', r.error.message);
}
{
  // also the inactive rows a FAILED publish leaves behind (the publish compensation deactivates, it does not delete)
  const accs = ((await db.from('ii_accounts').select('id').eq('user_id', userId)).data ?? []).map((a) => a.id);
  if (accs.length) {
    const orphan = await db.from('investments').select('id', { count: 'exact', head: true }).eq('user_id', userId).in('ii_canonical_account_id', accs);
    console.log(`  investments tied to those accounts (published or left by a failed publish): ${orphan.count}`);
    if (!dry && (orphan.count ?? 0) > 0) { await db.from('ii_fhip_publications').delete().eq('user_id', userId); await db.from('investments').delete().eq('user_id', userId).in('ii_canonical_account_id', accs); }
  }
}
for (const t of ['ii_goal_allocations', 'ii_fhip_publications', 'ii_tax_lot_consumptions', 'ii_capital_gains_computations', 'ii_tax_lots', 'ii_reconciliation_cases', 'ii_portfolio_truth_status', 'ii_holding_snapshots', 'ii_transaction_source_links', 'ii_transactions', 'ii_investment_date_inputs', 'nav2_fund_analytics_reports', 'ii_analytics_results']) await del(t);
const accIds = ((await db.from('ii_accounts').select('id').eq('user_id', userId)).data ?? []).map((a) => a.id);
if (accIds.length) { const r = await db.from('ii_ownership_allocation').select('*', { count: 'exact', head: true }).in('ii_account_id', accIds); console.log(`  ii_ownership_allocation: ${r.count ?? 'n/a'}`); if (!dry) await db.from('ii_ownership_allocation').delete().in('ii_account_id', accIds).then(() => {}, () => {}); }
await del('ii_accounts');
const docs = (await db.from('ii_source_documents').select('id, storage_path').eq('user_id', userId)).data ?? [];
if (!dry) {
  const bucket = db.storage.from('investment-source-documents');
  const listed = (await bucket.list(userId, { limit: 1000 })).data ?? [];
  const keys = [...new Set([...docs.map((d) => d.storage_path).filter(Boolean), ...listed.map((f) => `${userId}/${f.name}`)])];
  if (keys.length) await bucket.remove(keys);
  console.log(`  stored files removed: ${keys.length}`);
}
await del('ii_document_parse_runs');
await del('ii_source_documents');
const audit = await db.from('ii_audit_events').select('*', { count: 'exact', head: true }).eq('user_id', userId);
console.log(`  ii_audit_events left in place (append-only): ${audit.count}`);
