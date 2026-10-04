// Factsheet benchmark reader: dry run on a STORED SAMPLE. Read-only: no network, no database, no AI, nothing is written.
//
// It runs the deterministic extraction and the change-detection / auto-publish decision on text you already hold and
// prints what the reader would conclude. With no arguments it runs the four synthetic fixtures that mimic the benchmark
// sections of the four research funds (tests/fixtures/factsheet-benchmark-reader/). The fixtures are hand-written, not
// fund-house documents.
//
//   npx tsx scripts/factsheet_reader_sample_dry_run.ts
//   npx tsx scripts/factsheet_reader_sample_dry_run.ts --file path/to/extracted-text.txt --source sbi_contra_sid_2025_10
//
// --source is a registry source key (see FACTSHEET_SOURCE_SEED); the scheme name and document type come from it.
import fs from 'node:fs';
import path from 'node:path';
import { dryRunOnSample } from '../lib/services/investment-intelligence/factsheetReader/sampleDryRun';

const FIX = path.resolve(__dirname, '..', 'tests', 'fixtures', 'factsheet-benchmark-reader');
const DEFAULTS: Array<{ file: string; source: string }> = [
  { file: 'hdfc_balanced_advantage_sid.txt', source: 'hdfc_baf_sid_2024_06' },
  { file: 'sbi_multi_asset_allocation_factsheet.txt', source: 'sbi_multi_asset_factsheet_2026_04' },
  { file: 'sbi_contra_factsheet.txt', source: 'sbi_contra_factsheet_2025_08' },
  { file: 'nippon_power_infra_presentation.txt', source: 'nippon_power_infra_presentation' },
];

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = flag('--file');
const source = flag('--source');
const runs = file && source ? [{ file: path.resolve(file), source }] : DEFAULTS.map((d) => ({ file: path.join(FIX, d.file), source: d.source }));

for (const r of runs) {
  const text = fs.readFileSync(r.file, 'utf8');
  const out = dryRunOnSample({ text, sourceKey: r.source });
  console.log(`\n== ${path.basename(r.file)}  (source: ${r.source})`);
  for (const line of out.summary) console.log(`   ${line}`);
  if (out.decision.action === 'new_version' && out.decision.version.reviewReason) console.log(`   Why: ${out.decision.version.reviewReason}`);
}
console.log('\nDry run only: nothing was fetched, nothing was written.');
