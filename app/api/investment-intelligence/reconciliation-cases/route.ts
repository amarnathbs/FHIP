import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';

// R2 — "retrieve reconciliation cases" (spec section 51). Optional query
// filters: sourceDocumentId, status. RLS-respecting client only.
export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const url = new URL(req.url);
  const sourceDocumentId = url.searchParams.get('sourceDocumentId');
  const status = url.searchParams.get('status');

  const supabase = await createClient();
  let query = supabase.from('ii_reconciliation_cases').select('*').eq('user_id', user.id).order('opened_at', { ascending: false });
  if (sourceDocumentId) query = query.eq('source_document_id', sourceDocumentId);
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return bad(error.message);
  return ok(data);
}
