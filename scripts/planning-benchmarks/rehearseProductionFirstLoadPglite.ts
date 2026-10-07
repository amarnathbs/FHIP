// Rehearses the production first load on PGlite (see productionFirstLoadPglite.ts). For each file, in upload order, as two
// different people: prints what the preview says (the five counts and every row, live figure -> new figure), then what
// Activate did, then the state before and after.
//
// Run:  npx tsx scripts/planning-benchmarks/rehearseProductionFirstLoadPglite.ts
import { buildProductionFirstLoad } from './buildProductionFirstLoad';
import { createReplicaDb, readShipped, runOneFile, stateSnapshot, twinClient } from './productionFirstLoadPglite';
import { loadPeerBenchmark } from '../../lib/services/twinBenchmarkRetrieval';

type Row = Record<string, string | null>;

const fmt = (v: string | null): string => (v === null ? '-' : String(Number(v)));

async function main() {
  const t0 = Date.now();
  const db = await createReplicaDb();
  console.log(`Replica ready (migrations 0001 to 0278 + seed) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  // What the Financial Twin reads, through the REAL loadPeerBenchmark, for the figures the load changes.
  const twinLines = async (label: string) => {
    console.log(`\nTWIN READ ${label} (real loadPeerBenchmark)`);
    const probes: Array<[string, string | null, string]> = [
      ['property_concentration', null, 'AU'], ['net_worth', 'AU_AGE_25_34', 'AU'], ['net_worth', 'AU_AGE_55_64', 'AU'], ['gross_household_income', 'AU_AGE_25_34', 'AU'],
      ['net_worth', 'AU_AGE_18_24', 'AU'], ['net_worth', null, 'AU'], ['retirement_balance', null, 'AU'], ['debt_to_income', null, 'AU'], ['liquid_asset_share', 'IN_RURAL_ALL', 'IN'], ['retirement_contribution_rate', null, 'IN'],
    ];
    for (const [metric, cohort, country] of probes) {
      const m = ((await db.query(`select id from benchmark_metric_definitions where metric_code = '${metric}'`)).rows[0] as { id: string }).id;
      const c = cohort ? ((await db.query(`select id from benchmark_cohorts where cohort_code = '${cohort}'`)).rows[0] as { id: string }).id : null;
      const r = await loadPeerBenchmark(twinClient(db) as never, m, c, country);
      console.log(`   ${metric} / ${cohort ?? '(country-wide)'}: ${r ? `${r.statisticType} ${r.value}` : 'none'}`);
    }
  };
  await twinLines('BEFORE');
  console.log('PRE-STATE ' + JSON.stringify(await stateSnapshot(db)));
  const built = buildProductionFirstLoad();
  for (const f of built.files) {
    const r = await runOneFile(db, f, readShipped(f.fileName), { activate: true });
    console.log(`\n${f.order}. ${f.fileName} (${f.kind}, ${f.rows.length} rows): ${r.outcome}${r.error ? ' ERROR ' + r.error : ''}`);
    for (const i of r.stageIssues) console.log(`   issue ${i.code} row ${i.row}: ${i.message.slice(0, 200)}`);
    const c = (r.counts ?? {}) as Record<string, number>;
    console.log(`   preview: New ${c.new ?? 0}, Replaced ${c.changed ?? 0}, Same as live ${c.unchanged ?? 0}, Conflicts ${c.conflict ?? 0}, Bands removed ${c.removed ?? 0}; blockers ${(r.preview?.blockers as unknown[] | undefined)?.length ?? '-'}`);
    for (const row of (r.preview?.rows ?? []) as Row[]) {
      const key = [row.cohort_code ?? row.household_type ?? '(country-wide)', row.metric_code ?? '', row.statistic_type ?? (row.band_label ? `${row.band_label} tier ${row.band_tier}` : '')].filter(Boolean).join(' / ');
      const live = row.live_value !== null && row.live_value !== undefined ? fmt(row.live_value) : row.live_lower !== null && row.live_lower !== undefined ? `${fmt(row.live_lower)}..${fmt(row.live_upper)}` : '-';
      const nw = row.new_value !== null && row.new_value !== undefined ? fmt(row.new_value) : row.new_lower !== null && row.new_lower !== undefined ? `${fmt(row.new_lower)}..${fmt(row.new_upper)}` : row.cohort_description ? 'cohort' : '-';
      console.log(`   - ${String(row.classification).padEnd(9)} ${key}: live ${live} -> file ${nw}`);
    }
    const res = ((r.activated as { result?: Record<string, unknown> } | null)?.result ?? {}) as Record<string, unknown>;
    console.log(`   activated: ${res.rows_inserted} added, ${res.rows_end_dated} replaced and kept as history, ${res.bands_removed} bands removed, dataset ${res.dataset_status}`);
  }
  console.log('\nPOST-STATE ' + JSON.stringify(await stateSnapshot(db)));
  await twinLines('AFTER');
  await db.close();
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
