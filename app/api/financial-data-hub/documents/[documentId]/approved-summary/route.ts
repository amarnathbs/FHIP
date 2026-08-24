import { requireUser, bad, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';

// GET /api/financial-data-hub/documents/{documentId}/approved-summary —
// FDH-7 spec sections 57, 102. Read-only view of the CURRENT (non-superseded)
// Approved Financial Summary for one statement, if one exists yet.
export async function GET(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('fdh_approved_financial_summaries')
    .select('*')
    .eq('user_id', user.id)
    .eq('statement_upload_id', documentId)
    .eq('superseded', false)
    .order('approval_version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return bad('could not load approved summary', 500);
  if (!data) return bad('no approved summary exists for this statement yet', 404);

  return ok({ summary: data });
}
