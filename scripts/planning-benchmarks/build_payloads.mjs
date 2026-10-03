// Offline: turns the first-load CSV files into one payload JSON for the console runner.
// No network, no database. The only input from the target environment is the metric id map produced by
// scripts/planning-benchmarks/export_metric_ids.sql (a read-only SELECT the PO runs in the SQL editor).
//
//   node scripts/planning-benchmarks/build_payloads.mjs --ids metric_ids.json [--dir docs/planning-benchmarks/first_load] [--out first_load_payload.json]
//
// metric_ids.json is the JSON the SQL returns: either {"metric_code":"uuid",...} or the array form
// [{"metric_code":"...","id":"..."}].
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadImportSet, buildPayload } from './firstLoadPayload.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const dir = path.resolve(opt('dir', path.join(ROOT, 'docs', 'planning-benchmarks', 'first_load')));
const idsFile = opt('ids');
const outFile = path.resolve(opt('out', 'first_load_payload.json'));
if (!idsFile) {
  console.error('missing --ids <metric_ids.json> (see export_metric_ids.sql)');
  process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(idsFile, 'utf8'));
const metricIds = Array.isArray(raw) ? Object.fromEntries(raw.map((r) => [r.metric_code, r.id])) : raw;

const set = loadImportSet(dir);
const payload = buildPayload(set, metricIds);
payload.generatedFrom = path.relative(ROOT, dir).replace(/\\/g, '/');
fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
console.log(
  JSON.stringify({
    out: outFile,
    sources: payload.sources.length,
    datasets: payload.datasets.length,
    cohorts: payload.cohorts.length,
    values: payload.values.length,
    targetRanges: payload.targetRanges.length,
    skippedDraftFiles: set.files.drafts,
  })
);
