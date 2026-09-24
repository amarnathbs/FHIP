// PC6/NAV 1.26 — live wiring of HydrationDeps against the real Supabase
// admin client. Kept separate from selectiveHistoricalHydrationJob.ts so
// that file's orchestration logic stays unit-testable with no live
// database. This file is the thin, mostly-untested-by-design adapter layer
// — the same split referenceIngestJob.ts (orchestration) already uses
// against referenceImportRunner.ts (pure logic).

import { createAdminClient } from '@/lib/supabase/admin';
import { fetchAllRows } from '../pagination';
import type { HydrationAttemptRecord, HydrationDeps, HydrationJobResult, HydrationWriteRow, PerInstrumentOutcome } from './selectiveHistoricalHydrationJob';
import { buildHydrationBatchRow, HYDRATION_BATCH_KIND, HYDRATION_STALE_RUNNING_MINUTES } from './selectiveHistoricalHydrationJob';
import { reconcileStaleRunningBatches } from './referenceImportRunner';
import type { FundHouseResolver } from './adapters/amfiHistoricalAdapter';
import type { BenchmarkDependency } from './navRetentionPolicy';
import { userHeldInstrumentsToDependencies } from './navRetentionPolicy';
import type { ExistingObservation } from './referenceDataQuality';

const KILL_SWITCH_JOB_KEY = 'pc6_selective_historical_hydration';

/** How fund-house names are compared: case- and spacing-insensitive, matching 0191's unique index on lower(amc_name). */
export function normaliseFundHouseName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The server's fund-house resolver: the codes STORED in ii_amfi_fund_houses
 * (migration 0191), reached through ii_scheme_master.amc_name. Sends AMFI no
 * requests -- replacing the per-process probe of all 150 codes that stalled
 * the second production hydration run.
 *
 * Returns null (so the adapter reports not_found and TIGZIG is tried) when the
 * scheme has no fund-house name or the name has no stored code. A database
 * error is thrown instead, so it surfaces as a real failure -- never as "no
 * data", which could otherwise end in a wrong history floor.
 */
export function createLiveFundHouseResolver(): FundHouseResolver {
  const db = createAdminClient();
  let byName: Map<string, number> | null = null;
  return async (schemeCode: string) => {
    if (byName === null) {
      const { data, error } = await db.from('ii_amfi_fund_houses').select('fund_house_code, amc_name');
      if (error) throw new Error(`could not load ii_amfi_fund_houses: ${error.message}`);
      byName = new Map((data ?? []).map((r) => [normaliseFundHouseName(r.amc_name as string), r.fund_house_code as number]));
    }
    const { data, error } = await db
      .from('ii_scheme_master')
      .select('amc_name')
      .eq('amfi_scheme_code', schemeCode)
      .not('amc_name', 'is', null)
      .limit(1);
    if (error) throw new Error(`could not read the fund house for scheme ${schemeCode}: ${error.message}`);
    const name = data?.[0]?.amc_name as string | undefined;
    return name ? byName.get(normaliseFundHouseName(name)) ?? null : null;
  };
}

export function createLiveHydrationDeps(): HydrationDeps {
  const db = createAdminClient();

  return {
    async isEnabled() {
      const { data } = await db
        .from('ii_reference_job_control')
        .select('enabled, disabled_reason')
        .eq('job_key', KILL_SWITCH_JOB_KEY)
        .maybeSingle();
      if (!data) return { enabled: false, reason: 'no ii_reference_job_control row exists for this job_key' };
      return { enabled: data.enabled === true, reason: data.disabled_reason };
    },

    async fetchAcceptedDependencies() {
      // NAV 1 Stage D (migration 0189): "held" comes from the ONE shared SQL
      // definition that retention also uses -- any instrument in any
      // user-scoped ii_* table, in any statement status.
      //
      // Until 0189 this read only ii_portfolio_truth_status rows with status
      // IN ('certified', 'certified_with_warnings'). In production that
      // matched nothing (every statement sat at 'reconciliation_required'),
      // so once history had been deleted, a user bringing a deleted scheme
      // would never have had it fetched back.
      //
      // Paged, and ordered by the function's unique output column: a
      // set-returning RPC is capped at db-max-rows like any other PostgREST
      // read, and an unpaged read would silently drop held instruments past
      // the first 1000.
      //
      // supabase-js cannot infer that this RPC returns a TABLE rather than a
      // single row, so its result type is a union of the two. The function is
      // declared `returns table (instrument_id uuid)` in 0189, so PostgREST
      // always answers with an array -- the one narrowing below says exactly
      // that and nothing more.
      type HeldRow = { instrument_id: string };
      const rows = await fetchAllRows<HeldRow>(() => ({
        range: (from, to) =>
          db.rpc('pc6_user_held_instrument_ids')
            .select('instrument_id')
            .order('instrument_id')
            .range(from, to)
            .then(({ data, error }) => ({ data: data as HeldRow[] | null, error })),
      }));
      return userHeldInstrumentsToDependencies(rows.map((r) => r.instrument_id));
    },

    async fetchBenchmarkDependencies() {
      const rows = await fetchAllRows<{ instrument_id: string }>(() =>
        db.from('ii_instrument_benchmarks').select('instrument_id').order('instrument_id')
      );
      const map = new Map<string, BenchmarkDependency>();
      for (const r of rows) map.set(r.instrument_id, { instrumentId: r.instrument_id, everBenchmarked: true });
      return map;
    },

    async fetchEarliestExistingDate(instrumentId: string) {
      const { data } = await db
        .from('ii_prices_nav')
        .select('price_date')
        .eq('instrument_id', instrumentId)
        .order('price_date', { ascending: true })
        .limit(1)
        .maybeSingle();
      return data?.price_date ?? null;
    },

    async fetchAdapterIdentifier(instrumentId: string) {
      const { data } = await db
        .from('ii_instrument_identifiers')
        .select('identifier_value')
        .eq('instrument_id', instrumentId)
        .eq('identifier_scheme', 'amfi_scheme_code')
        .eq('is_active', true)
        .maybeSingle();
      return data?.identifier_value ?? null;
    },

    async fetchExistingObservations(instrumentId: string, fromDate: string, toDate: string) {
      const rows = await fetchAllRows<{ price_date: string; price: number; record_checksum: string | null; quality_status: string }>(() =>
        db.from('ii_prices_nav')
          .select('price_date, price, record_checksum, quality_status')
          .eq('instrument_id', instrumentId)
          .gte('price_date', fromDate)
          .lte('price_date', toDate)
      );
      const map = new Map<string, ExistingObservation>();
      for (const r of rows) {
        map.set(`${instrumentId}|${r.price_date}`, { value: String(r.price), recordChecksum: r.record_checksum ?? '', quality_status: r.quality_status as ExistingObservation['quality_status'] });
      }
      return map;
    },

    async writeRows(rows: HydrationWriteRow[]) {
      const { error } = await db.from('ii_prices_nav').upsert(
        rows.map((w) => ({
          instrument_id: w.instrumentId,
          currency_code: w.currencyCode,
          price_date: w.priceDate,
          price: w.price,
          source_timestamp: new Date().toISOString(),
          data_version: w.dataVersion,
          record_checksum: w.recordChecksum,
          import_batch_id: w.importBatchId,
          quality_status: 'ok',
        })),
        { onConflict: 'instrument_id,price_date', ignoreDuplicates: true }
      );
      return { inserted: error ? 0 : rows.length, error: error?.message ?? null };
    },

    async claimBatch(startedAt: string) {
      // Scoped to hydration's OWN batch kind (0192), so this never blocks on,
      // or reconciles, a PC6 ingest backfill -- and the ingest job never
      // touches hydration's rows.
      const { data: running, error: readError } = await db
        .from('ii_reference_import_batches')
        .select('id, started_at')
        .eq('batch_kind', HYDRATION_BATCH_KIND)
        .eq('status', 'running');
      if (readError) {
        // Fail closed: if we cannot tell whether a run is in flight, do not start one.
        return { batchId: null, blocked: `could not confirm that no hydration run is in flight: ${readError.message}`, error: null };
      }
      const rec = reconcileStaleRunningBatches(
        (running ?? []).map((r) => ({ id: r.id as string, started_at: r.started_at as string })),
        startedAt,
        HYDRATION_STALE_RUNNING_MINUTES,
      );
      if (rec.reconciledIds.length > 0) {
        await db
          .from('ii_reference_import_batches')
          .update({
            status: 'failed',
            finished_at: startedAt,
            error_code: 'STALE_RUNNING_RECONCILED',
            error_detail: `Reconciled by a later hydration run after ${HYDRATION_STALE_RUNNING_MINUTES}+ minute(s) with no terminal status -- most likely the platform ended the process. Its progress so far is in notes.perInstrument.`,
          })
          .in('id', rec.reconciledIds);
      }
      if (rec.stillRunning) return { batchId: null, blocked: rec.detail, error: null };

      const { data, error } = await db
        .from('ii_reference_import_batches')
        .insert({
          source_key: 'amfi',
          source_config_id: 'amfi_nav_history',
          batch_kind: HYDRATION_BATCH_KIND,
          as_of_date: startedAt.slice(0, 10),
          status: 'running',
          started_at: startedAt,
          notes: { sources: { primary: 'amfi_nav_history', fallback: 'tigzig_nav_history', perRowProvider: 'data_version' }, perInstrument: [] },
        })
        .select('id')
        .single();
      return { batchId: (data?.id as string | undefined) ?? null, blocked: null, error: error ? error.message : null };
    },

    async updateBatchProgress(batchId: string, perInstrument: PerInstrumentOutcome[]) {
      // Best effort by design: a lost progress note must never fail the run.
      await db
        .from('ii_reference_import_batches')
        .update({
          notes: {
            sources: { primary: 'amfi_nav_history', fallback: 'tigzig_nav_history', perRowProvider: 'data_version' },
            inProgress: true,
            perInstrument: perInstrument.slice(0, 200),
          },
        })
        .eq('id', batchId)
        .eq('status', 'running');
    },

    async recordBatch(summary: HydrationJobResult, batchId: string | null) {
      // The row is built by the pure, tested buildHydrationBatchRow(). This
      // once inserted an inline payload and ignored the result -- which
      // violated two check constraints and so recorded nothing, silently.
      const row = buildHydrationBatchRow(summary);
      const fmt = (e: { message: string; code?: string }) => `${e.message}${e.code ? ` (${e.code})` : ''}`;
      if (batchId !== null) {
        // Close the run's own row -- even if a later run already reconciled it
        // as stale: the real outcome replaces the guess. `.select()` so a
        // zero-row update is detected, never mistaken for success.
        const { data, error } = await db.from('ii_reference_import_batches').update(row).eq('id', batchId).select('id');
        if (error) return { error: fmt(error) };
        if ((data ?? []).length === 1) return { error: null };
        // The open row is gone; fall through and insert, so the outcome is still recorded.
      }
      const { error } = await db.from('ii_reference_import_batches').insert(row);
      return { error: error ? fmt(error) : null };
    },

    async fetchHistoryFloor(instrumentId: string) {
      const { data, error } = await db
        .from('ii_nav_history_floors')
        .select('floor_date')
        .eq('instrument_id', instrumentId)
        .maybeSingle();
      // A failed read must not become "no floor" silently in a way that hides
      // a broken table -- but it also must not fail hydration. Without a floor
      // the job simply walks back as it did before 0190, so treat it as none.
      if (error) return null;
      return (data?.floor_date as string | undefined) ?? null;
    },

    async fetchAttemptLedger() {
      // 0198. Any error -- including the table not existing yet, because the
      // code can deploy before the migration is applied -- returns null, and
      // the job falls back to a rotating order and says so. Never throws.
      type Row = { instrument_id: string; last_attempted_at: string; last_outcome: string; consecutive_failures: number; attempts_total: number; last_success_at: string | null };
      try {
        const rows = await fetchAllRows<Row>(() =>
          db.from('ii_nav_hydration_attempts')
            .select('instrument_id, last_attempted_at, last_outcome, consecutive_failures, attempts_total, last_success_at')
            .order('instrument_id')
        );
        const records = new Map<string, HydrationAttemptRecord>();
        for (const r of rows) {
          records.set(r.instrument_id, {
            instrumentId: r.instrument_id,
            lastAttemptedAt: r.last_attempted_at,
            lastOutcome: r.last_outcome as HydrationAttemptRecord['lastOutcome'],
            consecutiveFailures: r.consecutive_failures,
            attemptsTotal: r.attempts_total,
            lastSuccessAt: r.last_success_at,
          });
        }
        return { records, error: null };
      } catch (e) {
        return { records: null, error: e instanceof Error ? e.message : String(e) };
      }
    },

    async recordAttempt(record: HydrationAttemptRecord, detail: string) {
      // `.select()` so a write that silently touched no row is caught.
      const { data, error } = await db
        .from('ii_nav_hydration_attempts')
        .upsert(
          {
            instrument_id: record.instrumentId,
            last_attempted_at: record.lastAttemptedAt,
            last_outcome: record.lastOutcome,
            last_detail: detail.slice(0, 2000),
            consecutive_failures: record.consecutiveFailures,
            attempts_total: record.attemptsTotal,
            last_success_at: record.lastSuccessAt,
            updated_at: record.lastAttemptedAt,
          },
          { onConflict: 'instrument_id' },
        )
        .select('instrument_id');
      if (error) return { error: error.message };
      return { error: (data ?? []).length === 1 ? null : 'attempt record upsert affected no row' };
    },

    async recordHistoryFloor(instrumentId: string, floorDate: string, detail: string) {
      // Keep the EARLIEST confirmed floor: a later run can only ever find
      // more history, never less, so a floor is never moved later.
      const { data: existing, error: readError } = await db
        .from('ii_nav_history_floors')
        .select('floor_date')
        .eq('instrument_id', instrumentId)
        .maybeSingle();
      if (readError) return { error: readError.message };
      const current = (existing?.floor_date as string | undefined) ?? null;
      const floor = current !== null && current < floorDate ? current : floorDate;
      const { error } = await db.from('ii_nav_history_floors').upsert(
        {
          instrument_id: instrumentId,
          floor_date: floor,
          confirmed_by: 'pc6_selective_hydration',
          detail: detail.slice(0, 2000),
          confirmed_at: new Date().toISOString(),
        },
        { onConflict: 'instrument_id' },
      );
      return { error: error ? error.message : null };
    },
  };
}
