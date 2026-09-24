// PC6/NAV 1.26 — live wiring of HydrationDeps against the real Supabase
// admin client. Kept separate from selectiveHistoricalHydrationJob.ts so
// that file's orchestration logic stays unit-testable with no live
// database. This file is the thin, mostly-untested-by-design adapter layer
// — the same split referenceIngestJob.ts (orchestration) already uses
// against referenceImportRunner.ts (pure logic).

import { createAdminClient } from '@/lib/supabase/admin';
import { fetchAllRows } from '../pagination';
import type { HydrationDeps, HydrationJobResult, HydrationWriteRow } from './selectiveHistoricalHydrationJob';
import type { BenchmarkDependency } from './navRetentionPolicy';
import { userHeldInstrumentsToDependencies } from './navRetentionPolicy';
import type { ExistingObservation } from './referenceDataQuality';

const KILL_SWITCH_JOB_KEY = 'pc6_selective_historical_hydration';

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

    async recordBatch(summary: HydrationJobResult) {
      await db.from('ii_reference_import_batches').insert({
        source_key: 'tigzig',
        source_config_id: 'tigzig_nav_history',
        batch_kind: 'nav_history',
        as_of_date: new Date().toISOString().slice(0, 10),
        status: summary.instrumentsFailed > 0 && summary.instrumentsHydrated === 0 ? 'failed' : 'succeeded',
        rows_read: summary.instrumentsConsidered,
        rows_accepted: summary.instrumentsNeedingHydration,
        rows_inserted: summary.totalRowsInserted,
        notes: { perInstrument: summary.perInstrument.slice(0, 200) },
      });
    },
  };
}
