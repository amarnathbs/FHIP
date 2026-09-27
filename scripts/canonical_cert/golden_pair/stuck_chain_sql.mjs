/**
 * Write the guarded DEV SQL the PO runs to remove the APPLIED liability-statement chains the service role
 * cannot delete (GP-H1; tests/unit/gpImportChainDeletion.test.ts proves the order on the real chain).
 *
 *   node scripts/canonical_cert/golden_pair/stuck_chain_sql.mjs --ledger A-gp --out scripts/canonical_cert/golden_pair/dev_residue_A_liability_chains.sql
 *
 * Only rows that (a) this run's ledger captured, (b) still exist on DEV now, (c) belong to the ledger's
 * user and (d) were NOT in the baseline are listed. Read-only against DEV.
 */
import fs from 'node:fs';
import { ResidueLedger } from '../lib/residueLedger.mjs';
import { loadDevEnv } from '../lib/env.mjs';

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const ORDER = ['fhip_import_applications', 'liabilities', 'fdh_liability_statements', 'fhip_import_proposals', 'fdh_financial_accounts', 'fdh_statement_uploads'];

async function main() {
  const L = ResidueLedger.open(arg('--ledger'));
  const [uid] = L.data.users;
  const { url, serviceKey, ref } = loadDevEnv();
  const h = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const byTable = {};
  for (const t of ORDER) {
    const base = new Set(L.data.baseline[uid].tables[t] ?? []);
    const keys = [...new Set(L.data.rows.filter((r) => r.table === t).map((r) => JSON.parse(r.key)[0]))].filter((id) => !base.has(JSON.stringify([id])));
    const present = [];
    for (let i = 0; i < keys.length; i += 100) {
      const r = await fetch(`${url}/rest/v1/${t}?select=id&user_id=eq.${uid}&id=in.(${keys.slice(i, i + 100).join(',')})`, { headers: h });
      if (!r.ok) throw new Error(`${t}: HTTP ${r.status}`);
      present.push(...(await r.json()).map((x) => x.id));
    }
    byTable[t] = present.sort();
  }
  const total = Object.values(byTable).reduce((s, v) => s + v.length, 0);
  const q = (ids) => ids.map((i) => `'${i}'`).join(', ');
  const lines = [
    `-- DEV ONLY (${ref}). Golden-pair certifier (range A, user ${uid}) residue the service role cannot delete (GP-H1).`,
    `-- ${total} rows: ${ORDER.map((t) => `${t} ${byTable[t].length}`).join(', ')}.`,
    '-- Every id was created by this certification run (never a baseline fixture row) and is scoped to the one user below.',
    '-- Order proven on the real migration chain: tests/unit/gpImportChainDeletion.test.ts.',
    '-- Run as ONE transaction in the DEV SQL editor; each DELETE must report the count in its comment, else ROLLBACK.',
    'begin;',
    "select set_config('fhip.import_bridge_internal_write', 'true', true);",
    ...ORDER.filter((t) => byTable[t].length).map((t) => `delete from ${t} where user_id = '${uid}' and id in (${q(byTable[t])}); -- expect ${byTable[t].length}`),
    'commit;',
    '',
  ];
  fs.writeFileSync(arg('--out'), lines.join('\n'));
  console.log(`wrote ${arg('--out')}: ${total} rows ${JSON.stringify(Object.fromEntries(ORDER.map((t) => [t, byTable[t].length])))}`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
