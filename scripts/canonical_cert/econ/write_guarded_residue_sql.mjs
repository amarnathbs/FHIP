/**
 * Writes the DEV SQL the PO runs to remove the residue the service role CANNOT delete: each applied
 * liability chain (liability <-> its last application <-> proposal, the statement / upload / facility
 * account that reference the liability). Their FK ON DELETE SET NULL actions fire the 0096 authoritative-
 * write guards, which only the transaction-local GUC fhip.import_bridge_internal_write lets through.
 * Ids come from `residue.mjs verify` output (only rows that did NOT exist at baseline).
 *
 *   node scripts/canonical_cert/econ/write_guarded_residue_sql.mjs .canonical-cert/econ/verify1.json .canonical-cert/econ/verify2.json > out.sql
 */
import fs from 'node:fs';

const ids = {};
for (const f of process.argv.slice(2)) {
  const v = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const d of v.diffs) {
    if (d.missing.length) throw new Error(`${f}: baseline rows MISSING in ${d.table} -- not residue, refusing`);
    if (d.extra.length !== d.after - d.before) throw new Error(`${f}: ${d.table} diff truncated (${d.extra.length} of ${d.after - d.before})`);
    (ids[d.table] ??= []).push(...d.extra.map((k) => JSON.parse(k)[0]));
  }
}
const ORDER = ['fhip_import_applications', 'fhip_import_proposals', 'liabilities', 'fdh_liability_statements', 'fdh_financial_accounts', 'fdh_statement_uploads'];
const unknown = Object.keys(ids).filter((t) => !ORDER.includes(t));
if (unknown.length) throw new Error(`unexpected residue tables: ${unknown.join(', ')}`);
const total = Object.values(ids).reduce((s, a) => s + a.length, 0);
const lines = [
  '-- DEV ONLY (vqycarelcoijzwlpkpcz). Economic-oracle certifier (range B) residue the service role cannot delete.',
  `-- ${total} rows: ${ORDER.map((t) => `${t} ${ids[t]?.length ?? 0}`).join(', ')}.`,
  '-- Each is a row created by the certification run (never a baseline fixture row: verify reported 0 missing).',
  '-- Run as ONE transaction in the DEV SQL editor. Expected: every DELETE reports the count in its comment.',
  'begin;',
  "select set_config('fhip.import_bridge_internal_write', 'true', true);",
];
for (const t of ORDER) {
  const list = ids[t] ?? [];
  if (!list.length) continue;
  lines.push(`delete from ${t} where id in (${list.map((i) => `'${i}'`).join(', ')}); -- expect ${list.length}`);
}
lines.push('commit;', '');
process.stdout.write(lines.join('\n'));
