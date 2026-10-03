// Market Index Data - HELD schemes and whether they have a benchmark. Capability `view` (read-only).
// The held population is cross-user, so it comes from the aggregate-only SECURITY DEFINER RPC
// benchmark_held_schemes() (migration 0251), which checks the view capability again inside the
// database and returns holder COUNTS only: no user, account, unit or amount ever reaches this route.
// If the migration is not applied the answer is an explicit 503, never an empty list.
//
// Further READ-ONLY enrichments (all public fund facts, never personal data):
//   * AMFI's canonical scheme names (reference data), fail soft.
//   * declared_benchmark_records_for() (migration 0252): a held scheme whose own documents declare a benchmark the
//     catalogue cannot represent is shown as "Declared benchmark: <name> (cannot be compared with the data we hold)"
//     and is NEVER given a category benchmark. Missing function (0252 not applied) = no such records, as before.
//   * the latest factsheet-reader attempt per scheme (date and result), for the "last factsheet check" column.
//     Missing table (0252 not applied) = no check shown; the list itself is unaffected.
import { ok } from '@/lib/api';
import { adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { guarded, isMissingRelation, rpcFailureResponse } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';
import { buildHeldSchemeRows, heldRawFromRpc, withSchemeMasterNames } from '@/lib/services/investment-intelligence/benchmarkData/heldSchemes';
import { declaredRecordsFromRpc, isDeclaredRecordsUnavailable, type DeclaredRecord } from '@/lib/services/investment-intelligence/benchmarkData/declaredRecordStatus';
import { latestCheckByInstrument, type FactsheetCheckView } from '@/lib/services/investment-intelligence/factsheetReader/adminView';

export const dynamic = 'force-dynamic';

const RPC_CHUNK = 400;

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
  const ids = held.map((h) => h.instrumentId);
  // AMFI's canonical scheme names (reference data, readable by the caller's own session). Fail soft: if this
  // read fails the statement-derived names are used, never an error for a display nicety.
  const names = new Map<string, string>();
  try {
    for (let i = 0; i < ids.length; i += 200) {
      const { data: sm, error: smErr } = await g.supabase.from('ii_scheme_master').select('instrument_id, scheme_name').in('instrument_id', ids.slice(i, i + 200)).is('effective_to', null);
      if (smErr) break;
      for (const r of (sm ?? []) as Array<{ instrument_id: string; scheme_name: string }>) if (typeof r.scheme_name === 'string' && r.scheme_name.trim()) names.set(r.instrument_id, r.scheme_name);
    }
  } catch {
    names.clear();
  }
  const raw = withSchemeMasterNames(held, names);

  const declared = new Map<string, DeclaredRecord>();
  for (let i = 0; i < ids.length; i += RPC_CHUNK) {
    const dr = await g.supabase.rpc('declared_benchmark_records_for', { p_instrument_ids: ids.slice(i, i + RPC_CHUNK) });
    if (dr.error) {
      if (isDeclaredRecordsUnavailable(dr.error)) break; // 0252 not applied: nothing is declared
      return rpcFailureResponse(dr.error); // any other failure is explicit, never "no declared record"
    }
    for (const [k, v] of declaredRecordsFromRpc(dr.data)) declared.set(k, v);
  }
  for (const r of raw) r.declaredRecord = declared.get(r.instrumentId) ?? null;

  let factsheetChecks = new Map<string, FactsheetCheckView>();
  if (ids.length > 0) {
    const at = await g.supabase.from('ii_factsheet_attempts').select('instrument_id, attempted_at, outcome, document_date').in('instrument_id', ids).order('attempted_at', { ascending: false }).limit(2000);
    if (at.error) {
      if (!isMissingRelation(at.error)) return safeDbError(at.error, 'factsheet checks');
    } else {
      factsheetChecks = latestCheckByInstrument((at.data ?? []) as unknown as Array<{ instrument_id: string; attempted_at: string; outcome: string; document_date: string | null }>);
    }
  }
  return ok(buildHeldSchemeRows(raw, { factsheetChecks }));
});
