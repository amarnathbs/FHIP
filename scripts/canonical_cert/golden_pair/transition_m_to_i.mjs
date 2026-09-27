/**
 * Golden pair SETUP between phases (DEV, service role): after Household M has been measured, take the rows
 * M's journey CREATED (not baseline rows -- those are already neutralised) out of the household the same
 * way neutralise.mjs takes the baseline out: is_active = false, master_item_key = null. This lets Household
 * I run on the SAME user with an empty balance sheet again, while everything else (profile, insurance,
 * goals, household) stays identical across both phases.
 *
 *   node scripts/canonical_cert/golden_pair/transition_m_to_i.mjs --ledger A-gpfinal2 --email <e>
 *
 * Only rows that are (a) currently active, (b) NOT in the ledger baseline key set are touched. Every one is
 * recorded into the ledger via recordGlobal-equivalent tracking (they are new rows, so residue.mjs
 * captureNew() will already see them; this script only flips is_active so cleanup still finds and deletes
 * them at the end).
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
    const activeRows = await (await fetch(`${url}/rest/v1/${t}?user_id=eq.${uid}&is_active=eq.true&select=id`, { headers: h })).json();
    let n = 0;
    for (const row of activeRows) {
      const key = JSON.stringify([row.id]);
      if (baseKeys.has(key)) continue; // baseline rows are already handled by neutralise.mjs
      const r = await fetch(`${url}/rest/v1/${t}?id=eq.${row.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ is_active: false, master_item_key: null }) });
      if (!r.ok) throw new Error(`${t} ${row.id}: HTTP ${r.status} ${await r.text()}`);
      if ((await r.json()).length === 1) n++;
    }
    const chk = await fetch(`${url}/rest/v1/${t}?user_id=eq.${uid}&is_active=eq.true&select=id`, { headers: h });
    console.log(`${t}: ${activeRows.length} active pre-transition, ${n} non-baseline set inactive; active now = ${(await chk.json()).length}`);
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
