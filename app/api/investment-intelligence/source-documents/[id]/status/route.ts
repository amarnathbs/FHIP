import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';

// R2 — "retrieve processing status" (spec section 51). RLS-respecting
// client only (no service-role on this user-facing read path).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const supabase = await createClient();
  const { data: doc, error: docErr } = await supabase
    .from('ii_source_documents')
    .select('id, status, source_detected, source_confidence, document_type_detected, format_version_detected, parser_version, parse_completed_at, parse_error, statement_period_start, statement_period_end, statement_as_of_date')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (docErr) return bad(docErr.message);
  if (!doc) return bad('Source document not found.', 404);

  const { data: runs, error: runsErr } = await supabase
    .from('ii_document_parse_runs')
    .select('id, parser_code, parser_version, run_status, started_at, completed_at, accounts_found, schemes_found, transactions_found, holdings_found, warnings, errors, password_required')
    .eq('source_document_id', id)
    .eq('user_id', user.id)
    .order('started_at', { ascending: false })
    .limit(5);
  if (runsErr) return bad(runsErr.message);

  return ok({ document: doc, recentRuns: runs ?? [] });
}
