// Market Index Data - the registered fund-house documents the factsheet reader may read, with the terms-review status
// of each and the reader's latest result. Capability `view` (read-only). No personal data: the reviewer's identity is not
// returned. If migration 0252 is not applied the answer is an explicit 503, never an empty list.
import { ok } from '@/lib/api';
import { adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { guarded, isMissingRelation } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';
import { buildFactsheetSourceViews, type FactsheetSourcesResponse, type SourceRow } from '@/lib/services/investment-intelligence/factsheetReader/sourcesView';

export const dynamic = 'force-dynamic';

export const GET = adminRoute(async () => {
  const g = await guarded('view');
  if (!g.ok) return g.response;
  const src = await g.supabase
    .from('ii_factsheet_sources')
    .select('id, source_key, amc_name, document_type, url, host, amfi_scheme_codes, terms_review_status, terms_reviewed_at, terms_review_note, enabled')
    .order('source_key', { ascending: true })
    .limit(200);
  if (src.error) {
    if (isMissingRelation(src.error)) return Response.json({ error: 'The factsheet reader tables are not available (migration not applied).', code: 'unavailable' }, { status: 503 });
    return safeDbError(src.error, 'factsheet sources');
  }
  const att = await g.supabase.from('ii_factsheet_attempts').select('source_id, attempted_at, outcome, document_date').order('attempted_at', { ascending: false }).limit(2000);
  if (att.error && !isMissingRelation(att.error)) return safeDbError(att.error, 'factsheet source results');
  const body: FactsheetSourcesResponse = {
    state: 'ok',
    sources: buildFactsheetSourceViews((src.data ?? []) as unknown as SourceRow[], ((att.error ? [] : att.data) ?? []) as unknown as Array<{ source_id: string; attempted_at: string; outcome: string; document_date: string | null }>),
  };
  return ok(body);
});
