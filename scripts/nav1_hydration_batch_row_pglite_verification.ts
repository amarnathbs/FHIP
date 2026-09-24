// NAV 1 Stage D (D.9) — proves hydration's batch rows satisfy
// ii_reference_import_batches' check constraints against real Postgres, and
// that migration 0192 is a safe, additive widening of batch_kind.
//
// A TypeScript script (run with tsx) rather than .mjs, so it inserts the rows
// the REAL buildHydrationBatchRow() builds -- not a hand-copied imitation.
//
// Negative controls first:
//   - the payloads the live code used to insert fail both constraints (the
//     defect the first real production run hit: floors recorded, no batch);
//   - before 0192, a hydration row (batch_kind 'nav_hydration') is REFUSED --
//     so 0192 is demonstrably what admits it.
//
// Run: npx tsx scripts/nav1_hydration_batch_row_pglite_verification.ts

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { buildHydrationBatchRow, HYDRATION_BATCH_KIND, type HydrationJobResult } from '../lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJob';

const ROOT = path.resolve(__dirname, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0192_nav1_hydration_batch_kind.sql';
const strip = (s: string) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');

/** The batch_kind values a migration's CHECK admits, or null if it does not define that constraint. */
function batchKinds(sql: string): string[] | null {
  const m = /ii_reference_import_batches_batch_kind_check\s+check\s*\(\s*batch_kind\s+in\s*\(([\s\S]*?)\)\s*\)/i.exec(sql);
  if (!m) return null;
  return [...m[1].replace(/--[^\n]*/g, '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
}

(async () => {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(path.join(__dirname, 'db-rebuild-check', 'shim.sql'), 'utf8'));
  const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
  if (!files.includes(TARGET)) throw new Error(`${TARGET} not found`);
  const before = files.filter((f) => f < TARGET);
  const after = files.filter((f) => f > TARGET);
  for (const f of before) {
    await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
    if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
  }
  console.log(`replayed ${before.length} migrations up to ${before.at(-1)} -- ${TARGET} NOT yet applied\n`);

  let pass = 0, fail = 0;
  const check = (label: string, cond: boolean, detail = '') => {
    if (cond) pass++; else fail++;
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '\n        ' + detail : ''}`);
  };
  const insert = async (row: Record<string, unknown>): Promise<string | null> => {
    const cols = Object.keys(row);
    try {
      await db.query(`insert into ii_reference_import_batches (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
        cols.map((c) => (row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c])));
      return null;
    } catch (e) { return (e as Error).message; }
  };
  const base: HydrationJobResult = {
    status: 'succeeded', instrumentsConsidered: 3, instrumentsNeedingHydration: 3, instrumentsAlreadyCovered: 3,
    instrumentsHydrated: 0, instrumentsPartiallyHydrated: 0, instrumentsFailed: 0, totalRowsInserted: 0,
    detail: 'probe', perInstrument: [], startedAt: '2026-09-24T09:36:59Z', finishedAt: '2026-09-24T09:42:00Z',
  };

  // --- 0192 is a strict, one-value widening of the constraint IN FORCE ----------
  const predecessor = [...before].reverse().find((f) => batchKinds(fs.readFileSync(path.join(MIG, f), 'utf8')) !== null)!;
  const was = batchKinds(fs.readFileSync(path.join(MIG, predecessor), 'utf8'))!;
  const now = batchKinds(fs.readFileSync(path.join(MIG, TARGET), 'utf8'))!;
  check(`predecessor derived from the ledger: ${predecessor} (${was.length} values)`, was.length >= 6, was.join(', '));
  const dropped = was.filter((k) => !now.includes(k));
  const added = now.filter((k) => !was.includes(k));
  check('0192 drops nothing the constraint in force admits', dropped.length === 0, `dropped: [${dropped.join(', ')}]`);
  check(`0192 adds exactly '${HYDRATION_BATCH_KIND}'`, JSON.stringify(added) === JSON.stringify([HYDRATION_BATCH_KIND]), `added: [${added.join(', ')}]`);

  // --- Negative controls -------------------------------------------------------------
  const oldPayload = (status: 'succeeded' | 'failed') => ({
    source_key: 'amfi', source_config_id: 'amfi_nav_history', batch_kind: 'nav_history',
    as_of_date: '2026-09-24', status, rows_read: 3, rows_accepted: 3, rows_inserted: 0, notes: { perInstrument: [] },
  });
  const oldOk = await insert(oldPayload('succeeded'));
  check('NEGATIVE CONTROL: the old succeeded payload is refused (no finished_at)', !!oldOk && oldOk.includes('terminal_has_finish'), oldOk ?? 'accepted!');
  const oldFailed = await insert(oldPayload('failed'));
  check('NEGATIVE CONTROL: the old failed payload is refused', !!oldFailed, oldFailed ?? 'accepted!');
  const pre = await insert(buildHydrationBatchRow(base));
  check(`NEGATIVE CONTROL: before 0192, a '${HYDRATION_BATCH_KIND}' row is refused by the batch_kind check`, !!pre && pre.includes('batch_kind_check'), pre ?? 'accepted!');

  // --- Apply 0192 (and anything after it) --------------------------------------------
  await db.exec(strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8')));
  for (const f of after) await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
  let reapply: string | null = null;
  try { await db.exec(strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8'))); } catch (e) { reapply = (e as Error).message; }
  check('0192 is idempotent -- a second apply does not error', reapply === null, reapply ?? '');
  console.log(`\n${TARGET} applied.\n`);

  const succeeded = await insert(buildHydrationBatchRow(base));
  check('a successful run\'s row is accepted', succeeded === null, succeeded ?? '');
  const failed = await insert(buildHydrationBatchRow({ ...base, instrumentsAlreadyCovered: 0, instrumentsFailed: 3, detail: 'all failed' }));
  check('a row for a run where nothing succeeded is accepted (satisfies failed_has_error)', failed === null, failed ?? '');
  const mixed = await insert(buildHydrationBatchRow({ ...base, instrumentsAlreadyCovered: 2, instrumentsFailed: 1 }));
  check('a mixed run\'s row is accepted', mixed === null, mixed ?? '');
  // The shape the live claimBatch() opens: 'running', with no finish yet.
  const running = await insert({
    source_key: 'amfi', source_config_id: 'amfi_nav_history', batch_kind: HYDRATION_BATCH_KIND,
    as_of_date: '2026-09-24', status: 'running', started_at: '2026-09-24T12:00:00Z', notes: { perInstrument: [] },
  });
  check("the 'running' row claimBatch() opens is accepted (no finish needed while running)", running === null, running ?? '');
  const stale = await db.query<{ id: string }>(`select id from ii_reference_import_batches where status = 'running'`);
  const reconcile = await (async () => {
    try {
      await db.query(`update ii_reference_import_batches set status = 'failed', finished_at = now(), error_code = 'STALE_RUNNING_RECONCILED', error_detail = 'probe' where id = $1`, [stale.rows[0].id]);
      return null;
    } catch (e) { return (e as Error).message; }
  })();
  check('the stale-reconciliation update claimBatch() makes is accepted', reconcile === null, reconcile ?? '');
  const bogus = await insert({ ...buildHydrationBatchRow(base), batch_kind: 'not_a_kind' });
  check('an unknown batch_kind is still refused', !!bogus && bogus.includes('batch_kind_check'), bogus ?? 'accepted!');

  console.log(`\n=== NAV 1 hydration batch row PGlite verification: ${pass} PASS, ${fail} FAIL ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
