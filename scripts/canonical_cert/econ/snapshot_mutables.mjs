/**
 * Economic-oracle certifier (range B): save full copies of every PRE-EXISTING fixture row that a
 * journey might UPDATE (an Apply that edits a register row, the Dashboard's financial_snapshots
 * upsert, ...), so `residue.mjs cleanup` restores them and `verify` checks them column by column.
 *
 *   node scripts/canonical_cert/econ/snapshot_mutables.mjs --ledger B-econ1
 */
import { ResidueLedger } from '../lib/residueLedger.mjs';

const args = process.argv.slice(2);
const ledgerId = args[args.indexOf('--ledger') + 1];
if (!ledgerId || args.indexOf('--ledger') < 0) throw new Error('usage: snapshot_mutables.mjs --ledger <id>');
const L = ResidueLedger.open(ledgerId);
if (!L.data.baseline) throw new Error('run residue.mjs baseline first');
const TABLES = [
  'financial_snapshots', 'income_sources', 'expense_items', 'liabilities', 'assets', 'retirement_accounts',
  'investments', 'households', 'household_members', 'retirement_members', 'user_goals', 'goal_funding_sources',
];
const already = new Set(L.data.updated.map((u) => `${u.table}|${u.key}`));
let saved = 0;
for (const u of L.data.users) {
  for (const t of TABLES) {
    const before = L.data.updated.length;
    await L.snapshotRows(t, `user_id=eq.${u}&select=*`, ['id']);
    // de-duplicate if this script is re-run
    const fresh = L.data.updated.slice(before);
    L.data.updated.length = before;
    for (const f of fresh) if (!already.has(`${f.table}|${f.key}`)) { L.data.updated.push(f); already.add(`${f.table}|${f.key}`); saved++; }
  }
}
L.save();
console.log(`saved ${saved} pre-existing rows; ledger now restores ${L.data.updated.length} rows`);
