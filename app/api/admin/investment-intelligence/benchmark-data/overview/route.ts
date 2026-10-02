// Benchmark Data - the overview: per-benchmark catalogue status, coverage, ingestion watermarks, demand,
// entitlements and the PENDING-IMPORT task list. Capability `view` (read-only). Caller's own session.
//
// RESULT STATES (Standard section 8): 'ok' or 'unavailable' (migration not applied) - never an empty
// healthy dashboard; any other database error fails closed (explicit error). The data state of a
// benchmark is never a bare zero: no_data / history_missing / stale / current / blocked_no_entitlement.
import { ok } from '@/lib/api';
import { adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { DEFAULT_LIMITS } from '@/lib/services/investment-intelligence/benchmarkData/fileIngest';
import { listImportJobs } from '@/lib/services/investment-intelligence/benchmarkData/publishService';
import { assessPendingImport } from '@/lib/services/investment-intelligence/benchmarkData/ingestion/pending';
import { addDaysIso } from '@/lib/services/investment-intelligence/benchmarkData/ingestion/calendar';
import { guarded, isMissingRelation } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';
import type { BenchmarkOverviewRow, CoverageView, DemandView, EntitlementRightsView, IngestionView, OverviewResponse } from '@/lib/services/investment-intelligence/benchmarkData/apiTypes';

export const dynamic = 'force-dynamic';

const UNAVAILABLE = 'The benchmark governance tables (migration 0241) are not available in this database. This is reported as unavailable, not as an empty healthy state.';
const AUTOMATION_NOTICE =
  'Recurring ingestion is OFF unless every gate holds: the environment flag, the global kill switch, the write kill switch, the benchmark in automated mode, and an approved automation entitlement. Benchmarks in manual-import mode are updated only when an administrator uploads a file.';

export const GET = adminRoute(async () => {
  const g = await guarded('view');
  if (!g.ok) return g.response;
  const sb = g.supabase;
  const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);

  const bm = await sb
    .from('ii_benchmarks')
    .select('id, benchmark_key, benchmark_label, official_name, owner_name, official_identifier, asset_class, return_type, return_variant, currency_code, country_code, base_date, launch_date, history_start_date, history_class, backtested_through, methodology_url, source_url, evidence_ref, evidence_retrieved_at, catalogue_status, lifecycle_status, licence_status')
    .order('benchmark_key', { ascending: true })
    .limit(1000);
  if (bm.error) {
    if (isMissingRelation(bm.error)) return ok({ state: 'unavailable', reason: UNAVAILABLE, asOfDate: today, capabilities: g.flags, limits: DEFAULT_LIMITS, rows: [], recentJobs: [], pendingImports: [], switches: { globalIngestion: false, writeIngestion: false, environmentFlag: false, effectivelyEnabled: false }, automationNotice: AUTOMATION_NOTICE } satisfies OverviewResponse);
    return safeDbError(bm.error, 'benchmark catalogue');
  }
  const benchmarks = (bm.data ?? []) as unknown as Array<Record<string, unknown>>;
  const ids = benchmarks.map((b) => b.id as string);

  const [stateRes, demandRes, entRes, switchRes] = await Promise.all([
    sb.from('ii_benchmark_ingestion_state').select('*').in('benchmark_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']),
    sb.from('ii_benchmark_history_demand').select('*').in('benchmark_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']),
    sb.from('ii_benchmark_entitlements').select('id, benchmark_id, entitlement_kind, status, allow_manual_ingest, allow_automation, allow_storage, allow_calculation, allow_customer_display, allow_report_export, data_from, data_to, valid_from, valid_to, post_expiry_storage, evidence_reference, evidence_url, created_by, approved_at').in('benchmark_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']),
    sb.from('ii_reference_job_control').select('job_key, enabled').in('job_key', ['benchmark_ingestion_global', 'benchmark_ingestion_write']),
  ]);
  for (const r of [stateRes, demandRes, entRes, switchRes]) {
    if (r.error) {
      if (isMissingRelation(r.error)) return ok({ state: 'unavailable', reason: UNAVAILABLE, asOfDate: today, capabilities: g.flags, limits: DEFAULT_LIMITS, rows: [], recentJobs: [], pendingImports: [], switches: { globalIngestion: false, writeIngestion: false, environmentFlag: false, effectivelyEnabled: false }, automationNotice: AUTOMATION_NOTICE } satisfies OverviewResponse);
      return safeDbError(r.error, 'benchmark overview');
    }
  }
  const stateBy = new Map(((stateRes.data ?? []) as Array<Record<string, unknown>>).map((r) => [r.benchmark_id as string, r]));
  const demandBy = new Map(((demandRes.data ?? []) as Array<Record<string, unknown>>).map((r) => [r.benchmark_id as string, r]));
  const entBy = new Map<string, EntitlementRightsView[]>();
  for (const r of (entRes.data ?? []) as Array<Record<string, unknown>>) {
    const list = entBy.get(r.benchmark_id as string) ?? [];
    list.push({
      entitlementId: r.id as string,
      kind: r.entitlement_kind as EntitlementRightsView['kind'],
      status: r.status as EntitlementRightsView['status'],
      rights: { ingestManual: r.allow_manual_ingest === true, automation: r.allow_automation === true, storage: r.allow_storage === true, calculation: r.allow_calculation === true, customerDisplay: r.allow_customer_display === true, reportExport: r.allow_report_export === true },
      dataFrom: (r.data_from as string | null) ?? null,
      dataTo: (r.data_to as string | null) ?? null,
      validFrom: r.valid_from as string,
      validTo: (r.valid_to as string | null) ?? null,
      postExpiryStorage: r.post_expiry_storage as EntitlementRightsView['postExpiryStorage'],
      evidenceReference: r.evidence_reference as string,
      evidenceUrl: (r.evidence_url as string | null) ?? null,
      proposedByMe: r.created_by === g.user.id,
      approvedAt: (r.approved_at as string | null) ?? null,
    });
    entBy.set(r.benchmark_id as string, list);
  }
  const sw = new Map(((switchRes.data ?? []) as Array<{ job_key: string; enabled: boolean }>).map((r) => [r.job_key, r.enabled === true]));
  const envFlag = process.env.BENCHMARK_INGESTION_ENABLED === 'true';
  const globalOn = sw.get('benchmark_ingestion_global') === true;
  const writeOn = sw.get('benchmark_ingestion_write') === true;

  const rows: BenchmarkOverviewRow[] = [];
  const pendingImports = [];
  for (const b of benchmarks) {
    const id = b.id as string;
    // Coverage via head/limit-1 queries (no row payload).
    const first = await sb.from('ii_benchmark_series').select('series_date').eq('benchmark_id', id).neq('quality_status', 'superseded').order('series_date', { ascending: true }).limit(1).maybeSingle();
    const last = await sb.from('ii_benchmark_series').select('series_date').eq('benchmark_id', id).neq('quality_status', 'superseded').order('series_date', { ascending: false }).limit(1).maybeSingle();
    const cnt = await sb.from('ii_benchmark_series').select('id', { count: 'exact', head: true }).eq('benchmark_id', id).neq('quality_status', 'superseded');
    if (first.error || last.error || cnt.error) return safeDbError(first.error ?? last.error ?? cnt.error, 'benchmark coverage');
    const coverage: CoverageView = { firstDate: (first.data as { series_date: string } | null)?.series_date ?? null, lastDate: (last.data as { series_date: string } | null)?.series_date ?? null, rowCount: cnt.count ?? 0 };

    const s = stateBy.get(id);
    const ingestion: IngestionView | null = s
      ? {
          mode: s.ingestion_mode as IngestionView['mode'],
          automationEnabled: s.automation_enabled === true,
          adapterId: (s.adapter_id as string | null) ?? null,
          publicationLagDays: s.publication_lag_days as number,
          latestValidDataDate: (s.latest_valid_data_date as string | null) ?? null,
          completenessWatermark: (s.completeness_watermark as string | null) ?? null,
          lastAttemptAt: (s.last_attempt_at as string | null) ?? null,
          lastSuccessfulRunAt: (s.last_successful_run_at as string | null) ?? null,
          lastManualImportAt: (s.last_manual_import_at as string | null) ?? null,
          lastRunStatus: (s.last_run_status as string | null) ?? null,
          consecutiveFailures: s.consecutive_failures as number,
        }
      : null;
    const d = demandBy.get(id);
    const demand: DemandView | null = d ? { requiredFrom: d.required_from as string, requiredFromInvestor: (d.required_from_investor as string | null) ?? null, requiredTo: d.required_to as string, schemeCount: d.scheme_count as number, familyCount: d.family_count as number, computedAt: d.computed_at as string } : null;

    const pending = assessPendingImport(
      { benchmarkKey: b.benchmark_key as string, benchmarkLabel: (b.benchmark_label as string) ?? (b.benchmark_key as string), ingestionMode: ingestion?.mode ?? 'manual_import', publicationLagDays: ingestion?.publicationLagDays ?? 1, latestValidDataDate: ingestion?.latestValidDataDate ?? coverage.lastDate, requiredFrom: demand?.requiredFrom ?? null },
      nowIso
    );
    const ents = entBy.get(id) ?? [];
    const hasCalc = ents.some((e) => e.status === 'approved' && e.rights.calculation);
    let dataState: BenchmarkOverviewRow['dataState'];
    if (coverage.rowCount === 0) dataState = 'no_data';
    else if (!hasCalc) dataState = 'blocked_no_entitlement';
    else if (demand && coverage.firstDate && demand.requiredFrom < addDaysIso(coverage.firstDate, -7)) dataState = 'history_missing';
    else if (pending.status === 'overdue' || pending.status === 'due') dataState = 'stale';
    else dataState = 'current';
    if (pending.status !== 'not_manual' && pending.status !== 'current') pendingImports.push(pending);

    rows.push({
      catalogue: {
        id,
        benchmarkKey: b.benchmark_key as string,
        label: b.benchmark_label as string,
        officialName: (b.official_name as string | null) ?? null,
        ownerName: (b.owner_name as string | null) ?? null,
        officialIdentifier: (b.official_identifier as string | null) ?? null,
        assetClass: (b.asset_class as string | null) ?? null,
        returnType: (b.return_type as string | null) ?? null,
        returnVariant: (b.return_variant as BenchmarkOverviewRow['catalogue']['returnVariant']) ?? null,
        currencyCode: b.currency_code ? String(b.currency_code).trim() : null,
        countryCode: b.country_code ? String(b.country_code).trim() : null,
        baseDate: (b.base_date as string | null) ?? null,
        launchDate: (b.launch_date as string | null) ?? null,
        historyStartDate: (b.history_start_date as string | null) ?? null,
        historyClass: b.history_class as BenchmarkOverviewRow['catalogue']['historyClass'],
        backtestedThrough: (b.backtested_through as string | null) ?? null,
        methodologyUrl: (b.methodology_url as string | null) ?? null,
        sourceUrl: (b.source_url as string | null) ?? null,
        evidenceRef: (b.evidence_ref as string | null) ?? null,
        evidenceRetrievedAt: (b.evidence_retrieved_at as string | null) ?? null,
        catalogueStatus: b.catalogue_status as BenchmarkOverviewRow['catalogue']['catalogueStatus'],
        lifecycleStatus: b.lifecycle_status as string,
        licenceStatusSummary: b.licence_status as string,
      },
      coverage,
      ingestion,
      demand,
      dataState,
      entitlements: ents,
      pending,
    });
  }

  let recentJobs: OverviewResponse['recentJobs'] = [];
  try {
    recentJobs = await listImportJobs(sb, g.user.id, 20);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (!isMissingRelation(err)) return safeDbError(err, 'benchmark import jobs');
  }

  const body: OverviewResponse = {
    state: 'ok',
    asOfDate: today,
    capabilities: g.flags,
    limits: DEFAULT_LIMITS,
    rows,
    recentJobs,
    pendingImports,
    switches: { globalIngestion: globalOn, writeIngestion: writeOn, environmentFlag: envFlag, effectivelyEnabled: globalOn && writeOn && envFlag },
    automationNotice: AUTOMATION_NOTICE,
  };
  return ok(body);
});
