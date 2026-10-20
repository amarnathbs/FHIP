// D-6 DEV proof, idempotency: process the SAME accepted statement again, with a forced re-parse, and show that nothing was duplicated.
//   node scripts/nav2_rc/d6_reprocess.mjs
import { api, db, logoutAll, USERS, userIdOf } from '../nav2_stage3/_lib.mjs';
const uid = await userIdOf(USERS.admin);
const count = async () => {
  const out = {};
  for (const t of ['ii_portfolio_truth_status', 'ii_holding_snapshots', 'ii_transactions', 'ii_reconciliation_cases', 'ii_accounts']) out[t] = (await db.from(t).select('id', { count: 'exact', head: true }).eq('user_id', uid)).count;
  out.instruments = new Set(((await db.from('ii_portfolio_truth_status').select('instrument_id').eq('user_id', uid)).data ?? []).map((x) => x.instrument_id)).size;
  return out;
};
try {
  const before = await count();
  const { data: docs } = await db.from('ii_source_documents').select('id').eq('user_id', uid).order('created_at', { ascending: false }).limit(1);
  const id = docs[0].id;
  const r = await api(USERS.admin, 'POST', `/api/investment-intelligence/source-documents/${id}/process`, { json: { forceReparse: true } });
  console.log('process again:', r.status, r.text.slice(0, 120));
  const after = await count();
  console.log('before', JSON.stringify(before));
  console.log('after ', JSON.stringify(after));
  console.log(JSON.stringify(before) === JSON.stringify(after) ? 'IDEMPOTENT: identical counts' : 'DIFFERENT counts');
} finally { await logoutAll(); }
