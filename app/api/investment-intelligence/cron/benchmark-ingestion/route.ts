import crypto from 'node:crypto';
import { ok, bad } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { BENCHMARK_FEED_ADAPTERS } from '@/lib/services/investment-intelligence/benchmarkData/ingestion/adapters';
import { createLiveDeps, environmentMatches, INGESTION_ENV_FLAG } from '@/lib/services/investment-intelligence/benchmarkData/ingestion/liveDeps';
import { runBenchmarkIngestion, type RunKind } from '@/lib/services/investment-intelligence/benchmarkData/ingestion/orchestrator';
import { expectedLatestSession } from '@/lib/services/investment-intelligence/benchmarkData/ingestion/calendar';
import { refreshBenchmarkHistoryDemand } from '@/lib/services/investment-intelligence/benchmarkData/demand';

/**
 * Benchmark-specific recurring ingestion (BENCH-1 Phase 2).
 *
 * SHIPS DISABLED, and nothing schedules it: migration 0241 creates NO pg_cron
 * job, the adapter registry ships EMPTY (no index owner's terms were verified to
 * permit automation), and every gate below fails closed:
 *   1. x-cron-secret === CRON_SECRET (same job authentication as the other cron routes);
 *   2. BENCHMARK_INGESTION_ENABLED === 'true' in THIS environment (absent = off);
 *   3. BENCHMARK_INGESTION_PROJECT_REF equals the connected Supabase project ref, so a DEV job
 *      can never write production and vice versa (a production origin is never reused for DEV);
 *   4. inside the runner: global kill switch, per-benchmark mode + source switch, central
 *      entitlement (automation + storage), backoff, retry budget, single-flight lease, write
 *      kill switch (dry run when off).
 * Output is counts, statuses and alert codes only - never a URL, header or row.
 *
 * ?run_kind= daily | late_retry | weekly_gap | monthly_reconcile | history_expansion | demand_refresh
 */
const RUN_KINDS = new Set(['daily', 'late_retry', 'weekly_gap', 'monthly_reconcile', 'history_expansion', 'probe', 'demand_refresh']);

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export async function POST(req: Request) {
  const secret = req.headers.get('x-cron-secret');
  const expected = process.env.CRON_SECRET;
  if (!secret || !expected || !timingSafeEqual(secret, expected)) return bad('Unauthorized', 401);

  const runKind = new URL(req.url).searchParams.get('run_kind') ?? 'daily';
  if (!RUN_KINDS.has(runKind)) return bad('Unknown run_kind', 422);

  try {
    const env = { ...process.env } as Record<string, string | undefined>;
    // Fail closed BEFORE building a service-role client: when off, nothing is touched.
    if (env[INGESTION_ENV_FLAG] !== 'true') {
      return ok({ status: 'disabled_env', detail: `${INGESTION_ENV_FLAG} is not 'true'. Benchmark ingestion is OFF by default.`, results: [], alerts: [] });
    }
    const envCheck = environmentMatches(env);
    if (!envCheck.ok) return ok({ status: 'refused_environment', detail: envCheck.reason, results: [], alerts: [] });

    const admin = createAdminClient();
    const nowIso = new Date().toISOString();
    if (runKind === 'demand_refresh') {
      const r = await refreshBenchmarkHistoryDemand(admin, expectedLatestSession(nowIso, 1));
      return ok({ status: r.error ? 'failed' : 'completed', benchmarks: r.benchmarks, detail: r.error ? 'Demand refresh failed.' : 'Demand refreshed.', results: [], alerts: [] });
    }
    const deps = createLiveDeps(admin, { nowIso, holderId: `cron-${crypto.randomUUID()}`, adapters: BENCHMARK_FEED_ADAPTERS });
    const result = await runBenchmarkIngestion(deps, { runKind: runKind as RunKind });
    for (const a of result.alerts) if (a.severity === 'critical') console.error(`benchmark-ingestion ${a.code}: ${a.detail}`);
    return ok({
      version: result.version,
      status: result.status,
      results: result.results.map((r) => ({ benchmark: r.benchmarkKey, status: r.status, success: r.success, rows_fetched: r.rowsFetched, rows_inserted: r.rowsInserted, requests: r.requests, window_from: r.windowFrom, window_to: r.windowTo, completeness_watermark: r.completenessWatermark })),
      alerts: result.alerts.map((a) => ({ severity: a.severity, code: a.code })),
    });
  } catch (err) {
    console.error('Benchmark ingestion error:', err);
    return bad('Unexpected error', 500);
  }
}
