// NAV 1 D.11(A) -- source-rehydration proof, DEV ONLY (2026-09-25).
//
// Deletes the OLDEST ~2.5 years of one non-held instrument's NAV history in
// DEV, re-hydrates it from AMFI through the real production job and adapter
// chain (AMFI primary, TIGZIG fallback), and compares every date and value
// against an immutable before-image. Also proves:
//   - an interruption part-way leaves committed chunks and the next run
//     resumes without gaps or duplicates;
//   - a repeat run is idempotent (no provider call, no row);
// and then RESTORES the original rows byte-for-byte (same ids, same metadata)
// and removes everything it created (batch rows, history floor, attempt
// record), proving both with counts.
//
// Safety: asserts the DEV host before anything; hard row ceiling on the delete;
// never enables the DEV kill switch (the job's switch check is satisfied
// in-process for this one instrument only).
//
// Usage: npx tsx --env-file=D:/FHIP/.env.local scripts/nav1_d11_dev_rehydration_proof.ts <instrumentId> <deleteBeforeDate> <outDir>

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchAllRows } from '@/lib/services/investment-intelligence/pagination';
import { runSelectiveHistoricalHydration, type HydrationDeps, type HydrationJobResult } from '@/lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJob';
import { createLiveFundHouseResolver, createLiveHydrationDeps } from '@/lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJobLive';
import { AmfiHistoricalAdapter } from '@/lib/services/investment-intelligence/pc6/adapters/amfiHistoricalAdapter';
import { TigzigHistoricalAdapter } from '@/lib/services/investment-intelligence/pc6/adapters/tigzigHistoricalAdapter';
import { FallbackHistoricalAdapter } from '@/lib/services/investment-intelligence/pc6/adapters/fallbackHistoricalAdapter';
import type { HistoricalNavAdapter } from '@/lib/services/investment-intelligence/pc6/adapters/historicalNavAdapter';
import { userHeldInstrumentsToDependencies } from '@/lib/services/investment-intelligence/pc6/navRetentionPolicy';

const DEV_HOST = 'vqycarelcoijzwlpkpcz.supabase.co';
const C = '2026-09-21';
const DELETE_CEILING = 1500;
const [instrumentId, deleteBefore, outDir] = process.argv.slice(2);
if (!instrumentId || !/^\d{4}-\d{2}-\d{2}$/.test(deleteBefore ?? '') || !outDir) {
  console.error('usage: <instrumentId> <deleteBeforeDate> <outDir>');
  process.exit(2);
}
if (new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host !== DEV_HOST) throw new Error('NOT DEV -- refusing');
const db = createAdminClient();
fs.mkdirSync(outDir, { recursive: true });
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const out: Record<string, unknown> = { instrumentId, deleteBefore, startedAt: new Date().toISOString(), environment: DEV_HOST };
const log = (k: string, v: unknown) => { out[k] = v; console.log(k, typeof v === 'string' ? v : JSON.stringify(v)); };

type NavRow = { id: string; instrument_id: string; source_id: string | null; currency_code: string; price_date: string; price: number; created_at: string; source_timestamp: string | null; data_version: string | null; quality_status: string; import_batch_id: string | null; record_checksum: string | null; superseded_by_id: string | null; correction_of_id: string | null };
const COLS = 'id, instrument_id, source_id, currency_code, price_date, price, created_at, source_timestamp, data_version, quality_status, import_batch_id, record_checksum, superseded_by_id, correction_of_id';
const readAll = () => fetchAllRows<NavRow>(() => db.from('ii_prices_nav').select(COLS).eq('instrument_id', instrumentId).order('price_date').order('id'));
/**
 * Delete exactly these ids, in small batches. Until 0201 is applied, each
 * deleted row costs two full-table scans (unindexed self-FKs), so a large
 * delete hits the statement timeout; a timed-out batch rolls back and is
 * retried at half the size. Returns rows deleted and timing, as evidence.
 */
async function deleteByIds(ids: string[]) {
  let size = 8, deleted = 0, timeouts = 0;
  const t0 = Date.now();
  for (let i = 0; i < ids.length; ) {
    const batch = ids.slice(i, i + size);
    const { data, error } = await db.from('ii_prices_nav').delete().in('id', batch).eq('instrument_id', instrumentId).select('id');
    if (error) {
      if (/statement timeout/i.test(error.message) && size > 1) { timeouts++; size = Math.max(1, Math.floor(size / 2)); continue; }
      throw new Error(`delete failed at ${i}: ${error.message}`);
    }
    deleted += (data ?? []).length;
    i += batch.length;
  }
  return { deleted, requested: ids.length, ms: Date.now() - t0, msPerRow: Math.round((Date.now() - t0) / Math.max(1, ids.length)), finalBatchSize: size, timeouts };
}
const valueImage = (rows: NavRow[]) => rows.map((r) => `${r.price_date}|${Number(r.price)}`).sort().join('\n');
const fullImage = (rows: NavRow[]) => rows.map((r) => JSON.stringify(COLS.split(', ').map((c) => (r as unknown as Record<string, unknown>)[c]))).sort().join('\n');

async function main() {
  // --- guards: not held, nothing running, no pre-existing floor -------------------
  const { data: held } = await db.rpc('pc6_instrument_is_user_held', { p_instrument_id: instrumentId });
  if (held !== false) throw new Error(`instrument is user-held or unknown (${held}) -- refusing`);
  const { data: running } = await db.from('ii_reference_import_batches').select('id').eq('status', 'running');
  if ((running ?? []).length > 0) throw new Error('a batch is running in DEV -- refusing (the claim would reconcile it)');
  const { data: floorBefore } = await db.from('ii_nav_history_floors').select('instrument_id').eq('instrument_id', instrumentId);
  log('floor_existed_before', (floorBefore ?? []).length);
  const { count: batchesBefore } = await db.from('ii_reference_import_batches').select('*', { count: 'exact', head: true });
  log('dev_batches_before', batchesBefore);

  // --- before-image ---------------------------------------------------------------
  const before = await readAll();
  const sample = before.filter((r) => r.price_date < deleteBefore);
  const kept = before.filter((r) => r.price_date >= deleteBefore);
  fs.writeFileSync(path.join(outDir, 'before_image.json'), JSON.stringify(before));
  log('before', { rows: before.length, first: before[0]?.price_date, last: before.at(-1)?.price_date, value_sha256: sha(valueImage(before)), full_sha256: sha(fullImage(before)) });
  log('sample', { rows: sample.length, first: sample[0]?.price_date, last: sample.at(-1)?.price_date, value_sha256: sha(valueImage(sample)), data_versions: [...new Set(sample.map((r) => r.data_version))] });
  if (sample.length === 0 || sample.length > DELETE_CEILING) throw new Error(`sample size ${sample.length} outside (0, ${DELETE_CEILING}]`);

  const created: { batchIds: string[] } = { batchIds: [] };
  const deps = (): HydrationDeps => {
    const live = createLiveHydrationDeps();
    return {
      ...live,
      isEnabled: async () => ({ enabled: true, reason: null }), // in-process only; the DEV switch row is never touched
      fetchAcceptedDependencies: async () => userHeldInstrumentsToDependencies([instrumentId]),
      fetchBenchmarkDependencies: async () => new Map(),
      claimBatch: async (startedAt) => { const r = await live.claimBatch(startedAt); if (r.batchId) created.batchIds.push(r.batchId); return r; },
    };
  };
  const realAdapter = () => new FallbackHistoricalAdapter(new AmfiHistoricalAdapter({ resolveFundHouse: createLiveFundHouseResolver() }), new TigzigHistoricalAdapter());
  const counting = (inner: HistoricalNavAdapter, failOnCall?: number) => {
    let calls = 0;
    const a: HistoricalNavAdapter & { calls: () => number } = {
      providerKey: inner.providerKey, adapterVersion: inner.adapterVersion,
      calls: () => calls,
      fetchHistory: async (req) => {
        calls++;
        if (failOnCall !== undefined && calls === failOnCall) {
          return { ok: false, schemeIdentifier: req.schemeIdentifier, kind: 'network', detail: 'SIMULATED INTERRUPTION (D.11 resume test)', provider: { key: 'sim', adapterVersion: 'sim', requestUrl: null, httpStatus: null, retrievedAt: new Date().toISOString() } };
        }
        return inner.fetchHistory(req);
      },
    };
    return a;
  };
  const summary = (r: HydrationJobResult) => ({ status: r.status, telemetry: r.telemetry, perInstrument: r.perInstrument.map((p) => ({ outcome: p.outcome, rows: p.rowsInserted, resumeFromDate: p.resumeFromDate, floor: p.historyFloorRecorded, detail: p.detail.slice(0, 300) })) });

  try {
    // --- bounded delete of the named DEV sample -------------------------------------
    const del = await deleteByIds(sample.map((r) => r.id));
    log('deleted', { ...del, expected: sample.length, match: del.deleted === sample.length });
    if (del.deleted !== sample.length) throw new Error('deleted count != sample -- stopping');

    // --- run 1: interrupted on the 2nd provider call --------------------------------
    const a1 = counting(realAdapter(), 2);
    const r1 = await runSelectiveHistoricalHydration({ changeoverDate: C, adapter: a1, deps: deps(), maxInstruments: 1 });
    const afterRun1 = await readAll();
    log('run1_interrupted', { ...summary(r1), providerCalls: a1.calls(), rowsNow: afterRun1.length, earliestNow: afterRun1[0]?.price_date });

    // --- run 2: resumes ---------------------------------------------------------------
    const a2 = counting(realAdapter());
    const r2 = await runSelectiveHistoricalHydration({ changeoverDate: C, adapter: a2, deps: deps(), maxInstruments: 1 });
    const afterRun2 = await readAll();
    log('run2_resumed', { ...summary(r2), providerCalls: a2.calls(), rowsNow: afterRun2.length, earliestNow: afterRun2[0]?.price_date });

    // --- comparison -------------------------------------------------------------------
    const restored = afterRun2.filter((r) => r.price_date < deleteBefore);
    const sampleDates = new Set(sample.map((r) => r.price_date));
    const restoredDates = new Set(restored.map((r) => r.price_date));
    const missing = [...sampleDates].filter((d) => !restoredDates.has(d));
    const extra = [...restoredDates].filter((d) => !sampleDates.has(d));
    const byDate = new Map(sample.map((r) => [r.price_date, Number(r.price)]));
    const valueMismatches = restored.filter((r) => byDate.has(r.price_date) && byDate.get(r.price_date) !== Number(r.price)).map((r) => ({ date: r.price_date, before: byDate.get(r.price_date), after: Number(r.price) }));
    const dupDates = restored.length - restoredDates.size;
    const keptAfter = afterRun2.filter((r) => r.price_date >= deleteBefore);
    log('comparison', {
      sample_rows: sample.length, restored_rows: restored.length, missing_dates: missing.slice(0, 20), missing_count: missing.length,
      extra_dates: extra.slice(0, 20), extra_count: extra.length, value_mismatches: valueMismatches.slice(0, 20), value_mismatch_count: valueMismatches.length,
      duplicate_dates: dupDates,
      restored_value_sha256: sha(valueImage(restored)), sample_value_sha256: sha(valueImage(sample)),
      exact_value_equality: sha(valueImage(restored)) === sha(valueImage(sample)),
      rows_outside_sample_untouched: sha(fullImage(keptAfter)) === sha(fullImage(kept)),
      restored_provenance: [...new Set(restored.map((r) => (r.data_version ?? '').split(':')[0]))],
      restored_data_versions_sample: [...new Set(restored.map((r) => r.data_version))].slice(0, 5),
      non_financial_metadata_differs: ['id', 'created_at', 'source_timestamp', 'data_version', 'import_batch_id', 'record_checksum'],
    });

    // --- run 3: idempotent -----------------------------------------------------------
    const a3 = counting(realAdapter());
    const r3 = await runSelectiveHistoricalHydration({ changeoverDate: C, adapter: a3, deps: deps(), maxInstruments: 1 });
    const afterRun3 = await readAll();
    log('run3_idempotent', { ...summary(r3), providerCalls: a3.calls(), rowsNow: afterRun3.length, unchanged: sha(fullImage(afterRun3)) === sha(fullImage(afterRun2)) });
  } finally {
    // --- restore the ORIGINAL rows exactly, then remove everything this proof created ---
    const current = await readAll();
    const originalIds = new Set(before.map((r) => r.id));
    const toRemove = current.filter((r) => r.price_date < deleteBefore && !originalIds.has(r.id)).map((r) => r.id);
    try { log('restore_delete_rehydrated_rows', await deleteByIds(toRemove)); } catch (e) { console.error('RESTORE STEP 1 FAILED', e instanceof Error ? e.message : e); }
    const stillPresent = new Set((await readAll()).map((r) => r.id));
    const toReinsert = sample.filter((r) => !stillPresent.has(r.id));
    for (let i = 0; i < toReinsert.length; i += 500) {
      const { error } = await db.from('ii_prices_nav').insert(toReinsert.slice(i, i + 500));
      if (error) console.error('RESTORE INSERT FAILED', error.message);
    }
    log('restore_reinserted_original_rows', toReinsert.length);
    const final = await readAll();
    log('restored_original', { rows: final.length, full_sha256: sha(fullImage(final)), identical_to_before_image: sha(fullImage(final)) === sha(fullImage(before)) });
    if (created.batchIds.length) {
      const { data: rm } = await db.from('ii_reference_import_batches').delete().in('id', created.batchIds).select('id');
      log('cleanup_batches', { created: created.batchIds.length, deleted: (rm ?? []).length });
    }
    if ((floorBefore ?? []).length === 0) {
      const { data: rmf } = await db.from('ii_nav_history_floors').delete().eq('instrument_id', instrumentId).select('instrument_id');
      log('cleanup_floor', { deleted: (rmf ?? []).length });
    }
    const att = await db.from('ii_nav_hydration_attempts').delete().eq('instrument_id', instrumentId).select('instrument_id');
    log('cleanup_attempt_ledger', att.error ? { table: 'absent on DEV (0199 not applied)', detail: att.error.message.slice(0, 120) } : { deleted: (att.data ?? []).length });
    const { count: batchesAfter } = await db.from('ii_reference_import_batches').select('*', { count: 'exact', head: true });
    const { data: floorAfter } = await db.from('ii_nav_history_floors').select('instrument_id').eq('instrument_id', instrumentId);
    log('residue', { dev_batches_before: batchesBefore, dev_batches_after: batchesAfter, floor_rows_now: (floorAfter ?? []).length });
    out.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(outDir, 'd11_result.json'), JSON.stringify(out, null, 1));
  }
}

main().catch((e) => { console.error('FAILED', e instanceof Error ? e.message : e); process.exit(1); });
