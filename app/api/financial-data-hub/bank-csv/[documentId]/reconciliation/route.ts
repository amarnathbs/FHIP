import { requireUser, bad, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { statementUploadsRepository } from '@/lib/financial-data-hub/repositories';

// GET /api/financial-data-hub/bank-csv/{documentId}/reconciliation — spec 42-44, 54.
export async function GET(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const { data: document } = await statementUploadsRepository.getForUser(user.id, documentId);
  if (!document) return bad('document not found', 404);

  const supabase = await createClient();
  const [{ data: reconciliation }, { data: dataQuality }] = await Promise.all([
    supabase
      .from('fdh_reconciliation_results')
      .select('*')
      .eq('user_id', user.id)
      .eq('statement_upload_id', documentId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('fdh_data_quality_results')
      .select('check_code, status, score, details_sanitised')
      .eq('user_id', user.id)
      .eq('statement_upload_id', documentId)
      .order('check_code', { ascending: true }),
  ]);

  return ok({
    document_id: documentId,
    reconciliation,
    data_quality: dataQuality ?? [],
  });
}
