// Benchmark Data - the benchmark catalogue. GET: capability `view`. POST: capability `catalogue`
// (can_manage_benchmark_catalogue) -> upsert_benchmark_catalogue_entry, which re-checks the capability,
// keeps a VERIFIED entry's variant immutable and drops an edited verified entry back to draft.
import { ok } from '@/lib/api';
import { adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { CatalogueBody, guarded, isMissingRelation, parseBody, rpcFailureResponse } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';
import type { CatalogueRowView } from '@/lib/services/investment-intelligence/benchmarkData/apiTypes';

export const dynamic = 'force-dynamic';

const COLS =
  'id, benchmark_key, benchmark_label, official_name, owner_name, official_identifier, asset_class, return_type, return_variant, currency_code, country_code, base_date, launch_date, history_start_date, history_class, backtested_through, methodology_url, source_url, evidence_ref, evidence_retrieved_at, catalogue_status, lifecycle_status, licence_status';

export const GET = adminRoute(async () => {
  const g = await guarded('view');
  if (!g.ok) return g.response;
  const { data, error } = await g.supabase.from('ii_benchmarks').select(COLS).order('benchmark_key', { ascending: true }).limit(1000);
  if (error) {
    if (isMissingRelation(error)) return Response.json({ error: 'The benchmark catalogue columns are not available (migration not applied).', code: 'unavailable' }, { status: 503 });
    return safeDbError(error, 'benchmark catalogue');
  }
  const rows: CatalogueRowView[] = ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    benchmarkKey: r.benchmark_key as string,
    label: r.benchmark_label as string,
    officialName: (r.official_name as string | null) ?? null,
    ownerName: (r.owner_name as string | null) ?? null,
    officialIdentifier: (r.official_identifier as string | null) ?? null,
    assetClass: (r.asset_class as string | null) ?? null,
    returnType: (r.return_type as string | null) ?? null,
    returnVariant: (r.return_variant as CatalogueRowView['returnVariant']) ?? null,
    currencyCode: r.currency_code ? String(r.currency_code).trim() : null,
    countryCode: r.country_code ? String(r.country_code).trim() : null,
    baseDate: (r.base_date as string | null) ?? null,
    launchDate: (r.launch_date as string | null) ?? null,
    historyStartDate: (r.history_start_date as string | null) ?? null,
    historyClass: r.history_class as CatalogueRowView['historyClass'],
    backtestedThrough: (r.backtested_through as string | null) ?? null,
    methodologyUrl: (r.methodology_url as string | null) ?? null,
    sourceUrl: (r.source_url as string | null) ?? null,
    evidenceRef: (r.evidence_ref as string | null) ?? null,
    evidenceRetrievedAt: (r.evidence_retrieved_at as string | null) ?? null,
    catalogueStatus: r.catalogue_status as CatalogueRowView['catalogueStatus'],
    lifecycleStatus: r.lifecycle_status as string,
    licenceStatusSummary: r.licence_status as string,
  }));
  return ok(rows);
});

export const POST = adminRoute(async (req: Request) => {
  const g = await guarded('catalogue');
  if (!g.ok) return g.response;
  const body = await parseBody(req, CatalogueBody);
  if (!body.ok) return body.response;
  const { data, error } = await g.supabase.rpc('upsert_benchmark_catalogue_entry', { p: body.data });
  if (error) return rpcFailureResponse(error);
  return ok({ id: data as string });
});
