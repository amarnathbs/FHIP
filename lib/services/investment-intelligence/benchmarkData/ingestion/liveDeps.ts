// BENCH-1 Phase 2 - the LIVE wiring of the ingestion orchestrator: service-role
// Supabase client + the migration-0241 RPCs. Server-side only. Nothing here
// decides policy (that is orchestrator.ts and the database); it only performs
// the I/O each injected dependency names.
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/services/investment-intelligence/pagination';
import { toEntitlementRecord } from '../uploadService';
import type { AttemptRecord, BenchmarkFeedAdapter, IngestionStateRow, OrchestratorDeps } from './orchestrator';

export const GLOBAL_SWITCH_KEY = 'benchmark_ingestion_global';
export const WRITE_SWITCH_KEY = 'benchmark_ingestion_write';
/** Third, environment-level switch enforced by the cron route (absent / anything else = off). */
export const INGESTION_ENV_FLAG = 'BENCHMARK_INGESTION_ENABLED';
/** The Supabase project ref this runtime is allowed to ingest into; blocks a DEV job from writing production and vice versa. */
export const INGESTION_PROJECT_REF_ENV = 'BENCHMARK_INGESTION_PROJECT_REF';

/** Fail-closed switch read: a missing row, a read error or enabled=false are all OFF. */
async function readSwitch(admin: SupabaseClient, key: string): Promise<boolean> {
  const { data, error } = await admin.from('ii_reference_job_control').select('enabled').eq('job_key', key).maybeSingle();
  if (error || !data) return false;
  return (data as { enabled: boolean }).enabled === true;
}

export function projectRefFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.split('.')[0] || null;
  } catch {
    return null;
  }
}

/** Environment guard: the configured allowed ref must equal the connected project's ref. */
export function environmentMatches(env: Record<string, string | undefined>): { ok: boolean; reason: string } {
  const allowed = env[INGESTION_PROJECT_REF_ENV];
  const actual = projectRefFromUrl(env.NEXT_PUBLIC_SUPABASE_URL);
  if (!allowed) return { ok: false, reason: `${INGESTION_PROJECT_REF_ENV} is not set; refusing to run (an environment must name the one project it may ingest into).` };
  if (!actual) return { ok: false, reason: 'The Supabase URL is not configured.' };
  if (allowed !== actual) return { ok: false, reason: `This runtime is connected to project '${actual}' but is only authorised to ingest into '${allowed}'.` };
  return { ok: true, reason: 'environment matches' };
}

export function createLiveDeps(admin: SupabaseClient, params: { nowIso: string; holderId: string; adapters: ReadonlyMap<string, BenchmarkFeedAdapter>; holidays?: ReadonlySet<string> }): OrchestratorDeps {
  return {
    nowIso: params.nowIso,
    holderId: params.holderId,
    holidays: params.holidays,
    adapters: params.adapters,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    isGlobalEnabled: () => readSwitch(admin, GLOBAL_SWITCH_KEY),
    isWriteEnabled: () => readSwitch(admin, WRITE_SWITCH_KEY),
    async loadStates(keys) {
      let q = admin
        .from('ii_benchmark_ingestion_state')
        .select('benchmark_id, ingestion_mode, adapter_id, automation_enabled, publication_lag_days, latest_valid_data_date, completeness_watermark, consecutive_failures, next_attempt_not_before, retries_used_in_window, retry_budget_window_date, ii_benchmarks(benchmark_key, return_variant, currency_code)')
        .order('benchmark_id', { ascending: true })
        .limit(200);
      if (keys && keys.length > 0) q = q.in('ii_benchmarks.benchmark_key', keys);
      const { data, error } = await q;
      if (error) throw new Error(`ii_benchmark_ingestion_state: ${error.message}`);
      return ((data ?? []) as unknown as Array<Record<string, unknown>>)
        .filter((r) => r.ii_benchmarks)
        .map((r): IngestionStateRow => {
          const b = r.ii_benchmarks as { benchmark_key: string; return_variant: IngestionStateRow['returnVariant']; currency_code: string | null };
          return {
            benchmarkId: r.benchmark_id as string,
            benchmarkKey: b.benchmark_key,
            ingestionMode: r.ingestion_mode as IngestionStateRow['ingestionMode'],
            adapterId: (r.adapter_id as string | null) ?? null,
            automationEnabled: r.automation_enabled === true,
            publicationLagDays: r.publication_lag_days as number,
            latestValidDataDate: (r.latest_valid_data_date as string | null) ?? null,
            completenessWatermark: (r.completeness_watermark as string | null) ?? null,
            consecutiveFailures: r.consecutive_failures as number,
            nextAttemptNotBefore: (r.next_attempt_not_before as string | null) ?? null,
            retriesUsedInWindow: r.retries_used_in_window as number,
            retryWindowDate: (r.retry_budget_window_date as string | null) ?? null,
            returnVariant: b.return_variant,
            currencyCode: b.currency_code ? String(b.currency_code).trim() : null,
          };
        })
        .filter((r) => !keys || keys.length === 0 || keys.includes(r.benchmarkKey));
    },
    async loadEntitlements(benchmarkId) {
      const { data, error } = await admin.from('ii_benchmark_entitlements').select('*').eq('benchmark_id', benchmarkId).eq('status', 'approved');
      if (error) throw new Error(`ii_benchmark_entitlements: ${error.message}`);
      return ((data ?? []) as Parameters<typeof toEntitlementRecord>[0][]).map(toEntitlementRecord);
    },
    async claimLease(benchmarkId, holder, ttl) {
      const { data, error } = await admin.rpc('claim_benchmark_ingestion_lease', { p_benchmark: benchmarkId, p_holder: holder, p_ttl_seconds: ttl });
      if (error) return false; // fail closed
      return (data as { claimed: boolean }).claimed === true;
    },
    async releaseLease(benchmarkId, holder) {
      await admin.rpc('release_benchmark_ingestion_lease', { p_benchmark: benchmarkId, p_holder: holder });
    },
    async loadStoredDates(benchmarkId, from, to) {
      const rows = await fetchAllRows<{ series_date: string; value: number | string }>(() =>
        admin.from('ii_benchmark_series').select('series_date, value').eq('benchmark_id', benchmarkId).eq('quality_status', 'ok').gte('series_date', from).lte('series_date', to).order('series_date', { ascending: true })
      );
      return new Map(rows.map((r) => [r.series_date, Number(r.value)]));
    },
    async loadDemandFloor(benchmarkId) {
      const { data } = await admin.from('ii_benchmark_history_demand').select('required_from').eq('benchmark_id', benchmarkId).maybeSingle();
      return (data as { required_from: string } | null)?.required_from ?? null;
    },
    async writeRows(benchmarkId, rows, sourceHost, runKind) {
      const { data, error } = await admin.rpc('publish_benchmark_feed_rows', { p_benchmark: benchmarkId, p_rows: rows, p_source_host: sourceHost, p_run_kind: runKind });
      if (error) return { inserted: 0, identical: 0, conflicts: 0, error: error.message };
      const d = data as { inserted: number; identical: number; conflicts_skipped: number; batch_id: string };
      return { inserted: d.inserted, identical: d.identical, conflicts: d.conflicts_skipped, error: null, batchId: d.batch_id };
    },
    async recordAttempt(benchmarkId, rec: AttemptRecord, isSkip) {
      if (isSkip) {
        // A skip is not an attempt: it must not move last_attempt_at or any counter. It is a run-history row only.
        await admin.from('ii_benchmark_ingestion_runs').insert({ benchmark_id: benchmarkId, run_kind: rec.runKind, status: rec.status, started_at: rec.startedAt, finished_at: params.nowIso, error_code: rec.errorCode, error_detail: rec.errorDetail?.slice(0, 500) ?? null, lease_holder: params.holderId });
        return;
      }
      await admin.rpc('record_benchmark_ingestion_attempt', {
        p_benchmark: benchmarkId,
        p: {
          run_kind: rec.runKind,
          status: rec.status,
          success: rec.success,
          started_at: rec.startedAt,
          window_from: rec.windowFrom,
          window_to: rec.windowTo,
          http_status: rec.httpStatus,
          rows_fetched: rec.rowsFetched,
          rows_inserted: rec.rowsInserted,
          rows_identical: rec.rowsIdentical,
          rows_conflicting: rec.rowsConflicting,
          completeness_watermark: rec.completenessWatermark,
          error_code: rec.errorCode,
          error_detail: rec.errorDetail,
          lease_holder: rec.leaseHolder,
          next_attempt_not_before: rec.nextAttemptNotBefore,
        },
      });
    },
  };
}
