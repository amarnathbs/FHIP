// READ-ONLY DEV validation of the production first-load files.
//
// Reads the reference tables of DEV (the host MUST be vqycarelcoijzwlpkpcz; the script refuses any other host and never
// reads a PRODUCTION_ variable) with the PUBLIC anon key, exactly as the Allowed values lists do, then runs every shipped
// file through the real upload validator with those live lists (datasets, metrics, cohorts, the 0277 mapping).
// No write of any kind. No secret is printed or stored.
//
// Run:  npx tsx scripts/planning-benchmarks/validateProductionFirstLoadDev.ts
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { loadAllowedValues } from '../../lib/planning-benchmarks/allowedValues';
import { todayIsoUtc } from '../../lib/planning-benchmarks/dayFirst';
import { buildProductionFirstLoad, sha256 } from './buildProductionFirstLoad';
import { checkBytes, readShippedFile, runNegativeControls, withCohortsActivated } from './productionFirstLoadValidate';

const DEV_HOST = 'vqycarelcoijzwlpkpcz.supabase.co';
const envFile = process.env.ENV_FILE ?? 'D:/FHIP/.env.local';
const env: Record<string, string> = {};
for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = /^(NEXT_PUBLIC_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_ANON_KEY)=(.*)$/.exec(line); // only these two names are ever read
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const url = env.NEXT_PUBLIC_SUPABASE_URL;
if (!url || new URL(url).host !== DEV_HOST) throw new Error(`Refusing to run: the Supabase host is not DEV (${DEV_HOST}).`);
console.log(`Host verified: ${new URL(url).host} (DEV). Read-only, anon key.`);

async function main() {
  const supabase = createClient(url, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const today = todayIsoUtc();
  const av = await loadAllowedValues(supabase, today);
  if (av.state !== 'ok') throw new Error('lists unavailable: ' + av.reason);
  console.log(`DEV lists read on ${today}: ${av.counts.datasetsTotal} datasets (${av.counts.datasetsOpen} open), ${av.counts.metricsTotal} metrics, ${av.counts.cohortsTotal} cohorts, mapping installed=${av.mapping.installed} pairs=${av.mapping.pairs}; all lists complete=${Object.values(av.complete).every(Boolean)}`);

  const built = buildProductionFirstLoad();
  const cohortsFile = built.files.find((f) => f.kind === 'cohorts')!;
  const afterCohorts = withCohortsActivated(av, cohortsFile);
  let blockers = 0;
  let blockersAfterCohorts = 0;
  for (const f of built.files) {
    const bytes = readShippedFile(f.fileName);
    if (sha256(bytes) !== f.sha256) throw new Error(`${f.fileName}: the file on disk differs from the generator output. Run the generator again.`);
    const asIs = checkBytes(f.fileName, f.kind, bytes, av, today);
    const after = checkBytes(f.fileName, f.kind, bytes, afterCohorts, today);
    blockers += asIs.errors.length;
    blockersAfterCohorts += after.errors.length;
    console.log(`\n${f.fileName}  [${f.kind}]  dataset "${asIs.datasetName}" v${asIs.datasetVersion}`);
    console.log(`  against DEV as it stands today:   rows ${asIs.rowsRead}, accepted ${asIs.rowsAccepted}, blockers ${asIs.errors.length}, warnings ${asIs.warnings.length}`);
    for (const e of asIs.errors.slice(0, 5)) console.log(`    BLOCKER row ${e.rowNumber ?? '-'} ${e.column ?? ''} ${e.code}: ${e.message.slice(0, 220)}`);
    console.log(`  after the cohorts file is activated: rows ${after.rowsRead}, accepted ${after.rowsAccepted}, blockers ${after.errors.length}, warnings ${after.warnings.length}`);
    for (const e of after.errors.slice(0, 5)) console.log(`    BLOCKER row ${e.rowNumber ?? '-'} ${e.column ?? ''} ${e.code}: ${e.message.slice(0, 220)}`);
    for (const w of after.warnings) console.log(`    warning ${w.code}: ${w.message.slice(0, 160)}`);
  }
  console.log(`\nTOTAL blockers against DEV as it stands: ${blockers}; after the cohorts file is activated: ${blockersAfterCohorts}`);

  console.log('\nNEGATIVE CONTROLS (a tampered copy of each shipped file must be refused with the named code):');
  let controlsFailed = 0;
  for (const f of built.files) {
    for (const r of runNegativeControls(f, afterCohorts, today)) {
      const ok = r.refused && !r.untouchedHadCode;
      if (!ok) controlsFailed++;
      console.log(`  ${ok ? 'REFUSED ' : 'NOT-REFUSED'} ${r.id} ${f.fileName}: ${r.describe} -> expected ${r.expectCode}, tampered errors ${r.tamperedErrorCount}, code present ${r.tamperedHasCode}, untouched had code ${r.untouchedHadCode}`);
    }
  }
  console.log(`Negative controls not refused: ${controlsFailed}`);
  if (blockersAfterCohorts > 0 || controlsFailed > 0) process.exitCode = 1;
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
