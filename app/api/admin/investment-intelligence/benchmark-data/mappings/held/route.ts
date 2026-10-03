// Market Index Data - HELD schemes and whether they have a benchmark. Capability `view` (read-only).
// The held population is cross-user, so it comes from the aggregate-only SECURITY DEFINER RPC
// benchmark_held_schemes() (migration 0251), which checks the view capability again inside the
// database and returns holder COUNTS only: no user, account, unit or amount ever reaches this route.
// If the migration is not applied the answer is an explicit 503, never an empty list.
import { ok } from '@/lib/api';
import { adminRoute } from '@/lib/services/adminAuth';
import { guarded, isMissingRelation, rpcFailureResponse } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';
import { buildHeldSchemeRows, heldRawFromRpc, withSchemeMasterNames } from '@/lib/services/investment-intelligence/benchmarkData/heldSchemes';

export const dynamic = 'force-dynamic';

export const GET = adminRoute(async () => {
  const g = await guarded('view');
  if (!g.ok) return g.response;
  const { data, error } = await g.supabase.rpc('benchmark_held_schemes');
  if (error) {
    if (isMissingRelation(error)) {
      return Response.json({ error: 'This list needs a database update that has not been applied yet.', code: 'unavailable' }, { status: 503 });
    }
    return rpcFailureResponse(error);
  }
  const held = heldRawFromRpc(data);
  // AMFI's canonical scheme names (reference data, readable by the caller's own session). Fail soft: if this
  // read fails the statement-derived names are used, never an error for a display nicety.
  const names = new Map<string, string>();
  try {
    const ids = held.map((h) => h.instrumentId);
    for (let i = 0; i < ids.length; i += 200) {
      const { data: sm, error: smErr } = await g.supabase.from('ii_scheme_master').select('instrument_id, scheme_name').in('instrument_id', ids.slice(i, i + 200)).is('effective_to', null);
      if (smErr) break;
      for (const r of (sm ?? []) as Array<{ instrument_id: string; scheme_name: string }>) if (typeof r.scheme_name === 'string' && r.scheme_name.trim()) names.set(r.instrument_id, r.scheme_name);
    }
  } catch {
    names.clear();
  }
  return ok(buildHeldSchemeRows(withSchemeMasterNames(held, names)));
});
