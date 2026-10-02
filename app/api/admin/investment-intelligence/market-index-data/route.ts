// Market Index Data — admin upload of historical Nifty 50 / BSE Sensex closing
// values (price index close) and status of the daily feed.
//
// ADMIN ARCHITECTURE STANDARD — applicability, stated:
//   Capability  : marketIndexDataUpload (admin_users.can_upload_market_index_data,
//                 migration 0232). Separately named; NOT implied by isAdmin, PC6
//                 referenceDataQuality or PC7 lookthroughDataQuality (section 2).
//   Four layers : (1) DB   — is_market_index_data_admin(), the upload RPC's own
//                            auth.uid() check, RLS on ii_market_index_batches;
//                 (2) API  — requireMarketIndexAdmin() below, on EVERY verb;
//                 (3) page — requireMarketIndexAdminPage();
//                 (4) nav  — lib/admin/adminNav.ts `marketIndexDataUpload`.
//   Denial      : explicit 401 / 403, never a 200 with an empty body (section 4).
//   Section 9   : the tables behind this surface are GLOBAL reference data with
//                 no tenancy column. The ledger records the uploader's id but
//                 the API returns only `uploadedByMe`, never another admin's
//                 identifier. No user financial data is read or written here.
//   Section 11  : no export. The only output is JSON to the capability holder.
//   Section 13  : any role-resolution failure, missing column (0232 not
//                 applied), RPC error or malformed body fails closed with an
//                 explicit error — never a fabricated empty success.
//
// POST is preview-or-commit and runs under the CALLER'S OWN session client, so
// the database function authorises with auth.uid(); the service-role client is
// deliberately not used anywhere in this file.
import { createClient } from '@/lib/supabase/server';
import { ok, bad } from '@/lib/api';
import { adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { requireMarketIndexAdmin } from '@/lib/services/investment-intelligence/marketIndex/marketIndexAdmin';
import { MARKET_INDEX_KEY_LIST, MARKET_INDEX_LABELS, MARKET_INDEX_STALE_AFTER_DAYS, MARKET_INDEX_DAILY_JOB_KEY, MARKET_INDEX_FEED_ENV_FLAG } from '@/lib/config/investment-intelligence/marketIndexConfig';
import { ATTESTATION_TEXT } from '@/lib/services/investment-intelligence/marketIndex/indexUploadService';
import { INDEX_CSV_MAX_BYTES } from '@/lib/services/investment-intelligence/marketIndex/indexCsvParser';
import { assessFreshness } from '@/lib/services/investment-intelligence/pc6/referenceDataQuality';

export const dynamic = 'force-dynamic';

const UNAVAILABLE_0232 = 'Migration 0232 has not been applied to this database, so the market-index tables do not exist yet. This is reported as unavailable rather than as an empty healthy state.';

function isMissingRelation(error: { code?: string; message?: string } | null | undefined): boolean {
  return Boolean(error && (error.code === 'PGRST205' || error.code === '42P01' || error.code === '42703' || /does not exist|schema cache/i.test(error.message ?? '')));
}

export const GET = adminRoute(async () => {
  const { user, forbidden } = await requireMarketIndexAdmin();
  if (forbidden || !user) return forbidden ?? bad('unauthenticated', 401);

  const supabase = await createClient();
  const today = new Date().toISOString().slice(0, 10);
  const indices: Array<Record<string, unknown>> = [];

  for (const key of MARKET_INDEX_KEY_LIST) {
    const { data: bench, error: bErr } = await supabase.from('ii_benchmarks').select('id').eq('benchmark_key', key).maybeSingle();
    if (bErr) {
      if (isMissingRelation(bErr)) return ok({ state: 'unavailable', reason: UNAVAILABLE_0232, attestationText: ATTESTATION_TEXT });
      return safeDbError(bErr, 'market index benchmark');
    }
    if (!bench) return ok({ state: 'unavailable', reason: UNAVAILABLE_0232, attestationText: ATTESTATION_TEXT });
    const benchmarkId = (bench as { id: string }).id;
    const { data: latest, error: lErr } = await supabase
      .from('ii_benchmark_series')
      .select('series_date, value')
      .eq('benchmark_id', benchmarkId)
      .neq('quality_status', 'superseded')
      .order('series_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lErr) return safeDbError(lErr, 'market index latest');
    const { data: first } = await supabase.from('ii_benchmark_series').select('series_date').eq('benchmark_id', benchmarkId).order('series_date', { ascending: true }).limit(1).maybeSingle();
    const { count } = await supabase.from('ii_benchmark_series').select('id', { count: 'exact', head: true }).eq('benchmark_id', benchmarkId);
    const latestDate = (latest as { series_date: string } | null)?.series_date ?? null;
    indices.push({
      key,
      label: MARKET_INDEX_LABELS[key],
      // Section 8: never-loaded is its own state, not a zero and not "fresh".
      freshness: assessFreshness(latestDate, today, MARKET_INDEX_STALE_AFTER_DAYS),
      latestClose: latest ? Number((latest as { value: number | string }).value) : null,
      firstDate: (first as { series_date: string } | null)?.series_date ?? null,
      rowCount: count ?? 0,
    });
  }

  const { data: batches, error: batchErr } = await supabase
    .from('ii_market_index_batches')
    .select('id, benchmark_key, source_kind, file_name, file_sha256, row_count_submitted, rows_inserted, rows_identical_skipped, rows_conflicts_skipped, date_from, date_to, uploader_user_id, attested, created_at')
    .order('created_at', { ascending: false })
    .limit(30);
  if (batchErr) {
    if (isMissingRelation(batchErr)) return ok({ state: 'unavailable', reason: UNAVAILABLE_0232, attestationText: ATTESTATION_TEXT });
    return safeDbError(batchErr, 'market index batches');
  }

  const { data: job } = await supabase.from('ii_reference_job_control').select('enabled, disabled_reason, last_success_at, last_failure_at, consecutive_failures').eq('job_key', MARKET_INDEX_DAILY_JOB_KEY).maybeSingle();
  const envOn = process.env[MARKET_INDEX_FEED_ENV_FLAG] === 'true';

  return ok({
    state: 'ok',
    asOfDate: today,
    attestationText: ATTESTATION_TEXT,
    limits: { maxBytes: INDEX_CSV_MAX_BYTES },
    indices,
    recentBatches: (batches ?? []).map((b) => {
      const { uploader_user_id, ...rest } = b as Record<string, unknown> & { uploader_user_id: string | null };
      // Section 9: another admin's identifier is never returned.
      return { ...rest, uploadedByMe: uploader_user_id === user.id };
    }),
    dailyFeed: {
      // The feed runs only when BOTH the database switch and the environment
      // switch are on. Both ship off.
      jobEnabled: (job as { enabled?: boolean } | null)?.enabled === true,
      environmentEnabled: envOn,
      effectivelyEnabled: (job as { enabled?: boolean } | null)?.enabled === true && envOn,
      disabledReason: (job as { disabled_reason?: string | null } | null)?.disabled_reason ?? null,
      lastSuccessAt: (job as { last_success_at?: string | null } | null)?.last_success_at ?? null,
      lastFailureAt: (job as { last_failure_at?: string | null } | null)?.last_failure_at ?? null,
      consecutiveFailures: (job as { consecutive_failures?: number } | null)?.consecutive_failures ?? 0,
      termsWarning:
        'NSE and BSE restrict automated scraping and redistribution of their index data. Do not enable the daily feed until NSE/BSE terms have been confirmed or a licence is held.',
    },
  });
});

// SUPERSEDED (BENCH-1 Phase 2). The earlier single-step upload wrote series rows on an attestation
// checkbox alone and called commit_market_index_upload(), which migration 0241 revokes from
// authenticated sessions because it bypassed the per-right entitlement gate. All uploads now go
// through the ONE staged pipeline at /api/admin/investment-intelligence/benchmark-data/upload
// (stage -> validate -> approve -> publish, bound to checksum + staging digest + entitlement).
// Authentication is still checked first so an unauthenticated caller receives 401, not 410.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the signature is kept so callers/tests still pass a Request
export const POST = adminRoute(async (_req: Request) => {
  const { forbidden } = await requireMarketIndexAdmin();
  if (forbidden) return forbidden;
  return Response.json({ error: 'Superseded by /api/admin/investment-intelligence/benchmark-data/upload', code: 'SUPERSEDED' }, { status: 410 });
});
