// PC6/NAV 1.26 — live wiring of HydrationDeps against the real Supabase
// admin client. Kept separate from selectiveHistoricalHydrationJob.ts so
// that file's orchestration logic stays unit-testable with no live
// database. This file is the thin, mostly-untested-by-design adapter layer
// — the same split referenceIngestJob.ts (orchestration) already uses
// against referenceImportRunner.ts (pure logic).

import { createAdminClient } from '@/lib/supabase/admin';
import { fetchAllRows } from '../pagination';
import type { HydrationDeps, HydrationJobResult, HydrationWriteRow } from './selectiveHistoricalHydrationJob';
import type { AcceptedDependency, BenchmarkDependency } from './navRetentionPolicy';
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
      const rows = await fetchAllRows<{
        instrument_id: string; status: string; history_completeness: string | null;
        account_id: string; latest_holding_snapshot_id: string | null;
      }>(() =>
        db.from('ii_portfolio_truth_status')
          .select('instrument_id, status, history_completeness, account_id, latest_holding_snapshot_id')
          .in('status', ['certified', 'certified_with_warnings'])
          .order('instrument_id')
      );

      // Earliest non-reversed transaction date and certified snapshot as-of
      // date are resolved per (account, instrument) pair actually present,
      // rather than for every instrument in the deployment, to keep this
      // live query bounded to what NAV 1.09's binding actually needs.
      const pairs = rows.map((r) => ({ instrumentId: r.instrument_id, accountId: r.account_id }));
      const txByPair = new Map<string, string>();
      const snapshotByRow = new Map<string, string>();
      if (pairs.length > 0) {
        const instrumentIds = [...new Set(pairs.map((p) => p.instrumentId))];
        const txRows = await fetchAllRows<{ instrument_id: string; account_id: string; transaction_date: string }>(() =>
          db.from('ii_transactions')
            .select('instrument_id, account_id, transaction_date')
            .in('instrument_id', instrumentIds)
            .neq('status', 'reversed')
            .order('transaction_date')
        );
        for (const t of txRows) {
          const key = `${t.instrument_id}|${t.account_id}`;
          const existing = txByPair.get(key);
          if (!existing || t.transaction_date < existing) txByPair.set(key, t.transaction_date);
        }
        const snapshotIds = [...new Set(rows.map((r) => r.latest_holding_snapshot_id).filter(Boolean))] as string[];
        if (snapshotIds.length > 0) {
          const snapRows = await fetchAllRows<{ id: string; as_of_date: string }>(() =>
            db.from('ii_holding_snapshots').select('id, as_of_date').in('id', snapshotIds)
          );
          for (const s of snapRows) snapshotByRow.set(s.id, s.as_of_date);
        }
      }

      const map = new Map<string, AcceptedDependency>();
      for (const r of rows) {
        // Multiple accepted rows can exist for the same instrument across
        // different accounts; keep the union's most conservative (earliest)
        // requirement rather than overwriting with whichever row was read last.
        const candidate: AcceptedDependency = {
          instrumentId: r.instrument_id,
          isAccepted: true,
          historyCompleteness: r.history_completeness as AcceptedDependency['historyCompleteness'],
          earliestTransactionDate: txByPair.get(`${r.instrument_id}|${r.account_id}`) ?? null,
          certifiedAsOfDate: r.latest_holding_snapshot_id ? (snapshotByRow.get(r.latest_holding_snapshot_id) ?? null) : null,
        };
        const existing = map.get(r.instrument_id);
        if (!existing) { map.set(r.instrument_id, candidate); continue; }
        // Prefer complete_from_inception > complete_from_known_opening_balance > partial/holdings_only,
        // and within known_opening_balance prefer the EARLIER date (more conservative / more history).
        const rank = (h: AcceptedDependency['historyCompleteness']) =>
          h === 'complete_from_inception' || h === null ? 3 : h === 'complete_from_known_opening_balance' ? 2 : 1;
        if (rank(candidate.historyCompleteness) > rank(existing.historyCompleteness)) { map.set(r.instrument_id, candidate); continue; }
        if (rank(candidate.historyCompleteness) === rank(existing.historyCompleteness) && candidate.historyCompleteness === 'complete_from_known_opening_balance') {
          if ((candidate.earliestTransactionDate ?? '9999-12-31') < (existing.earliestTransactionDate ?? '9999-12-31')) map.set(r.instrument_id, candidate);
        }
      }
      return map;
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
