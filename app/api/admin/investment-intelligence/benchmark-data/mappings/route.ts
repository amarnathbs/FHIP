// Benchmark Data - scheme -> benchmark mapping proposals (with evidence). GET: capability `view`.
// POST (propose): capability `catalogue`. A proposal never changes a mapping by itself: review
// (approve/reject) is a separate route; only deterministic, high-confidence, evidenced matches to a
// VERIFIED catalogue entry may auto-publish, and only from the service-role job - not from here.
import { ok } from '@/lib/api';
import { adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { guarded, isMissingRelation, MappingBody, parseBody, rpcFailureResponse } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';
import type { MappingProposalView } from '@/lib/services/investment-intelligence/benchmarkData/apiTypes';

export const dynamic = 'force-dynamic';

const COLS =
  'id, instrument_id, proposed_benchmark_name, relationship_type, effective_from, effective_to, evidence_source, evidence_url, evidence_title, evidence_document_date, evidence_retrieved_at, evidence_excerpt, resolution_method, confidence, ambiguity_reason, status, auto_published, review_note, ii_benchmarks(benchmark_key), ii_instruments(instrument_name)';

export const GET = adminRoute(async () => {
  const g = await guarded('view');
  if (!g.ok) return g.response;
  const { data, error } = await g.supabase.from('ii_benchmark_mapping_proposals').select(COLS).order('proposed_at', { ascending: false }).limit(500);
  if (error) {
    if (isMissingRelation(error)) return Response.json({ error: 'Mapping tables are not available (migration not applied).', code: 'unavailable' }, { status: 503 });
    return safeDbError(error, 'benchmark mappings');
  }
  const rows: MappingProposalView[] = ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    instrumentId: r.instrument_id as string,
    instrumentName: (r.ii_instruments as { instrument_name: string } | null)?.instrument_name ?? null,
    benchmarkKey: (r.ii_benchmarks as { benchmark_key: string } | null)?.benchmark_key ?? null,
    proposedBenchmarkName: r.proposed_benchmark_name as string,
    relationshipType: r.relationship_type as MappingProposalView['relationshipType'],
    effectiveFrom: r.effective_from as string,
    effectiveTo: (r.effective_to as string | null) ?? null,
    evidenceSource: r.evidence_source as string,
    evidenceUrl: r.evidence_url as string,
    evidenceTitle: (r.evidence_title as string | null) ?? null,
    evidenceDocumentDate: r.evidence_document_date as string,
    evidenceRetrievedAt: r.evidence_retrieved_at as string,
    evidenceExcerpt: (r.evidence_excerpt as string | null) ?? null,
    resolutionMethod: r.resolution_method as string,
    confidence: r.confidence as string,
    ambiguityReason: (r.ambiguity_reason as string | null) ?? null,
    status: r.status as MappingProposalView['status'],
    autoPublished: r.auto_published === true,
    reviewNote: (r.review_note as string | null) ?? null,
  }));
  return ok(rows);
});

export const POST = adminRoute(async (req: Request) => {
  const g = await guarded('catalogue');
  if (!g.ok) return g.response;
  const body = await parseBody(req, MappingBody);
  if (!body.ok) return body.response;
  const { data, error } = await g.supabase.rpc('propose_benchmark_mapping', { p: body.data });
  if (error) return rpcFailureResponse(error);
  return ok({ id: data as string, status: 'proposed' });
});
