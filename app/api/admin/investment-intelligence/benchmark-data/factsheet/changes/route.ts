// Market Index Data - the "Factsheet changes to review" queue. Capability `view` (read-only).
//
// Reads, under the CALLER'S session, the declared-benchmark versions that wait for a human (a changed benchmark, an
// unsupported composite or commodity price, a low-confidence or disagreeing reading, a conflict with an admin mapping),
// with the previous benchmark, the new one, the source document, confidence and the evidence. No user, account, holding
// or holder count is read or returned. If migration 0252 is not applied the answer is an explicit 503, never an empty list.
import { ok } from '@/lib/api';
import { adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { guarded, isMissingRelation } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';
import { buildFactsheetChangeViews, type EventRow, type FactsheetChangesResponse, type VersionRow } from '@/lib/services/investment-intelligence/factsheetReader/adminView';

export const dynamic = 'force-dynamic';

const VERSION_COLS =
  'id, instrument_id, version_no, supersedes_version_id, tier1_name, additional_names, benchmark_kind, composition, catalogue_state, match_confidence, effective_from, effective_from_basis, source_url, source_title, source_document_type, document_date, document_month, retrieved_at, extraction_method, extraction_confidence, evidence_excerpt, review_state, review_reason, ii_instruments(instrument_name), ii_benchmarks(benchmark_key)';

export const GET = adminRoute(async () => {
  const g = await guarded('view');
  if (!g.ok) return g.response;
  const unavailable = (reason: string) => Response.json({ error: reason, code: 'unavailable' }, { status: 503 });

  const pending = await g.supabase.from('ii_scheme_declared_benchmark_versions').select(VERSION_COLS).eq('review_state', 'pending_review').order('created_at', { ascending: false }).limit(300);
  if (pending.error) {
    if (isMissingRelation(pending.error)) return unavailable('The factsheet reader tables are not available (migration not applied).');
    return safeDbError(pending.error, 'factsheet changes');
  }
  const refused = await g.supabase.from('ii_factsheet_version_events').select('version_id, event_type, proposal_id, created_at').eq('event_type', 'auto_publish_refused').limit(300);
  if (refused.error) return safeDbError(refused.error, 'factsheet changes');

  const versions = new Map<string, VersionRow>();
  for (const v of (pending.data ?? []) as unknown as VersionRow[]) versions.set(v.id, v);
  const refusedIds = [...new Set(((refused.data ?? []) as unknown as EventRow[]).map((e) => e.version_id))].filter((id) => !versions.has(id));
  if (refusedIds.length > 0) {
    const extra = await g.supabase.from('ii_scheme_declared_benchmark_versions').select(VERSION_COLS).in('id', refusedIds);
    if (extra.error) return safeDbError(extra.error, 'factsheet changes');
    for (const v of (extra.data ?? []) as unknown as VersionRow[]) versions.set(v.id, v);
  }
  const ids = [...versions.keys()];
  let events: EventRow[] = [];
  if (ids.length > 0) {
    const ev = await g.supabase.from('ii_factsheet_version_events').select('version_id, event_type, proposal_id, created_at').in('version_id', ids).order('created_at', { ascending: true });
    if (ev.error) return safeDbError(ev.error, 'factsheet changes');
    events = (ev.data ?? []) as unknown as EventRow[];
  }
  const prevIds = [...new Set([...versions.values()].map((v) => v.supersedes_version_id).filter((x): x is string => Boolean(x)))];
  const previousNames = new Map<string, string>();
  if (prevIds.length > 0) {
    const prev = await g.supabase.from('ii_scheme_declared_benchmark_versions').select('id, tier1_name').in('id', prevIds);
    if (prev.error) return safeDbError(prev.error, 'factsheet changes');
    for (const r of (prev.data ?? []) as unknown as Array<{ id: string; tier1_name: string }>) previousNames.set(r.id, r.tier1_name);
  }

  const src = await g.supabase.from('ii_factsheet_sources').select('source_key, amc_name, document_type, host, terms_review_status, enabled').order('source_key', { ascending: true }).limit(200);
  if (src.error) return safeDbError(src.error, 'factsheet sources');
  // The switch lives in a table only some capabilities may read; "cannot read it" is reported as unknown, never as on.
  const sw = await g.supabase.from('ii_reference_job_control').select('enabled').eq('job_key', 'factsheet_benchmark_reader').maybeSingle();
  const readerSwitchedOn = sw.error || !sw.data ? null : (sw.data as { enabled: boolean }).enabled === true;

  const body: FactsheetChangesResponse = {
    state: 'ok',
    items: buildFactsheetChangeViews([...versions.values()], events, previousNames),
    readerSwitchedOn,
    sources: ((src.data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
      sourceKey: r.source_key as string,
      amcName: r.amc_name as string,
      documentType: r.document_type as string,
      host: r.host as string,
      termsReviewStatus: r.terms_review_status as string,
      enabled: r.enabled === true,
    })),
  };
  return ok(body);
});
