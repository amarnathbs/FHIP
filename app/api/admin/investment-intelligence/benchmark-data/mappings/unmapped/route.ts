// Market Index Data - schemes with NO approved benchmark mapping yet, counted by AMFI category.
// Capability `view` (read-only, reference data only: no user, account, holding or amount is read).
// A category with a default lists the Tier-1 candidates it permits; such a default is only ever a
// low-confidence PROPOSAL that waits for a reviewer (see schemeMappingProposals.ts), never a mapping.
import { ok } from '@/lib/api';
import { adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { guarded, isMissingRelation } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';
import { summariseUnmappedSchemes, type UnmappedSummary } from '@/lib/services/investment-intelligence/benchmarkData/schemeMappingProposals';
import { fetchAllRows } from '@/lib/services/investment-intelligence/pagination';

export const dynamic = 'force-dynamic';

export const GET = adminRoute(async () => {
  const g = await guarded('view');
  if (!g.ok) return g.response;
  try {
    const mapped = await fetchAllRows<{ id: string; instrument_id: string }>(() =>
      g.supabase.from('ii_instrument_benchmarks').select('id, instrument_id').eq('relationship_type', 'primary').neq('quality_status', 'superseded').order('id', { ascending: true })
    );
    const open = await fetchAllRows<{ id: string; instrument_id: string }>(() =>
      g.supabase.from('ii_benchmark_mapping_proposals').select('id, instrument_id').eq('status', 'proposed').order('id', { ascending: true })
    );
    const schemes = await fetchAllRows<{ id: string; instrument_id: string; scheme_name: string; amc_name: string | null; sub_category: string | null }>(() =>
      g.supabase.from('ii_scheme_master').select('id, instrument_id, scheme_name, amc_name, sub_category').eq('lifecycle_status', 'active').is('effective_to', null).order('id', { ascending: true })
    );
    const summary: UnmappedSummary = summariseUnmappedSchemes(
      schemes.map((s) => ({ instrumentId: s.instrument_id, subCategory: s.sub_category, schemeName: s.scheme_name, amcName: s.amc_name })),
      new Set(mapped.map((m) => m.instrument_id)),
      new Set(open.map((p) => p.instrument_id))
    );
    return ok(summary);
  } catch (e) {
    const err = { message: e instanceof Error ? e.message : String(e) };
    if (isMissingRelation(err)) return Response.json({ error: 'Mapping tables are not available (migration not applied).', code: 'unavailable' }, { status: 503 });
    return safeDbError(err, 'unmapped schemes');
  }
});
