// D-6 DEV proof (read only): how many DISTINCT instruments the accepted 30-section statement ended on, per table, and the open review cases.
//   node scripts/nav2_rc/d6_distinct_instruments.mjs
import { db, USERS, userIdOf } from '../nav2_stage3/_lib.mjs';
const uid = await userIdOf(USERS.admin);
const d = async (t) => { const { data } = await db.from(t).select('instrument_id').eq('user_id', uid); return { rows: data?.length ?? 0, distinct: new Set((data ?? []).map((x) => x.instrument_id)).size }; };
for (const t of ['ii_portfolio_truth_status', 'ii_holding_snapshots', 'ii_transactions']) console.log(t.padEnd(30), JSON.stringify(await d(t)));
const { data: cases } = await db.from('ii_reconciliation_cases').select('discrepancy_type, status').eq('user_id', uid);
console.log('reconciliation cases:', JSON.stringify(cases ?? []));
