/**
 * Golden pair SETUP (DEV, service role): take the fixture user's STANDING register rows out of the household
 * (is_active = false) so Household M and Household I both start from an empty balance sheet and an empty
 * budget. Everything else about the user (profile, insurance, goals, household) stays identical for both
 * phases, which is why the pair is run on ONE user, sequentially.
 *
 *   node scripts/canonical_cert/golden_pair/neutralise.mjs --ledger A-gp --email <e>
 *
 * Every row is saved in the residue ledger (snapshotRows) BEFORE it is changed, so `residue.mjs cleanup`
 * restores it and `residue.mjs verify` checks it column by column. Only rows that exist at the ledger
 * baseline are touched (never a row a journey created).
 */
import { ResidueLedger } from '../lib/residueLedger.mjs';
import { loadDevEnv } from '../lib/env.mjs';

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const TABLES = ['income_sources', 'expense_items', 'liabilities', 'assets', 'investments', 'retirement_accounts'];

async function main() {
  const L = ResidueLedger.open(arg('--ledger'));
  const [uid] = L.data.users;
  if (!uid) throw new Error('ledger has no baseline user');
  const { url, serviceKey } = loadDevEnv();
  const h = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  for (const t of TABLES) {
    const baseKeys = new Set(L.data.baseline[uid].tables[t] ?? []);
    const already = L.data.updated.some((u) => u.table === t);
    if (!already) await L.snapshotRows(t, `user_id=eq.${uid}&select=*`, ['id']);
    const saved = L.data.updated.filter((u) => u.table === t);
    let n = 0;
    for (const s of saved) {
      if (!baseKeys.has(s.key)) throw new Error(`${t} ${s.key} is not a baseline row -- refusing`);
      const r = await fetch(`${url}/rest/v1/${t}?id=eq.${s.row.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ is_active: false }) });
      if (!r.ok) throw new Error(`${t} ${s.row.id}: HTTP ${r.status} ${await r.text()}`);
      if ((await r.json()).length === 1) n++;
    }
    const chk = await fetch(`${url}/rest/v1/${t}?user_id=eq.${uid}&is_active=eq.true&select=id`, { headers: h });
    console.log(`${t}: ${saved.length} standing rows saved, ${n} set inactive; active now = ${(await chk.json()).length}`);
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
