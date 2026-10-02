// Market Index Data - entitlement records (what FHIP may DO with a benchmark series, right by right).
// GET: capability `view`. POST (propose a DRAFT): capability `catalogue`. Approval/revocation are a
// separate capability (`entitlementApprove`) on separate routes: a proposer cannot approve without an
// explicit, recorded self-approval acknowledgement.
import { ok } from '@/lib/api';
import { adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { EntitlementBody, guarded, isMissingRelation, parseBody, rpcFailureResponse } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';
import type { EntitlementRightsView } from '@/lib/services/investment-intelligence/benchmarkData/apiTypes';

export const dynamic = 'force-dynamic';

const COLS =
  'id, benchmark_id, entitlement_kind, status, allow_manual_ingest, allow_automation, allow_storage, allow_calculation, allow_customer_display, allow_report_export, data_from, data_to, valid_from, valid_to, post_expiry_storage, evidence_reference, evidence_url, created_by, approved_at, ii_benchmarks(benchmark_key)';

export const GET = adminRoute(async () => {
  const g = await guarded('view');
  if (!g.ok) return g.response;
  const { data, error } = await g.supabase.from('ii_benchmark_entitlements').select(COLS).order('created_at', { ascending: false }).limit(500);
  if (error) {
    if (isMissingRelation(error)) return Response.json({ error: 'Entitlement tables are not available (migration not applied).', code: 'unavailable' }, { status: 503 });
    return safeDbError(error, 'benchmark entitlements');
  }
  const byBenchmark: Record<string, EntitlementRightsView[]> = {};
  for (const r of (data ?? []) as unknown as Array<Record<string, unknown>>) {
    const key = ((r.ii_benchmarks as { benchmark_key: string } | null)?.benchmark_key) ?? String(r.benchmark_id);
    (byBenchmark[key] ??= []).push({
      entitlementId: r.id as string,
      kind: r.entitlement_kind as EntitlementRightsView['kind'],
      status: r.status as EntitlementRightsView['status'],
      rights: {
        ingestManual: r.allow_manual_ingest === true,
        automation: r.allow_automation === true,
        storage: r.allow_storage === true,
        calculation: r.allow_calculation === true,
        customerDisplay: r.allow_customer_display === true,
        reportExport: r.allow_report_export === true,
      },
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
  }
  return ok(byBenchmark);
});

export const POST = adminRoute(async (req: Request) => {
  const g = await guarded('catalogue');
  if (!g.ok) return g.response;
  const body = await parseBody(req, EntitlementBody);
  if (!body.ok) return body.response;
  const { data, error } = await g.supabase.rpc('propose_benchmark_entitlement', { p: body.data });
  if (error) return rpcFailureResponse(error);
  return ok({ id: data as string, status: 'draft' });
});
