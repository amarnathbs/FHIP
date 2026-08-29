import { requireUser, bad, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { getAuInvestmentStatementIdForDocument } from '@/lib/financial-data-hub/services/investmentStatementProcessingService';

// GET /api/financial-data-hub/investment-statement/{documentId} — the full
// evidence review payload (spec sections 24-25, 61, 76): statement
// header + every position + every activity, all still pre-canonical
// (spec section 63). Uses the ordinary RLS-scoped client (not service
// role) — a plain owner-scoped read needs no elevated privilege.
export async function GET(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const statementId = await getAuInvestmentStatementIdForDocument(user.id, documentId);
  if (!statementId) return bad('No statement evidence has been extracted from this document yet.', 404);

  const supabase = await createClient();
  const [{ data: statement }, { data: positions }, { data: activities }] = await Promise.all([
    supabase.from('fdh_investment_statements').select('*').eq('id', statementId).eq('user_id', user.id).maybeSingle(),
    supabase.from('fdh_investment_statement_positions').select('*').eq('statement_id', statementId).eq('user_id', user.id).order('source_row_number'),
    supabase.from('fdh_investment_statement_activities').select('*').eq('statement_id', statementId).eq('user_id', user.id).order('source_row_number'),
  ]);
  if (!statement) return bad('Statement evidence not found.', 404);

  return ok({ statement, positions: positions ?? [], activities: activities ?? [] });
}
