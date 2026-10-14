// READ-ONLY DEV verification of the Planning Benchmarks "Allowed values" lists.
//
// Reads the reference tables of DEV (host must be vqycarelcoijzwlpkpcz) with the PUBLIC anon key (the tables are
// world-readable under RLS, migration 0011), generates the three Excel templates and the companion CSV with the
// SAME functions the routes call (loadAllowedValues, buildTemplate, buildAllowedValuesCsv), writes them to
// docs/planning-benchmarks/sample_downloads/, reads the produced XLSX back with an independent reader, prints the
// lists and counts, and compares them with direct count reads of benchmark_datasets / benchmark_metric_definitions
// / benchmark_cohorts. No write of any kind. No secret is printed or stored.
//
// Run:  npx tsx scripts/planning-benchmarks/devAllowedValuesSample.ts
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { loadAllowedValues } from '../../lib/planning-benchmarks/allowedValues';
import { buildAllowedValuesCsv, buildTemplate } from '../../lib/planning-benchmarks/uploadTemplates';
import { UPLOAD_KINDS } from '../../lib/planning-benchmarks/uploadSchema';
import { todayIsoUtc } from '../../lib/planning-benchmarks/dayFirst';

const DEV_HOST = 'vqycarelcoijzwlpkpcz.supabase.co';
const envFile = process.env.ENV_FILE ?? 'D:/FHIP/.env.local';
const env: Record<string, string> = {};
for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const url = env.NEXT_PUBLIC_SUPABASE_URL;
if (!url || new URL(url).host !== DEV_HOST) throw new Error(`Refusing to run: the Supabase host is not DEV (${DEV_HOST}).`);
console.log(`Host verified: ${new URL(url).host} (DEV). Read-only, anon key.`);
const supabase = createClient(url, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });

async function count(table: string, filter?: (q: ReturnType<typeof supabase.from>) => unknown): Promise<number> {
  const q = supabase.from(table).select('*', { count: 'exact', head: true });
  const r = (await (filter ? (filter(q as never) as typeof q) : q)) as { count: number | null; error: { message: string } | null };
  if (r.error || r.count === null) throw new Error(`count ${table}: ${r.error?.message}`);
  return r.count;
}

async function main() {
  const out = path.resolve(__dirname, '../../docs/planning-benchmarks/sample_downloads');
  fs.mkdirSync(out, { recursive: true });
  const today = todayIsoUtc();
  const av = await loadAllowedValues(supabase, today);
  if (av.state !== 'ok') throw new Error('lists unavailable: ' + av.reason);

  for (const kind of UPLOAD_KINDS) {
    const t = buildTemplate(kind, 'xlsx', av);
    fs.writeFileSync(path.join(out, `DEV_${t.fileName}`), t.body as Uint8Array);
  }
  fs.writeFileSync(path.join(out, 'DEV_planning_benchmarks_allowed_values.csv'), buildAllowedValuesCsv(av));

  // ---- read the produced files back and print what is in them ----
  const rows = (file: string, sheet: string) => {
    const wb = XLSX.read(fs.readFileSync(path.join(out, file)), { type: 'buffer' });
    return (XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: '' }) as unknown[][]).map((r) => r.map(String));
  };
  const values = rows('DEV_planning_benchmarks_values_template.xlsx', 'Read me');
  const heading = values.map((r) => r[0]).find((c) => /datasets? (is|are) open for upload today/.test(c) && !c.includes('full lists'));
  console.log('\nRead me heading:', heading);
  const datasetRows = values.filter((r) => av.datasets.some((d) => d.name === r[0] && d.version === r[1]));
  console.log(`\nDatasets in the Read me (${datasetRows.length}):`);
  for (const r of datasetRows) console.log(`  - ${r[0]} | v${r[1]} | ${r[2]} | ${r[4]} | source ${r[5]} | figures ${r[7]} | values: ${r[8].slice(0, 40)}`);
  const metricRows = values.filter((r) => av.metrics.some((m) => m.code === r[0]));
  console.log(`\nMetrics in the Read me (${metricRows.length}):`);
  for (const r of metricRows) console.log(`  - ${r[0]} | ${r[1]} | unit ${r[2]}`);
  const cohortRows = values.filter((r) => av.cohorts.some((c) => c.code === r[0]));
  console.log(`\nCohorts in the Read me (${cohortRows.length}):`);
  for (const r of cohortRows) console.log(`  - ${r[0]} | ${r[1]}`);

  // ---- direct reads for comparison ----
  const direct = {
    datasetsTotal: await count('benchmark_datasets'),
    datasetsClosed: await count('benchmark_datasets', (q) => (q as never as { in: (c: string, v: string[]) => unknown }).in('data_status', ['suspended', 'archived', 'superseded'])),
    metricsTotal: await count('benchmark_metric_definitions'),
    cohortsTotal: await count('benchmark_cohorts'),
  };
  const fromFile = { datasetsTotal: datasetRows.length, datasetsOpen: datasetRows.filter((r) => !['suspended', 'archived', 'superseded'].includes(r[4])).length, metricsTotal: metricRows.length, cohortsTotal: cohortRows.length };
  console.log('\nCOUNTS');
  console.log(`  datasets total       file ${fromFile.datasetsTotal}  direct ${direct.datasetsTotal}`);
  console.log(`  datasets closed      file ${fromFile.datasetsTotal - fromFile.datasetsOpen}  direct ${direct.datasetsClosed}`);
  console.log(`  datasets OPEN        file ${fromFile.datasetsOpen}  direct ${direct.datasetsTotal - direct.datasetsClosed}  (module state ${av.counts.datasetsOpen})`);
  console.log(`  metrics              file ${fromFile.metricsTotal}  direct ${direct.metricsTotal}`);
  console.log(`  cohorts              file ${fromFile.cohortsTotal}  direct ${direct.cohortsTotal}`);
  const ok =
    fromFile.datasetsTotal === direct.datasetsTotal &&
    fromFile.datasetsTotal - fromFile.datasetsOpen === direct.datasetsClosed &&
    fromFile.metricsTotal === direct.metricsTotal &&
    fromFile.cohortsTotal === direct.cohortsTotal &&
    av.counts.datasetsOpen === direct.datasetsTotal - direct.datasetsClosed;
  console.log(ok ? '\nMATCH: the produced file agrees with direct reads.' : '\nMISMATCH');
  if (!ok) process.exitCode = 1;
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
