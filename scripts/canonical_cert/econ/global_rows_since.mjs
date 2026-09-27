/**
 * Residue check for tables WITHOUT a user column (the residue ledger only diffs user-scoped tables):
 * lists every relation that has no USER_COLUMNS column but has created_at, and counts rows created
 * at or after --since. Read-only (service role GET).
 *
 *   node scripts/canonical_cert/econ/global_rows_since.mjs --since 2026-09-26T23:40:00Z
 */
import { loadDevEnv } from '../lib/env.mjs';
import { USER_COLUMNS } from '../lib/residueLedger.mjs';

const since = process.argv[process.argv.indexOf('--since') + 1];
const { url, serviceKey } = loadDevEnv();
const hdr = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
const defs = (await (await fetch(`${url}/rest/v1/`, { headers: hdr })).json()).definitions ?? {};
const out = [];
for (const [table, v] of Object.entries(defs)) {
  const props = v.properties ?? {};
  if (USER_COLUMNS.some((c) => props[c])) continue;
  const tsCol = ['created_at', 'inserted_at', 'recorded_at'].find((c) => props[c]);
  if (!tsCol) continue;
  const r = await fetch(`${url}/rest/v1/${table}?select=${tsCol}&${tsCol}=gte.${encodeURIComponent(since)}&limit=1`, { headers: { ...hdr, Prefer: 'count=exact', Range: '0-0' } });
  if (!r.ok) { out.push({ table, error: r.status }); continue; }
  const count = Number((r.headers.get('content-range') ?? '*/0').split('/')[1]);
  if (count > 0) out.push({ table, tsCol, count });
}
console.log(JSON.stringify({ since, tablesWithNewRows: out }, null, 1));
