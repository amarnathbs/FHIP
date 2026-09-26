import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { getStatementDetails, StatementDetailsError } from '@/lib/financial-data-hub/services/statementDetailsService';

// GET /api/financial-data-hub/documents/{documentId}/statement-details[?page=N]
// WP-08 (EXP-G14, D-04). The statement's own evidence for its owner: period,
// account, reconciliation, opening / closing balance (labelled per D-04),
// data-quality checks, the lines that could not be read (with reasons),
// statement notes, and every line's posting / value date, reference and
// running balance -- 100 lines per page. Another user's id is 404.
export async function GET(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const page = Number(new URL(req.url).searchParams.get('page') ?? '1');
  try {
    return ok(await getStatementDetails(user.id, documentId, Number.isFinite(page) ? page : 1));
  } catch (e) {
    if (e instanceof StatementDetailsError) return bad(e.message, e.code === 'not_found' ? 404 : 500);
    return bad('We could not load this statement.', 500);
  }
}
