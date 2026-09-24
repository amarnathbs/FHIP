// NAV 1 Stage D (D.9) — proves the hydration batch row satisfies
// ii_reference_import_batches' check constraints against real Postgres.
//
// A TypeScript script (run with tsx) rather than .mjs, so it inserts the row
// the REAL buildHydrationBatchRow() builds -- not a hand-copied imitation of it.
//
// Negative control first: the payload the live code used to insert is shown
// to FAIL both constraints -- the defect the first real production run hit,
// when three history floors were recorded and no batch row at all.
//
// Run: npx tsx scripts/nav1_hydration_batch_row_pglite_verification.ts

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { buildHydrationBatchRow, type HydrationJobResult } from '../lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJob';

const ROOT = path.resolve(__dirname, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');

(async () => {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(path.join(__dirname, 'db-rebuild-check', 'shim.sql'), 'utf8'));
  const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
    if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
  }
  console.log(`fresh rebuild complete -- ${files.length} migrations, ending at ${files.at(-1)}\n`);

  let pass = 0, fail = 0;
  const check = (label: string, cond: boolean, detail = '') => {
    if (cond) pass++; else fail++;
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '\n        ' + detail : ''}`);
  };
  const insert = async (row: Record<string, unknown>): Promise<string | null> => {
    const cols = Object.keys(row);
    const vals = cols.map((_, i) => `$${i + 1}`);
    try {
      await db.query(`insert into ii_reference_import_batches (${cols.join(',')}) values (${vals.join(',')})`,
        cols.map((c) => (row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c])));
      return null;
    } catch (e) { return (e as Error).message; }
  };
  const base: HydrationJobResult = {
    status: 'succeeded', instrumentsConsidered: 3, instrumentsNeedingHydration: 3, instrumentsAlreadyCovered: 3,
    instrumentsHydrated: 0, instrumentsPartiallyHydrated: 0, instrumentsFailed: 0, totalRowsInserted: 0,
    detail: 'probe', perInstrument: [], startedAt: '2026-09-24T09:36:59Z', finishedAt: '2026-09-24T09:42:00Z',
  };

  // --- Negative control: the payload the live code used to insert --------------
  const oldPayload = (status: 'succeeded' | 'failed') => ({
    source_key: 'amfi', source_config_id: 'amfi_nav_history', batch_kind: 'nav_history',
    as_of_date: '2026-09-24', status, rows_read: 3, rows_accepted: 3, rows_inserted: 0, notes: { perInstrument: [] },
  });
  const oldOk = await insert(oldPayload('succeeded'));
  check('NEGATIVE CONTROL: the old succeeded payload is refused (no finished_at)', !!oldOk && oldOk.includes('terminal_has_finish'), oldOk ?? 'accepted!');
  const oldFailed = await insert(oldPayload('failed'));
  check('NEGATIVE CONTROL: the old failed payload is refused', !!oldFailed, oldFailed ?? 'accepted!');

  // --- The fix ------------------------------------------------------------------------
  const succeeded = await insert(buildHydrationBatchRow(base));
  check('buildHydrationBatchRow() for a successful run is accepted', succeeded === null, succeeded ?? '');
  const failed = await insert(buildHydrationBatchRow({ ...base, instrumentsAlreadyCovered: 0, instrumentsFailed: 3, detail: 'all failed' }));
  check('buildHydrationBatchRow() for a run where nothing succeeded is accepted (satisfies failed_has_error too)', failed === null, failed ?? '');
  const mixed = await insert(buildHydrationBatchRow({ ...base, instrumentsAlreadyCovered: 2, instrumentsFailed: 1 }));
  check('buildHydrationBatchRow() for a mixed run is accepted', mixed === null, mixed ?? '');

  const rows = (await db.query<{ status: string; error_code: string | null; has_finish: boolean }>(
    `select status, error_code, finished_at is not null as has_finish from ii_reference_import_batches order by started_at, status`)).rows;
  check('exactly the three fixed rows were stored, each with a finish time', rows.length === 3 && rows.every((r) => r.has_finish), JSON.stringify(rows));
  check('the failed row carries its error code', rows.some((r) => r.status === 'failed' && r.error_code === 'HYDRATION_NOTHING_SUCCEEDED'));

  console.log(`\n=== NAV 1 hydration batch row PGlite verification: ${pass} PASS, ${fail} FAIL ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
